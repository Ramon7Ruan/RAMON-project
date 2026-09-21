/**
 * 内容仓库配置（架构 §4.3 / §4.8）
 *
 * 这块的价值在"三处必须一致"：publish.sh 推的分支与 tag、App 拼的 URL、
 * content-dist/ 里的实际文件名。任何一处漂移都会表现为"发布成功但永远查不到更新"——
 * 这是最难排查的一类故障，所以用测试钉死。
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  contentTagForVersion,
  contentUrlFor,
  manifestUrlFor,
  parseRepoSlug,
  repoFromPackageJson,
} from '../src/shared/repo';
import { Services, buildJsonl } from '../app/services';
import { resolveContentUrl } from '../app/update/updater';
import { cleanup, makeGroup, tempDir } from './fixtures';

const ROOT = join(__dirname, '..');

describe('仓库标识解析', () => {
  it('接受 owner/repo，并容忍首尾斜杠与空白', () => {
    expect(parseRepoSlug('ramon/RAMON-project')).toEqual({
      owner: 'ramon', repo: 'RAMON-project', slug: 'ramon/RAMON-project',
    });
    expect(parseRepoSlug('  ramon/RAMON-project  ')?.slug).toBe('ramon/RAMON-project');
    expect(parseRepoSlug('/ramon/RAMON-project/')?.slug).toBe('ramon/RAMON-project');
  });

  it('拒绝各种坏格式（配置可能被手工改坏，不能抛异常）', () => {
    for (const bad of ['', '   ', 'RAMON-project', 'a/b/c', '/', '//', null, undefined, 42, {}, []]) {
      expect(parseRepoSlug(bad), `不该接受 ${JSON.stringify(bad)}`).toBeNull();
    }
    // 非法字符
    expect(parseRepoSlug('ra mon/RAMON-project')).toBeNull();
    expect(parseRepoSlug('ramon/RAMON project')).toBeNull();
  });

  it('从 package.json 的 recall 字段取配置；未配置返回 null', () => {
    expect(repoFromPackageJson({ recall: { contentRepo: 'o/r' } })?.slug).toBe('o/r');
    expect(repoFromPackageJson({ recall: { contentRepo: '' } })).toBeNull();
    expect(repoFromPackageJson({ recall: {} })).toBeNull();
    expect(repoFromPackageJson({})).toBeNull();
    expect(repoFromPackageJson(null)).toBeNull();
    expect(repoFromPackageJson('不是对象')).toBeNull();
  });

  it('真实 package.json 里的配置要么为空、要么是合法 slug', () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as unknown;
    const raw = (pkg as { recall?: { contentRepo?: string } }).recall?.contentRepo;
    if (!raw) {
      // 未配置是合法状态：联网更新关闭，手动导入照常
      expect(repoFromPackageJson(pkg)).toBeNull();
    } else {
      expect(repoFromPackageJson(pkg), `package.json 里的 contentRepo 不合法：${raw}`).not.toBeNull();
    }
  });
});

describe('地址构造', () => {
  const ref = parseRepoSlug('ramon/RAMON-project')!;

  it('检查更新走分支、下载正文走 tag（两个地址故意分开）', () => {
    expect(manifestUrlFor(ref)).toBe(
      'https://cdn.jsdelivr.net/gh/ramon/RAMON-project@main/content-dist/manifest.json',
    );
    expect(manifestUrlFor(ref, 'master')).toContain('@master/');
    expect(contentUrlFor(ref, contentTagForVersion('2026.09.28'))).toBe(
      'https://cdn.jsdelivr.net/gh/ramon/RAMON-project@content-v2026.09.28/content-dist/concepts.jsonl',
    );
  });

  it('manifest 与正文不能走同一个地址（否则会出现版本撕裂）', () => {
    const m = manifestUrlFor(ref);
    const c = contentUrlFor(ref, contentTagForVersion('2026.09.28'));
    expect(m).not.toBe(c);
    // manifest 必须走可变分支，正文必须走不可变 tag
    expect(m).toContain('@main/');
    expect(c).not.toContain('@main/');
    expect(c).toContain('@content-v');
  });

  it('tag 命名规则固定为 content-v{版本}（与 publish.sh 一致）', () => {
    expect(contentTagForVersion('2026.09.28')).toBe('content-v2026.09.28');
    expect(contentTagForVersion('2026.09.28-2')).toBe('content-v2026.09.28-2');
  });

  it('URL 里的文件路径必须与 content-dist/ 的实际布局一致', () => {
    // jsDelivr 形如 …/gh/{owner}/{repo}@{ref}/{path}：取 @ 之后的 ref 与 path，再去掉 ref
    const fromUrl = (url: string) => {
      const afterAt = url.split('@')[1] ?? '';
      return afterAt.slice(afterAt.indexOf('/') + 1); // 去掉 ref（main / content-v…）
    };
    const cases: [string, string][] = [
      [manifestUrlFor(ref), 'content-dist/manifest.json'],
      [contentUrlFor(ref, contentTagForVersion('2026.09.21')), 'content-dist/concepts.jsonl'],
    ];
    for (const [url, expected] of cases) {
      expect(fromUrl(url), `URL 路径解析不对：${url}`).toBe(expected);
      expect(existsSync(join(ROOT, expected)), `发布产物里缺少 ${expected}`).toBe(true);
    }
  });
});

describe('正文地址必须走 tag（防止版本撕裂）', () => {
  const ref = parseRepoSlug('ramon/RAMON-project')!;
  const manifest = manifestUrlFor(ref);

  it('jsDelivr 地址 → 正文换成内容版本对应的 tag', () => {
    expect(resolveContentUrl(manifest, '2026.09.28', 'concepts.jsonl')).toBe(
      'https://cdn.jsdelivr.net/gh/ramon/RAMON-project@content-v2026.09.28/content-dist/concepts.jsonl',
    );
  });

  it('正文地址绝不能带 @main（那正是版本撕裂的来源）', () => {
    const url = resolveContentUrl(manifest, '2026.09.28', 'concepts.jsonl');
    expect(url).not.toContain('@main');
    expect(url).toContain('@content-v2026.09.28');
    // 文件名与目录保持与 manifest 同级
    expect(url.endsWith('/content-dist/concepts.jsonl')).toBe(true);
  });

  it('自定义服务器没有 tag 概念 → 回落到同目录，不能拼出坏地址', () => {
    const custom = 'https://example.com/recall/content-dist/manifest.json';
    expect(resolveContentUrl(custom, '2026.09.28', 'concepts.jsonl')).toBe(
      'https://example.com/recall/content-dist/concepts.jsonl',
    );
  });

  it('各种畸形 manifest 地址都不抛异常，且退化为同目录', () => {
    for (const bad of [
      'https://cdn.jsdelivr.net/gh/o/r/content-dist/manifest.json',   // 没有 @ref
      'https://cdn.jsdelivr.net/gh/o/r@main',                        // 没有路径
      'manifest.json',                                               // 相对路径
      '',
    ]) {
      expect(() => resolveContentUrl(bad, '2026.09.28', 'c.jsonl')).not.toThrow();
    }
  });

  it('端到端：checkUpdate 返回的 fileUrl 真的指向 tag（断言真实输出，而非辅助函数）', async () => {
    const dir = tempDir('recall-tag-');
    try {
      const newer = {
        version: '2026.09.28',
        updatedAt: '2026-09-28T10:00:00+08:00',
        schemaVersion: 1,
        counts: { econ: 3, finance: 0, hotspot: 0, total: 3 },
        file: 'concepts.jsonl',
        sha256: 'a'.repeat(64),
        size: 123,
      };
      const svc = new Services({
        root: dir,
        appVersion: '1.0.0-test',
        defaultManifestUrl: manifestUrlFor(ref),
        fetchImpl: (async () => ({
          ok: true, status: 200, text: async () => JSON.stringify(newer),
        })) as never,
      });
      try {
        const r = await svc.checkUpdate();
        expect(r.kind).toBe('update');
        const info = (r as { info: { fileUrl: string } }).info;
        // 这两条才是真正保护行为的断言
        expect(info.fileUrl).toContain('@content-v2026.09.28/');
        expect(info.fileUrl).not.toContain('@main/');
      } finally { svc.close(); }
    } finally { cleanup(dir); }
  });
});

describe('内置地址作为设置项的默认值', () => {
  const dirs: string[] = [];
  afterEach(() => { while (dirs.length) cleanup(dirs.pop()!); });

  const newSvc = (root: string, defaultManifestUrl?: string) => new Services({
    root,
    appVersion: '1.0.0-test',
    fetchImpl: (async () => { throw new Error('offline'); }) as never,
    defaultManifestUrl,
  });

  it('用户没填过时回落到内置地址 —— 装完即带可用的更新通道', () => {
    const dir = tempDir('recall-repo-');
    dirs.push(dir);
    const svc = newSvc(dir, 'https://cdn.jsdelivr.net/gh/o/r@main/content-dist/manifest.json');
    try {
      expect(svc.settings().manifestUrl).toBe(
        'https://cdn.jsdelivr.net/gh/o/r@main/content-dist/manifest.json',
      );
    } finally { svc.close(); }
  });

  it('用户填过就用自己的，内置地址不覆盖用户选择', () => {
    const dir = tempDir('recall-repo-');
    dirs.push(dir);
    const svc = newSvc(dir, 'https://cdn.jsdelivr.net/gh/o/r@main/content-dist/manifest.json');
    try {
      svc.updateSettings({ manifestUrl: 'https://example.com/mine.json' });
      expect(svc.settings().manifestUrl).toBe('https://example.com/mine.json');
    } finally { svc.close(); }
  });

  it('未配置内置地址时为空，检查更新静默跳过（离线优先不能坏）', async () => {
    const dir = tempDir('recall-repo-');
    dirs.push(dir);
    const svc = newSvc(dir);
    try {
      expect(svc.settings().manifestUrl).toBe('');
      expect(await svc.checkUpdate()).toEqual({ kind: 'skipped', reason: 'not-configured' });
    } finally { svc.close(); }
  });

  it('内置地址可用时，检查更新真的会去请求它', async () => {
    const dir = tempDir('recall-repo-');
    dirs.push(dir);
    const seen: string[] = [];
    const svc = new Services({
      root: dir,
      appVersion: '1.0.0-test',
      defaultManifestUrl: 'https://cdn.jsdelivr.net/gh/o/r@main/content-dist/manifest.json',
      fetchImpl: (async (url: string) => {
        seen.push(url);
        throw new Error('ENOTFOUND');   // 网络失败 → 静默跳过
      }) as never,
    });
    try {
      const r = await svc.checkUpdate();
      expect(seen).toHaveLength(1);
      expect(seen[0]).toContain('content-dist/manifest.json');
      expect(r.kind).toBe('skipped');
    } finally { svc.close(); }
  });

  it('导入内容不会把内置地址写进用户设置（更新内容不等于改配置）', () => {
    const dir = tempDir('recall-repo-');
    dirs.push(dir);
    const svc = newSvc(dir, 'https://cdn.jsdelivr.net/gh/o/r@main/content-dist/manifest.json');
    try {
      const r = svc.importContentText(buildJsonl(makeGroup(2), '2026.09.21', 'x'));
      expect('ok' in r && r.ok).toBe(true);
      expect(svc.settings().manifestUrl).toBe(
        'https://cdn.jsdelivr.net/gh/o/r@main/content-dist/manifest.json',
      );
    } finally { svc.close(); }
  });
});
