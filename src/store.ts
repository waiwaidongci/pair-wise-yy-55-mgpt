import { configureStore, createSlice, type PayloadAction } from '@reduxjs/toolkit'
import { createApi, fakeBaseQuery } from '@reduxjs/toolkit/query/react'
import type {
  AnyEdit, ConflictEntry, DomainSnapshot, PageTurnSettings, PendingCommit,
  RehearsalRevision, RevisionRequest, ScoreComment, ScoreNote, Track, WorkingChange,
} from './rehearsal/types'
import {
  acceptConflict as acceptConflictPure, commitRevision, defaultPageTurns,
  diffComments, diffPageTurns, diffTracks, editToSpec, measureOfIndex, rejectConflict as rejectConflictPure,
} from './rehearsal/changes'
import {
  LEGACY_DRAFT_KEY, FaultableStorage, readJournal, readSnapshot,
  appendJournal, clearJournal, writeSnapshot, writeWorking, readWorking,
} from './rehearsal/persistence'
import { isLegacyDraft, migrateLegacy } from './rehearsal/migration'
import { seedComments, seedTracks, seedVersions } from './mock'

const nowTime = () => new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false })

export interface WorkingCopy {
  tracks: Track[]
  comments: ScoreComment[]
  pageTurns: Record<string, PageTurnSettings>
}

interface ScoreState {
  domain: DomainSnapshot
  working: WorkingCopy
  selectedTrackId: string
  selectedNoteIndex: number
  history: string[]
  future: string[]
  pendingCommit: PendingCommit | null
  writeInterrupted: boolean
  lastEvent: string
  recoveredDraft: boolean
  initialized: boolean
  conflictMessage: string
}

function buildInitialDomain(): DomainSnapshot {
  return migrateLegacy({ tracks: seedTracks, comments: seedComments, versions: seedVersions }, nowTime())
}

/** 启动顺序：新快照 → 崩溃日志续做 → 旧草稿升级 → 种子 */
function bootstrap(): Pick<ScoreState, 'domain' | 'working' | 'pendingCommit' | 'recoveredDraft'> {
  const storage = new FaultableStorage(localStorage)
  let domain = readSnapshot(storage)
  if (!domain || domain.schemaVersion !== 2) {
    const legacyRaw = localStorage.getItem(LEGACY_DRAFT_KEY)
    if (legacyRaw) {
      try {
        const legacy = JSON.parse(legacyRaw)
        if (isLegacyDraft(legacy)) domain = migrateLegacy(legacy, nowTime())
      } catch { /* 损坏草稿忽略，落到种子 */ }
    }
    domain ??= buildInitialDomain()
    writeSnapshot(storage, domain)
    // 旧草稿已并入新快照，移除旧键避免重复升级
    localStorage.removeItem(LEGACY_DRAFT_KEY)
  }
  const pending = readJournal(storage)[0] ?? null
  let working: WorkingCopy = {
    tracks: structuredClone(domain.tracks), comments: structuredClone(domain.comments),
    pageTurns: structuredClone(domain.pageTurns ?? defaultPageTurns(domain.tracks)),
  }
  let recoveredDraft = false
  const savedWorking = readWorking(storage)
  if (savedWorking && !pending) {
    working = savedWorking
    recoveredDraft = true
  }
  if (pending) working = { tracks: structuredClone(domain.tracks), comments: structuredClone(domain.comments), pageTurns: structuredClone(domain.pageTurns) }
  return { domain, working, pendingCommit: pending, recoveredDraft }
}

const booted = bootstrap()

const initialState: ScoreState = {
  ...booted,
  selectedTrackId: booted.working.tracks[0]?.id ?? 'TR-01',
  selectedNoteIndex: 2,
  history: [], future: [],
  writeInterrupted: Boolean(booted.pendingCommit),
  lastEvent: booted.pendingCommit ? `检测到写盘中断，提交标记 ${booted.pendingCommit.token} 等待续做` : '',
  initialized: false,
  conflictMessage: '',
}

