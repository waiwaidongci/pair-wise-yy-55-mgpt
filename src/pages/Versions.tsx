import { useState } from 'react'
import { Card, Button, Tag, Tabs, Timeline, Alert, Input, Select, Space, Table, Tooltip } from 'antd'
import { CheckOutlined, CloseOutlined, CommentOutlined, ThunderboltOutlined, BugOutlined } from '@ant-design/icons'
import { useDispatch, useSelector } from 'react-redux'
import type { AppDispatch, RootState } from '../store'
import {
  addComment, armWriteFault, resolveComment, resolveConflictEntry, saveRevision, simulateConcurrentEdits,
} from '../store'
import type { NoteEdit, ScoreNote } from '../rehearsal/types'
import type { RehearsalRevision, ConflictEntry } from '../rehearsal/types'

const STATUS_TEXT: Record<RehearsalRevision['status'], { text: string; color: string }> = {
  committed: { text: '已成为基线', color: 'green' },
  partial: { text: '部分并入', color: 'orange' },
  quarantined: { text: '全部入冲突篮', color: 'red' },
}

function revisionNoteEdits(domain: RootState['score']['domain'], trackId: string, measure: number, patch: Partial<ScoreNote>): NoteEdit[] {
  const track = domain.tracks.find((item) => item.id === trackId)!
  const edits: NoteEdit[] = []
  track.notes.forEach((note, index) => {
    if (Math.floor(index / 4) + 1 !== measure) return
    edits.push({ kind: 'note', trackId, index, before: structuredClone(note), after: { ...structuredClone(note), ...patch, id: note.id } })
  })
  return edits
}

function trackName(tracks: RootState['score']['domain']['tracks'], id: string) {
  return tracks.find((track) => track.id === id)?.name ?? id
}

