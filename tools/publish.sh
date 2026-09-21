#!/usr/bin/env bash
# 发布内容：门禁 → 打包 → 提交 → 打 tag → 让 jsDelivr 立即刷新 manifest
#
# 用法：npm run publish:content -- 2026.09.28
# 不带版本号时用当天日期。
#
# 仓库地址的唯一来源是 package.json 的 recall.contentRepo（形如 owner/repo），
# 与 App 运行时读的是同一处，避免"脚本推了 tag、App 去拉另一个仓库"。
set -euo pipefail
cd "$(dirname "$0")/.."

VERSION="${1:-$(date +%Y.%m.%d)}"
TAG="content-v${VERSION}"   # 必须与 src/shared/repo.ts 的 contentTagForVersion 一致

REPO_SLUG="$(node -p "require('./package.json').recall?.contentRepo || ''" 2>/dev/null || echo '')"
BRANCH="$(node -p "require('./package.json').recall?.contentBranch || 'main'" 2>/dev/null || echo 'main')"

if [ -z "$REPO_SLUG" ]; then
  echo "✗ package.json 里没有配置 recall.contentRepo（形如 owner/repo）"
  echo "  未配置时 App 的联网更新是关闭的（手动导入通道不受影响）。"
  exit 1
fi
echo "内容仓库：${REPO_SLUG}（分支 ${BRANCH}）"

echo
echo "== 1/6 内容门禁 =="
npx tsx tools/validate-content.ts

echo
echo "== 2/6 打包 =="
npx tsx tools/build-package.ts "$VERSION"

echo
echo "== 3/6 确认 git 仓库就绪 =="
if [ ! -d .git ]; then
  echo "  当前不是 git 仓库，先初始化"
  git init -q
fi
if ! git remote get-url origin >/dev/null 2>&1; then
  echo "  添加 origin → https://github.com/${REPO_SLUG}.git"
  git remote add origin "https://github.com/${REPO_SLUG}.git"
fi
git remote get-url origin

echo
echo "== 4/6 提交 =="
git add content content-dist package.json
if git diff --cached --quiet; then
  echo "  内容无变化，仍继续打 tag"
else
  git commit -m "content: ${VERSION}"
fi

echo
echo "== 5/6 推送并打 tag =="
# manifest 走 @branch，所以分支必须推；正文走 @tag，所以 tag 必须存在。
git push -u origin "HEAD:${BRANCH}"
if git rev-parse -q --verify "refs/tags/${TAG}" >/dev/null; then
  echo "  tag ${TAG} 已存在，更新到当前提交"
  git tag -f "$TAG" && git push -f origin "$TAG"
else
  git tag "$TAG" && git push origin "$TAG"
fi

echo
echo "== 6/6 刷新 jsDelivr 缓存 =="
# 只有 manifest 需要 purge：它在分支上、内容可变，不刷新就会一直读到旧版本。
# 正文在 tag 上、不可变，靠长缓存，无需 purge。
if curl -s --max-time 15 "https://purge.jsdelivr.net/gh/${REPO_SLUG}@${BRANCH}/content-dist/manifest.json" >/dev/null; then
  echo "  已请求 purge"
else
  echo "  ⚠️ purge 请求失败（不致命）：CDN 可能要几分钟到几小时才自然过期"
fi

echo
echo "✓ 内容 v${VERSION} 已发布"
echo "  检查更新：https://cdn.jsdelivr.net/gh/${REPO_SLUG}@${BRANCH}/content-dist/manifest.json"
echo "  下载正文：https://cdn.jsdelivr.net/gh/${REPO_SLUG}@${TAG}/content-dist/concepts.jsonl"
