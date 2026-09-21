/**
 * 首启内置内容（app/content/seed.ts）
 *
 * 这条链路是「离线装完即有内容」的关键：打包产物里带一份 concepts.jsonl，
 * 首启内容库为空时导入。两个必须守住的性质：
 *   ① 内容库非空时**绝不**导入内置内容（否则会覆盖用户更新过或自己导入的内容）
 *   ② 内置内容走与手动导入完全相同的校验管道，坏内容导不进来也不拦住启动
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Concept } from '../src/shared/types';
import { Services, buildJsonl } from '../app/services';
import { ensureSeedContent, seedCandidates } from '../app/content/seed';
import { cleanup, makeGroup, tempDir } from './fixtures';

const dirs: string[] = [];
function newDir(tag: string): string {
  const d = tempDir(`recall-seed-${tag}-`);
  dirs.push(d);
  return d;
}
afterEach(() => {
  while (dirs.length) cleanup(dirs.pop()!);
});

function newService(root: string): Services {
  return new Services({
    root,
    appVersion: '1.0.0-test',
    fetchImpl: (async () => {
      throw new Error('ENOTFOUND');
    }) as never,
  });
}

function writeSeed(dir: string, concepts: Concept[]): string {
  const p = join(dir, 'concepts.jsonl');
  writeFileSync(p, buildJsonl(concepts, '2026.09.21', '2026-09-21T10:00:00+08:00'), 'utf8');
  return p;
}

describe('首启内置内容', () => {
  it('内容库为空时导入内置内容，且全部概念可读', () => {
    const dir = newDir('empty');
    const seedPath = writeSeed(dir, makeGroup(5));
    const svc = newService(dir);
    try {
      expect(svc.meta().counts.total).toBe(0); // 全新库确实是空的

      const r = ensureSeedContent(svc, [seedPath]);
      expect(r.imported).toBe(true);
      expect(r.count).toBe(5);
      expect(r.version).toBe('2026.09.21');

      expect(svc.summaries().length).toBe(5);
      expect(svc.concept(svc.summaries()[0].id)).not.toBeNull();
      expect(svc.meta().version).toBe('2026.09.21');
    } finally {
      svc.close();
    }
  });

  it('内容库非空时不导入 —— 绝不覆盖用户已有内容', () => {
    const dir = newDir('nonempty');
    const svc = newService(dir);
    try {
      const own = makeGroup(3);
      const own0 = svc.importContentText(buildJsonl(own, '2026.09.30', 'x'));
      expect('ok' in own0 && own0.ok).toBe(true);
      const before = svc.meta().version;

      const seedPath = writeSeed(dir, makeGroup(5));
      const r = ensureSeedContent(svc, [seedPath]);

      expect(r.imported).toBe(false);
      expect(r.reason).toContain('非空');
      // 内容与版本都没被动过
      expect(svc.meta().version).toBe(before);
      expect(svc.summaries().length).toBe(3);
    } finally {
      svc.close();
    }
  });

  it('找不到内置文件时安静跳过，不抛异常', () => {
    const dir = newDir('missing');
    const svc = newService(dir);
    try {
      const r = ensureSeedContent(svc, [join(dir, 'nope.jsonl')]);
      expect(r).toEqual({ imported: false, reason: '未找到内置内容文件' });
      expect(svc.summaries().length).toBe(0);
    } finally {
      svc.close();
    }
  });

  it('内置文件损坏时跳过且应用仍可用（不能拦住启动）', () => {
    const dir = newDir('broken');
    const bad = join(dir, 'bad.jsonl');
    writeFileSync(bad, '{这不是 JSONL\n', 'utf8');
    const svc = newService(dir);
    try {
      const r = ensureSeedContent(svc, [bad]);
      expect(r.imported).toBe(false);
      expect(r.reason).toBeTruthy();
      // 关键：库仍可用，后续导入照常
      const ok = svc.importContentText(buildJsonl(makeGroup(2), '2026.09.21', 'x'));
      expect('ok' in ok && ok.ok).toBe(true);
      expect(svc.summaries().length).toBe(2);
    } finally {
      svc.close();
    }
  });

  it('内置内容同样要过门禁（不能借内置之名绕过校验）', () => {
    const dir = newDir('gate');
    // 造一份违规内容：热点概念缺 timeline 与 source
    const bad: Concept[] = [
      {
        ...makeGroup(1)[0],
        id: 'hotspot.event.bad', domain: 'hotspot', track: 'event',
        source: undefined,
        blocks: [{ type: 'prose', label: 'x', body: 'y' } as never],
        recipe: ['prose'],
      },
    ];
    const p = join(dir, 'bad-gate.jsonl');
    writeFileSync(p, buildJsonl(bad, '2026.09.21', 'x'), 'utf8');
    const svc = newService(dir);
    try {
      const r = ensureSeedContent(svc, [p]);
      expect(r.imported).toBe(false);
      expect(svc.meta().counts.total).toBe(0);
    } finally {
      svc.close();
    }
  });

  it('seedCandidates 按运行形态给出候选路径（打包 / 本地 / 编译产物）', () => {
    // moduleDir 归一化后与 appPath 重合 → 去重
    expect(seedCandidates({
      resourcesPath: '/App/Contents/Resources',
      appPath: '/proj',
      moduleDir: '/proj/dist-electron/app',
    })).toEqual([
      '/App/Contents/Resources/content-dist/concepts.jsonl',
      '/proj/content-dist/concepts.jsonl',
    ]);

    // 三种形态落在不同位置时，三条都在（顺序即优先级）
    expect(seedCandidates({
      resourcesPath: '/App/Contents/Resources',
      appPath: '/other',
      moduleDir: '/proj/dist-electron/app',
    })).toEqual([
      '/App/Contents/Resources/content-dist/concepts.jsonl',
      '/other/content-dist/concepts.jsonl',
      '/proj/content-dist/concepts.jsonl',
    ]);

    // 不传任何路径时不产生空字符串路径
    expect(seedCandidates()).toEqual([]);
  });

  it('内容库为空时优先使用第一个存在的候选路径', () => {
    const dir = newDir('order');
    const good = writeSeed(dir, makeGroup(4));
    const svc = newService(dir);
    try {
      const r = ensureSeedContent(svc, [join(dir, '不存在.jsonl'), good]);
      expect(r.imported).toBe(true);
      expect(r.count).toBe(4);
      expect(r.path).toBe(good);
    } finally {
      svc.close();
    }
  });
});
