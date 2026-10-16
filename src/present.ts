/**
 * How the Quberi tools look in the Harness conversation.
 *
 * The model reads the plain text each tool returns. The person reads a card:
 * a short title while the call runs, and a tidy summary once it is done. These
 * functions build that summary. They only shape what is shown; they never change
 * what the model receives, and they take no input the model text did not already
 * come from.
 *
 * Everything that comes from Quberi (document names, space names, passages) is
 * somebody's text, and the card is rendered as Markdown, so it is escaped first:
 * a document called `![x](http://example.com/?a=b)` must show as that name, not
 * fetch an image or draw a link.
 *
 * This file does not import DeepSeek Harness, so it can be tested on its own.
 */

import type {
  DocumentInfo,
  DocumentsResult,
  Passage,
  SaveResult,
  SearchResult,
  SpacesResult,
  UploadResult,
} from './controller.js'
import { formatBytes } from './upload.js'

export type Lang = 'zh' | 'en'

/** A finished card: a title and Markdown for the body. */
export interface CardView {
  title: string
  markdown: string
}

/**
 * Chinese when the machine is set up for it, English otherwise. Harness hands a
 * plugin no UI language, so this follows the system locale.
 */
export function detectLang(env: Record<string, string | undefined> = process.env): Lang {
  for (const key of ['LC_ALL', 'LC_MESSAGES', 'LANG']) {
    const value = env[key]
    if (value !== undefined && value !== '' && value !== 'C' && value !== 'POSIX') {
      return /^zh/iu.test(value) ? 'zh' : 'en'
    }
  }
  try {
    return /^zh/iu.test(Intl.DateTimeFormat().resolvedOptions().locale) ? 'zh' : 'en'
  } catch {
    return 'en'
  }
}

const TEXT = {
  zh: {
    search: '搜索知识库',
    searchDone: (found: number, docs: number) => (found === 0 ? '没有找到相关内容' : `找到 ${found} 段内容，来自 ${docs} 份文档`),
    relevance: '相关度',
    pendingHead: '还在索引、暂时搜不到',
    pendingMore: (n: number) => `另有 ${n} 份`,
    save: '保存笔记',
    saved: (where: string) => `已保存到 ${where}`,
    upload: '上传文件',
    uploaded: (where: string) => `已上传到 ${where}`,
    uploadNote: '正在建立索引，完成前搜索不到。图片只保存，不能按内容检索。',
    personal: '个人空间',
    personalTag: '个人',
    sep: '，',
    colon: '：',
    spaceWord: (name: string) => `空间「${name}」`,
    listSpaces: '查看空间列表',
    spacesDone: (n: number) => `共 ${n} 个空间`,
    canEdit: '可编辑',
    readOnly: '只读',
    docs: (n: number) => `${n} 份文档`,
    moreSpaces: (n: number) => `还有 ${n} 个空间未列出`,
    listDocs: (name: string) => `查看「${name}」的文档`,
    docsDone: (shown: number, total: number) => (shown < total ? `显示 ${shown} / ${total} 份文档` : `共 ${total} 份文档`),
    emptySpace: '这个空间里还没有文档。',
    moreDocs: '还有更多，可以继续翻页。',
    ready: '可搜索',
    indexing: '索引中',
    notSearchable: '不能按内容搜索',
    kinds: { pdf: 'PDF', word: 'Word', excel: 'Excel', ppt: 'PPT', md: 'Markdown', csv: 'CSV', txt: '文本', json: 'JSON', image: '图片', other: '文件' },
  },
  en: {
    search: 'Search knowledge',
    searchDone: (found: number, docs: number) => (found === 0 ? 'Nothing relevant found' : `${found} passage${found === 1 ? '' : 's'} from ${docs} document${docs === 1 ? '' : 's'}`),
    relevance: 'relevance',
    pendingHead: 'Still indexing, not searchable yet',
    pendingMore: (n: number) => `${n} more`,
    save: 'Save note',
    saved: (where: string) => `Saved to ${where}`,
    upload: 'Upload file',
    uploaded: (where: string) => `Uploaded to ${where}`,
    uploadNote: 'Indexing now; it cannot be found by search until that finishes. Images are stored but not searchable by content.',
    personal: 'your personal space',
    personalTag: 'Personal',
    sep: ', ',
    colon: ': ',
    spaceWord: (name: string) => `the "${name}" space`,
    listSpaces: 'List spaces',
    spacesDone: (n: number) => `${n} space${n === 1 ? '' : 's'}`,
    canEdit: 'can edit',
    readOnly: 'read only',
    docs: (n: number) => `${n} document${n === 1 ? '' : 's'}`,
    moreSpaces: (n: number) => `${n} more space${n === 1 ? '' : 's'} not shown`,
    listDocs: (name: string) => `Documents in "${name}"`,
    docsDone: (shown: number, total: number) => (shown < total ? `Showing ${shown} of ${total} documents` : `${total} document${total === 1 ? '' : 's'}`),
    emptySpace: 'No documents in this space yet.',
    moreDocs: 'There are more; ask for the next page.',
    ready: 'searchable',
    indexing: 'indexing',
    notSearchable: 'not searchable by content',
    kinds: { pdf: 'PDF', word: 'Word', excel: 'Excel', ppt: 'PowerPoint', md: 'Markdown', csv: 'CSV', txt: 'Text', json: 'JSON', image: 'Image', other: 'File' },
  },
} as const

