/**
 * electron-builder afterPack 钩子：裁剪 Electron Framework 内的语言包
 *
 * 背景（踩坑记录）：
 *   electron-builder 的 `electronLanguages` 在 macOS 上只清理
 *   `Contents/Resources/*.lproj`，而 Electron 44 把真正的语言包
 *   （每个语言一个 locale.pak）放在
 *   `Contents/Frameworks/Electron Framework.framework/Versions/A/Resources/*.lproj`。
 *   结果是该配置**静默失效**：配置看起来生效了（顶层确实只剩两种语言），
 *   实际包里仍带着 200 多个语言、约 74MB。所以这里自己动手。
 *
 * 保留策略：只留应用真正会用的语言 + Apple 的 Base.lproj。
 * Chromium 在找不到对应语言时会回退到 en，删除其余语言是安全的。
 */
const { readdirSync, rmSync, statSync, existsSync } = require('node:fs');
const { join } = require('node:path');

/** 需要保留的语言（与 electron-builder.yml 的 electronLanguages 保持一致） */
const KEEP = new Set(['en', 'zh_CN', 'Base']);

function dirSize(p) {
  let total = 0;
  for (const entry of readdirSync(p, { withFileTypes: true })) {
    const full = join(p, entry.name);
    if (entry.isDirectory()) total += dirSize(full);
    else {
      try { total += statSync(full).size; } catch { /* 忽略统计失败 */ }
    }
  }
  return total;
}

/** 收集所有可能存放语言包的目录 */
function localeDirs(appOutDir, productName) {
  const app = join(appOutDir, `${productName}.app`);
  const out = [];

  // ① Framework 内部（Electron 44 的实际位置）
  const frameworks = join(app, 'Contents', 'Frameworks');
  if (existsSync(frameworks)) {
    for (const fw of readdirSync(frameworks)) {
      if (!fw.endsWith('.framework')) continue;
      const versions = join(frameworks, fw, 'Versions');
      if (!existsSync(versions)) continue;
      for (const ver of readdirSync(versions)) {
        const res = join(versions, ver, 'Resources');
        if (existsSync(res)) out.push(res);
      }
    }
  }

  // ② 顶层 Resources（electron-builder 自己也会处理，这里兜底）
  const top = join(app, 'Contents', 'Resources');
  if (existsSync(top)) out.push(top);

  return out;
}

exports.default = async function afterPack(context) {
  const productName = context.packager.appInfo.productFilename;
  const dirs = localeDirs(context.appOutDir, productName);
  let removedCount = 0;
  let savedBytes = 0;

  for (const dir of dirs) {
    for (const entry of readdirSync(dir)) {
      if (!entry.endsWith('.lproj')) continue;
      const lang = entry.slice(0, -'.lproj'.length);
      if (KEEP.has(lang)) continue;
      const full = join(dir, entry);
      try {
        savedBytes += dirSize(full);
        rmSync(full, { recursive: true, force: true });
        removedCount += 1;
      } catch {
        // 个别文件删不掉不影响打包，继续
      }
    }
  }

  if (removedCount > 0) {
    const mb = (savedBytes / 1024 / 1024).toFixed(1);
    console.log(`  • 已裁剪 ${removedCount} 个语言包，节省约 ${mb} MB`);
  }
};
