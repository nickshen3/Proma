import { describe, expect, test } from 'bun:test'
import { isGitDiffStateFilePath } from './git-state-path'

describe('isGitDiffStateFilePath', () => {
  test('识别直接影响 git diff 的状态元数据文件', () => {
    expect(isGitDiffStateFilePath('repo/.git/HEAD')).toBe(true)
    expect(isGitDiffStateFilePath('repo/.git/index')).toBe(true)
    expect(isGitDiffStateFilePath('repo/.git/ORIG_HEAD')).toBe(true)
    expect(isGitDiffStateFilePath('repo/.git/MERGE_HEAD')).toBe(true)
    expect(isGitDiffStateFilePath('repo/.git/CHERRY_PICK_HEAD')).toBe(true)
    expect(isGitDiffStateFilePath('repo/.git/REVERT_HEAD')).toBe(true)
  })

  test('兼容 Windows 反斜杠分隔的绝对路径', () => {
    expect(isGitDiffStateFilePath('D:\\repo\\.git\\index')).toBe(true)
    expect(isGitDiffStateFilePath('D:\\repo\\.git\\HEAD')).toBe(true)
  })

  test('普通文件与深层 .git 内部路径不视为状态元数据', () => {
    expect(isGitDiffStateFilePath('repo/.git/FETCH_HEAD')).toBe(false)
    expect(isGitDiffStateFilePath('repo/.git/refs/heads/main')).toBe(false)
    expect(isGitDiffStateFilePath('repo/.git/objects/ab/cdef')).toBe(false)
    expect(isGitDiffStateFilePath('repo/notes.md')).toBe(false)
    expect(isGitDiffStateFilePath('repo/.gitignore')).toBe(false)
  })

  test('非 Git 路径、嵌套 .git 目录与边界输入', () => {
    expect(isGitDiffStateFilePath('a/b/c.txt')).toBe(false)
    // 嵌套仓库：以最内层 .git 为准
    expect(isGitDiffStateFilePath('outer/repo/.git/index')).toBe(true)
    expect(isGitDiffStateFilePath('.git/index')).toBe(true)
    expect(isGitDiffStateFilePath('.git')).toBe(false)
    expect(isGitDiffStateFilePath('')).toBe(false)
    expect(isGitDiffStateFilePath('D:\\repo\\.git\\config')).toBe(false)
  })
})
