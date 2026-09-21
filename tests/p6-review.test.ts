import { existsSync, readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Concept, ConceptState } from '../src/shared/types';
import { defaultState, isDue, review, EASE_MIN, EASE_MAX } from '../src/shared/scheduler';
import { Services, buildJsonl } from '../app/services';
import { parseManifest, sha256, compareVersion, BACKUP_KEEP, parseJsonl } from '../app/update/updater';
import { cleanup, makeGroup, makeConcept, tempDir } from './fixtures';

const NOW = new Date('2026-09-21T10:00:00+08:00');

describe('P6 间隔重复算法（纯函数，无 IO）', () => {
  it('默认状态：未读、ease 2.5、无到期时间', () => {
    const s = defaultState('x');
    expect(s.status).toBe('unread');
    expect(s.ease).toBe(2.5);
    expect(s.interval_days).toBe(0);
    expect(s.due_at).toBeNull();
  });

  it('首次评分「记得」→ 间隔 2 天，ease 2.6，状态 known', () => {
    const r = review({ prev: defaultState('x'), rating: 2, now: NOW });
    expect(r.interval_days).toBe(2);
    expect(r.ease).toBeCloseTo(2.6, 3);
    expect(r.status).toBe('known');
    expect(r.due_at).toBe('2026-09-23');
    expect(r.reps).toBe(1);
  });

  it('首次评分「模糊」→ 间隔 1 天，状态 reading', () => {
    const r = review({ prev: defaultState('x'), rating: 1, now: NOW });
    expect(r.interval_days).toBe(1);
    expect(r.status).toBe('reading');
  });

  it('首次评分「忘了」→ 间隔重置 1 天，lapses +1', () => {
    const r = review({ prev: defaultState('x'), rating: 0, now: NOW });
    expect(r.interval_days).toBe(1);
    expect(r.lapses).toBe(1);
    expect(r.status).toBe('review');
  });

  it('连续「记得」间隔递增（2 → 5 → 14 天级别）', () => {
    let s: Pick<ConceptState, 'ease' | 'interval_days' | 'reps' | 'lapses'> = defaultState('x');
    const intervals: number[] = [];
    for (let i = 0; i < 4; i++) {
      const r = review({ prev: s, rating: 2, now: NOW });
      intervals.push(r.interval_days);
      s = { ease: r.ease, interval_days: r.interval_days, reps: r.reps, lapses: r.lapses };
    }
    for (let i = 1; i < intervals.length; i++) {
      expect(intervals[i], `第 ${i + 1} 次间隔没有增长：${intervals.join(',')}`).toBeGreaterThan(intervals[i - 1]);
    }
  });

  it('连续「忘了」：ease 逐次下降但不低于下限 1.3', () => {
    let ease = EASE_MAX;
    for (let i = 0; i < 30; i++) {
      const r = review({ prev: { ease, interval_days: 10, reps: 3, lapses: i }, rating: 0, now: NOW });
      ease = r.ease;
    }
    expect(ease).toBe(EASE_MIN);
  });

  it('连续「记得」：ease 逐次上升但不超过上限 3.0', () => {
    let ease = 1.3;
    for (let i = 0; i < 40; i++) {
      const r = review({ prev: { ease, interval_days: 1, reps: i, lapses: 0 }, rating: 2, now: NOW });
      ease = r.ease;
    }
    expect(ease).toBe(EASE_MAX);
  });

  it('「忘了」会把已经很长的间隔打回 1 天（间隔重置）', () => {
    const r = review({ prev: { ease: 2.8, interval_days: 120, reps: 9, lapses: 0 }, rating: 0, now: NOW });
    expect(r.interval_days).toBe(1);
    expect(r.lapses).toBe(1);
  });

  it('间隔至少 1 天，且是整数天', () => {
    for (const rating of [0, 1, 2] as const) {
      const r = review({ prev: { ease: 1.3, interval_days: 1, reps: 0, lapses: 0 }, rating, now: NOW });
      expect(Number.isInteger(r.interval_days)).toBe(true);
      expect(r.interval_days).toBeGreaterThanOrEqual(1);
    }
  });

  it('跨天翻转：23:59 评分与次日 00:01 评分得到相同的到期日', () => {
    const late = new Date(2026, 8, 21, 23, 59, 0);
    const early = new Date(2026, 8, 22, 0, 1, 0);
    const a = review({ prev: defaultState('x'), rating: 2, now: late });
    const b = review({ prev: defaultState('x'), rating: 2, now: early });
    expect(a.due_at).toBe('2026-09-23');
    expect(b.due_at).toBe('2026-09-24'); // 从各自的当天算起
  });

  it('月末/年末推进不出错', () => {
    const a = review({ prev: defaultState('x'), rating: 2, now: new Date(2026, 0, 31, 12) });
    expect(a.due_at).toBe('2026-02-02');
    const b = review({ prev: defaultState('x'), rating: 2, now: new Date(2026, 11, 31, 12) });
    expect(b.due_at).toBe('2027-01-02');
  });

  it('时间回拨（用户改了系统时间）不产生非法到期日', () => {
    // 间隔 = 上次间隔 × 新 ease = 10 × 2.6 = 26 天
    const r = review({ prev: { ease: 2.5, interval_days: 10, reps: 3, lapses: 0 }, rating: 2, now: new Date(2020, 0, 1) });
    expect(r.due_at).toBe('2020-01-27');
    expect(Number.isFinite(Date.parse(r.due_at))).toBe(true);
  });

  it('脏状态（NaN / 负数）被夹到合法区间，不产生 NaN', () => {
    const r = review({
      prev: { ease: NaN, interval_days: -5, reps: -1, lapses: -1 },
      rating: 2,
      now: NOW,
    });
    expect(Number.isFinite(r.ease)).toBe(true);
    expect(Number.isFinite(r.interval_days)).toBe(true);
    expect(r.reps).toBeGreaterThanOrEqual(0);
    expect(r.lapses).toBeGreaterThanOrEqual(0);
  });

  it('算法是纯函数：同输入同输出，且不修改入参', () => {
    const prev = { ease: 2.5, interval_days: 5, reps: 2, lapses: 0 };
    const snapshot = { ...prev };
    const a = review({ prev, rating: 1, now: NOW });
    const b = review({ prev, rating: 1, now: NOW });
    expect(a).toEqual(b);
    expect(prev).toEqual(snapshot);
  });

  it('isDue 由 due_at 决定，与 status 无关 —— 否则间隔重复不会二次触发', () => {
    const today = new Date(2026, 8, 21);
    expect(isDue({ due_at: '2026-09-21' }, today)).toBe(true);
    expect(isDue({ due_at: '2026-09-20' }, today)).toBe(true);
    expect(isDue({ due_at: '2026-09-22' }, today)).toBe(false);
    expect(isDue({ due_at: null }, today)).toBe(false);
  });
});

