import assert from 'node:assert/strict'
import { test } from 'node:test'
import { migrateLegacy } from '../src/rehearsal/migration'
import { seedComments, seedTracks, seedVersions } from '../src/mock'
import type { AnyEdit, DomainSnapshot, PendingCommit, RevisionRequest } from '../src/rehearsal/types'
import { MEASURE_SIZE, commitRevision } from '../src/rehearsal/changes'
import {
  JOURNAL_KEY, SNAPSHOT_KEY, appendJournal, clearJournal, readJournal, readSnapshot, writeSnapshot,
} from '../src/rehearsal/journal'
import { MemoryStorage } from './helpers/memoryStorage'

const TIME = '11:30:00'

function baseSnapshot(): DomainSnapshot {
  return migrateLegacy({ tracks: structuredClone(seedTracks), comments: structuredClone(seedComments), versions: structuredClone(seedVersions) }, TIME)
}

function makeRequest(snapshot: DomainSnapshot): RevisionRequest {
  const track = snapshot.tracks[0]!
  const index = MEASURE_SIZE // 第 2 小节
  const before = structuredClone(track.notes[index]!)
  const edits: AnyEdit[] = [{ kind: 'note', trackId: track.id, index, before, after: { ...before, dynamic: 'pp' } }]
  return { token: 'REV-crash-1', editor: '沈青', message: '写盘中断后续做', baseVersion: snapshot.baselineVersion, edits, time: TIME }
}

test('写盘中断后日志仍在，按提交标记续做只产生一份校订记录', () => {
  const storage = new MemoryStorage()
  const initial = baseSnapshot()
  const request = makeRequest(initial)
  const pending: PendingCommit = { token: request.token, request, phase: 'journaled', startedAt: TIME }

  // 阶段 1：提交标记落日志
  appendJournal(storage, pending)
  assert.equal(readJournal(storage).length, 1)

  // 阶段 2：快照写盘中断（只写了一半，读回为 null），日志那一笔此前已完整落盘
  const committed = commitRevision(initial, request, TIME).snapshot
  storage.failNextWrite()
  storage.setItem(SNAPSHOT_KEY, JSON.stringify(committed))
  assert.equal(readSnapshot(storage), null)
  assert.equal(readJournal(storage).length, 1, '中断后提交标记必须仍可用于续做')

  // 续做：以磁盘上最后的好快照（这里是初始快照）重放同一请求
  const recoveredBase = readSnapshot(storage) ?? initial
  const redo = commitRevision(recoveredBase, request, TIME)
  assert.equal(writeSnapshot(storage, redo.snapshot), true)
  clearJournal(storage, request.token)

  assert.equal(readSnapshot(storage)!.revisions.filter((revision) => revision.token === request.token).length, 1)
  assert.equal(readJournal(storage).length, 0)
  assert.equal(readSnapshot(storage)!.tracks[0]!.notes[MEASURE_SIZE]!.dynamic, 'pp')
})

test('即使快照其实已写好、只在确认时中断，续做也不会重复落账（幂等）', () => {
  const storage = new MemoryStorage()
  const initial = baseSnapshot()
  const request = makeRequest(initial)
  appendJournal(storage, { token: request.token, request, phase: 'journaled', startedAt: TIME })

  // 第一次落账成功（模拟磁盘已完整、只是应用在摘除日志前崩溃）
  const once = commitRevision(initial, request, TIME).snapshot
  assert.equal(writeSnapshot(storage, once), true)
  // 日志没来得及摘除就重启；续做时同一标记直接返回既有记录
  const onDisk = readSnapshot(storage)!
  const resume = commitRevision(onDisk, request, TIME)
  assert.equal(resume.snapshot.revisions.filter((revision) => revision.token === request.token).length, 1)
  assert.equal(resume.snapshot.baselineVersion, onDisk.baselineVersion)
  clearJournal(storage, request.token)
  assert.equal(readJournal(storage).length, 0)
})

test('故障注入适配器：半截 JSON 读取返回 null，下一次写入恢复正常', () => {
  const storage = new MemoryStorage()
  storage.failNextWrite()
  const payload = JSON.stringify({ hello: 'world'.repeat(20) })
  storage.setItem(SNAPSHOT_KEY, payload)
  assert.equal(readSnapshot(storage), null)
  storage.setItem(JOURNAL_KEY, JSON.stringify([{ a: 1 }]))
  assert.deepEqual(readJournal(storage), [{ a: 1 }])
})
