import assert from 'node:assert/strict'
import { test } from 'node:test'
import { migrateLegacy } from '../src/rehearsal/migration'
import { seedComments, seedTracks, seedVersions } from '../src/mock'
import type { AnyEdit, DomainSnapshot, NoteEdit, PageTurnEdit, RevisionRequest } from '../src/rehearsal/types'
import { MEASURE_SIZE, acceptConflict, cacheKey, commitRevision, measureOfIndex } from '../src/rehearsal/changes'

const TIME = '10:00:00'

function baseSnapshot(): DomainSnapshot {
  return migrateLegacy({ tracks: seedTracks, comments: seedComments, versions: seedVersions }, TIME)
}

let tokenCounter = 0
function token() { tokenCounter += 1; return `REV-test-${tokenCounter}` }

function noteEditAt(snapshot: DomainSnapshot, trackId: string, measure: number, patch: Partial<{ dynamic: string; tie: boolean }>): NoteEdit {
  const track = snapshot.tracks.find((item) => item.id === trackId)!
  const index = (measure - 1) * MEASURE_SIZE
  const before = structuredClone(track.notes[index]!)
  return { kind: 'note', trackId, index, before, after: { ...before, ...patch } as NoteEdit['after'] }
}
function pageTurnEdit(snapshot: DomainSnapshot, trackId: string, afterMeasure: number): PageTurnEdit {
  const before = snapshot.pageTurns[trackId]!
  return { kind: 'pageTurn', trackId, cue: before.cue, beforeMeasure: before.pageTurnMeasure, afterMeasure }
}
function request(snapshot: DomainSnapshot, editor: string, edits: AnyEdit[], message: string): RevisionRequest {
  return { token: token(), editor, message, baseVersion: snapshot.baselineVersion, edits, time: TIME }
}

test('三处窗口的改动汇成同一次校订，并记下小节、谱面版本与提交标记', () => {
  const initial = baseSnapshot()
  const baseVersion = initial.baselineVersion
  const edits: AnyEdit[] = [
    noteEditAt(initial, 'TR-03', 2, { dynamic: 'p' }),
    { kind: 'comment', comment: { ...structuredClone(initial.comments[0]!), resolved: true }, before: structuredClone(initial.comments[0]!) },
    pageTurnEdit(initial, 'TR-02', 3),
  ]
  const { snapshot, revision } = commitRevision(initial, request(initial, '沈青', edits, '排练校订合并'), TIME)

  assert.equal(snapshot.revisions.length, initial.revisions.length + 1)
  assert.equal(revision.baseVersion, baseVersion)
  assert.equal(revision.newVersion, baseVersion + 1)
  assert.equal(revision.applied.length, 3)
  assert.deepEqual(revision.applied.map((spec) => spec.measure), [2, 2, 3])
  assert.match(revision.applied[0]!.summary, /p/)
  assert.equal(revision.status, 'committed')
  assert.ok(/^REV-test-\d+$/.test(revision.token))
  // 真正落到了谱面
  assert.equal(snapshot.tracks[2]!.notes[4]!.dynamic, 'p')
  assert.equal(snapshot.pageTurns['TR-02']!.pageTurnMeasure, 3)
  assert.equal(snapshot.comments[0]!.resolved, true)
})