// ---------------------------------------------------------------------------

interface FetchBehaviour {
  status?: number;
  body?: string;
  reject?: string; // 'network' | 'timeout'
  hit?: { count: number };
}

function makeFetch(handler: (url: string) => FetchBehaviour) {
  return async (url: string) => {
    const b = handler(url);
    if (b.reject === 'timeout') {
      const e = new Error('aborted');
      e.name = 'AbortError';
      throw e;
    }
    if (b.reject === 'network') throw new Error('ENOTFOUND');
    return {
      ok: (b.status ?? 200) >= 200 && (b.status ?? 200) < 300,
      status: b.status ?? 200,
      text: async () => b.body ?? '',
    };
  };
}

function manifestFor(concepts: Concept[], version: string) {
  const updatedAt = '2026-09-28T10:00:00Z';
  const jsonl = buildJsonl(concepts, version, updatedAt);
  return {
    jsonl,
    manifest: {
      version,
      updatedAt,
      schemaVersion: 1,
      counts: { econ: concepts.filter((c) => c.domain === 'econ').length, finance: concepts.filter((c) => c.domain === 'finance').length, hotspot: concepts.filter((c) => c.domain === 'hotspot').length, total: concepts.length },
      file: 'concepts.jsonl',
      sha256: sha256(jsonl),
      size: Buffer.byteLength(jsonl, 'utf8'),
    },
  };
}

