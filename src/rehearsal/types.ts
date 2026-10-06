// 排练校订领域的核心类型定义

export interface ScoreNote {
  id: string
  key: string
  duration: 'q' | 'h' | '8'
  accidental?: '#' | 'b' | 'n'
  dynamic: 'pp' | 'p' | 'mp' | 'mf' | 'f' | 'ff'
  tie: boolean
  expression: string
}

export interface Track {
  id: string
  name: string
  instrument: string
  clef: 'treble' | 'bass' | 'alto'
  transposition: number
  color: string
  notes: ScoreNote[]
}

export interface ScoreComment {
  id: string
  measure: number
  author: string
  content: string
  resolved: boolean
}

export interface ScoreVersion {
  id: string
  author: string
  time: string
  summary: string
  trackNotes: Record<string, ScoreNote[]>
}

// —— 三处窗口汇入同一次排练校订的变更描述 ——

/** 总谱力度 / 音符编辑（总谱编辑窗口） */
export interface NoteEdit {
  kind: 'note'
  trackId: string
  /** 该音符在工作区声部中的下标，用于换算小节锚点 */
  index: number
  before: ScoreNote | null
  after: ScoreNote | null
}

/** 指挥批注（指挥意见窗口） */
export interface CommentEdit {
  kind: 'comment'
  comment: ScoreComment
  /** null 表示新增批注 */
  before: ScoreComment | null
}

/** 分谱换页（分谱出版窗口） */
export interface PageTurnEdit {
  kind: 'pageTurn'
  trackId: string
  cue: boolean
  beforeMeasure: number
  afterMeasure: number
}

export type AnyEdit = NoteEdit | CommentEdit | PageTurnEdit

/** 落进校订记录里的小节级条目 */
export interface RevisionSpec {
  kind: 'note' | 'comment' | 'pageTurn'
  measure: number
  trackId?: string
  summary: string
  note?: ScoreNote
  before?: ScoreNote | ScoreComment | null
  comment?: ScoreComment
  cue?: boolean
  afterMeasure?: number
  /** 暂存期内该条目涉及的音符下标，供窗口再次编辑时去重 */
  index?: number
}

/** 一次排练校订的提交请求：带提交标记与当时的谱面版本 */
export interface RevisionRequest {
  token: string
  editor: string
  message: string
  baseVersion: number
  edits: AnyEdit[]
  time: string
}

export type RevisionStatus = 'committed' | 'partial' | 'quarantined'

/** 已落账的排练校订记录 */
export interface RehearsalRevision {
  token: string
  seq: number
  versionId: string
  editor: string
  time: string
  message: string
  /** 提交时所依据的谱面版本号 */
  baseVersion: number
  /** 提交后形成的谱面版本号 */
  newVersion: number
  status: RevisionStatus
  /** 真正并入出版基线的小节条目 */
  applied: RevisionSpec[]
  /** 进了冲突篮的小节条目（可空） */
  blocked: RevisionSpec[]
  /** 冲突篮条目接受后补登记，指向新校订记录，避免与原记录重复 */
  appliedAsToken?: string
  conflictIds?: string[]
}

/** 冲突篮：未覆盖已接受片段的另一份改动（按小节格子聚合成一个片段） */
export interface ConflictEntry {
  id: string
  token: string
  editor: string
  time: string
  baseVersion: number
  /** 该小节片段包含的全部条目（同一小节的多个音符） */
  specs: RevisionSpec[]
  status: 'pending' | 'accepted' | 'rejected'
  appliedRevisionToken?: string
}

export const conflictHead = (entry: ConflictEntry): RevisionSpec => entry.specs[0]!

export interface PendingCommit {
  token: string
  request: RevisionRequest
  phase: 'journaled' | 'manifest'
  startedAt: string
}

export interface WorkingChange {
  id: string
  edit: AnyEdit
  spec: RevisionSpec
  time: string
}

/** 每个声部的分谱换页设置（分谱窗口） */
export interface PageTurnSettings {
  cue: boolean
  pageTurnMeasure: number
}

export type DerivedKind = 'rhythm' | 'pageTurnCue' | 'baseline'

export interface DerivedEntry {
  version: number
  value: string
  updatedAt: string
}

export interface DerivedLogEntry {
  time: string
  kind: DerivedKind
  key: string
  action: 'invalidate' | 'recompute' | 'reuse'
  detail: string
  token?: string
}

/** 按小节-声部维度缓存的派生结果：节奏检查、换页提示、出版基线 */
export interface DerivedState {
  cache: Partial<Record<string, DerivedEntry>>
  log: DerivedLogEntry[]
  recomputeCount: number
  reuseCount: number
}

export interface AffectedCell {
  kind: DerivedKind
  measure: number
  trackId?: string
}

/** 崩溃续做日志与完整快照 */
export interface DomainSnapshot {
  schemaVersion: 2
  tracks: Track[]
  comments: ScoreComment[]
  pageTurns: Record<string, PageTurnSettings>
  revisions: RehearsalRevision[]
  conflicts: ConflictEntry[]
  derived: DerivedState
  baselineVersion: number
  nextSeq: number
}

/** 本地工作区（三处窗口共享的一份暂存） */
export interface WorkingState {
  changes: WorkingChange[]
  pendingCommit: PendingCommit | null
}
