import { describe, expect, test } from 'bun:test'
import { filterSettingTabs, splitLabelByQuery } from './settings-search'

const TABS = [
  { id: 'general', label: '通用设置', keywords: ['通知', '归档', '头像'] },
  { id: 'channels', label: '模型配置', keywords: ['API', 'Key', '渠道'] },
  { id: 'about', label: '关于/更新', keywords: ['版本', '检查更新'] },
]

describe('设置快速搜索过滤', () => {
  test('Given 空搜索词 When 过滤 Then 返回全部标签页且保持顺序', () => {
    expect(filterSettingTabs(TABS, '').map((t) => t.id)).toEqual(['general', 'channels', 'about'])
  })

  test('Given 只包含空白的搜索词 When 过滤 Then 视为空搜索', () => {
    expect(filterSettingTabs(TABS, '   ')).toHaveLength(3)
  })

  test('Given 搜索词命中标签名 When 过滤 Then 只保留匹配的标签页', () => {
    expect(filterSettingTabs(TABS, '更新').map((t) => t.id)).toEqual(['about'])
  })

  test('Given 搜索词命中关键词 When 过滤 Then 关键词与标签名等效', () => {
    expect(filterSettingTabs(TABS, 'API').map((t) => t.id)).toEqual(['channels'])
    expect(filterSettingTabs(TABS, '通知').map((t) => t.id)).toEqual(['general'])
  })

  test('Given 多个搜索词 When 过滤 Then 要求全部命中（AND 语义）', () => {
    expect(filterSettingTabs(TABS, '通知 归档').map((t) => t.id)).toEqual(['general'])
    expect(filterSettingTabs(TABS, '通知 版本')).toEqual([])
  })

  test('Given 大小写混合的英文搜索词 When 过滤 Then 忽略大小写', () => {
    expect(filterSettingTabs(TABS, 'api').map((t) => t.id)).toEqual(['channels'])
    expect(filterSettingTabs(TABS, 'key').map((t) => t.id)).toEqual(['channels'])
  })

  test('Given 没有任何匹配 When 过滤 Then 返回空数组', () => {
    expect(filterSettingTabs(TABS, '不存在的设置')).toEqual([])
  })
})

describe('设置搜索标签高亮', () => {
  test('Given 搜索词出现在标签名中 When 切分 Then 命中片段被标记', () => {
    expect(splitLabelByQuery('关于/更新', '更新')).toEqual([
      { text: '关于/', matched: false },
      { text: '更新', matched: true },
    ])
  })

  test('Given 搜索词命中关键词而非标签名 When 切分 Then 返回整段未标记', () => {
    expect(splitLabelByQuery('通用设置', '通知')).toEqual([
      { text: '通用设置', matched: false },
    ])
  })

  test('Given 空搜索词 When 切分 Then 返回整段未标记', () => {
    expect(splitLabelByQuery('模型配置', ' ')).toEqual([
      { text: '模型配置', matched: false },
    ])
  })

  test('Given 多个搜索词 When 切分 Then 使用第一个命中标签名的词高亮', () => {
    expect(splitLabelByQuery('关于/更新', '版本 更新')).toEqual([
      { text: '关于/', matched: false },
      { text: '更新', matched: true },
    ])
  })
})
