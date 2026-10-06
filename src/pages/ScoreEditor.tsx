import { useEffect, useRef } from 'react'
import { Alert, Button, Divider, Segmented, Select, Space, Tag, Tooltip, List } from 'antd'
import { DeleteOutlined, PlusOutlined, RedoOutlined, UndoOutlined } from '@ant-design/icons'
import { useDispatch, useSelector } from 'react-redux'
import { Accidental, Formatter, Renderer, Stave, StaveNote, Voice } from 'vexflow'
import type { AppDispatch, RootState } from '../store'
import { addNote, redo, removeNote, selectNote, selectTrack, transposeTrack, undo, updateNote, selectStagedChanges } from '../store'

export default function ScoreEditor() {
  const dispatch = useDispatch<AppDispatch>()
  const { working, selectedTrackId, selectedNoteIndex, history, future } = useSelector((state: RootState) => state.score)
  const tracks = working.tracks
  const staged = useSelector(selectStagedChanges)
  const track = tracks.find((item) => item.id === selectedTrackId)!
  const note = track.notes[selectedNoteIndex]
  const scoreRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const element = scoreRef.current
    if (!element) return
    element.innerHTML = ''
    const renderer = new Renderer(element, Renderer.Backends.SVG)
    renderer.resize(1060, 230)
    const context = renderer.getContext()
    const measures = [track.notes.slice(0, 4), track.notes.slice(4, 8), track.notes.slice(8, 12)]
    measures.forEach((measure, index) => {
      const stave = new Stave(index * 340, 22, 320).addClef(track.clef)
      if (index === 0) stave.addTimeSignature('4/4')
      stave.setContext(context).draw()
      const staveNotes = measure.map((item) => {
        const staveNote = new StaveNote({ keys: [item.key], duration: item.duration })
        if (item.accidental) staveNote.addModifier(new Accidental(item.accidental), 0)
        return staveNote
      })
      if (staveNotes.length) {
        const voice = new Voice({ num_beats: measure.reduce((sum, item) => sum + (item.duration === 'h' ? 2 : item.duration === 'q' ? 1 : .5), 0), beat_value: 4 })
        voice.addTickables(staveNotes)
        new Formatter().joinVoices([voice]).format([voice], 275)
        voice.draw(context, stave)
      }
      context.setFont('Arial', 11, 'normal').fillText(track.name, index * 340 + 10, 15)
      if (track.transposition) context.fillText(`移调 ${track.transposition > 0 ? '+' : ''}${track.transposition}`, index * 340 + 210, 15)
    })
  }, [track])

  const update = (patch: Parameters<typeof updateNote>[0] extends never ? never : Record<string, unknown>) => dispatch(updateNote(patch as never))
  const stagedForTrack = staged.filter((change) => change.spec.trackId === selectedTrackId)
  return <main className="page">
    <div className="page-head"><div><p className="eyebrow">五线谱编辑与移调 · 总谱力度窗口</p><h1>多声部总谱</h1><p>这里的力度、音符改动只进入暂存；提交时与指挥批注、分谱换页汇成同一次排练校订。</p></div><Space><Tag color={staged.length ? 'orange' : 'green'}>{staged.length ? `暂存 ${staged.length} 处` : '与基线一致'}</Tag><Tooltip title="撤销"><Button icon={<UndoOutlined />} disabled={!history.length} onClick={() => dispatch(undo())} /></Tooltip><Tooltip title="重做"><Button icon={<RedoOutlined />} disabled={!future.length} onClick={() => dispatch(redo())} /></Tooltip></Space></div>
    <div className="score-toolbar"><Segmented value={selectedTrackId} options={tracks.map((item) => ({ label: item.name, value: item.id }))} onChange={(value) => dispatch(selectTrack(String(value)))} /><span style={{flex:1}} /><Button onClick={() => dispatch(transposeTrack(-1))}>降半音</Button><Button onClick={() => dispatch(transposeTrack(1))}>升半音</Button><Select value={track.transposition} style={{width:120}} options={[-12,-7,-5,-2,0,2,5,7,12].map((value)=>({value,label:`移调 ${value > 0 ? '+' : ''}${value}`}))} onChange={(value) => dispatch(transposeTrack(value - track.transposition))} /></div>
    <Alert type="info" showIcon message={`${track.instrument} · ${track.clef === 'treble' ? '高音谱号' : track.clef === 'bass' ? '低音谱号' : '中音谱号'}`} description="改动按小节锚点记录；提交后只有受影响小节的节奏检查、换页提示与出版基线失效重算。" style={{ marginBottom: 12 }} />
    <div className="score-grid">
      <section><div className="score-canvas-wrap" ref={scoreRef} /><div className="note-strip">{track.notes.map((item,index)=><button key={item.id} className={`note-chip ${index===selectedNoteIndex?'active':''}`} onClick={()=>dispatch(selectNote(index))}><b>{index+1}</b><small>{item.key.replace('/', '')} · {item.dynamic}</small></button>)}</div><Space wrap><Button icon={<PlusOutlined />} onClick={()=>dispatch(addNote())}>添加音符</Button><Button danger icon={<DeleteOutlined />} onClick={()=>dispatch(removeNote())}>删除当前</Button><Button onClick={()=>update({ duration: note?.duration === 'q' ? 'h' : note?.duration === 'h' ? '8' : 'q' })}>切换时值</Button><Button onClick={()=>update({ tie: !note?.tie })}>{note?.tie ? '取消延音' : '增加延音'}</Button><Button onClick={()=>update({ accidental: note?.accidental ? undefined : '#' })}>{note?.accidental ? '移除临时记号' : '增加升号'}</Button></Space></section>
      <aside className="panel"><h3>音符属性</h3><label>力度</label><Select value={note?.dynamic} style={{width:'100%'}} options={['pp','p','mp','mf','f','ff'].map((value)=>({value,label:value}))} onChange={(value)=>update({ dynamic:value })} /><label>表情标记</label><Select value={note?.expression} allowClear style={{width:'100%'}} options={[{value:'dolce',label:'dolce 柔和地'},{value:'cantabile',label:'cantabile 如歌地'},{value:'marcato',label:'marcato 着重地'}]} onChange={(value)=>update({ expression:value ?? '' })} /><Divider /><h3>本窗口暂存（{stagedForTrack.length}）</h3><List size="small" dataSource={stagedForTrack} locale={{ emptyText: '暂无改动，直接编辑即可入暂存' }} renderItem={(change) => <List.Item><Tag color="blue">第 {change.spec.measure} 小节</Tag><span>{change.spec.summary}</span></List.Item>} /><Divider /><Alert type="info" showIcon message="三处窗口共享同一份暂存" description="总谱、批注、分谱的改动会在提交时合并为一条校订记录，并记下修改小节、谱面版本与提交标记。" /></aside>
    </div>
  </main>
}
