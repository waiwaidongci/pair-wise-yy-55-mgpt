import type { PageTurnSettings, ScoreComment, Track } from './types'

export * from './journal'
import { safeRead, safeWrite, type KVStore } from './journal'
import { WORKING_KEY } from './journal'

export interface WorkingDraft {
  tracks: Track[]
  comments: ScoreComment[]
  pageTurns: Record<string, PageTurnSettings>
}

export function writeWorking(storage: KVStore, working: WorkingDraft): boolean {
  return safeWrite(storage, WORKING_KEY, working)
}

export function readWorking(storage: KVStore): WorkingDraft | null {
  return safeRead<WorkingDraft>(storage, WORKING_KEY)
}

export function clearWorking(storage: KVStore) { storage.removeItem(WORKING_KEY) }