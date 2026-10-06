import assert from 'node:assert/strict'
import { test, before } from 'node:test'
import { JSDOM } from 'jsdom'

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost:62055/' })
const g = globalThis as unknown as Record<string, unknown>
g.window = dom.window
g.document = dom.window.document
g.localStorage = dom.window.localStorage
g.navigator = dom.window.navigator
g.HTMLElement = dom.window.HTMLElement

// 必须在设置好 localStorage 后再导入 store（导入即 bootstrap）
type StoreModule = typeof import('../src/store')
type JournalModule = typeof import('../src/rehearsal/journal')
let M: StoreModule
let J: JournalModule

before(async () => {
  dom.window.localStorage.clear()
  M = await import('../src/store')
  J = await import('../src/rehearsal/journal')
})

test('端到端：三个窗口的改动暂存、汇成一次校订、基线推进并落盘', () => {
  const { store, selectStagedChanges, saveRevision, selectTrack, selectNote, updateNote, addComment, setPageTurn } = M
  const baseline0 = store.getState().score.domain.baselineVersion

  // 总谱窗口：圆号第 2 小节首个音符改力度 p
  store.dispatch(selectTrack('TR-03'))
  store.dispatch(selectNote(4))
  store.dispatch(updateNote({ dynamic: 'p' }))
  // 批注窗口：新增一条锚定第 3 小节的指挥批注
  store.dispatch(addComment({ measure: 3, content: '集成测试：第 3 小节再轻一点', author: '指挥 · 方亦' }))
  // 分谱窗口：单簧管换页改到第 3 小节前
  store.dispatch(setPageTurn({ trackId: 'TR-02', patch: { pageTurnMeasure: 3 } }))

  const staged = selectStagedChanges(store.getState())
  assert.ok(staged.length >= 3, `三处窗口都应有改动（实际 ${staged.length}）`)
  const kinds = new Set(staged.map((change) => change.edit.kind))
  assert.deepEqual([...kinds].sort(), ['comment', 'note', 'pageTurn'])

  store.dispatch(saveRevision('集成测试校订'))
  const state1 = store.getState().score
  assert.equal(state1.pendingCommit, null)
  assert.equal(state1.writeInterrupted, false)
  assert.equal(state1.domain.baselineVersion, baseline0 + 1)
  assert.equal(state1.domain.revisions[0]!.message, '集成测试校订')
  assert.ok(state1.domain.revisions[0]!.applied.length >= 3)
  assert.equal(state1.domain.revisions[0]!.baseVersion, baseline0)
  assert.match(state1.domain.revisions[0]!.token, /^REV-/)
  // 提交后工作区与基线一致
  assert.equal(selectStagedChanges(store.getState()).length, 0)
  // 谱面真实变化
  assert.equal(state1.working.tracks[2]!.notes[4]!.dynamic, 'p')
  assert.equal(state1.working.pageTurns['TR-02']!.pageTurnMeasure, 3)
  // 落盘可重新读回
  assert.equal(J.readSnapshot(dom.window.localStorage)!.baselineVersion, baseline0 + 1)
})

test('端到端：同一基线并发提交，后完成者进冲突篮，接受后合并且不新增校订', () => {
  const { store, simulateConcurrentEdits, resolveConflictEntry } = M
  const before = store.getState().score.domain.baselineVersion

  store.dispatch(simulateConcurrentEdits([
    { editor: '沈青', message: '集成：长笛第 1 小节改 p', edits: makeEdits(store, 'TR-01', 1, { dynamic: 'p' }) },
    { editor: '指挥 · 方亦', message: '集成：长笛第 1 小节改 ff', edits: makeEdits(store, 'TR-01', 1, { dynamic: 'ff' }) },
  ]))

  const state = store.getState().score
  assert.equal(state.domain.baselineVersion, before + 1, '只有先完成者推进基线')
  assert.equal(state.domain.tracks[0]!.notes[0]!.dynamic, 'p')
  const mine = state.domain.revisions.slice(0, 2).find((revision) => revision.editor === '指挥 · 方亦')!
  assert.equal(mine.status, 'quarantined')
  const conflict = state.domain.conflicts.find((entry) => entry.token === mine.token && entry.status === 'pending')!
  assert.ok(conflict, '后完成者的片段在冲突篮里')
  assert.equal(conflict.specs[0]!.measure, 1)
  assert.equal(conflict.specs.length, 4, '同一小节四个音符聚合成一个冲突片段')

  const revisionCount = state.domain.revisions.length
  store.dispatch(resolveConflictEntry(conflict.id, true))
  const after = store.getState().score
  assert.equal(after.domain.tracks[0]!.notes[0]!.dynamic, 'ff', '人工并入后取落方值')
  assert.equal(after.domain.baselineVersion, before + 2)
  assert.equal(after.domain.revisions.length, revisionCount, '并入冲突不新增校订记录')
  assert.equal(after.domain.conflicts.find((entry) => entry.id === conflict.id)!.status, 'accepted')
})

