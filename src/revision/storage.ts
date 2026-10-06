import type { EngineState } from './engine'
import { createInitialEngineState, recomputeAllDerived } from './engine'
import type { RevisionCommit } from './types'

const LEDGER_KEY = 'yy55-revision-ledger'
const LEGACY_DRAFT_KEY = 'yy55-score-draft'

/**
 * 从磁盘载入引擎状态。
 * - 新格式：直接读台账，并按提交标记做中断恢复与幂等去重。
 * - 旧格式：升级迁移，保住已有音符、评论与小节锚点。
 */
export function loadEngineState(): EngineState {
  const raw = localStorage.getItem(LEDGER_KEY)
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as Partial<EngineState>
      const state = createInitialEngineState()
      if (parsed.baseline) state.baseline = parsed.baseline
      if (Array.isArray(parsed.tracks) && parsed.tracks.length) state.tracks = parsed.tracks
      if (Array.isArray(parsed.comments)) state.comments = parsed.comments
      if (parsed.partSettings) state.partSettings = parsed.partSettings
      state.draftBaseVersion = parsed.draftBaseVersion ?? state.baseline.version
      state.commits = dedupeCommits(parsed.commits ?? state.commits)
      state.conflictBasket = parsed.conflictBasket ?? []
      state.derived = parsed.derived ?? state.derived
      state.lastCommitId = parsed.lastCommitId ?? null
      state.migrated = parsed.migrated ?? false
      state.migrationNote = parsed.migrationNote ?? null

      // 写盘中断恢复：pendingCommitId 已记下但台账里没有对应提交记录
      if (parsed.pendingCommitId && !state.commits.some((item) => item.commitId === parsed.pendingCommitId)) {
        state.recoveredCommitId = parsed.pendingCommitId
      }
      state.pendingCommitId = null

      // 派生缓存若与基线版本不一致则整体重算（只补缺失小节，沿用未涉及结果）
      if (state.derived.baselineVersion !== state.baseline.version) {
        state.derived = { rhythmCheck: {}, pageTurnHints: {}, baselineVersion: state.baseline.version }
        recomputeAllDerived(state)
      }
      // 恢复/升级提示仅当次有效：持久化时清掉，避免每次载入重复弹出
      const notice = {
        recoveredCommitId: state.recoveredCommitId,
        migrated: state.migrated,
        migrationNote: state.migrationNote,
      }
      state.recoveredCommitId = null
      state.migrated = false
      state.migrationNote = null
      persistEngineState(state)
      state.recoveredCommitId = notice.recoveredCommitId
      state.migrated = notice.migrated
      state.migrationNote = notice.migrationNote
      return state
    } catch {
      // 台账损坏时退化为迁移，避免白屏
    }
  }
  return migrateFromLegacy()
}

/** 幂等：同一提交标记只保留第一条记录，同一校订不产生两份记录 */
function dedupeCommits(commits: RevisionCommit[]): RevisionCommit[] {
  const seen = new Set<string>()
  const result: RevisionCommit[] = []
  for (const commit of commits) {
    if (seen.has(commit.commitId)) continue
    seen.add(commit.commitId)
    result.push(commit)
  }
  return result
}

/**
 * 旧数据升级：把旧版草稿（音符 + 评论）并入新的合并草稿，
 * 出版基线仍从种子 v12 起步，保住已有音符、评论与小节锚点。
 */
function migrateFromLegacy(): EngineState {
  const state = createInitialEngineState()
  const legacyRaw = localStorage.getItem(LEGACY_DRAFT_KEY)
  if (legacyRaw) {
    try {
      const legacy = JSON.parse(legacyRaw) as { tracks?: EngineState['tracks']; comments?: EngineState['comments'] }
      const noteCount = Array.isArray(legacy.tracks)
        ? legacy.tracks.reduce((sum, track) => sum + (track.notes?.length ?? 0), 0)
        : 0
      const commentCount = Array.isArray(legacy.comments) ? legacy.comments.length : 0
      const measureAnchors = Array.isArray(legacy.comments) ? new Set(legacy.comments.map((item) => item.measure)).size : 0
      if (Array.isArray(legacy.tracks) && legacy.tracks.length) state.tracks = legacy.tracks
      if (Array.isArray(legacy.comments) && legacy.comments.length) state.comments = legacy.comments
      state.draftBaseVersion = state.baseline.version
      state.migrated = true
      state.migrationNote = `已升级旧数据：保住 ${noteCount} 个音符、${commentCount} 条评论、${measureAnchors} 个小节锚点`
    } catch {
      // 旧草稿损坏则忽略，使用全新状态
    }
  }
  recomputeAllDerived(state)
  persistEngineState(state)
  return state
}

/** 原子化写盘：整份台账一次性写入，提交标记幂等去重 */
export function persistEngineState(state: EngineState): void {
  const toWrite: EngineState = {
    ...state,
    commits: dedupeCommits(state.commits),
    pendingCommitId: state.pendingCommitId,
  }
  try {
    localStorage.setItem(LEDGER_KEY, JSON.stringify(toWrite))
  } catch {
    // 存储配额或隐私模式下静默失败，不影响当次编辑
  }
}