describe('P6 内容更新失败矩阵（架构 §4.6，硬门禁）', () => {
  let dir: string;
  let svc: Services;
  const v1 = makeGroup(3);
  // 新增概念必须换一组 recipe（版本 5），否则会与 v1 里的组合撞车而被门禁拦下
  const v2 = [
    ...v1,
    makeConcept({
      id: 'econ.micro.newbie', title: '新增概念', domain: 'econ', track: 'micro', variant: 5,
      links: [{ to: v1[0].id, reason: '延伸' }],
    }),
  ];

  const baseManifestUrl = 'https://cdn.jsdelivr.net/gh/o/r@main/content-dist/manifest.json';

  function newService(fetchImpl: ReturnType<typeof makeFetch>): Services {
    const s = new Services({ root: dir, appVersion: '1.0.0-test', fetchImpl: fetchImpl as never });
    return s;
  }

  beforeEach(() => {
    dir = tempDir('recall-upd-');
  });
  afterEach(() => {
    try { svc?.close(); } catch { /* ignore */ }
    cleanup(dir);
  });

  it('① 未配置地址：静默跳过', async () => {
    svc = newService(makeFetch(() => ({ reject: 'network' })) as never);
    const r = await svc.checkUpdate();
    expect(r).toEqual({ kind: 'skipped', reason: 'not-configured' });
  });

  it('② 无网络：静默跳过，应用仍可用', async () => {
    svc = newService(makeFetch(() => ({ reject: 'network' })) as never);
    svc.updateSettings({ manifestUrl: baseManifestUrl });
    const r = await svc.checkUpdate();
    expect(r).toEqual({ kind: 'skipped', reason: 'no-network' });
    expect(svc.meta().version).toBe('0.0.0'); // 旧库未受影响
  });

  it('③ 超时：静默跳过', async () => {
    svc = newService(makeFetch(() => ({ reject: 'timeout' })) as never);
    svc.updateSettings({ manifestUrl: baseManifestUrl });
    const r = await svc.checkUpdate();
    expect(r).toEqual({ kind: 'skipped', reason: 'timeout' });
  });

  it('④ manifest 格式非法：静默跳过', async () => {
    svc = newService(makeFetch(() => ({ body: '{不是 JSON' })) as never);
    svc.updateSettings({ manifestUrl: baseManifestUrl });
    expect(await svc.checkUpdate()).toEqual({ kind: 'skipped', reason: 'bad-manifest' });

    svc.close();
    svc = newService(makeFetch(() => ({ body: JSON.stringify({ version: '2026.09.28' }) })) as never);
    svc.updateSettings({ manifestUrl: baseManifestUrl });
    expect(await svc.checkUpdate()).toEqual({ kind: 'skipped', reason: 'bad-manifest' });
  });

  it('⑤ jsDelivr 返回旧缓存（版本不比本地新）：视为无更新', async () => {
    svc = newService(makeFetch(() => ({ reject: 'network' })) as never);
    // 先导入一个较新的版本
    svc.importContentText(buildJsonl(v1, '2026.09.28', 'x'));
    expect(svc.meta().version).toBe('2026.09.28');

    svc.close();
    const old = manifestFor(v1, '2026.09.21');
    svc = newService(makeFetch(() => ({ body: JSON.stringify(old.manifest) })) as never);
    svc.updateSettings({ manifestUrl: baseManifestUrl });
    expect(await svc.checkUpdate()).toEqual({ kind: 'skipped', reason: 'up-to-date' });
    expect(svc.meta().version).toBe('2026.09.28');
  });

  it('⑥ sha256 不匹配：拒绝替换，旧库完好', async () => {
    svc = newService(makeFetch(() => ({ reject: 'network' })) as never);
    svc.importContentText(buildJsonl(v1, '2026.09.21', 'x'));
    const before = svc.summaries().map((c) => c.id).sort();

    svc.close();
    const good = manifestFor(v2, '2026.09.28');
    svc = newService(makeFetch((url) =>
      url.endsWith('manifest.json') ? { body: JSON.stringify(good.manifest) } : { body: good.jsonl },
    ) as never);
    svc.updateSettings({ manifestUrl: baseManifestUrl });

    const res = await svc.applyUpdate({
      fileUrl: baseManifestUrl.replace('manifest.json', 'concepts.jsonl'),
      sha256: 'f'.repeat(64), // 故意错
      size: good.manifest.size,
      version: '2026.09.28',
      updated_at: '2026-09-28T10:00:00Z',
    });
    expect(res.ok).toBe(false);
    expect(res.ok === false && res.reason).toContain('sha256');
    expect(svc.meta().version).toBe('2026.09.21'); // 仍是旧库
    expect(svc.summaries().map((c) => c.id).sort()).toEqual(before);
  });

  it('⑥b 大小不匹配同样拒绝', async () => {
    svc = newService(makeFetch(() => ({ reject: 'network' })) as never);
    svc.importContentText(buildJsonl(v1, '2026.09.21', 'x'));
    svc.close();

    const good = manifestFor(v2, '2026.09.28');
    svc = newService(makeFetch(() => ({ body: good.jsonl })) as never);
    const res = await svc.applyUpdate({
      fileUrl: 'x', sha256: good.manifest.sha256, size: 1, version: '2026.09.28', updated_at: 'x',
    });
    expect(res.ok).toBe(false);
    expect(res.ok === false && res.reason).toContain('大小');
    expect(svc.meta().version).toBe('2026.09.21');
  });

  it('⑦ JSONL 解析失败：保留旧库并指出行号', async () => {
    svc = newService(makeFetch(() => ({ reject: 'network' })) as never);
    svc.importContentText(buildJsonl(v1, '2026.09.21', 'x'));
    svc.close();

    const broken = '{"_meta":{"version":"2026.09.28"}}\n{坏行\n' + JSON.stringify(v2[0]);
    svc = newService(makeFetch(() => ({ body: broken })) as never);
    const res = await svc.applyUpdate({
      fileUrl: 'x', sha256: sha256(broken), size: Buffer.byteLength(broken), version: '2026.09.28', updated_at: 'x',
    });
    expect(res.ok).toBe(false);
    expect(res.ok === false && res.reason).toContain('第 2 行');
    expect(svc.meta().version).toBe('2026.09.21');
  });

  it('⑧ 新内容未通过门禁校验：拒绝替换', async () => {
    svc = newService(makeFetch(() => ({ reject: 'network' })) as never);
    svc.importContentText(buildJsonl(v1, '2026.09.21', 'x'));
    svc.close();

    // 两个 recipe 完全相同的概念 → 触发 recipe-collision
    const dup = [makeConcept({ id: 'econ.macro.a1', variant: 0 }), makeConcept({ id: 'econ.macro.a2', variant: 0 })];
    const bad = buildJsonl(dup, '2026.09.28', 'x');
    svc = newService(makeFetch(() => ({ body: bad })) as never);
    const res = await svc.applyUpdate({
      fileUrl: 'x', sha256: sha256(bad), size: Buffer.byteLength(bad), version: '2026.09.28', updated_at: 'x',
    });
    expect(res.ok).toBe(false);
    expect(res.ok === false && res.reason).toContain('未通过校验');
    expect(svc.meta().version).toBe('2026.09.21');
  });

  it('⑨ 成功路径：内容被替换，且 user.db 的进度一条不丢（A6/A10 硬指标）', async () => {
    svc = newService(makeFetch(() => ({ reject: 'network' })) as never);
    svc.importContentText(buildJsonl(v1, '2026.09.21', 'x'));

    // 造一些进度
    const ids = v1.map((c) => c.id);
    svc.setStatus(ids[0], 'known');
    svc.rate(ids[1], 2, NOW);
    svc.toggleFavorite(ids[2]);
    const before = svc.states();
    const favBefore = svc.favorites();

    svc.close();
    const good = manifestFor(v2, '2026.09.28');
    svc = newService(makeFetch((url) =>
      url.endsWith('manifest.json') ? { body: JSON.stringify(good.manifest) } : { body: good.jsonl },
    ) as never);
    svc.updateSettings({ manifestUrl: baseManifestUrl });

    const check = await svc.checkUpdate();
    expect(check.kind).toBe('update');

    const res = await svc.applyUpdate({
      fileUrl: baseManifestUrl.replace('manifest.json', 'concepts.jsonl'),
      sha256: good.manifest.sha256,
      size: good.manifest.size,
      version: good.manifest.version,
      updated_at: good.manifest.updatedAt,
    });
    expect(res.ok).toBe(true);
    expect(svc.meta().version).toBe('2026.09.28');
    expect(svc.summaries().length).toBe(v2.length);

    // 逐条核对：进度完全保留
    const after = svc.states();
    for (const id of ids) {
      expect(after[id], `${id} 的进度丢了`).toEqual(before[id]);
    }
    expect(svc.favorites()).toEqual(favBefore);

    // 备份确实生成了
    expect(existsSync(join(dir, 'backups'))).toBe(true);
    expect(readdirSync(join(dir, 'backups')).length).toBeGreaterThanOrEqual(1);
  });

  it('⑩ 备份失败时中止更新，不替换内容库（PRD §6.4）', async () => {
    svc = newService(makeFetch(() => ({ reject: 'network' })) as never);
    svc.importContentText(buildJsonl(v1, '2026.09.21', 'x'));
    svc.close();

    const good = manifestFor(v2, '2026.09.28');
    svc = newService(makeFetch(() => ({ body: good.jsonl })) as never);

    // 让备份必然失败：把 user.db 挪走
    const { renameSync, rmSync } = await import('node:fs');
    renameSync(join(dir, 'user.db'), join(dir, 'user.db.hidden'));
    rmSync(join(dir, 'user.db-wal'), { force: true });
    rmSync(join(dir, 'user.db-shm'), { force: true });

    const res = await svc.applyUpdate({
      fileUrl: 'x', sha256: good.manifest.sha256, size: good.manifest.size, version: '2026.09.28', updated_at: 'x',
    });
    expect(res.ok).toBe(false);
    expect(res.ok === false && res.reason).toContain('备份失败');
    expect(svc.meta().version).toBe('2026.09.21');
  });

  it('parseManifest 对缺字段的清单返回 null，而不是抛出', () => {
    expect(parseManifest('{}')).toBeNull();
    expect(parseManifest('null')).toBeNull();
    expect(parseManifest(JSON.stringify({ version: 'v', updatedAt: 'x', sha256: 'short', file: 'f' }))).toBeNull();
    expect(parseManifest(JSON.stringify({ version: 'v', updatedAt: 'x', sha256: 'a'.repeat(64), file: 'f' })))?.toMatchObject({ version: 'v' });
  });

  it('compareVersion 只做字符串比较（架构 §4.8）', () => {
    expect(compareVersion('2026.09.28', '2026.09.21')).toBe(1);
    expect(compareVersion('2026.09.21', '2026.09.28')).toBe(-1);
    expect(compareVersion('v2026.09.21', '2026.09.21')).toBe(0);
    expect(compareVersion('2026.10.01', '2026.09.30')).toBe(1);
  });
});