test('两位编辑从同一版同时提交：先完成者成为新基线，后者重叠片段进冲突篮且不覆盖', () => {
  const common = baseSnapshot()
  const baseVersion = common.baselineVersion

  const first = commitRevision(common, request(common, '沈青', [noteEditAt(common, 'TR-03', 1, { dynamic: 'p' })], '先完成'), TIME)
  assert.equal(first.snapshot.baselineVersion, baseVersion + 1)
  assert.equal(first.snapshot.tracks[2]!.notes[0]!.dynamic, 'p')

  // 第二位编辑仍从旧基线提交，改同一小节（重叠）+ 不同小节（不重叠）
  const second = commitRevision(first.snapshot, request(common, '指挥 · 方亦', [
    noteEditAt(common, 'TR-03', 1, { dynamic: 'ff' }),
    noteEditAt(common, 'TR-03', 2, { dynamic: 'f' }),
  ], '后完成'), TIME)

  assert.equal(second.revision.status, 'partial')
  assert.equal(second.revision.applied.length, 1)
  assert.equal(second.revision.blocked.length, 1)
  assert.equal(second.revision.applied[0]!.measure, 2)
  // 已接受的第一小节仍是 p，没有被 ff 覆盖
  assert.equal(second.snapshot.tracks[2]!.notes[0]!.dynamic, 'p')
  // 第二小节的不重叠改动并入
  assert.equal(second.snapshot.tracks[2]!.notes[4]!.dynamic, 'f')
  // 冲突篮留了一条待处置片段
  assert.equal(second.conflicts.length, 1)
  assert.equal(second.conflicts[0]!.status, 'pending')
  assert.equal(second.conflicts[0]!.specs[0]!.measure, 1)
  assert.equal(second.conflicts[0]!.baseVersion, baseVersion)
})

test('全部重叠时整份校订隔离，出版基线与已接受片段不变', () => {
  const common = baseSnapshot()
  const first = commitRevision(common, request(common, 'A', [noteEditAt(common, 'TR-01', 1, { dynamic: 'p' })], 'a'), TIME)
  const second = commitRevision(first.snapshot, request(common, 'B', [noteEditAt(common, 'TR-01', 1, { dynamic: 'ff' })], 'b'), TIME)
  assert.equal(second.revision.status, 'quarantined')
  assert.equal(second.revision.newVersion, first.snapshot.baselineVersion)
  assert.equal(second.snapshot.tracks[0]!.notes[0]!.dynamic, 'p')
  assert.equal(second.revision.applied.length, 0)
})

test('冲突篮并入时若片段已被接受则拒绝，绝不覆盖；否则补入基线', () => {
  const common = baseSnapshot()
  const first = commitRevision(common, request(common, 'A', [noteEditAt(common, 'TR-03', 1, { dynamic: 'p' })], 'a'), TIME)
  const second = commitRevision(first.snapshot, request(common, 'B', [noteEditAt(common, 'TR-03', 1, { dynamic: 'f' })], 'b'), TIME)
  const conflictId = second.conflicts[0]!.id

  // 又有一位编辑抢先接受了该小节的另一改动（这里模拟基线已再次前进到该格子）
  const third = commitRevision(second.snapshot, request(second.snapshot, 'C', [noteEditAt(second.snapshot, 'TR-03', 1, { dynamic: 'mp' })], 'c'), TIME)
  assert.equal(third.snapshot.tracks[2]!.notes[0]!.dynamic, 'mp')
  const rejected = acceptConflict(third.snapshot, conflictId, TIME)
  assert.equal(rejected.ok, false)
  assert.equal((rejected as { ok: false; reason: string }).reason, '该小节片段之后已被接受，不能覆盖')

  // 另一条仍空闲的冲突片段可以并入；A 的延音线（赢方已接受片段）不能被 B 的旧快照盖掉
  const common2 = baseSnapshot()
  const f1 = commitRevision(common2, request(common2, 'A', [noteEditAt(common2, 'TR-03', 2, { tie: true })], 'a'), TIME)
  const f2 = commitRevision(f1.snapshot, request(common2, 'B', [noteEditAt(common2, 'TR-03', 2, { dynamic: 'ff' })], 'b'), TIME)
  assert.equal(f2.snapshot.tracks[2]!.notes[4]!.tie, true, '赢方接受前的状态')
  const accepted = acceptConflict(f2.snapshot, f2.conflicts[0]!.id, TIME)
  assert.equal(accepted.ok, true)
  if (accepted.ok) {
    assert.equal(accepted.snapshot.tracks[2]!.notes[4]!.dynamic, 'ff')
    assert.equal(accepted.snapshot.tracks[2]!.notes[4]!.tie, true, '原已接受的延音线不能丢')
    assert.equal(accepted.revision.status, 'committed')
    const entry = accepted.snapshot.conflicts[0]!
    assert.equal(entry.status, 'accepted')
  }
})

