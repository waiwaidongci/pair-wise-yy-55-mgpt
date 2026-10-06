import type {
  ConflictEntry, DerivedState, DomainSnapshot, PageTurnSettings, RehearsalRevision,
  RevisionSpec, ScoreComment, ScoreNote, ScoreVersion, Track,
} from './types'
import { defaultPageTurns, initialDerived, measureOfIndex } from './changes'

interface LegacyState {
  tracks?: Track[]
  comments?: ScoreComment[]
  versions?: ScoreVersion[]
}

/** 旧版本的本地草稿（两处窗口轮流保存时留下的 yy55-score-draft） */
export function isLegacyDraft(raw: unknown): raw is LegacyState {
  if (!raw || typeof raw !== 'object') return false
  const data = raw as LegacyState
  return Boolean(data.tracks?.length || data.comments?.length)
}

/**
 * 旧数据升级：
 * - 音符逐音保留（id / key / 力度 / 连音 / 表情）
 * - 评论保留并作为小节锚点挂在原 measure 上
 * - 旧“版本”不丢弃，升级为已提交的排练校订记录（状态 committed，全部并入基线）
 * - 缺失的换页设置按默认补齐，并初算派生结果
 */
export function migrateLegacy(legacy: LegacyState, time: string): DomainSnapshot {
  const tracks: Track[] = structuredClone(legacy.tracks ?? [])
  const comments: ScoreComment[] = structuredClone(legacy.comments ?? [])
  const pageTurns: Record<string, PageTurnSettings> = defaultPageTurns(tracks)

  const revisions: RehearsalRevision[] = []
  ;(legacy.versions ?? []).forEach((version, index) => {
    const applied: RevisionSpec[] = []
    const numericVersion = Number(String(version.id).replace(/^v/i, ''))
    const order = Number.isFinite(numericVersion) ? numericVersion : index + 1
    Object.entries(version.trackNotes ?? {}).forEach(([trackId, legacyNotes]) => {
      const notes: ScoreNote[] = legacyNotes
      notes.forEach((note, noteIndex) => {
        applied.push({
          kind: 'note', measure: measureOfIndex(noteIndex), trackId,
          summary: `${version.summary} · ${note.key.replace('/', '')}（${note.dynamic}）`,
          note: structuredClone(note), before: null, index: noteIndex,
        })
      })
    })
    revisions.push({
      token: `legacy-${version.id}`, seq: order, versionId: version.id,
      editor: version.author, time: version.time, message: version.summary,
      baseVersion: order - 1, newVersion: order, status: 'committed',
      applied, blocked: [],
    })
  })
  // revisions 在新模型里按时间倒序存储
  revisions.sort((a, b) => b.newVersion - a.newVersion)
  const baselineVersion = revisions.length ? Math.max(...revisions.map((revision) => revision.newVersion)) : 12
  const conflicts: ConflictEntry[] = []
  const seeded: Omit<DomainSnapshot, 'derived'> = {
    schemaVersion: 2, tracks, comments, pageTurns, revisions, conflicts, baselineVersion,
    nextSeq: baselineVersion + 1,
  }
  const derived: DerivedState = initialDerived(seeded, time)
  derived.log.unshift({ time, kind: 'baseline', key: '*', action: 'reuse', detail: `旧数据升级：保留 ${tracks.reduce((sum, track) => sum + track.notes.length, 0)} 个音符、${comments.length} 条评论锚点、${revisions.length} 份历史校订` })
  return { ...seeded, derived }
}
