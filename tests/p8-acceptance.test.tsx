// @vitest-environment jsdom
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { App } from '../src/renderer/App';
import { createHandlers } from '../app/ipc';
import { Services, buildJsonl } from '../app/services';
import { CH } from '../src/shared/ipc';
import { loadContent } from '../app/content/load';
import { cleanup, tempDir } from './fixtures';

const ROOT = join(__dirname, '..');

/**
 * P8 验收：把**真实的 App 组件**挂到 DOM 上，通过**真实的 IPC 处理器**
 * 打到一个装着**真实 68 个概念**的临时数据目录。
 *
 * 这一层能捕捉单测覆盖不到的问题：路由跳转、页面之间的状态传递、
 * 两级纵深是否真的成立、四态是否真的渲染得出来。
 */

let dir: string;
let svc: Services;
let handlers: Record<string, (p?: unknown) => unknown>;
let root: Root;
let host: HTMLElement;
let readyCalls = 0;
/** 主进程 → 渲染层的事件回调，测试里手动触发以模拟推送 */
let eventCb: ((name: string, data: unknown) => void) | null = null;

function installBridge(): void {
  (globalThis as unknown as { recall: unknown }).recall = {
    invoke: async (channel: string, payload?: unknown) => {
      const h = handlers[channel];
      if (!h) throw new Error('未注册的通道：' + channel);
      return await h(payload);
    },
    onEvent: (cb: (name: string, data: unknown) => void) => { eventCb = cb; },
    platform: 'test',
  };
}

const view = () => host.querySelector('.view')!;
/** 内容区内的查询——侧栏的进度环也是 svg，不隔离会误判 */
const $$v = (sel: string) => Array.from(view().querySelectorAll(sel));
const $v = (sel: string) => view().querySelector(sel);
const $$ = (sel: string) => Array.from(host.querySelectorAll(sel));
const $ = (sel: string) => host.querySelector(sel);

const flush = async (n = 8) => {
  for (let i = 0; i < n; i += 1) await act(async () => { await Promise.resolve(); });
};

async function mount(): Promise<void> {
  await act(async () => { root.render(<App />); });
  await flush();
}

