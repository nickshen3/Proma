/**
 * 设置快速搜索纯逻辑
 *
 * 设置左侧导航顶部的搜索框按「标签名 + 关键词」过滤标签页。
 * 逻辑与 UI 分离，便于单测覆盖匹配与高亮行为。
 */

/** 可搜索的设置标签页最小结构 */
export interface SearchableSettingTab {
  id: string
  label: string
  /** 同义关键词（功能词、别名），匹配行为与标签名一致 */
  keywords?: readonly string[]
}

/** 标签文本高亮片段 */
export interface LabelSegment {
  text: string
  /** 是否命中搜索词 */
  matched: boolean
}

/** 归一化：去首尾空白并转小写 */
function normalize(value: string): string {
  return value.trim().toLowerCase()
}

/** 把搜索词拆成 token；空白分隔，空串返回空数组 */
function tokenize(query: string): string[] {
  return normalize(query).split(/\s+/).filter(Boolean)
}

/**
 * 过滤设置标签页。
 *
 * 所有以空白分隔的搜索词都需要命中（标签名或任一关键词，大小写不敏感）
 * 才保留该标签页；空搜索词返回全部标签页（保持原顺序）。
 */
export function filterSettingTabs<T extends SearchableSettingTab>(
  tabs: readonly T[],
  query: string,
): T[] {
  const tokens = tokenize(query)
  if (tokens.length === 0) return [...tabs]

  return tabs.filter((tab) => {
    const haystack = [normalize(tab.label), ...(tab.keywords ?? []).map(normalize)].join('\n')
    return tokens.every((token) => haystack.includes(token))
  })
}

/**
 * 按搜索词切分标签文本，用于高亮命中的片段。
 *
 * 仅使用第一个出现在标签名中的搜索词做单区间高亮，保持视觉轻量；
 * 未命中或空搜索词时返回整段未标记文本。
 */
export function splitLabelByQuery(label: string, query: string): LabelSegment[] {
  const tokens = tokenize(query)
  if (tokens.length === 0) return [{ text: label, matched: false }]

  const lowerLabel = label.toLowerCase()
  let matchIndex = -1
  let matchLength = 0
  for (const token of tokens) {
    const at = lowerLabel.indexOf(token)
    if (at >= 0) {
      matchIndex = at
      matchLength = token.length
      break
    }
  }
  if (matchIndex < 0) return [{ text: label, matched: false }]

  const segments: LabelSegment[] = []
  if (matchIndex > 0) {
    segments.push({ text: label.slice(0, matchIndex), matched: false })
  }
  segments.push({ text: label.slice(matchIndex, matchIndex + matchLength), matched: true })
  if (matchIndex + matchLength < label.length) {
    segments.push({ text: label.slice(matchIndex + matchLength), matched: false })
  }
  return segments
}
