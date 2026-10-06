import type {
  AffectedCell, AnyEdit, CommentEdit, ConflictEntry, DerivedEntry, DerivedKind,
  DomainSnapshot, NoteEdit, PageTurnEdit, PageTurnSettings, RehearsalRevision,
  RevisionRequest, RevisionSpec, ScoreComment, ScoreNote, Track,
} from './types'

export const MEASURE_SIZE = 4

export const measureOfIndex = (index: number) => Math.floor(index / MEASURE_SIZE) + 1
export const measureCount = (track: Track) => Math.max(3, Math.ceil(track.notes.length / MEASURE_SIZE))
export const cacheKey = (kind: DerivedKind, trackId: string, measure: number) => `${kind}:${trackId}:m${measure}`
export const defaultPageTurns = (tracks: Track[]): Record<string, PageTurnSettings> =>
  Object.fromEntries(tracks.map((track) => [track.id, { cue: true, pageTurnMeasure: 2 }]))

// —— 把各窗口的编辑换算成带小节锚点的校订条目 ——

export function editToSpec(edit: AnyEdit): RevisionSpec {
  if (edit.kind === 'note') {
    const measure = measureOfIndex(edit.index)
    const note = edit.after ?? edit.before
    let summary: string
    if (!edit.after) summary = `删除音符 ${edit.before!.key.replace('/', '')}`
    else if (!edit.before) summary = `新增音符 ${edit.after.key.replace('/', '')}（${edit.after.dynamic}）`
    else summary = `音符改为 ${edit.after.key.replace('/', '')} · ${edit.after.dynamic}${edit.after.tie ? ' · 延音' : ''}`
    return { kind: 'note', measure, trackId: edit.trackId, summary, note: edit.after ?? undefined, before: edit.before, index: edit.index }
  }
  if (edit.kind === 'comment') {
    const wasResolved = edit.before?.resolved ?? false
    const summary = !edit.before
      ? `新增批注：${edit.comment.content}`
      : edit.comment.resolved && !wasResolved
        ? `应用批注：${edit.comment.content}`
        : `修订批注：${edit.comment.content}`
    return { kind: 'comment', measure: edit.comment.measure, summary, comment: structuredClone(edit.comment), before: edit.before ? structuredClone(edit.before) : null }
  }
  return {
    kind: 'pageTurn', measure: edit.afterMeasure, trackId: edit.trackId, cue: edit.cue, afterMeasure: edit.afterMeasure,
    summary: `换页改在第 ${edit.afterMeasure} 小节前，提示音${edit.cue ? '显示' : '隐藏'}`,
  }
}

/** 冲突判定所用的片段格子：声部×小节（批注细化到具体批注，换页细化到声部） */
export function specCell(spec: RevisionSpec): string {
  if (spec.kind === 'note') return `note:${spec.trackId}:m${spec.measure}`
  if (spec.kind === 'pageTurn') return `pageTurn:${spec.trackId}`
  const id = spec.comment?.id ?? ''
  // 新增的不同内容批注互不冲突；同一批注的修改才在同一格子
  return spec.before === null ? `comment:new:m${spec.measure}:${id}` : `comment:${id}`
}

export function changedCells(specs: RevisionSpec[]): Set<string> {
  return new Set(specs.map(specCell))
}

// —— 派生结果的依赖表：任一小节变化后，只让关联项失效 ——

export function affectedCells(spec: RevisionSpec, tracks: Track[]): AffectedCell[] {
  if (spec.kind === 'note') {
    const measure = spec.measure
    return [
      { kind: 'rhythm', measure, trackId: spec.trackId },
      { kind: 'pageTurnCue', measure, trackId: spec.trackId },
      { kind: 'baseline', measure, trackId: spec.trackId },
    ]
  }
  if (spec.kind === 'comment') {
    // 指挥批注只牵动出版基线，节奏与换页沿用原结果
    return tracks.map((track) => ({ kind: 'baseline' as const, measure: spec.measure, trackId: track.id }))
  }
  const track = tracks.find((item) => item.id === spec.trackId)
  const count = track ? measureCount(track) : 3
  // 换页设置只影响本声部各小节的提示音
  return Array.from({ length: count }, (_v, index) => ({ kind: 'pageTurnCue' as const, measure: index + 1, trackId: spec.trackId }))
}

