import type { DomainSnapshot, PendingCommit } from './types'

export interface KVStore {
  getItem: (key: string) => string | null
  setItem: (key: string, value: string) => void
  removeItem: (key: string) => void
}

export const SNAPSHOT_KEY = 'yy55-rehearsal-snapshot'
export const WORKING_KEY = 'yy55-rehearsal-working'
export const JOURNAL_KEY = 'yy55-rehearsal-journal'
export const LEGACY_DRAFT_KEY = 'yy55-score-draft'

// 写盘故障标志在所有适配器实例间共享（应用每次提交都会新建适配器）
let pendingFault = false
let corruptionHappened = false

/**
 * 带写盘故障注入的持久化适配器：
 * failNextWrite() 后第一次【快照】写入只落一半（模拟写盘中断），再下一次恢复正常，
 * 用于验证“按提交标记续做，同一校订不多出两份记录”。
 */
export class FaultableStorage implements KVStore {
  constructor(private readonly backing: KVStore) {}
  getItem(key: string) { return this.backing.getItem(key) }
  removeItem(key: string) { this.backing.removeItem(key) }
  setItem(key: string, value: string) {
    if (pendingFault && key === SNAPSHOT_KEY) {
      pendingFault = false
      corruptionHappened = true
      this.backing.setItem(key, value.slice(0, Math.max(16, Math.floor(value.length / 2))))
      return
    }
    this.backing.setItem(key, value)
  }
  /** 安排下一次快照写盘中断（静态/实例等价，跨实例共享） */
  static failNextWrite() { pendingFault = true }
  failNextWrite() { pendingFault = true }
  static hadCorruption() { return corruptionHappened }
  static clearCorruption() { corruptionHappened = false }
}

export function safeWrite(storage: KVStore, key: string, value: unknown): boolean {
  try {
    storage.setItem(key, JSON.stringify(value))
    // 校验落盘内容可完整读回，半截 JSON 视为中断
    const raw = storage.getItem(key)
    JSON.parse(raw ?? '')
    return true
  } catch {
    return false
  }
}

export function safeRead<T>(storage: KVStore, key: string): T | null {
  const raw = storage.getItem(key)
  if (!raw) return null
  try { return JSON.parse(raw) as T } catch { return null }
}

export function readJournal(storage: KVStore): PendingCommit[] {
  return safeRead<PendingCommit[]>(storage, JOURNAL_KEY) ?? []
}

/** 登记一笔提交（阶段 1：写提交标记与请求，之后即便中断也可续做） */
export function appendJournal(storage: KVStore, pending: PendingCommit): PendingCommit[] {
  const journal = readJournal(storage).filter((item) => item.token !== pending.token)
  journal.push(pending)
  storage.setItem(JOURNAL_KEY, JSON.stringify(journal))
  return journal
}

/** 阶段 2：提交标记对应的快照落盘成功后，从日志摘除 */
export function clearJournal(storage: KVStore, token: string) {
  const journal = readJournal(storage).filter((item) => item.token !== token)
  if (journal.length) storage.setItem(JOURNAL_KEY, JSON.stringify(journal))
  else storage.removeItem(JOURNAL_KEY)
}

export function writeSnapshot(storage: KVStore, snapshot: DomainSnapshot): boolean {
  return safeWrite(storage, SNAPSHOT_KEY, snapshot)
}

export function readSnapshot(storage: KVStore): DomainSnapshot | null {
  return safeRead<DomainSnapshot>(storage, SNAPSHOT_KEY)
}