describe('P6 备份与恢复', () => {
  let dir: string;
  let svc: Services;

  beforeEach(() => {
    dir = tempDir('recall-bak-');
    svc = new Services({ root: dir, appVersion: '1.0.0-test', fetchImpl: makeFetch(() => ({ reject: 'network' })) as never });
    svc.importContentText(buildJsonl(makeGroup(3), '2026.09.21', 'x'));
  });
  afterEach(() => { svc.close(); cleanup(dir); });

  it('导出后导入预览：区分更新 / 更旧 / 孤儿', () => {
    const ids = svc.summaries().map((c) => c.id);
    svc.rate(ids[0], 2, NOW);
    svc.rate(ids[1], 1, NOW);

    const out = join(dir, 'export.json');
    const r = svc.exportUserData(out);
    if (!r.ok) throw new Error('导出失败：' + r.reason);
    expect(r.count).toBe(2);

    const payload = JSON.parse(readFileSync(out, 'utf8')) as { conceptState: { title: string }[] };
    expect(payload.conceptState.every((s) => typeof s.title === 'string')).toBe(true);

    // 自己导入自己：应当都是「相同」
    const pv = svc.previewImportFile(out);
    expect(pv.ok).toBe(true);
    expect(pv.total).toBe(2);
    expect(pv.unchanged + pv.older).toBe(2);
    expect(pv.willUpdate).toBe(0);
  });

  it('导入是合并式：更新的覆盖、更旧的跳过（PRD §6.5）', () => {
    const ids = svc.summaries().map((c) => c.id);
    svc.rate(ids[0], 2, NOW);
    const current = svc.states()[ids[0]];

    const newer = {
      schemaVersion: 1,
      conceptState: [{ conceptId: ids[0], status: 'fuzzy', ease: 1.4, intervalDays: 3, dueAt: '2026-10-01', reps: 2, lapses: 2, lastReview: '2026-12-01T00:00:00Z' }],
      favorites: [], settings: {}, notes: [],
    };
    const p = join(dir, 'newer.json');
    writeFileSync(p, JSON.stringify(newer));
    const applied = svc.applyImportFile(p) as { applied: number; skipped: number };
    expect(applied.applied).toBe(1);
    expect(svc.states()[ids[0]].status).toBe('fuzzy');
    expect(svc.states()[ids[0]].last_review).not.toBe(current.last_review);

    const older = { ...newer, conceptState: [{ ...newer.conceptState[0], lastReview: '2020-01-01T00:00:00Z' }] };
    const p2 = join(dir, 'older.json');
    writeFileSync(p2, JSON.stringify(older));
    const applied2 = svc.applyImportFile(p2) as { applied: number; skipped: number };
    expect(applied2.applied).toBe(0);
    expect(applied2.skipped).toBe(1);
    expect(svc.states()[ids[0]].status).toBe('fuzzy'); // 没被旧数据覆盖
  });

  it('概念已不存在时写成孤儿记录，不报错', () => {
    const p = join(dir, 'orphan.json');
    writeFileSync(p, JSON.stringify({
      schemaVersion: 1,
      conceptState: [{ conceptId: '早就删掉的概念', status: 'known', lastReview: '2026-12-09T00:00:00Z' }],
    }));
    const applied = svc.applyImportFile(p) as { orphans: number };
    expect(applied.orphans).toBe(1);
    expect(svc.states()['早就删掉的概念'].status).toBe('known');
  });

  it('损坏的导入文件被识别，返回明确原因而不是抛异常', () => {
    const p = join(dir, 'broken.json');
    writeFileSync(p, '{不是 JSON');
    const pv = svc.previewImportFile(p);
    expect(pv.ok).toBe(false);

    // 契约：坏文件返回 { ok:false, reason }，让 UI 能显示具体原因；
    // 抛异常会被 IPC 的 safe() 压成一句笼统的错误，用户看不出问题在哪。
    const applied = svc.applyImportFile(p) as { ok: boolean; reason?: string };
    expect(applied.ok).toBe(false);
    expect(applied.reason).toContain('合法 JSON');

    const missing = svc.previewImportFile(join(dir, '不存在.json'));
    expect(missing.ok).toBe(false);
    expect(missing.reason).toContain('文件不存在');

    const missingApply = svc.applyImportFile(join(dir, '不存在.json')) as { ok: boolean; reason?: string };
    expect(missingApply.ok).toBe(false);
    expect(missingApply.reason).toContain('文件不存在');
  });

  it('重置进度必须输入确认文案，且默认保留收藏', () => {
    const ids = svc.summaries().map((c) => c.id);
    svc.rate(ids[0], 2, NOW);
    svc.toggleFavorite(ids[1]);

    expect(svc.resetProgress('随便写的').ok).toBe(false);
    expect(Object.keys(svc.states()).length).toBeGreaterThan(0);

    const r = svc.resetProgress('重置进度', true);
    expect(r.ok).toBe(true);
    expect(svc.states()).toEqual({});
    expect(svc.favorites()).toContain(ids[1]);

    svc.toggleFavorite(ids[2]);
    svc.resetProgress('重置进度', false);
    expect(svc.favorites()).toEqual([]);
  });

  it(`自动备份保留最近 ${BACKUP_KEEP} 份`, async () => {
    const good = manifestFor(makeGroup(3), '2026.10.01');
    for (let i = 0; i < BACKUP_KEEP + 3; i++) {
      await svc.applyUpdate({
        fileUrl: 'x', sha256: good.manifest.sha256, size: good.manifest.size,
        version: `2026.10.${String(i + 1).padStart(2, '0')}`, updated_at: 'x',
      }).catch(() => undefined);
    }
    // 每次 applyUpdate 都先备份一次
    expect(svc.listBackups().length).toBeLessThanOrEqual(BACKUP_KEEP);
  });
});

