import type { ScoreComment, ScoreNote, Track } from '../types'
import { seedComments, seedTracks } from '../mock'
import type {
  ConflictEntry,
  DerivedCache,
  PageTurnHintResult,
  PartSettings,
  RevisionCommit,
  RevisionDraft,
  RhythmCheckResult,
} from './types'
import { defaultPartSettings } from './types'

export const MEASURE_BEATS = 4
export const NOTES_PER_MEASURE = 4

/** 引擎状态：工作草稿（三类改动合并体）+ 出版基线 + 台账 + 冲突篮 + 派生缓存 */
export interface EngineState {
  tracks: Track[]
  comments: ScoreComment[]
  partSettings: PartSettings
  /** 当时的谱面版本：本草稿所基于的出版基线 */
  draftBaseVersion: string
  /** 出版基线（已接受的最新版本） */
  baseline: { version: string; tracks: Track[]; comments: ScoreComment[]; partSettings: PartSettings }
  /** 已接受的校订台账（新→旧） */
  commits: RevisionCommit[]
  /** 冲突篮：后到的、未覆盖已接受片段的校订 */
  conflictBasket: ConflictEntry[]
  /** 按小节缓存的派生结果 */
  derived: DerivedCache
  /** 最近一次提交标记 */
  lastCommitId: string | null
  /** 写盘中的提交标记（用于中断后续做） */
  pendingCommitId: string | null
  /** 中断后续做时恢复到的提交标记 */
  recoveredCommitId: string | null
  /** 是否由旧数据升级而来 */
  migrated: boolean
  migrationNote: string | null
}

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

export function measureOfNoteIndex(noteIndex: number): number {
  return Math.floor(noteIndex / NOTES_PER_MEASURE)
}

export function numMeasures(state: EngineState): number {
  return Math.max(1, ...state.tracks.map((track) => Math.ceil(track.notes.length / NOTES_PER_MEASURE)))
}

export function clampMeasure(measure: number, state: EngineState): number {
  return Math.min(Math.max(0, measure), numMeasures(state) - 1)
}

export function versionNumber(version: string): number {
  return parseInt(version.replace(/^v/, ''), 10) || 0
}

export function bumpVersion(version: string): string {
  return `v${versionNumber(version) + 1}`
}

