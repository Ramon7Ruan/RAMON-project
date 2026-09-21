import { join } from 'node:path';
import { existsSync, readdirSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Services } from '../app/services';
import { createHandlers, safe } from '../app/ipc';
import { CH } from '../src/shared/ipc';
import { cleanup, makeGroup, tempDir } from './fixtures';
import { buildJsonl } from '../app/services';

let dir: string;
let svc: Services;
let handlers: ReturnType<typeof createHandlers>;
let alphaId: string;

const noFetch = async () => { throw new Error('测试中不应发起真实网络请求'); };

describe('P4 IPC 契约', () => {
  beforeAll(() => {
    dir = tempDir('recall-ipc-');
    svc = new Services({ root: dir, appVersion: '1.0.0-test', fetchImpl: noFetch as never });
    handlers = createHandlers(svc, { pickPath: async () => null });

    const concepts = makeGroup(3);
    const r = svc.importContentText(buildJsonl(concepts, '2026.09.21', '2026-09-21T10:00:00+08:00'));
    if (!('ok' in r) || !r.ok) throw new Error('fixture 导入失败：' + JSON.stringify(r).slice(0, 400));
    alphaId = concepts[0].id;
  });
  afterAll(() => { svc.close(); cleanup(dir); });

  it('架构 §1.3 列出的通道全部已注册', () => {
    for (const ch of Object.values(CH)) {
      expect(handlers[ch], `缺少通道 ${ch}`).toBeTypeOf('function');
    }
  });

  it('safe() 把异常转成 { ok:false, error }，绝不抛回渲染层', async () => {
    const boom = safe(() => { throw new Error('炸了'); });
    const r = await boom({}) as { ok: boolean; error: string };
    expect(r.ok).toBe(false);
    expect(r.error).toBe('炸了');

    const asyncBoom = safe(async () => { throw new Error('异步炸了'); });
    const r2 = await asyncBoom({}) as { ok: boolean; error: string };
    expect(r2.ok).toBe(false);
    expect(r2.error).toBe('异步炸了');

    // 返回当前值的 handler 不受影响
    const fine = safe((p) => ({ ok: true, echo: p }));
    expect(await fine('x')).toEqual({ ok: true, echo: 'x' });
  });

  it('每个通道在收到垃圾载荷时都不抛异常', async () => {
    const junk: unknown[] = [undefined, null, 0, '', [], { id: 123 }, { q: { nope: 1 } }, { path: 42 }];
    for (const [ch, fn] of Object.entries(handlers)) {
      for (const payload of junk) {
        await expect(
          Promise.resolve(safe(fn)(payload)),
          `通道 ${ch} 在载荷 ${JSON.stringify(payload)} 下抛异常了`,
        ).resolves.toBeDefined();
      }
    }
  });

  it('文件路径必须被校验：非法路径一律拒绝，且不落盘（回归）', async () => {
    // 背景：这里原本用 String(payload.path) 强转，于是 { path: 42 } 变成相对路径 "42"，
    // 文件被写进**进程当前目录**——既是越界写入，也违反「只写数据目录」的约束。
    const cwdBefore = readdirSync(process.cwd()).sort();

    const badPaths: unknown[] = [42, 0, null, undefined, '', '   ', 'relative.json', './x.json', '../y.json', {}, []];
    for (const bad of badPaths) {
      const exp = await handlers[CH.backupExport]({ path: bad }) as { ok: boolean; reason?: string };
      expect(exp.ok, `导出不该接受路径 ${JSON.stringify(bad)}`).toBe(false);
      expect(exp.reason).toBeTruthy();

      const pv = await handlers[CH.backupPreview]({ path: bad }) as { ok: boolean };
      expect(pv.ok, `预览不该接受路径 ${JSON.stringify(bad)}`).toBe(false);

      const im = await handlers[CH.backupImport]({ path: bad }) as { ok: boolean };
      expect(im.ok, `导入不该接受路径 ${JSON.stringify(bad)}`).toBe(false);
    }

    // 关键断言：整个过程不能在当前目录留下任何文件
    expect(readdirSync(process.cwd()).sort()).toEqual(cwdBefore);
  });

  it('绝对路径仍然正常可用（校验没有误伤正常用法）', async () => {
    const out = join(dir, 'export-abs.json');
    const r = await handlers[CH.backupExport]({ path: out }) as { ok: boolean; path: string; count: number };
    expect(r.ok).toBe(true);
    expect(r.path).toBe(out);
    expect(existsSync(out)).toBe(true);
    expect((await handlers[CH.backupPreview]({ path: out }) as { ok: boolean }).ok).toBe(true);
  });

  it('content:meta / listConcepts / getConcept 正常返回', async () => {
    const meta = await handlers[CH.contentMeta]({}) as { version: string; counts: { total: number } };
    expect(meta.version).toBe('2026.09.21');
    expect(meta.counts.total).toBe(3);

    const list = await handlers[CH.contentList]({}) as unknown[];
    expect(list.length).toBe(3);

    const c = await handlers[CH.contentGet]({ id: alphaId }) as { title: string };
    expect(c.title).toBeTruthy();

    const none = await handlers[CH.contentGet]({ id: '不存在' });
    expect(none).toBeNull();
  });

  it('progress 通道：标记状态、评分、到期队列', async () => {
    await handlers[CH.progressSet]({ id: alphaId, status: 'review' });
    const states = await handlers[CH.progressGetAll]({}) as Record<string, { status: string }>;
    expect(states[alphaId].status).toBe('review');

    const due = await handlers[CH.progressDue]({}) as string[];
    expect(due).toContain(alphaId);

    const next = await handlers[CH.progressReview]({ id: alphaId, rating: 2 }) as { status: string; due_at: string };
    expect(next.status).toBe('known');
    expect(next.due_at).toBeTruthy();
  });

  it('progress:markRead 只在未读时改状态（PRD §3.5 唯一自动转移）', async () => {
    const a = await handlers[CH.progressMarkRead]({ id: alphaId }) as { status: string };
    expect(a.status).toBe('known'); // 已是 known，不应被改回 reading

    const b = await handlers[CH.progressMarkRead]({ id: 'econ.macro.brand-new' }) as { status: string };
    expect(b.status).toBe('reading');
  });

  it('收藏与设置通道', async () => {
    const f = await handlers[CH.progressToggleFav]({ id: alphaId }) as { favorite: boolean };
    expect(f.favorite).toBe(true);
    expect(await handlers[CH.progressFavorites]({})).toContain(alphaId);

    await handlers[CH.settingsSet]({ theme: 'dark' });
    const s = await handlers[CH.settingsGet]({}) as { theme: string };
    expect(s.theme).toBe('dark');
  });

  it('检查更新：未配置地址时静默跳过，不报错', async () => {
    const r = await handlers[CH.contentCheckUpdate]({}) as { kind: string; reason: string };
    expect(r.kind).toBe('skipped');
    expect(r.reason).toBe('not-configured');
  });

  it('重置进度：确认文案不正确时拒绝执行（PRD §6.7 二次确认）', async () => {
    const bad = await handlers[CH.progressReset]({ confirm: '随便写的' }) as { ok: boolean; reason: string };
    expect(bad.ok).toBe(false);
    expect(bad.reason).toContain('确认文案');

    const good = await handlers[CH.progressReset]({ confirm: '重置进度', keepFavorites: true }) as { ok: boolean; cleared: number };
    expect(good.ok).toBe(true);
    expect(good.cleared).toBeGreaterThan(0);
    // 收藏默认保留
    expect(await handlers[CH.progressFavorites]({})).toContain(alphaId);
  });

  it('备份与导入预览通道走通', async () => {
    const out = join(dir, 'export.json');
    const r = await handlers[CH.backupExport]({ path: out }) as { ok: boolean; path: string };
    expect(r.ok).toBe(true);

    const pv = await handlers[CH.backupPreview]({ path: out }) as { ok: boolean; total: number };
    expect(pv.ok).toBe(true);

    const bad = await handlers[CH.backupPreview]({ path: join(dir, '不存在.json') }) as { ok: boolean; reason: string };
    expect(bad.ok).toBe(false);
    expect(bad.reason).toContain('文件不存在');
  });

  it('stats 通道返回可用的统计视图', async () => {
    const st = await handlers[CH.appStats]({}) as { total: number; tracks: unknown[]; meta: { version: string } };
    expect(st.total).toBe(3);
    expect(st.tracks.length).toBe(9);
    expect(st.meta.version).toBeTruthy();
  });
});
