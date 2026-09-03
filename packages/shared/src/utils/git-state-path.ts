/**
 * Git diff 状态元数据路径判断。
 *
 * watcher 在主进程放行 `.git/HEAD`、`.git/index` 等状态文件事件，用于刷新 Git diff；
 * 这类路径不影响文件树内容。渲染进程据此区分“仅 Git 元数据变化”的事件，
 * 避免后台 Git 活动（编辑器轮询 git status 等）导致文件面板反复重载。
 */

/** 直接影响 `git diff HEAD` 结果的 Git 元数据文件名；必须位于 .git 目录第一层。 */
const GIT_DIFF_STATE_FILES = new Set([
  'HEAD', 'ORIG_HEAD', 'MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'index',
])

/**
 * 判断路径（绝对或相对，`/` 或 `\` 分隔均可）是否为 Git diff 状态元数据文件。
 *
 * 远端 fetch 产生的 FETCH_HEAD、refs/remotes 与 objects 均不在范围内，避免重现刷新循环。
 */
export function isGitDiffStateFilePath(path: string): boolean {
  const segments = path.split(/[\\/]/).filter(Boolean)
  const gitIndex = segments.lastIndexOf('.git')
  if (gitIndex < 0) return false
  const gitRelativePath = segments.slice(gitIndex + 1)
  return gitRelativePath.length === 1 && GIT_DIFF_STATE_FILES.has(gitRelativePath[0]!)
}
