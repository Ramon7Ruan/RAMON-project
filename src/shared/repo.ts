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

export interface VersionCheckInput {
  /** 本次要使用的版本号 */
  version: string;
  /** `content-v{version}` 是否已存在（= 该版本已对外发布过） */
  tagExists: boolean;
  /** 本地 `content-dist/manifest.json` 已有的版本；未知传 null */
  localVersion?: string | null;
}

export type VersionCheck = { ok: true } | { ok: false; reason: string };

/**
 * 内容版本号守卫（架构 §4.8）的判定逻辑。
 *
 * **为什么单独抽成纯函数**：它的判据很容易被写错，而写错之后
 * **不会让任何测试变红** —— 只会让某个完全正常的流程在某一天突然走不通。
 * 真实发生过一次：判据用的是「本地 manifest 的版本」而不是「是否真的发布过」，
 * 于是"先 `build:content` 本地看一眼、确认后再 `publish:content`"这条最谨慎的流程
 * 被自己拦下，而那时**什么都还没发布**。所以它值得被单独测。
 *
 * 环境查询（tag 是否存在、本地已有版本）由调用方传入，本函数不碰文件系统与 git。
 */
export function checkContentVersion(input: VersionCheckInput): VersionCheck {
  const { version, tagExists, localVersion } = input;

  // ① 已发布版本的内容不可变更。
  //    正文走 tag、tag 走长缓存（见 contentUrlFor 的说明），同一 tag 一旦指向不同内容，
  //    缓存过旧内容的客户端会**永远拿不到新数据，而且不报错**。
  //    真正的判据是 tag —— 它才唯一标识一次对外发布。
  if (tagExists) {
    return {
      ok: false,
      reason:
        `版本号必须递增：${version} 对应的 tag ${contentTagForVersion(version)} 已存在（= 已对外发布）。\n` +
        `  已发布版本的内容不可变更 —— 请换一个更高的版本号。\n` +
        `  （若确实需要重发，先删掉该 tag 再重新发布，那是一个显式动作。）`,
    };
  }

  // ② **同版本重建是允许的**：本地重建 ≠ 已发布，没发布过就没人缓存过。
  //    只有**回退**才拒绝 —— 把更新的构建覆盖成旧的没有任何好处。
  if (localVersion && version < localVersion) {
    return {
      ok: false,
      reason: `版本号不能回退：当前 ${version} 小于本地已有的 ${localVersion}`,
    };
  }

  return { ok: true };
}

/** 从 `package.json` 的 `recall` 字段取出已配置的仓库（未配置返回 null） */
export function repoFromPackageJson(pkg: unknown): RepoRef | null {
  const recall = (pkg as { recall?: { contentRepo?: unknown } } | null)?.recall;
  return parseRepoSlug(recall?.contentRepo);
}
