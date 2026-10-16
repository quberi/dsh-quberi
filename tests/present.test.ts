import { describe, expect, it } from 'vitest'

import type { DocumentsResult, SearchResult, SpacesResult } from '../src/controller.js'
import {
  callCard,
  detectLang,
  documentsCard,
  escapeMd,
  kindOf,
  saveCard,
  searchCard,
  spacesCard,
  uploadCard,
} from '../src/present.js'

describe('detectLang', () => {
  it('follows the system locale', () => {
    expect(detectLang({ LANG: 'zh_CN.UTF-8' })).toBe('zh')
    expect(detectLang({ LC_ALL: 'zh_TW.UTF-8', LANG: 'en_US.UTF-8' })).toBe('zh')
    expect(detectLang({ LANG: 'en_US.UTF-8' })).toBe('en')
    expect(detectLang({ LANG: 'de_DE.UTF-8' })).toBe('en')
  })

  it('ignores the placeholder locales and falls back to something sensible', () => {
    expect(['zh', 'en']).toContain(detectLang({ LANG: 'C' }))
    expect(['zh', 'en']).toContain(detectLang({}))
  })
})

describe('escapeMd: other people\'s text must show as text', () => {
  it('turns Markdown and HTML into plain characters', () => {
    const hostile = '![x](http://example.com/?a=b) <img src=x onerror=1> [click](javascript:1) `code` **bold** | table'
    const out = escapeMd(hostile)
    expect(out).not.toMatch(/(?<!\\)[[\]()<>`*|]/u)
    expect(out).toContain('\\!\\[x\\]\\(http://example.com/?a=b\\)')
  })

  it('flattens line breaks so a name cannot start a new block', () => {
    expect(escapeMd('a\n# heading\n- item')).toBe('a \\# heading - item')
  })
})

describe('callCard: the line shown while a tool runs', () => {
  it('names the action in the person\'s language', () => {
    expect(callCard('quberi_search', { query: 'AI RMF' }, 'zh')).toEqual({ title: '搜索知识库：AI RMF', kind: 'search' })
    expect(callCard('quberi_search', { query: 'AI RMF' }, 'en')).toEqual({ title: 'Search knowledge: AI RMF', kind: 'search' })
    expect(callCard('quberi_save', { title: '会议结论' }, 'zh')?.title).toBe('保存笔记：会议结论')
    expect(callCard('quberi_list_spaces', {}, 'zh')?.title).toBe('查看空间列表')
    expect(callCard('quberi_list_documents', { space: '标准' }, 'zh')?.title).toBe('查看「标准」的文档')
  })

  it('shows where an upload is going', () => {
    expect(callCard('quberi_upload_file', { path: 'docs/a.pdf' }, 'zh')?.title).toBe('上传文件：docs/a.pdf → 个人空间')
    expect(callCard('quberi_upload_file', { path: 'a.pdf', space: 'Ops' }, 'en')?.title).toBe('Upload file: a.pdf → the "Ops" space')
  })

  it('clips what the model sent, and copes with missing or odd arguments', () => {
    const long = 'x'.repeat(500)
    expect(callCard('quberi_search', { query: long }, 'en')!.title.length).toBeLessThan(90)
    expect(callCard('quberi_search', undefined, 'en')?.title).toBe('Search knowledge')
    expect(callCard('quberi_search', { query: 7 }, 'en')?.title).toBe('Search knowledge')
    expect(callCard('quberi_upload_file', null, 'en')?.title).toBe('Upload file → your personal space')
    expect(callCard('other_tool', {}, 'en')).toBeUndefined()
  })
})

const passage = (over: Record<string, unknown> = {}) => ({
  document_id: 'd',
  document_name: 'AI RMF.pdf',
  space_id: 's',
  space_name: 'Standards',
  chunk_index: 0,
  text: 'Govern, map, measure and manage.',
  score: 0.82,
  ...over,
})
const search = (over: Partial<SearchResult> = {}): SearchResult => ({
  organization: 'Acme',
  searched_spaces: 1,
  passages: [],
  pending_documents: [],
  pending_total: 0,
  ...over,
})

describe('searchCard', () => {
  it('groups passages under their document with the space and best score', () => {
    const card = searchCard(
      'ai rmf',
      search({
        passages: [passage(), passage({ text: 'Second passage.', score: 0.7 }), passage({ document_name: 'Other.md', space_name: 'HR', score: 0.5 })],
      }),
      'en',
    )
    expect(card.title).toBe('Search knowledge: ai rmf · 3 passages from 2 documents')
    expect(card.markdown).toContain('**AI RMF.pdf** · Standards · relevance 0.82')
    expect(card.markdown).toContain('> Govern, map, measure and manage.')
    expect(card.markdown).toContain('> Second passage.')
    expect(card.markdown).toContain('**Other.md** · HR · relevance 0.50')
    // Each document appears once, however many passages it has.
    expect(card.markdown.match(/AI RMF.pdf/gu)).toHaveLength(1)
  })

  it('says so when nothing was found', () => {
    expect(searchCard('x', search(), 'zh').title).toContain('没有找到相关内容')
    expect(searchCard('x', search(), 'zh').markdown).toBe('')
  })

  it('lists what is still being indexed, so weak matches are not mistaken for the answer', () => {
    const card = searchCard(
      'ai rmf',
      search({
        passages: [passage({ score: 0.5 })],
        pending_total: 3,
        pending_documents: [{ document_name: 'New.pdf', space_name: 'Standards', state: 'indexing' }],
      }),
      'zh',
    )
    expect(card.markdown).toContain('**还在索引、暂时搜不到**：⏳ New.pdf (另有 2 份)')
  })

  it('cannot be made to draw links or images by a document\'s own text', () => {
    const card = searchCard(
      'q',
      search({ passages: [passage({ document_name: '![a](http://e.x/p.png)', text: '[click](http://e.x) <script>1</script>' })] }),
      'en',
    )
    expect(card.markdown).not.toMatch(/(?<!\\)!\[/u)
    expect(card.markdown).not.toMatch(/(?<!\\)\]\(/u)
    expect(card.markdown).not.toMatch(/(?<!\\)</u)
  })

  it('keeps long passages short', () => {
    const card = searchCard('q', search({ passages: [passage({ text: 'word '.repeat(400) })] }), 'en')
    expect(card.markdown.length).toBeLessThan(400)
  })
})

describe('save and upload cards', () => {
  it('say where the note or file went', () => {
    expect(saveCard('T', { document_id: 'd', space_id: 's', space_name: '', name: 'T.md' }, 'zh').title).toBe('已保存到 个人空间')
    expect(saveCard('T', { document_id: 'd', space_id: 's', space_name: 'Ops', name: 'T.md' }, 'en').title).toBe('Saved to the "Ops" space')
    const up = uploadCard(
      { document_id: 'd', space_id: 's', space_name: 'Ops', name: 'a.pdf', mime_type: 'application/pdf', size_bytes: 1_100_000 },
      'zh',
    )
    expect(up.title).toBe('已上传到 空间「Ops」')
    expect(up.markdown).toContain('**a.pdf** · PDF · 1.05 MB')
    expect(up.markdown).toContain('正在建立索引')
  })
})

const spaces = (over: Partial<SpacesResult> = {}): SpacesResult => ({
  organization: 'Acme',
  total: 2,
  spaces: [
    { name: "chaney's space", kind: 'personal', can_edit: true, document_count: 3 },
    { name: '产品团队', kind: 'shared', can_edit: false, document_count: 1 },
  ],
  ...over,
})

describe('spacesCard', () => {
  it('shows one tidy line per space', () => {
    const card = spacesCard(spaces(), 'zh')
    expect(card.title).toBe('查看空间列表 · 共 2 个空间')
    expect(card.markdown.split('\n')).toEqual([
      "- 👤 **个人 · chaney's space** · 3 份文档 · 可编辑",
      '- 📁 **产品团队** · 1 份文档 · 只读',
    ])
  })

  it('reads well in English, with singular and plural', () => {
    const card = spacesCard(spaces({ total: 1, spaces: [spaces().spaces[1]] }), 'en')
    expect(card.title).toBe('List spaces · 1 space')
    expect(card.markdown).toBe('- 📁 **产品团队** · 1 document · read only')
  })

  it('says how many were left out', () => {
    expect(spacesCard(spaces({ total: 5 }), 'en').markdown).toContain('_3 more spaces not shown_')
  })
})

const docs = (over: Partial<DocumentsResult> = {}): DocumentsResult => ({
  space_name: '标准',
  total: 3,
  next_cursor: undefined,
  documents: [
    { name: 'AI RMF.pdf', mime_type: 'application/pdf', size_bytes: 1_946_127, updated_at: '2026-10-16T10:10:00Z', status: 'ready' },
    { name: '江苏规则.pdf', mime_type: 'application/pdf', size_bytes: 1_460_062, updated_at: '2026-10-16T10:21:00Z', status: 'indexing' },
    { name: 'ndrc.png', mime_type: 'image/png', size_bytes: 900, updated_at: '2026-10-15T08:00:00Z', status: 'not_searchable' },
  ],
  ...over,
})

describe('documentsCard', () => {
  it('shows name, type, size, time and whether it can be searched', () => {
    const card = documentsCard(docs(), 'zh')
    expect(card.title).toBe('查看「标准」的文档 · 共 3 份文档')
    expect(card.markdown).toContain('- 📄 **AI RMF.pdf**')
    expect(card.markdown).toMatch(/PDF · 1\.86 MB · .* · ✅ 可搜索/u)
    expect(card.markdown).toMatch(/PDF · 1\.39 MB · .* · ⏳ 索引中/u)
    expect(card.markdown).toMatch(/图片 · 900 B · .* · ➖ 不能按内容搜索/u)
  })

  it('says when there is a next page, and when a page is only part of the whole', () => {
    const card = documentsCard(docs({ total: 212, next_cursor: 'abc' }), 'en')
    expect(card.title).toBe('Documents in "标准" · Showing 3 of 212 documents')
    expect(card.markdown).toContain('_There are more; ask for the next page._')
    expect(card.markdown).not.toContain('abc') // the cursor is for the model, not the person
  })

  it('says when a space is empty', () => {
    expect(documentsCard(docs({ documents: [], total: 0 }), 'en').markdown).toBe('_No documents in this space yet._')
  })

  it('escapes document names', () => {
    const card = documentsCard(
      docs({ documents: [{ name: '![x](http://e.x/a.png)', mime_type: 'text/plain', size_bytes: 1, updated_at: '', status: 'ready' }], total: 1 }),
      'en',
    )
    expect(card.markdown).not.toMatch(/(?<!\\)!\[/u)
    expect(card.markdown).not.toMatch(/(?<!\\)\]\(/u)
  })
})

describe('kindOf', () => {
  it.each([
    ['application/pdf', 'PDF'],
    ['application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'Word'],
    ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'Excel'],
    ['application/vnd.openxmlformats-officedocument.presentationml.presentation', 'PowerPoint'],
    ['text/markdown', 'Markdown'],
    ['text/csv', 'CSV'],
    ['text/plain', 'Text'],
    ['application/json', 'JSON'],
    ['image/webp', 'Image'],
    ['application/zip', 'File'],
  ])('%s is %s', (mime, label) => {
    expect(kindOf(mime, 'en')).toBe(label)
  })
})