function transposeKey(key: string, semitones: number) {
  const chromatic = ['c','c#','d','d#','e','f','f#','g','g#','a','a#','b']
  const [pitch, octaveText] = key.split('/')
  let index = chromatic.indexOf(pitch!.replace('b', '')) + semitones
  let octave = Number(octaveText)
  while (index < 0) { index += 12; octave -= 1 }
  while (index >= 12) { index -= 12; octave += 1 }
  return `${chromatic[index]}/${octave}`
}

const historySnap = (working: WorkingCopy) => JSON.stringify({ tracks: working.tracks, comments: working.comments, pageTurns: working.pageTurns })
function pushHistory(state: ScoreState) {
  state.history.push(historySnap(state.working))
  if (state.history.length > 40) state.history.shift()
  state.future = []
}

const slice = createSlice({
  name: 'score',
  initialState,
  reducers: {
    initialized(state) { state.initialized = true },
    selectTrack(state, action: PayloadAction<string>) { state.selectedTrackId = action.payload; state.selectedNoteIndex = 0 },
    selectNote(state, action: PayloadAction<number>) { state.selectedNoteIndex = action.payload },
    addNote(state) {
      pushHistory(state)
      const track = state.working.tracks.find((item) => item.id === state.selectedTrackId)!
      const template = track.notes[Math.min(track.notes.length - 1, state.selectedNoteIndex)]
      track.notes.splice(state.selectedNoteIndex + 1, 0, { id: `N-${Date.now()}`, key: template?.key ?? 'c/4', duration: 'q', dynamic: template?.dynamic ?? 'mf', tie: false, expression: '' })
      state.selectedNoteIndex += 1
      state.lastEvent = `总谱窗口：${track.name} 第 ${measureOfIndex(state.selectedNoteIndex)} 小节新增音符`
    },
    removeNote(state) {
      pushHistory(state)
      const track = state.working.tracks.find((item) => item.id === state.selectedTrackId)!
      if (track.notes.length > 1) { track.notes.splice(state.selectedNoteIndex, 1); state.lastEvent = `总谱窗口：${track.name} 第 ${measureOfIndex(state.selectedNoteIndex)} 小节删除音符` }
      state.selectedNoteIndex = Math.max(0, state.selectedNoteIndex - 1)
    },
    updateNote(state, action: PayloadAction<Partial<ScoreNote>>) {
      pushHistory(state)
      const track = state.working.tracks.find((item) => item.id === state.selectedTrackId)!
      Object.assign(track.notes[state.selectedNoteIndex]!, action.payload)
      state.lastEvent = `总谱窗口：${track.name} 第 ${measureOfIndex(state.selectedNoteIndex)} 小节音符属性改动`
    },
    transposeTrack(state, action: PayloadAction<number>) {
      pushHistory(state)
      const track = state.working.tracks.find((item) => item.id === state.selectedTrackId)!
      track.notes.forEach((note) => { note.key = transposeKey(note.key, action.payload) })
      track.transposition += action.payload
      state.lastEvent = `总谱窗口：${track.name} 全部小节移调 ${action.payload > 0 ? '+' : ''}${action.payload}`
    },
    setPageTurn(state, action: PayloadAction<{ trackId: string; patch: Partial<PageTurnSettings> }>) {
      pushHistory(state)
      const { trackId, patch } = action.payload
      state.working.pageTurns[trackId] = { ...state.working.pageTurns[trackId]!, ...patch }
      state.lastEvent = `分谱窗口：${state.working.tracks.find((item) => item.id === trackId)!.name} 换页设置改动`
    },
    addComment(state, action: PayloadAction<{ measure: number; content: string; author: string }>) {
      pushHistory(state)
      state.working.comments.push({ id: `CM-${Date.now()}`, measure: action.payload.measure, author: action.payload.author, content: action.payload.content, resolved: false })
      state.lastEvent = `批注窗口：第 ${action.payload.measure} 小节新增指挥批注`
    },
    resolveComment(state, action: PayloadAction<string>) {
      pushHistory(state)
      const comment = state.working.comments.find((item) => item.id === action.payload)
      if (comment && !comment.resolved) { comment.resolved = true; state.lastEvent = `批注窗口：第 ${comment.measure} 小节批注已应用` }
    },
    undo(state) {
      const previous = state.history.pop()
      if (!previous) return
      state.future.push(historySnap(state.working))
      const data = JSON.parse(previous) as WorkingCopy
      state.working.tracks = data.tracks; state.working.comments = data.comments; state.working.pageTurns = data.pageTurns
      state.lastEvent = '撤销最近一个窗口改动'
    },
    redo(state) {
      const next = state.future.pop()
      if (!next) return
      state.history.push(historySnap(state.working))
      const data = JSON.parse(next) as WorkingCopy
      state.working.tracks = data.tracks; state.working.comments = data.comments; state.working.pageTurns = data.pageTurns
      state.lastEvent = '重做窗口改动'
    },
    commitStarted(state, action: PayloadAction<PendingCommit>) {
      state.pendingCommit = action.payload
      state.writeInterrupted = false
      state.lastEvent = `提交标记 ${action.payload.token} 已登记（依据 v${action.payload.request.baseVersion}）`
    },
    commitInterrupted(state) {
      if (!state.pendingCommit) return
      state.writeInterrupted = true
      state.lastEvent = `写盘中断！提交标记 ${state.pendingCommit.token} 已入日志，可按标记续做`
    },
    commitSucceeded(state, action: PayloadAction<{ snapshot: DomainSnapshot; token: string; revision: RehearsalRevision }>) {
      state.domain = action.payload.snapshot
      state.working = { tracks: structuredClone(action.payload.snapshot.tracks), comments: structuredClone(action.payload.snapshot.comments), pageTurns: structuredClone(action.payload.snapshot.pageTurns) }
      state.history = []; state.future = []
      state.pendingCommit = null; state.writeInterrupted = false; state.recoveredDraft = false
      const { revision } = action.payload
      const blocked = revision.blocked.length
      state.lastEvent = blocked
        ? `校订 ${revision.versionId} 已提交：${revision.applied.length} 个小节成为新基线，${blocked} 个片段留在冲突篮`
        : `校订 ${revision.versionId} 已提交并成为出版基线（提交标记 ${action.payload.token}）`
    },
    discardPending(state) {
      const token = state.pendingCommit?.token
      state.pendingCommit = null; state.writeInterrupted = false
      state.lastEvent = `已丢弃未完成的提交标记 ${token ?? ''}`
    },
    acceptConflict(state, action: PayloadAction<{ snapshot: DomainSnapshot; revision: RehearsalRevision; conflict: ConflictEntry }>) {
      state.domain = action.payload.snapshot
      state.working = { tracks: structuredClone(action.payload.snapshot.tracks), comments: structuredClone(action.payload.snapshot.comments), pageTurns: structuredClone(action.payload.snapshot.pageTurns) }
      state.history = []; state.future = []
      state.lastEvent = `冲突篮片段 ${action.payload.conflict.id} 已并入，形成 ${action.payload.revision.versionId}`
    },
    rejectConflict(state, action: PayloadAction<{ snapshot: DomainSnapshot; conflict: ConflictEntry }>) {
      state.domain = action.payload.snapshot
      state.lastEvent = `冲突篮片段 ${action.payload.conflict.id} 已弃用，出版基线不变`
    },
    setConflictMessage(state, action: PayloadAction<string>) { state.conflictMessage = action.payload },
    dismissDraftNotice(state) { state.recoveredDraft = false },
  },
})

