import assert from 'node:assert/strict'
import { test } from 'node:test'
import { migrateLegacy, isLegacyDraft } from '../src/rehearsal/migration'
import { seedComments, seedTracks, seedVersions } from '../src/mock'

const TIME = '09:00:00'

test('旧数据升级保住所有音符、评论小节锚点与历史版本', () => {
  const legacy = { tracks: structuredClone(seedTracks), comments: structuredClone(seedComments), versions: structuredClone(seedVersions) }
  const snapshot = migrateLegacy(legacy, TIME)

  // 音符逐音保留
  assert.equal(snapshot.tracks.length, seedTracks.length)
  snapshot.tracks.forEach((track, trackIndex) => {
    assert.equal(track.notes.length, seedTracks[trackIndex]!.notes.length)
    track.notes.forEach((note, index) => {
      const original = seedTracks[trackIndex]!.notes[index]!
      assert.equal(note.key, original.key)
      assert.equal(note.dynamic, original.dynamic)
      assert.equal(note.tie, original.tie)
      assert.equal(note.expression, original.expression)
      assert.equal(note.id, original.id)
    })
  })
  // 评论与小节锚点保留
  assert.equal(snapshot.comments.length, seedComments.length)
  snapshot.comments.forEach((comment, index) => {
    assert.equal(comment.id, seedComments[index]!.id)
    assert.equal(comment.measure, seedComments[index]!.measure)
    assert.equal(comment.content, seedComments[index]!.content)
    assert.equal(comment.resolved, seedComments[index]!.resolved)
  })
  // 旧版本升级为已提交校订
  const upgraded = snapshot.revisions.filter((revision) => revision.token.startsWith('legacy-'))
  assert.equal(upgraded.length, seedVersions.length)
  assert.ok(upgraded.every((revision) => revision.status === 'committed'))
  // 新版本号与换页默认设置补齐
  assert.equal(snapshot.schemaVersion, 2)
  assert.ok(snapshot.pageTurns['TR-01'])
  // 派生缓存已初算
  assert.ok(snapshot.derived.cache['rhythm:TR-01:m1'])
})

test('没有版本信息的旧草稿也能升级，且评论锚点不丢', () => {
  const legacy = {
    tracks: structuredClone(seedTracks),
    comments: [{ id: 'CM-X', measure: 6, author: '指挥', content: '旧草稿里的批注', resolved: false }],
  }
  const snapshot = migrateLegacy(legacy, TIME)
  assert.equal(snapshot.comments[0]!.measure, 6)
  assert.equal(snapshot.comments[0]!.content, '旧草稿里的批注')
  assert.equal(snapshot.revisions.filter((revision) => revision.token.startsWith('legacy-')).length, 0)
  assert.equal(snapshot.baselineVersion, 12)
  assert.ok(isLegacyDraft(legacy))
  assert.equal(isLegacyDraft({}), false)
  assert.equal(isLegacyDraft(null), false)
})

test('升级不会损坏或丢弃力度与连音等属性', () => {
  const snapshot = migrateLegacy({ tracks: structuredClone(seedTracks), comments: [] }, TIME)
  assert.equal(snapshot.tracks[2]!.notes[4]!.dynamic, 'mf')
  assert.equal(snapshot.tracks[0]!.notes[2]!.tie, true)
  assert.equal(snapshot.tracks[0]!.notes[3]!.expression, 'dolce')
})