test('同一提交标记重复提交是幂等的，不会多出第二份记录', () => {
  const initial = baseSnapshot()
  const req = request(initial, '沈青', [noteEditAt(initial, 'TR-01', 1, { dynamic: 'pp' })], '幂等')
  const once = commitRevision(initial, req, TIME)
  const revisionCount = once.snapshot.revisions.length
  const twice = commitRevision(once.snapshot, req, TIME)
  assert.equal(twice.snapshot.revisions.length, revisionCount)
  assert.equal(twice.revision.token, req.token)
  assert.equal(twice.snapshot.baselineVersion, once.snapshot.baselineVersion)
})

test('小节变化只让关联的节奏/换页/基线失效重算，未涉及声部沿用原结果', () => {
  const initial = baseSnapshot()
  const untouchedTrack = initial.tracks[1]! // TR-02 单簧管
  const untouchedKey = cacheKey('rhythm', untouchedTrack.id, 1)
  const untouchedEntry = initial.derived.cache[untouchedKey]!
  const touchedOtherKey = cacheKey('rhythm', 'TR-03', 3)
  const otherBefore = initial.derived.cache[touchedOtherKey]!

  const { snapshot } = commitRevision(initial, request(initial, '沈青', [noteEditAt(initial, 'TR-03', 1, { dynamic: 'f' })], '只改圆号第一小节'), TIME)

  // 受影响格子被重算（updatedAt 刷新、值重算）
  const rhythm1 = snapshot.derived.cache[cacheKey('rhythm', 'TR-03', 1)]!
  const cue1 = snapshot.derived.cache[cacheKey('pageTurnCue', 'TR-03', 1)]!
  const base1 = snapshot.derived.cache[cacheKey('baseline', 'TR-03', 1)]!
  assert.equal(rhythm1.version, snapshot.baselineVersion)
  assert.equal(cue1.version, snapshot.baselineVersion)
  assert.equal(base1.version, snapshot.baselineVersion)
  // 同一声部的其他小节节奏检查沿用
  assert.deepEqual(snapshot.derived.cache[touchedOtherKey], otherBefore)
  // 其他声部完全不动
  assert.deepEqual(snapshot.derived.cache[untouchedKey], untouchedEntry)
  // 日志里有失效、重算、复用三类记录
  const actions = snapshot.derived.log.map((entry) => entry.action)
  assert.ok(actions.includes('invalidate'))
  assert.ok(actions.includes('recompute'))
  assert.ok(actions.includes('reuse'))
})

test('指挥批注只令出版基线失效，节奏与换页结果沿用', () => {
  const initial = baseSnapshot()
  const rhythmKey = cacheKey('rhythm', 'TR-03', 2)
  const cueKey = cacheKey('pageTurnCue', 'TR-03', 2)
  const rhythmBefore = initial.derived.cache[rhythmKey]!
  const cueBefore = initial.derived.cache[cueKey]!
  const edit = { kind: 'comment' as const, comment: { ...structuredClone(initial.comments[0]!), resolved: true }, before: structuredClone(initial.comments[0]!) }
  const { snapshot } = commitRevision(initial, request(initial, '指挥', [edit], '应用批注'), TIME)
  assert.deepEqual(snapshot.derived.cache[rhythmKey], rhythmBefore)
  assert.deepEqual(snapshot.derived.cache[cueKey], cueBefore)
  snapshot.tracks.forEach((track) => {
    assert.equal(snapshot.derived.cache[cacheKey('baseline', track.id, 2)]!.version, snapshot.baselineVersion)
  })
})

test('小节锚点换算：音符下标落在正确小节', () => {
  assert.equal(measureOfIndex(0), 1)
  assert.equal(measureOfIndex(3), 1)
  assert.equal(measureOfIndex(4), 2)
  assert.equal(measureOfIndex(11), 3)
})