// —— 派生结果的计算 ——

function beatSum(notes: ScoreNote[]) {
  return notes.reduce((sum, note) => sum + (note.duration === 'h' ? 2 : note.duration === 'q' ? 1 : 0.5), 0)
}
function hashText(text: string) {
  let hash = 0
  for (let i = 0; i < text.length; i += 1) { hash = (hash * 31 + text.charCodeAt(i)) | 0 }
  return Math.abs(hash).toString(16).padStart(6, '0')
}

export function computeDerived(kind: DerivedKind, snapshot: DomainSnapshot, track: Track, measure: number): string {
  const notes = track.notes.slice((measure - 1) * MEASURE_SIZE, measure * MEASURE_SIZE)
  if (kind === 'rhythm') {
    const beats = beatSum(notes)
    return beats === 4 ? `第 ${measure} 小节节奏完整（4 拍）` : `第 ${measure} 小节共 ${beats} 拍，需复核`
  }
  if (kind === 'pageTurnCue') {
    const settings = snapshot.pageTurns[track.id] ?? { cue: true, pageTurnMeasure: 2 }
    if (!settings.cue) return `第 ${measure} 小节提示音已隐藏`
    if (measure >= settings.pageTurnMeasure) return `第 ${measure} 小节前换页，保留 2 小节提示音`
    return `第 ${measure} 小节提示音随页显示`
  }
  const comments = snapshot.comments.filter((item) => item.measure === measure && !item.resolved).map((item) => item.content).join('|')
  return `出版基线校验和 #${hashText(track.id + measure + JSON.stringify(notes) + comments)}`
}

export function initialDerived(snapshot: Omit<DomainSnapshot, 'derived'>, time: string): DomainSnapshot['derived'] {
  const cache: DomainSnapshot['derived']['cache'] = {}
  const kinds: DerivedKind[] = ['rhythm', 'pageTurnCue', 'baseline']
  let recomputeCount = 0
  snapshot.tracks.forEach((track) => {
    for (let measure = 1; measure <= measureCount(track); measure += 1) {
      kinds.forEach((kind) => {
        cache[cacheKey(kind, track.id, measure)] = { version: snapshot.baselineVersion, value: computeDerived(kind, snapshot as DomainSnapshot, track, measure), updatedAt: time }
        recomputeCount += 1
      })
    }
  })
  return { cache, log: [{ time, kind: 'baseline', key: '*', action: 'recompute', detail: `建库初算 ${recomputeCount} 项节奏/换页/基线结果` }], recomputeCount, reuseCount: 0 }
}

/** 对受影响的小节格子做失效—重算，其余声部沿用原缓存 */
export function recomputeFor(snapshot: DomainSnapshot, specs: RevisionSpec[], token: string, time: string): DomainSnapshot['derived'] {
  const derived: DomainSnapshot['derived'] = structuredClone(snapshot.derived)
  const invalid = new Set<string>()
  const cells: AffectedCell[] = specs.flatMap((spec) => affectedCells(spec, snapshot.tracks))
  const cellKeys = new Set(cells.map((cell) => cacheKey(cell.kind, cell.trackId!, cell.measure)))
  const byKind: Record<string, { measure: number; trackId?: string }[]> = {}
  cells.forEach((cell) => {
    const key = cacheKey(cell.kind, cell.trackId!, cell.measure)
    invalid.add(key)
    ;(byKind[cell.kind] ??= []).push({ measure: cell.measure, trackId: cell.trackId })
  })
  invalid.forEach((key) => {
    if (derived.cache[key]) derived.log.push({ time, kind: key.split(':')[0] as DerivedKind, key, action: 'invalidate', detail: '关联小节发生变化，旧结果失效', token })
    delete derived.cache[key]
  })
  cells.forEach((cell) => {
    const track = snapshot.tracks.find((item) => item.id === cell.trackId)!
    const key = cacheKey(cell.kind, track.id, cell.measure)
    const value = computeDerived(cell.kind, snapshot, track, cell.measure)
    derived.cache[key] = { version: snapshot.baselineVersion, value, updatedAt: time }
    derived.recomputeCount += 1
    derived.log.push({ time, kind: cell.kind, key, action: 'recompute', detail: value, token })
  })
  const reused = Object.keys(derived.cache).filter((key) => !cellKeys.has(key)).length
  derived.reuseCount += reused
  if (reused > 0) derived.log.push({ time, kind: 'baseline', key: '*', action: 'reuse', detail: `${reused} 项未涉及小节沿用原结果`, token })
  if (derived.log.length > 60) derived.log.splice(0, derived.log.length - 60)
  return derived
}