export const scoreApi = createApi({
  reducerPath: 'scoreApi',
  baseQuery: fakeBaseQuery(),
  endpoints: (builder) => ({
    getPublishingProfile: builder.query<{ title: string; publisher: string; pages: number; deadline: string }, void>({ queryFn: async () => ({ data: { title: '《潮汐线》室内交响作品', publisher: '云谱出版社', pages: 46, deadline: '2026-10-12' } }) }),
  }),
})

// —— 选择器：三处窗口相对基线的暂存差异 ——

export function selectStagedChanges(state: RootState): WorkingChange[] {
  const { domain, working } = state.score
  const time = nowTime()
  const edits: AnyEdit[] = [
    ...diffTracks(working.tracks, domain.tracks),
    ...diffComments(working.comments, domain.comments),
    ...diffPageTurns(working.pageTurns, domain.pageTurns),
  ]
  return edits.map((edit, index) => ({ id: `WC-${index}`, edit, spec: editToSpec(edit), time }))
}

export const selectDirty = (state: RootState) => selectStagedChanges(state).length > 0

function makeToken() {
  return `REV-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`
}

/** 把三处窗口的暂存汇成同一次排练校订并提交 */
export const saveRevision = (message?: string) => (dispatch: AppDispatch, getState: () => RootState) => {
  const state = getState().score
  if (state.pendingCommit) { dispatch(resumePending()); return }
  const edits: AnyEdit[] = [
    ...diffTracks(state.working.tracks, state.domain.tracks),
    ...diffComments(state.working.comments, state.domain.comments),
    ...diffPageTurns(state.working.pageTurns, state.domain.pageTurns),
  ]
  if (!edits.length) return
  const request: RevisionRequest = {
    token: makeToken(), editor: '沈青（本地工作区）',
    message: message ?? '排练校订：总谱力度 / 指挥批注 / 分谱换页合并提交',
    baseVersion: state.domain.baselineVersion, edits, time: nowTime(),
  }
  const pending: PendingCommit = { token: request.token, request, phase: 'journaled', startedAt: nowTime() }
  const storage = new FaultableStorage(localStorage)
  appendJournal(storage, pending)
  dispatch(slice.actions.commitStarted(pending))
  const { snapshot, revision } = commitRevision(state.domain, request, nowTime())
  if (!writeSnapshot(storage, snapshot)) { dispatch(slice.actions.commitInterrupted()); return }
  clearJournal(storage, request.token)
  dispatch(slice.actions.commitSucceeded({ snapshot, token: request.token, revision }))
}