describe('P6 复习队列', () => {
  let dir: string;
  let svc: Services;

  beforeEach(() => {
    dir = tempDir('recall-q-');
    svc = new Services({ root: dir, appVersion: '1.0.0-test', fetchImpl: makeFetch(() => ({ reject: 'network' })) as never });
    svc.importContentText(buildJsonl(makeGroup(4), '2026.09.21', 'x'));
  });
  afterEach(() => { svc.close(); cleanup(dir); });

  it('只有待复习且到期的才进队列', () => {
    const ids = svc.summaries().map((c) => c.id);
    expect(svc.dueQueue(NOW)).toEqual([]);
    svc.setStatus(ids[0], 'review');
    expect(svc.dueQueue(NOW)).toContain(ids[0]);
    svc.setStatus(ids[0], 'known');
    expect(svc.dueQueue(NOW)).not.toContain(ids[0]);
  });

  it('「不懂」的概念排在最前（PRD §4.3）', () => {
    const ids = svc.summaries().map((c) => c.id);
    svc.setStatus(ids[0], 'review');
    svc.setStatus(ids[3], 'fuzzy');
    const q = svc.dueQueue(NOW);
    expect(q).toContain(ids[0]);
    expect(q[0]).toBe(ids[3]);
  });

  it('概念页点「我掌握了」会清空 due_at，真正移出复习队列', () => {
    const id = svc.summaries()[0].id;
    svc.setStatus(id, 'review');
    expect(svc.dueQueue(NOW)).toContain(id);
    svc.setStatus(id, 'known');
    expect(svc.dueQueue(NOW)).not.toContain(id);
  });

  it('复习评分「记得」保留 due_at，到日子会重新出现（间隔重复成立）', () => {
    const id = svc.summaries()[0].id;
    svc.rate(id, 2, NOW);                       // 间隔 2 天
    expect(svc.dueQueue(NOW)).not.toContain(id);
    expect(svc.dueQueue(new Date('2026-09-23T10:00:00+08:00'))).toContain(id);
  });

  it('未到期的待复习概念不进队列', () => {
    const id = svc.summaries()[0].id;
    svc.setStatus(id, 'review');
    svc.rate(id, 2, NOW);              // 记得 → 2 天后才到期
    expect(svc.dueQueue(NOW)).not.toContain(id);
    expect(svc.dueQueue(new Date('2026-09-25T10:00:00+08:00'))).toContain(id);
  });

  it('评分后状态与到期时间同步更新', () => {
    const id = svc.summaries()[0].id;
    svc.setStatus(id, 'review');
    const s = svc.rate(id, 2, NOW);
    expect(s.status).toBe('known');
    expect(s.due_at).toBe('2026-09-23');
    expect(svc.dueQueue(NOW)).not.toContain(id);
  });
});
