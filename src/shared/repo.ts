/**
 * 内容仓库配置（架构 §4.3）
 *
 * **唯一来源**：`package.json` 的 `recall.contentRepo`，形如 `"owner/repo"`。
 * 放这里的好处是 bash（publish.sh）和 TS（主进程默认设置）都能读同一处，
 * 不会出现"脚本推了 tag，App 却去拉另一个仓库"这种对不上的情况。
 *
 * 为空表示未配置联网更新：此时检查更新一律静默跳过，
 * 手动导入通道不受影响（架构 §4.1 离线优先）。
 */

export interface RepoRef {
  owner: string;
  repo: string;
  /** `owner/repo` */
  slug: string;
}

/** 解析 `owner/repo`；格式不对返回 null 而不是抛异常（配置可能被手工改坏） */
export function parseRepoSlug(slug: unknown): RepoRef | null {
  if (typeof slug !== 'string') return null;
  const trimmed = slug.trim().replace(/^\/+|\/+$/g, '');
  const parts = trimmed.split('/');
  if (parts.length !== 2) return null;
  const [owner, repo] = parts;
  if (!owner || !repo) return null;
  // GitHub 用户名/仓库名只允许字母数字与 . _ -
  if (!/^[\w.-]+$/.test(owner) || !/^[\w.-]+$/.test(repo)) return null;
  return { owner, repo, slug: `${owner}/${repo}` };
}

const CDN = 'https://cdn.jsdelivr.net/gh';

/**
 * 检查更新用的地址：走 `@main`，因为 manifest 是可变的，需要发布后立即能看到新版本。
 * 发布后必须调 jsDelivr purge API 让它生效。
 */
export function manifestUrlFor(ref: RepoRef, branch = 'main'): string {
  return `${CDN}/${ref.slug}@${branch}/content-dist/manifest.json`;
}

/**
 * 下载正文的地址：走 **tag**，因为正文不可变，可以用长缓存换稳定与速度。
 * 两个文件走不同路径是为了避免"v2 的 manifest 配 v1 的正文"这种版本撕裂。
 */
export function contentUrlFor(ref: RepoRef, contentTag: string): string {
  return `${CDN}/${ref.slug}@${contentTag}/content-dist/concepts.jsonl`;
}

/** 内容版本号对应的 git tag（架构 §4.8），如 2026.09.28 → content-v2026.09.28 */
export function contentTagForVersion(version: string): string {
  return `content-v${version}`;
}

/** 从 `package.json` 的 `recall` 字段取出已配置的仓库（未配置返回 null） */
export function repoFromPackageJson(pkg: unknown): RepoRef | null {
  const recall = (pkg as { recall?: { contentRepo?: unknown } } | null)?.recall;
  return parseRepoSlug(recall?.contentRepo);
}
