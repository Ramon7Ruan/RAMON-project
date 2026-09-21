import type { Services } from './services';
import { CH } from '../src/shared/ipc';
import type { ConceptStatus, Rating } from '../src/shared/types';

export interface Handler {
  (payload: unknown): unknown | Promise<unknown>;
}

/**
 * 把服务层方法映射到 IPC 通道。
 * 每个 handler 都被 safe() 包住：**绝不把异常抛回渲染层**（架构 §1.3），
 * 而是返回 { ok:false, error } 让 UI 就地显示原因。
 */
export interface HandlerDeps {
  /** 文件选择需要 BrowserWindow，由主进程注入；测试里传桩实现 */
  pickPath?: (mode: string) => Promise<string | null>;
  /** 渲染层首屏可交互时回调（冷启动计时用） */
  onReady?: () => void;
}

export function createHandlers(svc: Services, deps: HandlerDeps = {}): Record<string, Handler> {
  const asObj = (p: unknown): Record<string, unknown> =>
    (p && typeof p === 'object' ? p : {}) as Record<string, unknown>;

  return {
    [CH.contentMeta]: () => svc.meta(),
    [CH.contentList]: () => svc.summaries(),
    [CH.contentGet]: (p) => svc.concept(String(asObj(p).id ?? '')),
    [CH.contentSearch]: (p) => svc.searchHits(String(asObj(p).q ?? ''), Number(asObj(p).limit ?? 40)),
    [CH.contentCheckUpdate]: () => svc.checkUpdate(),
    [CH.contentApplyUpdate]: (p) => svc.applyUpdate(asObj(p) as never),
    [CH.contentImport]: (p) => {
      const path = asObj(p).path;
      if (typeof path === 'string' && path) return svc.importContentFile(path);
      const text = asObj(p).text;
      if (typeof text === 'string') return svc.importContentText(text);
      return { ok: false, reason: '需要 path 或 text' };
    },
    [CH.contentExportDist]: () => svc.buildDistFiles(),

    [CH.progressGetAll]: () => svc.states(),
    [CH.progressSet]: (p) => svc.setStatus(String(asObj(p).id ?? ''), asObj(p).status as ConceptStatus),
    [CH.progressReview]: (p) => svc.rate(String(asObj(p).id ?? ''), Number(asObj(p).rating ?? 2) as Rating),
    [CH.progressReset]: (p) => svc.resetProgress(String(asObj(p).confirm ?? ''), asObj(p).keepFavorites !== false),
    [CH.progressDue]: () => svc.dueQueue(),
    [CH.progressMarkRead]: (p) => svc.markRead(String(asObj(p).id ?? '')),
    [CH.progressToggleFav]: (p) => ({ favorite: svc.toggleFavorite(String(asObj(p).id ?? '')) }),
    [CH.progressFavorites]: () => svc.favorites(),

    [CH.settingsGet]: () => svc.settings(),
    [CH.settingsSet]: (p) => svc.updateSettings(asObj(p) as never),

    // 路径不做 String() 强转：那会把 { path: 42 } 变成相对路径 "42" 并写到 CWD。
    // 交给 Services 侧校验，非法即拒绝。
    [CH.backupExport]: (p) => svc.exportUserData(asObj(p).path),
    [CH.backupPreview]: (p) => svc.previewImportFile(asObj(p).path),
    [CH.backupImport]: (p) => svc.applyImportFile(asObj(p).path),
    [CH.backupList]: () => svc.listBackups(),

    [CH.appStats]: () => svc.stats(),
    [CH.appVersion]: () => svc.version(),
    [CH.appReady]: () => { deps.onReady?.(); return { ok: true }; },
    [CH.appPickPath]: async (p) => {
      const mode = String(asObj(p).mode ?? 'openFile');
      return deps.pickPath ? await deps.pickPath(mode) : null;
    },
  };
}

export function safe(fn: Handler): Handler {
  return async (payload: unknown) => {
    try {
      return await fn(payload);
    } catch (e) {
      return { ok: false, error: (e as Error)?.message ?? String(e) };
    }
  };
}