// —— 编辑的实际套用 ——

function applyNoteEdit(snapshot: DomainSnapshot, edit: NoteEdit) {
  const track = snapshot.tracks.find((item) => item.id === edit.trackId)!
  if (!edit.after) track.notes.splice(edit.index, 1)
  else if (!edit.before) track.notes.splice(edit.index, 0, structuredClone(edit.after))
  else {
    const current = track.notes[edit.index]
    if (current && current.id === edit.after.id) track.notes[edit.index] = structuredClone(edit.after)
    else {
      const atId = track.notes.findIndex((note) => note.id === edit.after!.id)
      if (atId >= 0) track.notes[atId] = structuredClone(edit.after)
      else track.notes.splice(edit.index, 0, structuredClone(edit.after))
    }
  }
}
function applyCommentEdit(snapshot: DomainSnapshot, edit: CommentEdit) {
  const index = snapshot.comments.findIndex((item) => item.id === edit.comment.id)
  if (index < 0) snapshot.comments.push(structuredClone(edit.comment))
  else snapshot.comments[index] = structuredClone(edit.comment)
}
function applyPageTurnEdit(snapshot: DomainSnapshot, edit: PageTurnEdit) {
  snapshot.pageTurns[edit.trackId] = { cue: edit.cue, pageTurnMeasure: edit.afterMeasure }
}
export function applyEdit(snapshot: DomainSnapshot, edit: AnyEdit) {
  if (edit.kind === 'note') applyNoteEdit(snapshot, edit)
  else if (edit.kind === 'comment') applyCommentEdit(snapshot, edit)
  else applyPageTurnEdit(snapshot, edit)
}
export function applySpec(snapshot: DomainSnapshot, spec: RevisionSpec) {
  if (spec.kind === 'note' && spec.note) {
    const track = snapshot.tracks.find((item) => item.id === spec.trackId)!
    const index = spec.index ?? track.notes.findIndex((note) => note.id === spec.note!.id)
    const current = track.notes[index]
    if (current && current.id === spec.note.id) track.notes[index] = structuredClone(spec.note)
    else track.notes.splice(index < 0 ? track.notes.length : index, 0, structuredClone(spec.note))
  } else if (spec.kind === 'comment' && spec.comment) {
    const index = snapshot.comments.findIndex((item) => item.id === spec.comment!.id)
    if (index < 0) snapshot.comments.push(structuredClone(spec.comment))
    else snapshot.comments[index] = structuredClone(spec.comment)
  } else if (spec.kind === 'pageTurn') {
    snapshot.pageTurns[spec.trackId!] = { cue: spec.cue!, pageTurnMeasure: spec.afterMeasure! }
  }
}

// —— 核心提交：乐观并发，先完成者成为出版基线，后者进冲突篮 ——

export interface CommitOutcome {
  snapshot: DomainSnapshot
  revision: RehearsalRevision
  conflicts: ConflictEntry[]
}

