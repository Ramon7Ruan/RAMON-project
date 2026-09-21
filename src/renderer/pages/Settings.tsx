import { useEffect, useState } from 'react';
import type { UpdateInfo } from '@shared/types';
import { api, type CheckResultDTO, type ImportPreviewDTO } from '../api';
import { InlineError } from '../components';
import type { PageCtx } from '../route';

type UpdState =
  | { k: 'idle' }
  | { k: 'checking' }
  | { k: 'uptodate' }
  | { k: 'skipped'; reason: string }
  | { k: 'found'; info: UpdateInfo }
  | { k: 'applying'; info: UpdateInfo }
  | { k: 'done'; version: string }
  | { k: 'failed'; reason: string };

const SKIP_TEXT: Record<string, string> = {
  'not-configured': '尚未配置内容分发地址——可在下方填写，或直接用「导入内容」',
  'no-network': '检查更新失败（网络不可用），不影响使用',
  timeout: '检查更新超时，不影响使用',
  'bad-manifest': '内容清单格式异常，已跳过',
  'up-to-date': '已是最新版本',
};

export function SettingsPage({ ctx }: { ctx: PageCtx }) {
  const [upd, setUpd] = useState<UpdState>({ k: 'idle' });
  const [manifestUrl, setManifestUrl] = useState(ctx.settings.manifestUrl);
  const [backups, setBackups] = useState<string[]>([]);
  const [preview, setPreview] = useState<ImportPreviewDTO | null>(null);
  const [pendingImport, setPendingImport] = useState<string | null>(null);
  const [confirmText, setConfirmText] = useState('');
  const [keepFav, setKeepFav] = useState(true);
  const [note, setNote] = useState<string | null>(null);

  useEffect(() => { void api.listBackups().then(setBackups); }, []);
  useEffect(() => { setManifestUrl(ctx.settings.manifestUrl); }, [ctx.settings.manifestUrl]);

  const check = async () => {
    setUpd({ k: 'checking' });
    const r: CheckResultDTO = await api.checkUpdate();
    if (r.kind === 'update') setUpd({ k: 'found', info: r.info });
    else setUpd(r.reason === 'up-to-date' ? { k: 'uptodate' } : { k: 'skipped', reason: r.reason });
  };

  const apply = async (info: UpdateInfo) => {
    setUpd({ k: 'applying', info });
    const r = await api.applyUpdate(info);
    if (r.ok) {
      setUpd({ k: 'done', version: r.version ?? info.version });
      await ctx.refresh();
    } else {
      setUpd({ k: 'failed', reason: r.reason ?? '未知原因' });
    }
  };

  const importContent = async () => {
    const p = await api.pickPath('content');
    if (!p) return;
    const r = await api.importContent(p);
    setNote(r.ok ? `已导入 ${r.count} 个概念（版本 ${r.version}），备份在 ${r.backup}` : `导入失败：${r.reason}`);
    if (r.ok) await ctx.refresh();
  };

  const exportData = async () => {
    const p = await api.pickPath('save');
    if (!p) return;
    const target = p.endsWith('.json') ? p : `${p}.json`;
    const r = await api.exportData(target);
    setNote(r.ok ? `已导出 ${r.count} 条进度到 ${r.path}` : '导出失败');
  };

  const pickImport = async () => {
    const p = await api.pickPath('openFile');
    if (!p) return;
    const pv = await api.previewImport(p);
    setPendingImport(p);
    setPreview(pv);
  };

  const doImport = async () => {
    if (!pendingImport) return;
    const r = await api.importData(pendingImport);
    setNote(`已恢复 ${r.applied} 条进度，跳过 ${r.skipped} 条（已有更新的记录），其中 ${r.orphans} 条对应概念已不在内容库中`);
    setPendingImport(null);
    setPreview(null);
    await ctx.refresh();
  };

  const doReset = async () => {
    const r = await api.resetProgress(confirmText, keepFav);
    if (r.ok) {
      setNote(`已清空 ${r.cleared} 条进度${keepFav ? '（收藏已保留）' : '（收藏也已清空）'}`);
      setConfirmText('');
      await ctx.refresh();
    } else {
      setNote(r.reason ?? '重置失败');
    }
  };

  const setTheme = async (t: string) => {
    await api.saveSettings({ theme: t });
    document.documentElement.dataset.theme = t;
    await ctx.refresh();
  };

  const saveUrl = async () => {
    await api.saveSettings({ manifestUrl });
    setNote(manifestUrl ? '分发地址已保存' : '分发地址已清空');
    await ctx.refresh();
  };

  const toggleAuto = async () => {
    await api.saveSettings({ autoCheckUpdate: !ctx.settings.autoCheckUpdate });
    await ctx.refresh();
  };

  const m = ctx.meta;

  return (
    <div className="page">
      <h2 className="page-title">设置</h2>

      <div className="set-sec">内容</div>
      <div className="set-box">
        <div className="set-row">
          <div>
            <div className="sl">当前版本</div>
            <div className="sd">
              {m.version} · 经济学 {m.counts.econ} · 金融学 {m.counts.finance} · 热点 {m.counts.hotspot}
            </div>
          </div>
        </div>
        <div className="set-row">
          <div>
            <div className="sl">上次检查</div>
            <div className="sd">{ctx.settings.lastCheck ? ctx.settings.lastCheck.replace('T', ' ').slice(0, 16) : '从未检查'}</div>
          </div>
          <div className="sr">
            <span className="chip" onClick={toggleAuto}>
              <span className={`dot ${ctx.settings.autoCheckUpdate ? 'known' : 'unread'}`}>●</span>
              {' '}启动时自动检查
            </span>
          </div>
        </div>
        <div className="set-row">
          <div>
            <div className="sl">检查更新</div>
            <div className="sd">
              {upd.k === 'checking' ? '正在检查…'
                : upd.k === 'uptodate' ? '已是最新版本'
                : upd.k === 'skipped' ? SKIP_TEXT[upd.reason] ?? '已跳过'
                : upd.k === 'done' ? `已更新到 ${upd.version}`
                : upd.k === 'failed' ? upd.reason
                : '有更新时会在这里显示详情'}
            </div>
          </div>
          <div className="sr">
            {upd.k === 'checking'
              ? <span style={{ color: 'var(--text-tertiary)' }}>检查中…</span>
              : upd.k === 'found' || upd.k === 'applying'
                ? <span className="btn sm primary" onClick={() => { if (upd.k !== 'applying') void apply(upd.info); }}>
                    {upd.k === 'applying' ? '更新中…' : '立即更新'}
                  </span>
                : <span className="btn sm" onClick={check}>立即检查</span>}
          </div>
        </div>
        <div className="set-row">
          <div>
            <div className="sl">分发地址</div>
            <div className="sd">manifest.json 的完整 URL（jsDelivr 路径）</div>
          </div>
          <div className="sr">
            <input className="confirm-input" style={{ width: 260 }} value={manifestUrl}
              placeholder="https://cdn.jsdelivr.net/gh/…/manifest.json"
              aria-label="分发地址"
              onChange={(e) => setManifestUrl(e.target.value)} />
            <span className="btn sm" onClick={saveUrl}>保存</span>
          </div>
        </div>
        <div className="set-row">
          <div>
            <div className="sl">导入内容</div>
            <div className="sd">选一个本地的 concepts.jsonl，校验通过后替换内容库</div>
          </div>
          <div className="sr"><span className="btn sm" onClick={importContent}>选择文件…</span></div>
        </div>
      </div>

      {upd.k === 'found' && (
        <div className="upd-panel">
          <div className="uh">{upd.info.version} 可用</div>
          <div className="upd-line"><span>发布日期</span><span>{upd.info.updated_at.slice(0, 10)}</span></div>
          <div className="upd-line"><span>概念总数</span><span>{upd.info.counts.total}</span></div>
          <div className="upd-line"><span>大小 / 校验</span><span>{upd.info.size} B · sha256 {upd.info.sha256.slice(0, 8)}…</span></div>
          <div style={{ marginTop: 'var(--space-3)' }}>
            <span className="btn sm primary" onClick={() => apply(upd.info)}>立即更新</span>
          </div>
          <div style={{ marginTop: 'var(--space-2)', fontSize: 'var(--text-xs)', color: 'var(--text-tertiary)' }}>
            更新只替换内容库，你的复习进度不受影响。
          </div>
        </div>
      )}

      <div className="set-sec">数据</div>
      <div className="set-box">
        <div className="set-row">
          <div><div className="sl">导出我的数据</div><div className="sd">进度、收藏、设置 · 不含内容库</div></div>
          <div className="sr"><span className="btn sm" onClick={exportData}>导出</span></div>
        </div>
        <div className="set-row">
          <div><div className="sl">导入我的数据</div><div className="sd">从备份文件恢复 · 合并式，先预览再执行</div></div>
          <div className="sr"><span className="btn sm" onClick={pickImport}>导入</span></div>
        </div>
        <div className="set-row">
          <div>
            <div className="sl">重置复习进度</div>
            <div className="sd">清空全部进度与复习记录，不可撤销。输入「重置进度」以确认</div>
          </div>
          <div className="sr">
            <span className="chip" onClick={() => setKeepFav((v) => !v)}>
              {keepFav ? '保留收藏' : '同时清空收藏'}
            </span>
            <input className="confirm-input" value={confirmText} placeholder="重置进度"
              aria-label="确认文案" onChange={(e) => setConfirmText(e.target.value)} />
            <span className="btn sm danger" onClick={doReset}>重置</span>
          </div>
        </div>
        <div className="set-row">
          <div><div className="sl">自动备份</div><div className="sd">每次更新内容前自动备份 user.db，保留最近 5 份</div></div>
          <div className="sr">{backups.length} 份</div>
        </div>
      </div>

      {preview && (
        <div className="upd-panel">
          <div className="uh">导入预览</div>
          {!preview.compatible && <InlineError message={preview.problems.join('；')} />}
          <div className="upd-line"><span>文件内进度记录</span><span>{preview.total} 条</span></div>
          <div className="upd-line"><span>将更新（比现有更新）</span><span>{preview.willUpdate} 条</span></div>
          <div className="upd-line"><span>跳过（现有更新或相同）</span><span>{preview.older + preview.unchanged} 条</span></div>
          <div className="upd-line"><span>对应概念已不在内容库</span><span>{preview.orphans} 条</span></div>
          <div className="upd-line"><span>收藏</span><span>{preview.favorites} 条</span></div>
          <div style={{ marginTop: 'var(--space-3)', display: 'flex', gap: 'var(--space-2)' }}>
            <span className="btn sm primary" onClick={doImport}>确认导入</span>
            <span className="btn sm" onClick={() => { setPreview(null); setPendingImport(null); }}>取消</span>
          </div>
        </div>
      )}

      <div className="set-sec">外观</div>
      <div className="set-box">
        <div className="set-row">
          <div><div className="sl">主题</div><div className="sd">视觉值全部来自 tokens.css，换肤只改一处</div></div>
          <div className="sr">
            <div className="seg">
              {[['light', '浅色'], ['dark', '深色'], ['system', '跟随系统']].map(([k, label]) => (
                <div key={k} className={ctx.settings.theme === k ? 'on' : ''} onClick={() => setTheme(k)}>{label}</div>
              ))}
            </div>
          </div>
        </div>
      </div>

      <div className="set-sec">关于</div>
      <div className="set-box">
        <div className="set-row">
          <div>
            <div className="sl">Recall v1.0</div>
            <div className="sd">纯本地运行 · 内容可离线使用 · 除内容更新外不产生任何网络请求</div>
          </div>
        </div>
      </div>

      {note && (
        <div style={{ marginTop: 'var(--space-4)' }}>
          <div className="upd-panel">{note}</div>
        </div>
      )}
    </div>
  );
}