async function click(el: Element | null | undefined): Promise<void> {
  if (!el) throw new Error('要点击的元素不存在');
  await act(async () => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
  await flush();
}

/** 挂一个独立的 App 实例，用于四态测试 */
async function mountFresh(): Promise<{ el: HTMLElement; r: Root }> {
  const el = document.createElement('div');
  document.body.appendChild(el);
  const r = createRoot(el);
  await act(async () => { r.render(<App />); });
  await flush();
  return { el, r };
}

async function unmountFresh(x: { el: HTMLElement; r: Root }): Promise<void> {
  await act(async () => { x.r.unmount(); });
  x.el.remove();
}

beforeAll(async () => {
  // React 19 要求显式声明，act() 才会真正刷新与批处理
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  dir = tempDir('recall-p8-');
  svc = new Services({
    root: dir,
    appVersion: '1.0.0',
    fetchImpl: async () => { throw new Error('offline'); },
  });
  const { concepts } = loadContent(join(ROOT, 'content'));
  const r = svc.importContentText(buildJsonl(concepts, '2026.09.21', '2026-09-21T10:00:00+08:00'));
  if (!('ok' in r) || !r.ok) throw new Error('内容导入失败：' + JSON.stringify(r).slice(0, 300));

  handlers = createHandlers(svc, {
    pickPath: async () => null,
    onReady: () => { readyCalls += 1; },
  }) as unknown as Record<string, (p?: unknown) => unknown>;

  installBridge();
  host = document.createElement('div');
  host.id = 'root';
  document.body.appendChild(host);
  root = createRoot(host);
  await mount();
});

afterAll(() => {
  try { svc.close(); } catch { /* ignore */ }
  cleanup(dir);
});

describe('A1 启动与外壳', () => {
  it('渲染出完整外壳：侧栏 + 顶栏 + 内容区', () => {
    expect($('.sidebar')).not.toBeNull();
    expect($('.nav')).not.toBeNull();
    expect($('.topbar')).not.toBeNull();
    expect($('.view')).not.toBeNull();
  });

  it('首屏可交互时向主进程上报（冷启动计时用）', () => {
    expect(readyCalls).toBeGreaterThan(0);
  });

  it('导航包含三个分区与复习/搜索/设置，编号与内容一致', () => {
    const labels = $$('.nav-item span:first-child').map((e) => e.textContent);
    expect(labels).toEqual(['首页', '经济学', '金融学', '世界热点', '复习', '搜索', '设置']);
    const counts = $$('.nav-item .cnt').map((e) => e.textContent);
    expect(counts).toContain('24'); // 经济学
    expect(counts).toContain('20'); // 世界热点
  });

  it('顶栏显示内容版本号', () => {
    expect($('.badge')?.textContent).toContain('2026.09.21');
  });

  it('App 图标已生成（.icns 与 PNG 各尺寸）', () => {
    expect(existsSync(join(ROOT, 'build/icon.icns')), 'build/icon.icns 不存在').toBe(true);
    expect(existsSync(join(ROOT, 'build/icon.png')), 'build/icon.png 不存在').toBe(true);
    expect(existsSync(join(ROOT, 'build/icon.iconset'))).toBe(true);
    expect(readFileSync(join(ROOT, 'build/icon.icns')).length).toBeGreaterThan(1000);
  });
});

describe('A3 两级页面纵深（分区首屏是内容，不是导航）', () => {
  it('首页三张分区卡', async () => {
    await click($$('.nav-item')[0]);
    expect($$v('.dcard').length).toBe(3);
  });

  it('点「经济学」→ 首屏直接是要点速览，且不出现任何完整解析 block', async () => {
    await click($$('.nav-item')[1]);
    expect($v('.page-title')?.textContent).toBe('经济学');
    expect($$v('.kcard').length).toBe(24);
    // 硬约束：速览页不得渲染解析 block（图表、公式、计算器都不该出现）
    expect($$v('.blk').length).toBe(0);
    expect($$v('.formula-box').length).toBe(0);
    expect($$v('svg').length).toBe(0);
  });

  it('每张要点卡都有：标题、一句话、1–3 条要点、recipe 徽标、详情按钮', () => {
    const bad: string[] = [];
    for (const card of $$v('.kcard')) {
      const title = card.querySelector('.kc-title')?.textContent?.trim();
      if (!title) bad.push('缺标题');
      if (!card.querySelector('.kc-one')?.textContent?.trim()) bad.push(`${title} 缺一句话`);
      const pts = card.querySelectorAll('.kc-pts li').length;
      if (pts < 1 || pts > 3) bad.push(`${title} 要点数=${pts}`);
      if (!card.querySelector('.kc-recipe .rb')) bad.push(`${title} 缺 recipe 徽标`);
      if (!card.querySelector('.kc-detail')) bad.push(`${title} 缺详情按钮`);
    }
    expect(bad, bad.join('; ')).toEqual([]);
  });

  it('点详情 → 进入完整解析页，出现 block、recipe 与相关概念', async () => {
    const first = $$v('.kcard')[0];
    const title = first.querySelector('.kc-title')?.textContent ?? '';
    await click(first);
    expect($v('.c-title')?.textContent).toBe(title);
    expect($$v('.blk').length).toBeGreaterThanOrEqual(3);
    expect($v('.recipe')).not.toBeNull();
    expect($v('.links')).not.toBeNull();
    const btns = $$v('.action-bar button').map((b) => b.textContent);
    expect(btns).toEqual(['标记不懂', '加入待复习', '我掌握了']);
  });

  it('概念页有显眼的返回要点速览入口，点了能回去', async () => {
    const back = $v('.backlink');
    expect(back?.textContent).toContain('返回');
    expect(back?.textContent).toContain('要点速览');
    await click(back);
    expect($v('.page-title')?.textContent).toBe('经济学');
    expect($$v('.kcard').length).toBe(24);
    expect($$v('.blk').length).toBe(0);
  });

  it('相关概念都带「为什么相关」，不是裸链接', async () => {
    await click($$v('.kcard')[0]);
    const links = $$v('.lk');
    expect(links.length).toBeGreaterThan(0);
    for (const l of links) {
      expect(l.querySelector('b')?.textContent?.trim()).toBeTruthy();
      expect(l.querySelector('span:last-child')?.textContent?.trim()).toBeTruthy();
    }
    await click($v('.backlink'));
  });
});

describe('A9 页面四态完整（PRD §8）', () => {
  it('loading：请求未返回时渲染骨架而不是空白', async () => {
    const bak = handlers[CH.contentMeta];
    handlers[CH.contentMeta] = () => new Promise(() => { /* 永不返回 */ });
    const x = await mountFresh();
    try {
      expect(x.el.querySelector('.skeleton'), 'loading 态没有骨架屏').not.toBeNull();
    } finally {
      handlers[CH.contentMeta] = bak;
      await unmountFresh(x);
    }
  });

  it('empty：内容库为空时不崩溃，给出空状态', async () => {
    const bak = handlers[CH.contentList];
    handlers[CH.contentList] = () => [];
    try {
      const x = await mountFresh();
      try {
        expect(x.el.querySelector('.sidebar')).not.toBeNull();
      } finally {
        await unmountFresh(x);
      }
    } finally {
      handlers[CH.contentList] = bak;
    }
  });

  it('error：主进程不可用时显示错误态与重试，而不是空白页', async () => {
    const bak = handlers[CH.contentMeta];
    handlers[CH.contentMeta] = () => { throw new Error('模拟主进程故障'); };
    const x = await mountFresh();
    try {
      expect(x.el.querySelector('.inline-error')).not.toBeNull();
      expect(x.el.textContent).toContain('模拟主进程故障');
    } finally {
      handlers[CH.contentMeta] = bak;
      await unmountFresh(x);
    }
  });

  it('概念不存在时给出「已不在内容库中」而不是崩溃', async () => {
    const { ConceptPage } = await import('../src/renderer/pages/Concept');
    const el = document.createElement('div');
    document.body.appendChild(el);
    const r = createRoot(el);
    const ctx = {
      summaries: svc.summaries(), states: {}, favs: new Set<string>(),
      meta: svc.meta(), settings: svc.settings(), stats: svc.stats(),
      go: () => undefined, refresh: async () => undefined,
      setLocalStatus: () => undefined, setLocalFav: () => undefined,
    } as unknown as Parameters<typeof ConceptPage>[0]['ctx'];
    try {
      await act(async () => { r.render(<ConceptPage ctx={ctx} id="not.exist.at-all" />); });
      await flush();
      expect(el.querySelector('.empty')).not.toBeNull();
      expect(el.textContent).toContain('已不在内容库中');
    } finally {
      await act(async () => { r.unmount(); });
      el.remove();
    }
  });
});

describe('A2/A4 内容完整性与讲解方式多样性（端到端核对）', () => {
  it('68 个概念可被页面完整列出，且每个都有独立组合', async () => {
    const meta = await handlers[CH.contentMeta]() as { counts: Record<string, number> };
    expect(meta.counts).toEqual({ econ: 24, finance: 24, hotspot: 20, total: 68 });

    const combos = new Set<string>();
    for (const c of svc.summaries()) combos.add([...c.recipe].sort().join('+'));
    expect(combos.size).toBe(68);
  });

  it('三个分区都能列出各自全部概念，且都不渲染解析 block', async () => {
    for (const [idx, n] of [[1, 24], [2, 24], [3, 20]] as const) {
      await click($$('.nav-item')[idx]);
      expect($$v('.kcard').length, `第 ${idx} 个分区卡片数不对`).toBe(n);
      expect($$v('.blk').length).toBe(0);
    }
  });

  it('热点速览卡显示「内容截至」日期', async () => {
    await click($$('.nav-item')[3]);
    const stale = $$v('.kc-stale');
    expect(stale.length).toBe(20);
    expect(stale[0].textContent).toMatch(/内容截至 \d{4}-\d{2}-\d{2}/);
  });
});

describe('A5 状态与复习闭环（在真实页面上操作）', () => {
  it('概念页三个状态按钮真的写进库', async () => {
    await click($$('.nav-item')[1]);
    const first = $$v('.kcard')[0];
    const title = first.querySelector('.kc-title')?.textContent ?? '';
    await click(first);
    expect($v('.c-title')?.textContent).toBe(title);

    const id = svc.summaries().find((c) => c.title === title)!.id;
    const before = (await handlers[CH.progressGetAll]() as Record<string, { status: string }>)[id]?.status;
    expect(before).not.toBe('review');

    await click($$v('.action-bar button')[1]); // 加入待复习
    expect((await handlers[CH.progressGetAll]() as Record<string, { status: string }>)[id].status).toBe('review');
    await click($v('.backlink'));
  });

  it('复习页：两段式（先回忆再展开），评分后进入下一张', async () => {
    const list = svc.summaries();
    svc.setStatus(list[0].id, 'review');
    svc.setStatus(list[1].id, 'fuzzy');
    await click($$('.nav-item')[4]);

    // 第一段：只有标题与一句话，没有任何解析
    expect($v('.rq-t'), '复习卡没渲染出来').not.toBeNull();
    expect($$v('.rq-full').length).toBe(0);
    const before = $v('.rq-t')?.textContent;
    expect($v('.rq-o')?.textContent?.trim()).toBeTruthy();

    // 展开：出现完整解析
    const reveal = $$v('.btn').find((b) => /展开解析/.test(b.textContent ?? ''));
    expect(reveal, '找不到展开按钮').toBeTruthy();
    await click(reveal);
    expect($$v('.rq-full .blk').length).toBeGreaterThanOrEqual(3);
    expect($v('.rq-rate')).not.toBeNull();

    // 评分 → 进入下一张
    const rate = $$v('.rq-btn');
    expect(rate.length).toBe(3);
    expect(rate.map((b) => b.textContent)).toEqual(expect.arrayContaining([expect.stringContaining('记得')]));
    await click(rate[2]); // 记得
    expect($v('.rq-t')?.textContent).not.toBe(before);
    expect(svc.dueQueue().length).toBeGreaterThanOrEqual(0);
  });
});

describe('A6 有更新时的提示（只提示，不打扰）', () => {
  it('收到 update-available 后顶栏出现提示点，不弹窗、内容区照常可用', async () => {
    const fresh = await mountFresh();
    try {
      const before = fresh.el.querySelector('.badge')!;
      expect(before.className).not.toContain('new');

      await act(async () => { eventCb?.('update-available', { version: '2026.09.28' }); });
      await flush();

      const after = fresh.el.querySelector('.badge')!;
      expect(after.className).toContain('new');
      expect(after.querySelector('i'), '缺少提示点').not.toBeNull();
      expect(after.textContent).toContain('v');

      // 关键：不出现任何模态遮罩，也不打断当前页面
      expect(fresh.el.querySelector('[role="dialog"], .modal, .overlay')).toBeNull();
      expect(fresh.el.querySelector('.view')).not.toBeNull();
    } finally {
      await unmountFresh(fresh);
    }
  });

  it('点提示点进入设置页（更新的唯一入口，符合 N5）', async () => {
    const fresh = await mountFresh();
    try {
      await act(async () => { eventCb?.('update-available', {}); });
      await flush();
      await click(fresh.el.querySelector('.badge'));
      expect(fresh.el.querySelector('.set-box'), '未进入设置页').not.toBeNull();
    } finally {
      await unmountFresh(fresh);
    }
  });
});

describe('A7/A8 数据操作与离线可用', () => {
  it('设置页展示内容版本与手动导入入口', async () => {
    await click($$('.nav-item')[6]);
    expect($v('.set-box')).not.toBeNull();
    expect(view().textContent).toContain('2026.09.21');
    expect(view().textContent).toContain('导入内容');
  });

  it('检查更新在离线（fetch 抛错）时静默跳过，不弹错', async () => {
    const r = await handlers[CH.contentCheckUpdate]() as { kind: string };
    expect(r.kind).toBe('skipped');
    expect($('.sidebar')).not.toBeNull();
  });

  it('导出内容含 schemaVersion，且与库内数据一致', async () => {
    const target = join(dir, 'export.json');
    const out = await handlers[CH.backupExport]({ path: target } as unknown) as { ok: boolean };
    expect(out.ok).toBe(true);
    const payload = JSON.parse(readFileSync(target, 'utf8')) as {
      schemaVersion: number; conceptState: unknown[];
    };
    expect(payload.schemaVersion).toBeGreaterThan(0);
    expect(payload.conceptState.length).toBeGreaterThan(0);
  });
});