export function commitRevision(input: DomainSnapshot, request: RevisionRequest, time: string): CommitOutcome {
  const snapshot: DomainSnapshot = structuredClone(input)
  // 同提交标记幂等：写盘中断续做不会多出第二份记录
  const existing = snapshot.revisions.find((revision) => revision.token === request.token)
  if (existing) return { snapshot, revision: existing, conflicts: snapshot.conflicts.filter((entry) => entry.token === request.token) }

  const specs = request.edits.map(editToSpec)
  // 提交基线之后又落账、且片段已被接受的校订
  const newerAccepted = snapshot.revisions.filter((revision) => revision.newVersion > request.baseVersion && revision.status !== 'quarantined')
  const occupied = new Set<string>()
  newerAccepted.forEach((revision) => revision.applied.forEach((spec) => occupied.add(specCell(spec))))

  const appliedEdits: AnyEdit[] = []
  const blockedSpecs: RevisionSpec[] = []
  request.edits.forEach((edit, index) => {
    const spec = specs[index]!
    if (occupied.has(specCell(spec))) blockedSpecs.push(spec)
    else appliedEdits.push(edit)
  })

  appliedEdits.forEach((edit) => applyEdit(snapshot, edit))

  const seq = snapshot.nextSeq
  const movesBaseline = appliedEdits.length > 0
  const newVersion = movesBaseline ? snapshot.baselineVersion + 1 : snapshot.baselineVersion
  if (movesBaseline) snapshot.baselineVersion = newVersion
  snapshot.nextSeq = seq + 1

  const appliedSpecs = appliedEdits.map(editToSpec)
  // 同一小节格子的多个条目聚合成一个冲突片段
  const blockedByCell = new Map<string, RevisionSpec[]>()
  blockedSpecs.forEach((spec) => {
    const cell = specCell(spec)
    const list = blockedByCell.get(cell)
    if (list) list.push(spec)
    else blockedByCell.set(cell, [spec])
  })
  const conflicts: ConflictEntry[] = []
  let conflictIndex = 0
  blockedByCell.forEach((specs) => {
    conflictIndex += 1
    conflicts.push({
      id: `CF-${seq}-${conflictIndex}`, token: request.token, editor: request.editor, time,
      baseVersion: request.baseVersion, specs, status: 'pending',
    })
  })
  const status = blockedSpecs.length === 0 ? 'committed' : appliedSpecs.length > 0 ? 'partial' : 'quarantined'
  const revision: RehearsalRevision = {
    token: request.token, seq, versionId: `v${newVersion}`, editor: request.editor, time, message: request.message,
    baseVersion: request.baseVersion, newVersion, status, applied: appliedSpecs, blocked: blockedSpecs,
    conflictIds: conflicts.map((entry) => entry.id),
  }
  snapshot.revisions.unshift(revision)
  conflicts.forEach((entry) => snapshot.conflicts.unshift(entry))

  if (appliedSpecs.length > 0) {
    snapshot.derived = recomputeFor(snapshot, appliedSpecs, request.token, time)
  } else {
    snapshot.derived.log.push({ time, kind: 'baseline', key: '*', action: 'reuse', detail: '校订全部进入冲突篮，出版基线与派生结果不动', token: request.token })
    if (snapshot.derived.log.length > 60) snapshot.derived.log.splice(0, snapshot.derived.log.length - 60)
  }
  return { snapshot, revision, conflicts }
}

// —— 冲突篮的人工处置：只并入仍空闲的片段，绝不覆盖已接受内容 ——

export type ConflictActionResult = { ok: true; snapshot: DomainSnapshot; revision: RehearsalRevision } | { ok: false; reason: string }

export function acceptConflict(input: DomainSnapshot, conflictId: string, time: string): ConflictActionResult {
  const snapshot: DomainSnapshot = structuredClone(input)
  const entry = snapshot.conflicts.find((item) => item.id === conflictId)
  if (!entry) return { ok: false, reason: '冲突篮中找不到该片段' }
  if (entry.status !== 'pending') return { ok: false, reason: '该片段已经处置过' }
  const origin = snapshot.revisions.find((revision) => revision.token === entry.token)
  if (!origin) return { ok: false, reason: '找不到原校订记录' }
  const cells = new Set(entry.specs.map(specCell))
  // 只拦截“来源校订落账之后”又占用该格子的新校订；原始竞争赢家的存在是冲突的前提，
  // 人工并入是显式决定（全程留痕），而后来者会被保护、不被覆盖。
  const occupiedAfter = snapshot.revisions.some((revision) =>
    revision.seq > origin.seq && revision.status !== 'quarantined' &&
    revision.applied.some((spec) => cells.has(specCell(spec))))
  if (occupiedAfter) return { ok: false, reason: '该小节片段之后已被接受，不能覆盖' }

  // 音符冲突按字段三方合并：以共同基线为参照，落方未改而赢方已改的属性保留赢方值，
  // 落方自己改过的字段取落方值，避免整颗音符快照盖掉已接受的连音/力度等片段。
  entry.specs.forEach((incoming) => {
    if (incoming.kind !== 'note' || !incoming.note) return
    const loserNote0: ScoreNote = incoming.note
    const track = snapshot.tracks.find((item) => item.id === incoming.trackId)!
    const index = incoming.index ?? track.notes.findIndex((note) => note.id === loserNote0.id)
    const current = track.notes[index]
    const base = incoming.before && 'key' in incoming.before ? incoming.before as ScoreNote : null
    if (current && base && current.id === loserNote0.id) {
      const keys = ['key', 'duration', 'accidental', 'dynamic', 'tie', 'expression'] as const
      keys.forEach((field) => {
        const winnerChanged = JSON.stringify(current[field]) !== JSON.stringify(base[field])
        const loserChanged = JSON.stringify(loserNote0[field]) !== JSON.stringify(base[field])
        // 赢方改了而落方没改：保留赢方；双方都改时以人工并入的落方为准（冲突字段已留痕）
        if (winnerChanged && !loserChanged) (loserNote0 as unknown as Record<string, unknown>)[field] = structuredClone(current[field])
      })
    }
  })

  entry.specs.forEach((spec) => applySpec(snapshot, spec))
  snapshot.baselineVersion += 1
  // 从原校订的 blocked 中摘除该片段的全部条目，转入 applied
  const moved = origin.blocked.filter((spec) => cells.has(specCell(spec)))
  origin.blocked = origin.blocked.filter((spec) => !cells.has(specCell(spec)))
  origin.applied.push(...moved)
  origin.newVersion = snapshot.baselineVersion
  origin.versionId = `v${snapshot.baselineVersion}`
  origin.status = origin.blocked.length === 0 ? 'committed' : 'partial'
  entry.status = 'accepted'
  snapshot.derived = recomputeFor(snapshot, entry.specs, entry.token, time)
  return { ok: true, snapshot, revision: origin }
}

