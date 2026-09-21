import { app, BrowserWindow, ipcMain, dialog, shell } from 'electron';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Services } from './services';
import { ensureSeedContent, seedCandidates } from './content/seed';
import { manifestUrlFor, repoFromPackageJson } from '../src/shared/repo';
import { createHandlers, safe } from './ipc';
import { CH, type Channel } from '../src/shared/ipc';

const isDev = !!process.env.RECALL_DEV_URL;
const isSmoke = !!process.env.RECALL_SMOKE;
const BOOT_T0 = Date.now();

/** 数据目录固定为 ~/Library/Application Support/Recall（PRD §6.1 F1） */
function dataRoot(): string {
  return join(app.getPath('appData'), 'Recall');
}

/**
 * Chromium 自己的缓存/存储（Code Cache、GPUCache、Local Storage…）不能和
 * 我们的 SQLite 文件挤在同一个目录里：
 * 实测在「全新目录 + Chromium 正在并写缓存」时，SQLite 切 WAL 会报 disk I/O error。
 * 所以把 Electron 的 userData 指到子目录，数据库文件留在数据目录根部（仍是 PRD §6.1 的位置）。
 */
function runtimeRoot(): string {
  return join(dataRoot(), 'runtime');
}

let svc: Services;
let win: BrowserWindow | null = null;
let readyHook: (() => void) | null = null;

function createWindow(): void {
  const s = svc.settings();
  const saved = svc.user.getSetting('window_bounds', '');
  let bounds: Electron.Rectangle = { x: 0, y: 0, width: 1180, height: 780 };
  if (saved) {
    try {
      const b = JSON.parse(saved) as Electron.Rectangle;
      if (b && b.width >= 960 && b.height >= 640) bounds = b;
    } catch { /* 用默认尺寸 */ }
  }

  win = new BrowserWindow({
    ...bounds,
    minWidth: 960,
    minHeight: 640,
    title: 'Recall',
    backgroundColor: '#FAFAF8',
    show: false,
    webPreferences: {
      preload: join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  if (bounds.x === 0 && bounds.y === 0) win.center();
  win.once('ready-to-show', () => win?.show());

  // 冒烟自检：等渲染层报告首屏可交互，打印冷启动耗时后自动退出。
  // 用于验证打包产物真的能启动，而不是只看构建是否成功。
  if (isSmoke) {
    let done = false;
    const finish = (payload: Record<string, unknown>) => {
      if (done) return;
      done = true;
      process.stdout.write('[SMOKE] ' + JSON.stringify(payload) + '\n');
      setTimeout(() => app.quit(), 120);
    };
    readyHook = () => finish({
      ok: true,
      coldStartMs: Date.now() - BOOT_T0,
      appVersion: app.getVersion(),
      dataRoot: dataRoot(),
      contentVersion: svc.meta().version,
      concepts: svc.meta().counts.total,
    });
    setTimeout(() => finish({ ok: false, reason: 'timeout waiting for renderer ready' }), 20000);
  }

  const persist = () => {
    if (!win || win.isDestroyed()) return;
    try { svc.user.setSetting('window_bounds', JSON.stringify(win.getBounds())); } catch { /* ignore */ }
  };
  win.on('resized', persist);
  win.on('moved', persist);
  win.on('close', persist);

  // 外链一律交给系统浏览器，应用本身不内嵌浏览
  win.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: 'deny' };
  });

  if (isDev) {
    void win.loadURL(process.env.RECALL_DEV_URL!);
  } else {
    void win.loadFile(join(__dirname, '../../dist/index.html'));
  }
}

function registerIpc(): void {
  const handlers = createHandlers(svc, {
    onReady: () => readyHook?.(),
    pickPath: async (mode) => {
      const r = await dialog.showOpenDialog(win!, {
        title: mode === 'save' ? '选择保存位置' : '选择文件',
        properties: mode === 'save' ? ['createDirectory'] : ['openFile'],
        filters: mode === 'content'
          ? [{ name: '内容文件', extensions: ['jsonl'] }]
          : [{ name: 'JSON', extensions: ['json'] }],
      });
      return r.canceled ? null : r.filePaths[0] ?? null;
    },
  });
  for (const [channel, fn] of Object.entries(handlers)) {
    ipcMain.handle(channel, async (_e, payload: unknown) => (await safe(fn)(payload)));
  }

}

/**
 * 读取 package.json 里的 recall.contentRepo，得出内置的内容仓库地址。
 * 读不到就当未配置（离线优先：检查更新静默跳过，手动导入照常可用）。
 */
function resolveDefaultManifestUrl(): string {
  try {
    const pkgPath = join(app.getAppPath(), 'package.json');
    const ref = repoFromPackageJson(JSON.parse(readFileSync(pkgPath, 'utf8')));
    if (!ref) return '';
    return manifestUrlFor(ref, process.env.RECALL_CONTENT_BRANCH || 'main');
  } catch (e) {
    console.warn('[recall] 读取内容仓库配置失败，联网更新将不可用：', (e as Error).message);
    return '';
  }
}

app.whenReady().then(() => {
  const manifestUrl = resolveDefaultManifestUrl();
  svc = new Services({
    root: dataRoot(),
    appVersion: app.getVersion(),
    fetchImpl: (url, init) => fetch(url, init as RequestInit) as never,
    defaultManifestUrl: manifestUrl,
  });
  if (manifestUrl) console.log(`[recall] 内容更新通道：${manifestUrl}`);
  else console.log('[recall] 未配置内容仓库，联网更新关闭（手动导入不受影响）');

  // 首启内置内容：只在内容库为空时导入，绝不用内置内容覆盖用户已有/已更新的内容（A2/A8）
  const seed = ensureSeedContent(
    svc,
    seedCandidates({ resourcesPath: process.resourcesPath, appPath: app.getAppPath(), moduleDir: __dirname }),
  );
  if (seed.imported) {
    console.log(`[recall] 已导入内置内容 v${seed.version}，共 ${seed.count} 个概念`);
  } else if (seed.reason && seed.path) {
    console.warn(`[recall] 内置内容未导入：${seed.reason}`);
  }

  registerIpc();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });

  // 启动时后台静默检查更新：不阻塞 UI，失败不打扰（PRD §4.5 M7-O1）
  if (svc.settings().autoCheckUpdate) {
    setTimeout(async () => {
      try {
        const r = await svc.checkUpdate();
        if (r.kind === 'update') {
          win?.webContents.send('app:event', 'update-available', r.info);
        }
      } catch { /* 静默 */ }
    }, 1500);
  }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  try { svc?.close(); } catch { /* ignore */ }
});

process.on('uncaughtException', (e) => {
  // 主进程永不因未捕获异常退出：最坏结果是"还在用旧内容"
  console.error('[recall] uncaught:', (e as Error)?.stack ?? e);
});
process.on('unhandledRejection', (e) => {
  console.error('[recall] unhandledRejection:', (e as Error)?.stack ?? e);
});

// 必须在 app ready 之前设置，且无条件执行（即使目录尚不存在）
mkdirSync(runtimeRoot(), { recursive: true });
app.setPath('userData', runtimeRoot());
