import { useState } from 'react'
import { Button, InputNumber, Select, Space, Switch, Tag, Alert, Divider } from 'antd'
import { PrinterOutlined } from '@ant-design/icons'
import { useDispatch, useSelector } from 'react-redux'
import type { AppDispatch, RootState } from '../store'
import { setPageTurn } from '../store'
import { cacheKey, measureCount } from '../rehearsal/changes'

export default function Parts() {
  const dispatch = useDispatch<AppDispatch>()
  const { working, domain } = useSelector((state: RootState) => state.score)
  const tracks = working.tracks
  const [trackId, setTrackId] = useState(tracks[0]!.id)
  const selectedTrackId = trackId
  const settings = working.pageTurns[selectedTrackId]!
  const baseSettings = domain.pageTurns[selectedTrackId]!
  const track = tracks.find((item) => item.id === selectedTrackId)!
  const pageTurnStaged = settings.cue !== baseSettings.cue || settings.pageTurnMeasure !== baseSettings.pageTurnMeasure
  const measures = measureCount(track)
  const update = (patch: { cue?: boolean; pageTurnMeasure?: number }) => dispatch(setPageTurn({ trackId: selectedTrackId, patch }))
  return <main className="page">
    <div className="page-head no-print"><div><p className="eyebrow">分谱提取与出版排版 · 换页窗口</p><h1>演奏者分谱预览</h1><p>换页位置与提示音改动进入共享暂存；提交时只让本声部各小节的换页提示缓存失效。</p></div><Button type="primary" icon={<PrinterOutlined />} onClick={() => window.print()}>打印分谱</Button></div>
    <div className="panel no-print" style={{marginBottom:16}}><Space wrap><Select value={selectedTrackId} style={{width:180}} options={tracks.map((item)=>({value:item.id,label:`${item.name} · ${item.instrument}`}))} onChange={setTrackId} /><span>换页前提示音：</span><InputNumber min={1} max={measures} value={settings.pageTurnMeasure} onChange={(value)=>update({ pageTurnMeasure:value ?? 1 })} /><span>小节前换页</span><Switch checked={settings.cue} onChange={(value)=>update({ cue:value })} checkedChildren="显示提示音" unCheckedChildren="隐藏提示音" /><Tag color={pageTurnStaged ? 'orange' : 'green'}>{pageTurnStaged ? '换页改动待提交' : '与出版基线一致'}</Tag><Tag color={track.transposition ? 'purple' : 'blue'}>{track.transposition ? `移调 ${track.transposition}` : '不移调'}</Tag></Space></div>
    {pageTurnStaged && <Alert type="warning" showIcon className="no-print" style={{marginBottom:16}} message="换页设置已暂存" description={`将在第 ${settings.pageTurnMeasure} 小节前换页，提示音${settings.cue ? '显示' : '隐藏'}；与总谱、批注的改动一并提交为同一次校订。`} />}
    <article className="part-page">
      <div style={{display:'flex',justifyContent:'space-between',borderBottom:'2px solid #0f172a',paddingBottom:10}}><div><h1 style={{margin:0,fontFamily:'serif'}}>{track.name}</h1><small>{track.instrument} · 移调后记谱分谱</small></div><div style={{textAlign:'right'}}><b>《潮汐线》</b><div>沈青 作品</div><div>出版稿 v{domain.baselineVersion}</div></div></div>
      <div style={{display:'flex',justifyContent:'space-between',marginTop:10}}><b>I. 潮起 · ♩ = 72</b><span>1</span></div>
      {Array.from({ length: measures }, (_v, measureIndex) => {
        const measure = measureIndex + 1
        const cached = domain.derived.cache[cacheKey('pageTurnCue', track.id, measure)]
        return <div key={measureIndex}>
          <div className="part-measure">{track.notes.slice(measureIndex*4, measureIndex*4+4).map((note,index)=><div key={note.id} className="part-note"><b>{note.key.replace('/', '')}</b><small style={{display:'block',color:'#64748b'}}>{note.dynamic}{note.tie ? ' ⁀' : ''}</small>{settings.cue && index===0 && measureIndex>0 && <em style={{display:'block',fontSize:10,color:'#2563eb'}}>提示：{tracks[(tracks.indexOf(track)+1)%tracks.length]!.name}</em>}</div>)}</div>
          <div style={{display:'flex',justifyContent:'space-between',color:'#64748b',fontSize:12}}>
            {measure === settings.pageTurnMeasure ? <span>换页 → 建议在第 {settings.pageTurnMeasure} 小节前（暂存）</span> : <span>第 {measure} 小节</span>}
            <Tag color={cached?.version === domain.baselineVersion ? 'default' : 'orange'}>{cached?.value ?? '待重算'} · 缓存 v{cached?.version}</Tag>
          </div>
        </div>
      })}
      <Divider className="no-print" />
      <div className="no-print" style={{color:'#475569',fontSize:12}}>缓存版本标签展示：未涉及换页的小节在提交后仍沿用原缓存（版本号保持旧值即可复用）。</div>
      <div style={{marginTop:30,borderTop:'1px solid #94a3b8',paddingTop:10,color:'#64748b',fontSize:11}}>© 2026 云谱出版社 · 仅限排练使用 · 禁止未授权复制</div>
    </article>
  </main>
}