/** 客户端生成的提交标记：写盘中断后按它续做，同一校订幂等 */
export function generateCommitId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID()
  return `c-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

function nowTime(): string {
  return new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false })
}

function cloneDraft(draft: RevisionDraft): RevisionDraft {
  return {
    tracks: structuredClone(draft.tracks),
    comments: structuredClone(draft.comments),
    partSettings: {
      cueEnabled: draft.partSettings.cueEnabled,
      pageTurnByTrack: { ...draft.partSettings.pageTurnByTrack },
    },
  }
}

/** 出版基线初始内容 = 种子总谱 v12 */
export function seedBaseline(): EngineState['baseline'] {
  return {
    version: 'v12',
    tracks: structuredClone(seedTracks),
    comments: structuredClone(seedComments),
    partSettings: {
      cueEnabled: defaultPartSettings.cueEnabled,
      pageTurnByTrack: { ...defaultPartSettings.pageTurnByTrack },
    },
  }
}

function freshDraftFrom(baseline: EngineState['baseline']): RevisionDraft {
  return cloneDraft(baseline)
}

export function createInitialEngineState(): EngineState {
  const baseline = seedBaseline()
  const draft = freshDraftFrom(baseline)
  return {
    tracks: draft.tracks,
    comments: draft.comments,
    partSettings: draft.partSettings,
    draftBaseVersion: baseline.version,
    baseline,
    commits: seedHistoryCommits(),
    conflictBasket: [],
    derived: emptyDerived(baseline.version),
    lastCommitId: null,
    pendingCommitId: null,
    recoveredCommitId: null,
    migrated: false,
    migrationNote: null,
  }
}

function emptyDerived(baselineVersion: string): DerivedCache {
  return { rhythmCheck: {}, pageTurnHints: {}, baselineVersion }
}

/** 历史出版版本 v11、v12（来自种子数据），台账的起点 */
function seedHistoryCommits(): RevisionCommit[] {
  const baseline = seedBaseline()
  const v12: RevisionCommit = {
    commitId: 'seed-v12',
    baseVersion: 'v11',
    newVersion: 'v12',
    author: '沈青',
    time: '今天 16:28',
    summary: '调整终段和声，补充圆号力度与连音线',
    measures: [2],
    draft: cloneDraft(baseline),
    status: 'accepted',
  }
  const v11: RevisionCommit = {
    commitId: 'seed-v11',
    baseVersion: 'v10',
    newVersion: 'v11',
    author: '方亦',
    time: '今天 14:10',
    summary: '移调单簧管分谱并调整换气标记',
    measures: [0],
    draft: cloneDraft(baseline),
    status: 'accepted',
  }
  return [v12, v11]
}

// ---------------------------------------------------------------------------
// 改动检测：以小节为单位，跨声部取并集
// ---------------------------------------------------------------------------

function noteEqual(a: ScoreNote, b: ScoreNote): boolean {
  return (
    a.id === b.id &&
    a.key === b.key &&
    a.duration === b.duration &&
    a.accidental === b.accidental &&
    a.dynamic === b.dynamic &&
    a.tie === b.tie &&
    a.expression === b.expression
  )
}

/**
 * 比较工作草稿与出版基线，返回发生变化的小节（0 基索引）。
 * 音符/力度按声部逐拍比对，评论按其小节锚点归位，换页设置映射到提示小节。
 */
export function computeChangedMeasures(state: EngineState): number[] {
  const draft: RevisionDraft = { tracks: state.tracks, comments: state.comments, partSettings: state.partSettings }
  const baseline = state.baseline
  const measures = new Set<number>()
  const num = numMeasures(state)
  const add = (m: number) => measures.add(clampMeasure(m, state))

  // 1) 音符 / 力度：逐声部、逐小节比对
  for (const dTrack of draft.tracks) {
    const bTrack = baseline.tracks.find((track) => track.id === dTrack.id)
    if (!bTrack) {
      for (let m = 0; m < num; m++) add(m)
      continue
    }
    if (dTrack.transposition !== bTrack.transposition) {
      for (let m = 0; m < num; m++) add(m)
    }
    const len = Math.max(dTrack.notes.length, bTrack.notes.length)
    for (let i = 0; i < len; i++) {
      const dNote = dTrack.notes[i]
      const bNote = bTrack.notes[i]
      if (!dNote || !bNote || !noteEqual(dNote, bNote)) add(measureOfNoteIndex(i))
    }
  }

  // 2) 指挥批注：按小节锚点归位
  for (const comment of draft.comments) {
    const bComment = baseline.comments.find((item) => item.id === comment.id)
    if (!bComment || bComment.measure !== comment.measure || bComment.content !== comment.content || bComment.resolved !== comment.resolved) {
      add(comment.measure - 1)
    }
  }
  for (const bComment of baseline.comments) {
    if (!draft.comments.find((item) => item.id === bComment.id)) add(bComment.measure - 1)
  }

  // 3) 分谱换页：提前量变化映射到提示小节，提示音开关变化影响第 1、2 小节
  for (const trackId of Object.keys(draft.partSettings.pageTurnByTrack)) {
    const offset = draft.partSettings.pageTurnByTrack[trackId]!
    const baselineOffset = baseline.partSettings.pageTurnByTrack[trackId]
    if (offset !== baselineOffset) add(offset + 3)
  }
  if (draft.partSettings.cueEnabled !== baseline.partSettings.cueEnabled) {
    add(1)
    add(2)
  }

  return [...measures].sort((a, b) => a - b)
}

// ---------------------------------------------------------------------------
// 派生结果：节奏检查、换页提示（按小节缓存，按需重算）
// ---------------------------------------------------------------------------

function computeRhythmCheck(state: EngineState, measure: number): RhythmCheckResult {
  const voices = state.tracks.map((track) => {
    const slice = track.notes.slice(measure * NOTES_PER_MEASURE, measure * NOTES_PER_MEASURE + NOTES_PER_MEASURE)
    const beats = slice.reduce((sum, note) => sum + (note.duration === 'h' ? 2 : note.duration === 'q' ? 1 : 0.5), 0)
    return { trackId: track.id, trackName: track.name, beats, expected: MEASURE_BEATS }
  })
  return { measure, complete: voices.every((voice) => voice.beats === voice.expected), voices }
}

function computePageTurnHint(state: EngineState, measure: number): PageTurnHintResult {
  if (!state.partSettings.cueEnabled) return { measure, needed: false, targetTrackId: null, targetTrackName: null }
  // 提示音出现在第 1、2 小节的换页处，预告下一声部
  if (measure !== 1 && measure !== 2) return { measure, needed: false, targetTrackId: null, targetTrackName: null }
  const target = state.tracks[1] ?? null
  return { measure, needed: true, targetTrackId: target?.id ?? null, targetTrackName: target?.name ?? null }
}

/** 只重算指定小节的派生结果，未涉及小节的缓存原样保留、沿用 */
export function recomputeDerived(state: EngineState, measures: number[]): void {
  for (const raw of measures) {
    const measure = clampMeasure(raw, state)
    state.derived.rhythmCheck[measure] = computeRhythmCheck(state, measure)
    state.derived.pageTurnHints[measure] = computePageTurnHint(state, measure)
  }
  state.derived.baselineVersion = state.baseline.version
}

/** 令指定小节的派生结果失效（下次访问前重算） */
export function invalidateDerived(state: EngineState, measures: number[]): void {
  for (const raw of measures) {
    const measure = clampMeasure(raw, state)
    delete state.derived.rhythmCheck[measure]
    delete state.derived.pageTurnHints[measure]
  }
}

export function recomputeAllDerived(state: EngineState): void {
  const all = Array.from({ length: numMeasures(state) }, (_, i) => i)
  recomputeDerived(state, all)
}

// ---------------------------------------------------------------------------
// 基线合并：把草稿在指定小节上的改动并入出版基线（小节粒度）
// ---------------------------------------------------------------------------

function applyDraftToBaseline(baseline: EngineState['baseline'], draft: RevisionDraft, measures: number[]): void {
  for (const dTrack of draft.tracks) {
    let bTrack = baseline.tracks.find((track) => track.id === dTrack.id)
    if (!bTrack) {
      baseline.tracks.push(structuredClone(dTrack))
      continue
    }
    const trackMeasures = Math.ceil(Math.max(dTrack.notes.length, bTrack.notes.length) / NOTES_PER_MEASURE)
    for (const measure of measures) {
      if (measure < 0 || measure >= trackMeasures) continue
      const start = measure * NOTES_PER_MEASURE
      const incoming = dTrack.notes.slice(start, start + NOTES_PER_MEASURE)
      bTrack.notes.splice(start, incoming.length, ...structuredClone(incoming))
    }
    bTrack.transposition = dTrack.transposition
  }
  baseline.comments = structuredClone(draft.comments)
  baseline.partSettings = {
    cueEnabled: draft.partSettings.cueEnabled,
    pageTurnByTrack: { ...draft.partSettings.pageTurnByTrack },
  }
}

// ---------------------------------------------------------------------------
// 提交：乐观并发，先完成者成为新基线，后到者进冲突篮
// ---------------------------------------------------------------------------

export interface CommitOutcome {
  ok: boolean
  reason?: string
  commit?: RevisionCommit
  conflictingMeasures?: number[]
}

export function commitRevision(state: EngineState, author: string, summary: string): CommitOutcome {
  const measures = computeChangedMeasures(state)
  if (measures.length === 0) return { ok: false, reason: '没有需要提交的修改' }

  const commitId = generateCommitId()
  const baseVersion = state.draftBaseVersion
  const draft = cloneDraft({ tracks: state.tracks, comments: state.comments, partSettings: state.partSettings })

  if (baseVersion === state.baseline.version) {
    // 先完成的一份成为新的出版基线
    const newVersion = bumpVersion(state.baseline.version)
    const commit: RevisionCommit = {
      commitId,
      baseVersion,
      newVersion,
      author,
      time: nowTime(),
      summary,
      measures,
      draft,
      status: 'accepted',
    }
    state.pendingCommitId = commitId
    applyDraftToBaseline(state.baseline, draft, measures)
    state.baseline.version = newVersion
    state.commits.unshift(commit)
    state.lastCommitId = commitId
    state.pendingCommitId = null
    // 提交后草稿回到新基线，三类改动重新合并
    const fresh = freshDraftFrom(state.baseline)
    state.tracks = fresh.tracks
    state.comments = fresh.comments
    state.partSettings = fresh.partSettings
    state.draftBaseVersion = newVersion
    // 只让本次涉及的小节重算，未涉及声部沿用原结果
    recomputeDerived(state, measures)
    return { ok: true, commit }
  }

  // 另一位把改动留在冲突篮里，不覆盖已接受的片段
  const acceptedSince = state.commits.filter(
    (item) => item.status === 'accepted' && versionNumber(item.newVersion ?? '') > versionNumber(baseVersion),
  )
  const acceptedMeasures = new Set<number>()
  for (const item of acceptedSince) for (const measure of item.measures) acceptedMeasures.add(measure)
  const conflictingMeasures = measures.filter((measure) => acceptedMeasures.has(measure))
  const nonConflictingMeasures = measures.filter((measure) => !acceptedMeasures.has(measure))
  const commit: RevisionCommit = {
    commitId,
    baseVersion,
    newVersion: null,
    author,
    time: nowTime(),
    summary,
    measures,
    draft,
    status: 'conflict',
  }
  state.conflictBasket.unshift({
    commit,
    conflictingMeasures,
    nonConflictingMeasures,
    reason: `基线已从 ${baseVersion} 推进到 ${state.baseline.version}，先完成的校订已成为出版基线`,
  })
  return { ok: false, commit, conflictingMeasures, reason: 'conflict' }
}

// ---------------------------------------------------------------------------
// 冲突篮：按提交标记续做，只补入未被接受的小节，不覆盖已接受片段
// ---------------------------------------------------------------------------

export interface ReapplyOutcome {
  applied: number[]
  stillConflicting: number[]
  commit?: RevisionCommit
}

/** 判断某小节在两个快照之间是否被改动过 */
function measureChangedBetween(a: RevisionDraft, b: RevisionDraft, measure: number): boolean {
  for (const aTrack of a.tracks) {
    const bTrack = b.tracks.find((track) => track.id === aTrack.id)
    if (!bTrack) return true
    const aSlice = aTrack.notes.slice(measure * NOTES_PER_MEASURE, measure * NOTES_PER_MEASURE + NOTES_PER_MEASURE)
    const bSlice = bTrack.notes.slice(measure * NOTES_PER_MEASURE, measure * NOTES_PER_MEASURE + NOTES_PER_MEASURE)
    if (aSlice.length !== bSlice.length) return true
    for (let i = 0; i < aSlice.length; i++) {
      const aNote = aSlice[i]!
      const bNote = bSlice[i]!
      if (!noteEqual(aNote, bNote)) return true
    }
    if (aTrack.transposition !== bTrack.transposition) return true
  }
  return false
}

export function reapplyConflict(state: EngineState, commitId: string): ReapplyOutcome {
  const index = state.conflictBasket.findIndex((entry) => entry.commit.commitId === commitId)
  if (index < 0) return { applied: [], stillConflicting: [] }
  const entry = state.conflictBasket[index]!
  const parked = entry.commit

  // 还原该提交所基于的基线快照，用于判断哪些小节已被先完成者改过
  const baseCommit = state.commits.find((item) => item.status === 'accepted' && item.newVersion === parked.baseVersion)
  const baseSnapshot: RevisionDraft = baseCommit ? baseCommit.draft : cloneDraft(state.baseline)

  const applicable = entry.nonConflictingMeasures.filter(
    (measure) => !measureChangedBetween(state.baseline, baseSnapshot, measure),
  )
  const stillConflicting = entry.conflictingMeasures.concat(
    entry.nonConflictingMeasures.filter((measure) => measureChangedBetween(state.baseline, baseSnapshot, measure)),
  )

  if (applicable.length === 0) return { applied: [], stillConflicting }

  const baseVersion = state.baseline.version
  const newVersion = bumpVersion(baseVersion)
  applyDraftToBaseline(state.baseline, parked.draft, applicable)
  state.baseline.version = newVersion
  const commit: RevisionCommit = {
    commitId: generateCommitId(),
    baseVersion,
    newVersion,
    author: parked.author,
    time: nowTime(),
    summary: `从冲突篮补入：${parked.summary}`,
    measures: applicable,
    draft: cloneDraft(state.baseline),
    status: 'accepted',
  }
  state.commits.unshift(commit)
  state.lastCommitId = commit.commitId
  state.conflictBasket.splice(index, 1)
  // 草稿回到新基线
  const fresh = freshDraftFrom(state.baseline)
  state.tracks = fresh.tracks
  state.comments = fresh.comments
  state.partSettings = fresh.partSettings
  state.draftBaseVersion = newVersion
  recomputeDerived(state, applicable)
  return { applied: applicable, stillConflicting, commit }
}

export function discardConflict(state: EngineState, commitId: string): void {
  const index = state.conflictBasket.findIndex((entry) => entry.commit.commitId === commitId)
  if (index >= 0) state.conflictBasket.splice(index, 1)
}

// ---------------------------------------------------------------------------
// 模拟另一编辑窗口：从同一版谱面同时提交，先完成者得基线
// ---------------------------------------------------------------------------

export function simulateRemoteCommit(state: EngineState): CommitOutcome {
  const baseVersion = state.draftBaseVersion
  const measures = [1]
  const commitId = generateCommitId()
  const remoteDraft = cloneDraft({ tracks: state.tracks, comments: state.comments, partSettings: state.partSettings })
  // 另一窗口的改动：单簧管第 2 小节力度提到 f
  const clarinet = remoteDraft.tracks.find((track) => track.id === 'TR-02')
  if (clarinet) {
    for (let i = 1 * NOTES_PER_MEASURE; i < 2 * NOTES_PER_MEASURE; i++) {
      const note = clarinet.notes[i]
      if (note) note.dynamic = 'f'
    }
  }

  if (baseVersion === state.baseline.version) {
    // 远程窗口先完成，成为新基线；本窗口草稿保持原样（随即落后）
    const newVersion = bumpVersion(state.baseline.version)
    const commit: RevisionCommit = {
      commitId,
      baseVersion,
      newVersion,
      author: '另一窗口 · 方亦',
      time: nowTime(),
      summary: '远程窗口提交：单簧管第 2 小节力度调整为 f',
      measures,
      draft: remoteDraft,
      status: 'accepted',
    }
    state.pendingCommitId = commitId
    applyDraftToBaseline(state.baseline, remoteDraft, measures)
    state.baseline.version = newVersion
    state.commits.unshift(commit)
    state.lastCommitId = commitId
    state.pendingCommitId = null
    recomputeDerived(state, measures)
    return { ok: true, commit }
  }

  // 基线已推进，远程这份同样进冲突篮
  const commit: RevisionCommit = {
    commitId,
    baseVersion,
    newVersion: null,
    author: '另一窗口 · 方亦',
    time: nowTime(),
    summary: '远程窗口提交：单簧管第 2 小节力度调整为 f',
    measures,
    draft: remoteDraft,
    status: 'conflict',
  }
  state.conflictBasket.unshift({
    commit,
    conflictingMeasures: measures,
    nonConflictingMeasures: [],
    reason: `基线已从 ${baseVersion} 推进到 ${state.baseline.version}，先完成的校订已成为出版基线`,
  })
  return { ok: false, commit, conflictingMeasures: measures, reason: 'conflict' }
}