export default function Versions() {
  const dispatch = useDispatch<AppDispatch>()
  const { domain, working, conflictMessage, lastEvent } = useSelector((state: RootState) => state.score)
  const [measure, setMeasure] = useState(2)
  const [content, setContent] = useState('')
  const [faultArmed, setFaultArmed] = useState(false)
  const armFault = () => { dispatch(armWriteFault()); setFaultArmed(true) }

  const revisionItems = domain.revisions.map((revision: RehearsalRevision) => ({
    color: (revision.status === 'committed' ? 'green' : revision.status === 'partial' ? 'orange' : 'red') as 'green' | 'orange' | 'red',
    children: <div key={revision.token}>
      <Space wrap size={6}><b>{revision.versionId}</b><Tag>{revision.editor}</Tag><Tag>{revision.time}</Tag><Tag color={STATUS_TEXT[revision.status].color}>{STATUS_TEXT[revision.status].text}</Tag><Tag>依据 v{revision.baseVersion} → 新 v{revision.newVersion}</Tag><small style={{ color: '#94a3b8' }}>提交标记 {revision.token}</small></Space>
      <p style={{ margin: '6px 0' }}>{revision.message}</p>
      {revision.applied.slice(0, 6).map((spec, index) => <Tag key={`a${index}`} color="blue">第 {spec.measure} 小节{spec.trackId ? ` · ${trackName(domain.tracks, spec.trackId)}` : ''} · {spec.summary}</Tag>)}
      {revision.blocked.length > 0 && <div style={{ marginTop: 6 }}>{revision.blocked.map((spec, index) => <Tag key={`b${index}`} color="red">冲突篮：第 {spec.measure} 小节{spec.trackId ? ` · ${trackName(domain.tracks, spec.trackId)}` : ''} · {spec.summary}</Tag>)}</div>}
    </div>,
  }))

  return <main className="page">
    <div className="page-head"><div><p className="eyebrow">版本、评论与出版基线</p><h1>排练校订与冲突篮</h1><p>每次提交都记下修改小节、当时谱面版本与提交标记；两位编辑同版提交时，后完成者的重叠片段留在冲突篮。</p></div><Button type="primary">锁定出版基线 v{domain.baselineVersion}</Button></div>
    {conflictMessage && <Alert type="error" showIcon style={{ marginBottom: 12 }} message={conflictMessage} />}
    {lastEvent && <Alert type="info" showIcon style={{ marginBottom: 12 }} message={lastEvent} />}
    <Tabs items={[
      { key: 'revisions', label: `校订记录 (${domain.revisions.length})`, children: <Card><Timeline items={revisionItems} /></Card> },
      {
        key: 'conflicts', label: `冲突篮 (${domain.conflicts.filter((item) => item.status === 'pending').length})`, children: (
          <Card>
            <Alert type="warning" showIcon style={{ marginBottom: 14 }} message="冲突片段不会覆盖已接受内容" description="在“并发排练”页让两位编辑从同一版本改同一小节：先完成者成为新基线，后完成者的片段进入此篮；接受时按字段三方合并，该片段若已被后来者再次占用则拒绝。" />
            <Table rowKey="id" pagination={false} dataSource={domain.conflicts} columns={[
              { title: '片段', render: (_v, row: ConflictEntry) => <Space direction="vertical" size={2}><b>{row.id}</b><small>提交标记 {row.token}</small></Space> },
              { title: '编辑', dataIndex: 'editor' },
              { title: '依据版本', render: (_v, row) => `v${row.baseVersion}` },
              { title: '小节与改动', render: (_v, row) => {
                const head = row.specs[0]!
                const trackIds = [...new Set(row.specs.map((spec) => spec.trackId).filter(Boolean))]
                return <Space direction="vertical" size={2}><Tag color="blue">第 {head.measure} 小节{trackIds[0] ? ` · ${trackName(domain.tracks, trackIds[0]!)}` : ''}</Tag><small>{row.specs.length} 个音符条目</small></Space>
              } },
              { title: '说明', render: (_v, row) => <Space direction="vertical" size={0}>{row.specs.slice(0, 3).map((spec, i) => <small key={i}>{spec.summary}</small>)}{row.specs.length > 3 && <small>…共 {row.specs.length} 项</small>}</Space> },
              { title: '状态', render: (_v, row) => <Tag color={row.status === 'pending' ? 'orange' : row.status === 'accepted' ? 'green' : 'default'}>{row.status === 'pending' ? '待处置' : row.status === 'accepted' ? '已并入基线' : '已弃用'}</Tag> },
              { title: '操作', render: (_v, row) => row.status === 'pending' ? <Space><Tooltip title="按字段三方合并整个小节片段，绝不覆盖赢方已接受的其他属性"><Button size="small" type="primary" icon={<CheckOutlined />} onClick={() => dispatch(resolveConflictEntry(row.id, true))}>并入</Button></Tooltip><Button size="small" danger icon={<CloseOutlined />} onClick={() => dispatch(resolveConflictEntry(row.id, false))}>弃用</Button></Space> : null },
            ]} />
          </Card>
        ),
      },
      {
        key: 'comments', label: `批注锚点 (${working.comments.filter((item) => !item.resolved).length})`, children: <div style={{ display: 'grid', gridTemplateColumns: '1.3fr .7fr', gap: 16 }}>
          <Card>
            <Space style={{ marginBottom: 12 }}>
              <Select style={{ width: 130 }} value={measure} options={[1, 2, 3, 6].map((value) => ({ value, label: `第 ${value} 小节` }))} onChange={setMeasure} />
              <Input style={{ width: 320 }} placeholder="写下指挥批注，锚定到该小节" value={content} onChange={(event) => setContent(event.target.value)} onPressEnter={() => { if (content.trim()) { dispatch(addComment({ measure, content: content.trim(), author: '指挥 · 方亦' })); setContent('') } }} />
              <Button type="primary" disabled={!content.trim()} onClick={() => { dispatch(addComment({ measure, content: content.trim(), author: '指挥 · 方亦' })); setContent('') }}>加入批注窗口</Button>
            </Space>
            {working.comments.map((comment) => <div key={comment.id} style={{ display: 'grid', gridTemplateColumns: '90px 1fr auto', gap: 12, padding: '14px 0', borderBottom: '1px solid #edf0f5' }}><Tag icon={<CommentOutlined />}>第 {comment.measure} 小节</Tag><div><b>{comment.author}</b><p>{comment.content}</p></div><div>{comment.resolved ? <Tag color="green">已解决</Tag> : <Button size="small" onClick={() => dispatch(resolveComment(comment.id))}>应用批注</Button>}</div></div>)}
          </Card>
          <Card title="提交说明"><Alert type="info" showIcon message="批注也是校订的一部分" description="应用批注只让关联小节的出版基线缓存失效；节奏检查与换页提示沿用原结果。批注与小节锚点在旧数据升级时原样保留。" /></Card>
        </div>,
      },
      {
        key: 'derived', label: '派生重算日志', children: <Card title={`累计重算 ${domain.derived.recomputeCount} 次 · 复用未涉及小节 ${domain.derived.reuseCount} 次`}>
          <Timeline items={domain.derived.log.slice().reverse().map((entry, index) => ({ color: entry.action === 'recompute' ? 'blue' : entry.action === 'invalidate' ? 'orange' : 'gray', children: <Space key={index} wrap size={6}><Tag color={entry.action === 'recompute' ? 'blue' : entry.action === 'invalidate' ? 'orange' : 'default'}>{entry.action === 'recompute' ? '重算' : entry.action === 'invalidate' ? '失效' : '复用'}</Tag><b>{entry.kind}</b><code style={{ fontSize: 11 }}>{entry.key}</code><span>{entry.detail}</span>{entry.token && <small style={{ color: '#94a3b8' }}>{entry.token.slice(0, 12)}</small>}</Space> }))} />
        </Card>,
      },
      {
        key: 'concurrent', label: '并发排练', children: <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
          <Card title={<Space><ThunderboltOutlined />两位编辑从同一版谱面提交</Space>}>
            <Alert type="info" showIcon style={{ marginBottom: 14 }} message={`当前出版基线 v${domain.baselineVersion}`} description="每个场景中两位编辑的请求都携带同一个依据版本：先完成者成为新基线，后完成者的重叠小节进冲突篮，不重叠小节自动并入。" />
            <div className="sim-grid">
              <div className="sim-card"><b>场景一 · 完全重叠</b><p>沈青与方亦都改圆号第 1 小节（p / f）</p><Button size="small" danger onClick={() => dispatch(simulateConcurrentEdits([
                { editor: '沈青', message: '圆号第 1 小节力度改为 p', edits: revisionNoteEdits(domain, 'TR-03', 1, { dynamic: 'p' }) },
                { editor: '指挥 · 方亦', message: '圆号第 1 小节力度改为 f', edits: revisionNoteEdits(domain, 'TR-03', 1, { dynamic: 'f' }) },
              ]))}>先沈青后方亦</Button></div>
              <div className="sim-card"><b>场景二 · 不重叠</b><p>沈青改圆号第 1 小节，方亦改单簧管第 2 小节</p><Button size="small" type="primary" ghost onClick={() => dispatch(simulateConcurrentEdits([
                { editor: '沈青', message: '圆号第 1 小节力度改为 p', edits: revisionNoteEdits(domain, 'TR-03', 1, { dynamic: 'p' }) },
                { editor: '指挥 · 方亦', message: '单簧管第 2 小节加延音', edits: revisionNoteEdits(domain, 'TR-02', 2, { tie: true }) },
              ]))}>两份都并入</Button></div>
              <div className="sim-card"><b>场景三 · 部分重叠</b><p>沈青改单簧管第 1 小节，方亦改第 1、3 小节</p><Button size="small" type="primary" ghost onClick={() => dispatch(simulateConcurrentEdits([
                { editor: '沈青', message: '单簧管第 1 小节力度改为 mp', edits: revisionNoteEdits(domain, 'TR-02', 1, { dynamic: 'mp' }) },
                { editor: '指挥 · 方亦', message: '单簧管第 1、3 小节力度改为 f', edits: [...revisionNoteEdits(domain, 'TR-02', 1, { dynamic: 'f' }), ...revisionNoteEdits(domain, 'TR-02', 3, { dynamic: 'f' })] },
              ]))}>第 1 进篮 · 第 3 并入</Button></div>
              <div className="sim-card"><b>反向顺序</b><p>同场景一，但方亦先完成（与身份无关）</p><Button size="small" onClick={() => dispatch(simulateConcurrentEdits([
                { editor: '指挥 · 方亦', message: '圆号第 1 小节力度改为 f', edits: revisionNoteEdits(domain, 'TR-03', 1, { dynamic: 'f' }) },
                { editor: '沈青', message: '圆号第 1 小节力度改为 p', edits: revisionNoteEdits(domain, 'TR-03', 1, { dynamic: 'p' }) },
              ]))}>先方亦后沈青</Button></div>
            </div>
            <div style={{ marginTop: 14 }}><Button type="primary" onClick={() => dispatch(saveRevision())}>把三个窗口的暂存汇成一次校订</Button></div>
          </Card>
          <Card title={<Space><BugOutlined />写盘中断与续做</Space>}>
            <Alert type="warning" showIcon style={{ marginBottom: 14 }} message="模拟下一次快照写盘只落一半" description="先武装故障，再点任意提交（包括左侧并发场景）：提交标记已在日志中但快照写坏，顶栏出现续做横幅；点“按提交标记续做”后同一校订只产生一条记录。" />
            <Button danger={faultArmed} type={faultArmed ? 'primary' : 'default'} icon={<BugOutlined />} onClick={armFault}>{faultArmed ? '故障已武装：去左侧提交吧' : '让下一次快照写盘中断'}</Button>
            <div className="sim-card" style={{ marginTop: 14 }}><b>幂等保证</b><p>续做时若该提交标记已经落账，直接返回既有校订，不会再多出一份记录。</p></div>
          </Card>
        </div>,
      },
    ]} />
  </main>
}