export function rejectConflict(input: DomainSnapshot, conflictId: string, time: string): ConflictActionResult {
  void time
  const snapshot: DomainSnapshot = structuredClone(input)
  const entry = snapshot.conflicts.find((item) => item.id === conflictId)
  if (!entry || entry.status !== 'pending') return { ok: false, reason: '该片段无法拒绝' }
  const origin = snapshot.revisions.find((revision) => revision.token === entry.token)
  entry.status = 'rejected'
  if (origin && origin.applied.length === 0) {
    const remaining = snapshot.conflicts.some((item) => item.token === origin.token && item.status === 'pending')
    if (!remaining) origin.status = 'quarantined'
  }
  return { ok: true, snapshot, revision: origin! }
}

// —— 本地工作区相对出版基线的差异：三个窗口汇成一份暂存 ——

export function diffTracks(working: Track[], baseline: Track[]): NoteEdit[] {
  const edits: NoteEdit[] = []
  const trackCount = Math.max(working.length, baseline.length)
  for (let t = 0; t < trackCount; t += 1) {
    const wTrack = working[t]
    const bTrack = baseline[t]
    if (!wTrack || !bTrack || wTrack.id !== bTrack.id) continue
    const length = Math.max(wTrack.notes.length, bTrack.notes.length)
    for (let i = 0; i < length; i += 1) {
      const w = wTrack.notes[i]
      const b = bTrack.notes[i]
      if (JSON.stringify(w) === JSON.stringify(b)) continue
      edits.push({ kind: 'note', trackId: wTrack.id, index: i, before: b ? structuredClone(b) : null, after: w ? structuredClone(w) : null })
    }
  }
  return edits
}

export function diffComments(working: ScoreComment[], baseline: ScoreComment[]): CommentEdit[] {
  const edits: CommentEdit[] = []
  working.forEach((comment) => {
    const before = baseline.find((item) => item.id === comment.id) ?? null
    if (JSON.stringify(before) === JSON.stringify(comment)) return
    edits.push({ kind: 'comment', comment: structuredClone(comment), before: before ? structuredClone(before) : null })
  })
  return edits
}

export function diffPageTurns(working: Record<string, PageTurnSettings>, baseline: Record<string, PageTurnSettings>): PageTurnEdit[] {
  return Object.entries(working).flatMap(([trackId, settings]) => {
    const before = baseline[trackId]
    if (before && before.cue === settings.cue && before.pageTurnMeasure === settings.pageTurnMeasure) return []
    return [{ kind: 'pageTurn', trackId, cue: settings.cue, beforeMeasure: before?.pageTurnMeasure ?? 2, afterMeasure: settings.pageTurnMeasure }]
  })
}