/** Characters that mean something in Markdown (and HTML) become plain text. */
export function escapeMd(value: string): string {
  return value
    .replace(/[\r\n\t]+/gu, ' ')
    .replace(/[\\`*_{}[\]()#+!|<>~&]/gu, (ch) => `\\${ch}`)
    .trim()
}

/** `Head: tail`, or just `Head` when there is nothing to add. */
function labelled(t: { colon: string }, head: string, tail: string): string {
  return tail === '' ? head : `${head}${t.colon}${tail}`
}

function clip(value: string, max: number): string {
  const flat = value.replace(/\s+/gu, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}

const MIME_KIND: Array<[RegExp, keyof (typeof TEXT)['en']['kinds']]> = [
  [/^application\/pdf$/u, 'pdf'],
  [/wordprocessingml/u, 'word'],
  [/spreadsheetml/u, 'excel'],
  [/presentationml/u, 'ppt'],
  [/^text\/markdown$/u, 'md'],
  [/^text\/csv$/u, 'csv'],
  [/^text\//u, 'txt'],
  [/^application\/json$/u, 'json'],
  [/^image\//u, 'image'],
]

export function kindOf(mime: string, lang: Lang): string {
  const hit = MIME_KIND.find(([pattern]) => pattern.test(mime))
  return TEXT[lang].kinds[hit ? hit[1] : 'other']
}

function when(iso: string, lang: Lang): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return ''
  return date.toLocaleString(lang === 'zh' ? 'zh-CN' : 'en-GB', {
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

function statusMark(status: DocumentInfo['status'], lang: Lang): string {
  const t = TEXT[lang]
  if (status === 'ready') return `✅ ${t.ready}`
  if (status === 'indexing') return `⏳ ${t.indexing}`
  return `➖ ${t.notSearchable}`
}

// ---------------------------------------------------------------------------
// While the call runs
// ---------------------------------------------------------------------------

export interface CallCard {
  title: string
  kind: 'search' | 'other'
  rawInput?: string
}

/** The one-line label shown while a tool call is pending. Arguments are the model's, so they are clipped. */
export function callCard(tool: string, args: unknown, lang: Lang = detectLang()): CallCard | undefined {
  const t = TEXT[lang]
  const a = (typeof args === 'object' && args !== null ? args : {}) as Record<string, unknown>
  const str = (key: string, max: number): string => (typeof a[key] === 'string' ? clip(a[key] as string, max) : '')
  switch (tool) {
    case 'quberi_search':
      return { title: labelled(t, t.search, str('query', 60)), kind: 'search' }
    case 'quberi_save':
      return { title: labelled(t, t.save, str('title', 50)), kind: 'other' }
    case 'quberi_upload_file': {
      const where = str('space', 40) ? t.spaceWord(str('space', 40)) : t.personal
      const file = str('path', 80)
      return { title: file === '' ? `${t.upload} → ${where}` : labelled(t, t.upload, `${file} → ${where}`), kind: 'other' }
    }
    case 'quberi_list_spaces':
      return { title: t.listSpaces, kind: 'search' }
    case 'quberi_list_documents':
      return { title: t.listDocs(str('space', 60)), kind: 'search' }
    default:
      return undefined
  }
}

// ---------------------------------------------------------------------------
// When it is done
// ---------------------------------------------------------------------------

function whereOf(spaceName: string, lang: Lang): string {
  const t = TEXT[lang]
  return spaceName ? t.spaceWord(spaceName) : t.personal
}

export function searchCard(query: string, result: SearchResult, lang: Lang = detectLang()): CardView {
  const t = TEXT[lang]
  const byDocument = new Map<string, { space: string; best: number; passages: Passage[] }>()
  for (const passage of result.passages) {
    const key = `${passage.space_name}\u0000${passage.document_name}`
    const entry = byDocument.get(key) ?? { space: passage.space_name, best: 0, passages: [] }
    entry.best = Math.max(entry.best, passage.score)
    entry.passages.push(passage)
    byDocument.set(key, entry)
  }
  const lines: string[] = []
  for (const [key, entry] of byDocument) {
    const name = key.slice(key.indexOf('\u0000') + 1)
    const space = entry.space ? ` · ${escapeMd(entry.space)}` : ''
    lines.push(`**${escapeMd(clip(name, 80))}**${space} · ${t.relevance} ${entry.best.toFixed(2)}`)
    for (const passage of entry.passages.slice(0, 2)) {
      lines.push(`> ${escapeMd(clip(passage.text, 180))}`)
    }
    lines.push('')
  }
  if (result.pending_total > 0 && result.pending_documents.length > 0) {
    const names = result.pending_documents.map((d) => `⏳ ${escapeMd(clip(d.document_name, 60))}`)
    const more = result.pending_total - names.length
    lines.push(`**${t.pendingHead}**${t.colon}${names.join(t.sep)}${more > 0 ? ` (${t.pendingMore(more)})` : ''}`)
  }
  return {
    title: `${labelled(t, t.search, clip(query, 50))} · ${t.searchDone(result.passages.length, byDocument.size)}`,
    markdown: lines.join('\n').trim(),
  }
}

export function saveCard(title: string, result: SaveResult, lang: Lang = detectLang()): CardView {
  const t = TEXT[lang]
  return {
    title: `${t.saved(whereOf(result.space_name, lang))}`,
    markdown: `**${escapeMd(clip(result.name || title, 100))}**`,
  }
}

export function uploadCard(result: UploadResult, lang: Lang = detectLang()): CardView {
  const t = TEXT[lang]
  const kind = kindOf(result.mime_type, lang)
  const size = result.size_bytes > 0 ? ` · ${formatBytes(result.size_bytes)}` : ''
  return {
    title: t.uploaded(whereOf(result.space_name, lang)),
    markdown: `**${escapeMd(clip(result.name, 100))}** · ${kind}${size}\n\n⏳ ${t.uploadNote}`,
  }
}

export function spacesCard(result: SpacesResult, lang: Lang = detectLang()): CardView {
  const t = TEXT[lang]
  const lines = result.spaces.map((space) => {
    const icon = space.kind === 'personal' ? '👤' : '📁'
    const name = space.kind === 'personal' ? `${t.personalTag} · ${escapeMd(space.name)}` : escapeMd(space.name)
    const right = space.can_edit ? t.canEdit : t.readOnly
    return `- ${icon} **${name}** · ${t.docs(space.document_count)} · ${right}`
  })
  const more = result.total - result.spaces.length
  if (more > 0) lines.push('', `_${t.moreSpaces(more)}_`)
  return { title: `${t.listSpaces} · ${t.spacesDone(result.total)}`, markdown: lines.join('\n') }
}

export function documentsCard(result: DocumentsResult, lang: Lang = detectLang()): CardView {
  const t = TEXT[lang]
  const lines = result.documents.map((doc) => {
    const parts = [kindOf(doc.mime_type, lang), formatBytes(doc.size_bytes), when(doc.updated_at, lang), statusMark(doc.status, lang)]
    return `- 📄 **${escapeMd(clip(doc.name, 90))}**  \n  ${parts.filter((p) => p !== '').join(' · ')}`
  })
  if (lines.length === 0) lines.push(`_${t.emptySpace}_`)
  if (result.next_cursor !== undefined) lines.push('', `_${t.moreDocs}_`)
  return {
    title: `${t.listDocs(result.space_name)} · ${t.docsDone(result.documents.length, result.total)}`,
    markdown: lines.join('\n'),
  }
}