/** 写盘中断后按提交标记续做；同一标记只会落一份记录 */
export const resumePending = () => (dispatch: AppDispatch, getState: () => RootState) => {
  const state = getState().score
  const storage = new FaultableStorage(localStorage)
  const pending = state.pendingCommit ?? readJournal(storage)[0] ?? null
  if (!pending) return
  const current = readSnapshot(storage) ?? state.domain
  const { snapshot, revision } = commitRevision(current, pending.request, nowTime())
  if (!writeSnapshot(storage, snapshot)) { dispatch(slice.actions.commitInterrupted()); return }
  clearJournal(storage, pending.token)
  dispatch(slice.actions.commitSucceeded({ snapshot, token: pending.token, revision }))
}

export const discardPendingCommit = () => (dispatch: AppDispatch, getState: () => RootState) => {
  const pending = getState().score.pendingCommit
  const storage = new FaultableStorage(localStorage)
  if (pending) clearJournal(storage, pending.token)
  dispatch(slice.actions.discardPending())
}

/** 外部编辑（第二位编辑）从指定基线提交：走同一套乐观并发与冲突篮规则 */
export const submitExternalRevision = (request: RevisionRequest) => (dispatch: AppDispatch, getState: () => RootState) => {
  const state = getState().score
  const storage = new FaultableStorage(localStorage)
  const pending: PendingCommit = { token: request.token, request, phase: 'journaled', startedAt: nowTime() }
  appendJournal(storage, pending)
  const { snapshot, revision } = commitRevision(state.domain, request, nowTime())
  if (!writeSnapshot(storage, snapshot)) { dispatch(slice.actions.commitInterrupted()); return }
  clearJournal(storage, request.token)
  dispatch(slice.actions.commitSucceeded({ snapshot, token: request.token, revision }))
}

