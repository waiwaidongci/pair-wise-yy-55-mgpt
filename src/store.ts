import { configureStore, createSlice, type PayloadAction } from '@reduxjs/toolkit'
import { createApi, fakeBaseQuery } from '@reduxjs/toolkit/query/react'
import type { ScoreNote } from './types'
import {
  commitRevision as commitRevisionEngine,
  computeChangedMeasures,
  discardConflict as discardConflictEngine,
  invalidateDerived,
  recomputeDerived,
  reapplyConflict as reapplyConflictEngine,
  simulateRemoteCommit as simulateRemoteCommitEngine,
  type EngineState,
} from './revision/engine'
import { loadEngineState, persistEngineState } from './revision/storage'
import type { PartSettings } from './revision/types'

interface ScoreState extends EngineState {
  selectedTrackId: string
  selectedNoteIndex: number
  history: string[]
  future: string[]
  dirty: boolean
}

function transposeKey(key: string, semitones: number) {
  const chromatic = ['c', 'c#', 'd', 'd#', 'e', 'f', 'f#', 'g', 'g#', 'a', 'a#', 'b']
  const [pitch, octaveText] = key.split('/')
  const index = chromatic.indexOf(pitch!.replace('b', '')) + semitones
  let octave = Number(octaveText)
  let shifted = index
  while (shifted < 0) {
    shifted += 12
    octave -= 1
  }
  while (shifted >= 12) {
    shifted -= 12
    octave += 1
  }
  return `${chromatic[shifted]}/${octave}`
}

function captureDraft(state: ScoreState): string {
  return JSON.stringify({ tracks: state.tracks, comments: state.comments, partSettings: state.partSettings })
}

function pushHistory(state: ScoreState) {
  state.history.push(captureDraft(state))
  if (state.history.length > 40) state.history.shift()
  state.future = []
  state.dirty = true
}

function applyDraftSnapshot(state: ScoreState, json: string) {
  const snapshot = JSON.parse(json) as { tracks: ScoreState['tracks']; comments: ScoreState['comments']; partSettings: PartSettings }
  state.tracks = snapshot.tracks
  state.comments = snapshot.comments
  state.partSettings = snapshot.partSettings
}

/** 小节变化后：只让关联小节的派生结果失效重算，未涉及声部沿用原结果 */
function refreshDerived(state: ScoreState) {
 const changed = computeChangedMeasures(state)
  invalidateDerived(state, changed)
  recomputeDerived(state, changed)
}

const engineState = loadEngineState()
const initialState: ScoreState = {
  ...engineState,
  selectedTrackId: 'TR-01',
  selectedNoteIndex: 2,
  history: [],
  future: [],
  dirty: computeChangedMeasures(engineState).length > 0,
}

