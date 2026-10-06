import type { ScoreComment, Track } from '../types'

/**
 * 分谱换页设置。
 * 与总谱力度（音符）、指挥批注（评论）并列的第三类改动，
 * 三者在同一次保存中汇成同一次排练校订。
 */
export interface PartSettings {
  cueEnabled: boolean
  /** 每个声部的换页提示提前量（小节数），键为 trackId */
  pageTurnByTrack: Record<string, number>
}

export const defaultPartSettings: PartSettings = {
  cueEnabled: true,
  pageTurnByTrack: { 'TR-01': 2, 'TR-02': 2, 'TR-03': 2, 'TR-04': 2 },
}

/**
 * 工作草稿 = 三类改动的合并体。
 * 一次“形成版本”提交把音符、评论、换页设置作为同一次校订写入台账。
 */
export interface RevisionDraft {
  tracks: Track[]
  comments: ScoreComment[]
  partSettings: PartSettings
}

/**
 * 一次排练校订（提交记录）。
 * 每次保存都记下：修改的小节、当时的谱面版本、提交标记。
 */
export interface RevisionCommit {
  /** 提交标记：客户端生成的幂等键，写盘中断后按它续做，同一校订不产生两份记录 */
  commitId: string
  /** 当时的谱面版本（提交所基于的出版基线） */
  baseVersion: string
  /** 提交后成为的新基线版本；若被冲突篮收留则为 null */
  newVersion: string | null
  author: string
  time: string
  summary: string
  /** 本次改动涉及的小节（0 基索引），跨声部取并集 */
  measures: number[]
  /** 合并后的三类改动快照 */
  draft: RevisionDraft
  status: 'accepted' | 'conflict'
}

/** 冲突篮中收留的、后到的校订 */
export interface ConflictEntry {
  commit: RevisionCommit
  /** 与已接受片段落在同一小节、真正冲突的小节 */
  conflictingMeasures: number[]
  /** 未被先完成者改动、可安全补入的小节 */
  nonConflictingMeasures: number[]
  reason: string
}

/** 节奏检查结果（按小节缓存） */
export interface RhythmCheckResult {
  measure: number
  complete: boolean
  voices: { trackId: string; trackName: string; beats: number; expected: number }[]
}

/** 换页提示结果（按小节缓存） */
export interface PageTurnHintResult {
  measure: number
  needed: boolean
  targetTrackId: string | null
  targetTrackName: string | null
}

/**
 * 派生结果缓存。
 * 任意小节变化后，只让该小节关联的节奏检查与换页提示失效重算，
 * 未涉及声部的结果原样保留、沿用。
 */
export interface DerivedCache {
  rhythmCheck: Record<number, RhythmCheckResult>
  pageTurnHints: Record<number, PageTurnHintResult>
  /** 缓存所对应的基线版本，用于判断是否整体过期 */
  baselineVersion: string
}