export const resolveConflictEntry = (conflictId: string, accept: boolean) => (dispatch: AppDispatch, getState: () => RootState) => {
  const state = getState().score
  const storage = new FaultableStorage(localStorage)
  const entry = state.domain.conflicts.find((item) => item.id === conflictId)
  if (!entry || entry.status !== 'pending') return
  if (accept) {
    const result = acceptConflictPure(state.domain, conflictId, nowTime())
    if (!result.ok) { dispatch(slice.actions.setConflictMessage(result.reason)); return }
    const conflict = result.snapshot.conflicts.find((item) => item.id === conflictId)!
    writeSnapshot(storage, result.snapshot)
    dispatch(slice.actions.acceptConflict({ snapshot: result.snapshot, revision: result.revision, conflict }))
  } else {
    const result = rejectConflictPure(state.domain, conflictId, nowTime())
    if (!result.ok) return
    const conflict = result.snapshot.conflicts.find((item) => item.id === conflictId)!
    writeSnapshot(storage, result.snapshot)
    dispatch(slice.actions.rejectConflict({ snapshot: result.snapshot, conflict }))
  }
}

/** 安排下一次写盘中断（演示崩溃恢复） */
export const armWriteFault = () => () => { FaultableStorage.failNextWrite() }

/**
 * 并发排练演示：两位编辑从同一版谱面出发，各自的请求都携带相同的 baseVersion，
 * 顺序落账后由乐观并发规则决定谁成基线、谁进冲突篮。
 */
export const simulateConcurrentEdits = (plans: Array<{ editor: string; message: string; edits: AnyEdit[] }>) =>
  (dispatch: AppDispatch, getState: () => RootState) => {
    const base = getState().score.domain
    const storage = new FaultableStorage(localStorage)
    let current = base
    const time = nowTime()
    plans.forEach((plan, order) => {
      const request: RevisionRequest = {
        token: makeToken(), editor: plan.editor, message: plan.message,
        baseVersion: base.baselineVersion, edits: plan.edits, time,
      }
      const pending: PendingCommit = { token: request.token, request, phase: 'journaled', startedAt: time }
      appendJournal(storage, pending)
      const outcome = commitRevision(current, request, time)
      writeSnapshot(storage, outcome.snapshot)
      clearJournal(storage, request.token)
      current = outcome.snapshot
      // 最后一份才刷新 Redux，中间结果完全由纯函数 + 持久化推进
      if (order === plans.length - 1) {
        dispatch(slice.actions.commitSucceeded({ snapshot: outcome.snapshot, token: request.token, revision: outcome.revision }))
      }
    })
  }

export const store = configureStore({
  reducer: { score: slice.reducer, [scoreApi.reducerPath]: scoreApi.reducer },
  middleware: (getDefault) => getDefault().concat(scoreApi.middleware),
})

// 工作区暂存自动落盘（不触碰提交日志）
store.subscribe(() => {
  const state = store.getState().score
  if (!state.initialized || state.pendingCommit) return
  writeWorking(new FaultableStorage(localStorage), { tracks: state.working.tracks, comments: state.working.comments, pageTurns: state.working.pageTurns })
})
// 首帧后标记初始化，避免用启动快照覆盖恢复内容
queueMicrotask(() => store.dispatch(slice.actions.initialized()))

export const {
  selectTrack, selectNote, addNote, removeNote, updateNote, transposeTrack,
  undo, redo, resolveComment, addComment, setPageTurn, dismissDraftNotice,
} = slice.actions
export type RootState = ReturnType<typeof store.getState>
export type AppDispatch = typeof store.dispatch