const scoreSlice = createSlice({
  name: 'score',
  initialState,
  reducers: {
    selectTrack(state, action: PayloadAction<string>) {
      state.selectedTrackId = action.payload
      state.selectedNoteIndex = 0
    },
    selectNote(state, action: PayloadAction<number>) {
      state.selectedNoteIndex = action.payload
    },
    addNote(state) {
      pushHistory(state)
      const track = state.tracks.find((item) => item.id === state.selectedTrackId)!
      const template = track.notes[Math.min(track.notes.length - 1, state.selectedNoteIndex)]
      track.notes.splice(state.selectedNoteIndex + 1, 0, {
        id: `N-${Date.now()}`,
        key: template?.key ?? 'c/4',
        duration: 'q',
        dynamic: template?.dynamic ?? 'mf',
        tie: false,
        expression: '',
      })
      state.selectedNoteIndex += 1
      refreshDerived(state)
      persistEngineState(state)
    },
    removeNote(state) {
      pushHistory(state)
      const track = state.tracks.find((item) => item.id === state.selectedTrackId)!
      if (track.notes.length > 1) track.notes.splice(state.selectedNoteIndex, 1)
      state.selectedNoteIndex = Math.max(0, state.selectedNoteIndex - 1)
      refreshDerived(state)
      persistEngineState(state)
    },
    updateNote(state, action: PayloadAction<Partial<ScoreNote>>) {
      pushHistory(state)
      const track = state.tracks.find((item) => item.id === state.selectedTrackId)!
      Object.assign(track.notes[state.selectedNoteIndex]!, action.payload)
      refreshDerived(state)
      persistEngineState(state)
    },
    transposeTrack(state, action: PayloadAction<number>) {
      pushHistory(state)
      const track = state.tracks.find((item) => item.id === state.selectedTrackId)!
      track.notes.forEach((note) => {
        note.key = transposeKey(note.key, action.payload)
      })
      track.transposition += action.payload
      refreshDerived(state)
      persistEngineState(state)
    },
    undo(state) {
      const previous = state.history.pop()
      if (!previous) return
      state.future.push(captureDraft(state))
      applyDraftSnapshot(state, previous)
      state.dirty = true
      refreshDerived(state)
      persistEngineState(state)
    },
    redo(state) {
      const next = state.future.pop()
      if (!next) return
      state.history.push(captureDraft(state))
      applyDraftSnapshot(state, next)
      state.dirty = true
      refreshDerived(state)
      persistEngineState(state)
    },
    resolveComment(state, action: PayloadAction<string>) {
      const comment = state.comments.find((item) => item.id === action.payload)
      if (comment) {
        comment.resolved = true
        state.dirty = true
        refreshDerived(state)
        persistEngineState(state)
      }
    },
    /** 分谱换页设置变化：与音符、批注一样进入同一版草稿，提交时汇成同一次校订 */
    updatePartSettings(state, action: PayloadAction<Partial<PartSettings>>) {
      if (action.payload.cueEnabled !== undefined) state.partSettings.cueEnabled = action.payload.cueEnabled
      if (action.payload.pageTurnByTrack) {
        state.partSettings.pageTurnByTrack = { ...state.partSettings.pageTurnByTrack, ...action.payload.pageTurnByTrack }
      }
      state.dirty = true
      refreshDerived(state)
      persistEngineState(state)
    },
    /** 形成版本：三类改动合并提交，记下修改小节、当时谱面版本与提交标记 */
    commitDraft(state) {
      const outcome = commitRevisionEngine(state, '当前用户', '保存当前总谱、指挥批注与分谱换页调整')
      if (outcome.ok) state.dirty = false
      persistEngineState(state)
    },
    /** 冲突篮：补入未被接受的小节，不覆盖已接受片段 */
    reapplyConflict(state, action: PayloadAction<string>) {
      reapplyConflictEngine(state, action.payload)
      persistEngineState(state)
    },
    discardConflict(state, action: PayloadAction<string>) {
      discardConflictEngine(state, action.payload)
      persistEngineState(state)
    },
    /** 模拟另一编辑窗口从同一版谱面同时提交 */
    simulateRemoteEditor(state) {
      simulateRemoteCommitEngine(state)
      persistEngineState(state)
    },
  },
})

export const scoreApi = createApi({
  reducerPath: 'scoreApi',
  baseQuery: fakeBaseQuery(),
  endpoints: (builder) => ({
    getPublishingProfile: builder.query<{ title: string; publisher: string; pages: number; deadline: string }, void>({
      queryFn: async () => ({ data: { title: '《潮汐线》室内交响作品', publisher: '云谱出版社', pages: 46, deadline: '2026-10-12' } }),
    }),
  }),
})

export const {
  selectTrack,
  selectNote,
  addNote,
  removeNote,
  updateNote,
  transposeTrack,
  undo,
  redo,
  resolveComment,
  updatePartSettings,
  commitDraft,
  reapplyConflict,
  discardConflict,
  simulateRemoteEditor,
} = scoreSlice.actions

export const store = configureStore({
  reducer: { score: scoreSlice.reducer, [scoreApi.reducerPath]: scoreApi.reducer },
  middleware: (getDefault) => getDefault().concat(scoreApi.middleware),
})

export type RootState = ReturnType<typeof store.getState>
export type AppDispatch = typeof store.dispatch