test('端到端：写盘中断后按提交标记续做，同一校订只有一份记录', () => {
  const { store, saveRevision, resumePending, selectTrack, selectNote, updateNote } = M
  const before = store.getState().score.domain.baselineVersion
  store.dispatch(selectTrack('TR-04'))
  store.dispatch(selectNote(0))
  store.dispatch(updateNote({ dynamic: 'pp' }))

  J.FaultableStorage.failNextWrite()
  store.dispatch(saveRevision('中断校订'))
  const interrupted = store.getState().score
  assert.ok(interrupted.pendingCommit, '提交标记已登记')
  assert.equal(interrupted.writeInterrupted, true)
  assert.equal(interrupted.domain.baselineVersion, before, '中断时基线不动')
  // 快照写坏、日志完好
  assert.equal(J.readSnapshot(dom.window.localStorage), null)
  assert.equal(J.readJournal(dom.window.localStorage).length, 1)
  const token = interrupted.pendingCommit!.token

  // 模拟刷新后续做
  store.dispatch(resumePending())
  const resumed = store.getState().score
  assert.equal(resumed.writeInterrupted, false)
  assert.equal(resumed.pendingCommit, null)
  assert.equal(resumed.domain.baselineVersion, before + 1)
  assert.equal(resumed.domain.revisions.filter((revision) => revision.token === token).length, 1)
  assert.equal(J.readJournal(dom.window.localStorage).length, 0)
  assert.equal(J.readSnapshot(dom.window.localStorage)!.revisions.filter((revision) => revision.token === token).length, 1)

  // 再次续做是空操作，不会多出记录
  store.dispatch(resumePending())
  assert.equal(store.getState().score.domain.revisions.filter((revision) => revision.token === token).length, 1)
})

test('丢弃未完成提交标记后可以重新开始', () => {
  const { store, saveRevision, discardPendingCommit, selectTrack, selectNote, updateNote } = M
  store.dispatch(selectTrack('TR-04'))
  store.dispatch(selectNote(1))
  store.dispatch(updateNote({ dynamic: 'ff' }))
  J.FaultableStorage.failNextWrite()
  store.dispatch(saveRevision('要丢弃的校订'))
  assert.ok(store.getState().score.pendingCommit)
  store.dispatch(discardPendingCommit())
  assert.equal(store.getState().score.pendingCommit, null)
  assert.equal(dom.window.localStorage.getItem(J.JOURNAL_KEY), null)
})

// 辅助：基于当前基线构造某声部某小节的音符编辑
function makeEdits(
  store: StoreModule['store'],
  trackId: string,
  measure: number,
  patch: Partial<{ dynamic: string; tie: boolean }>,
) {
  const domain = store.getState().score.domain
  const track = domain.tracks.find((item) => item.id === trackId)!
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const edits: any[] = []
  track.notes.forEach((note, index) => {
    if (Math.floor(index / 4) + 1 !== measure) return
    edits.push({ kind: 'note' as const, trackId, index, before: structuredClone(note), after: { ...structuredClone(note), ...patch, id: note.id } })
  })
  return edits
}
