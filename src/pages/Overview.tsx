import { Alert, Button, Card, Col, Progress, Row, Table, Tag } from 'antd'
import { useNavigate } from 'react-router-dom'
import { useDispatch, useSelector } from 'react-redux'
import type { AppDispatch, RootState } from '../store'
import { scoreApi, dismissDraftNotice, selectStagedChanges } from '../store'
import { cacheKey, measureCount } from '../rehearsal/changes'

export default function Overview() {
  const navigate = useNavigate()
  const dispatch = useDispatch<AppDispatch>()
  const { domain, working, recoveredDraft, lastEvent } = useSelector((state: RootState) => state.score)
  const staged = useSelector(selectStagedChanges)
  const { data } = scoreApi.endpoints.getPublishingProfile.useQuery()
  const pendingConflicts = domain.conflicts.filter((item) => item.status === 'pending').length
  const openComments = working.comments.filter((item) => !item.resolved).length
  const totalMeasures = domain.tracks.reduce((sum, track) => sum + measureCount(track), 0)
  const staleRhythm = domain.tracks.reduce((sum, track) => {
    for (let measure = 1; measure <= measureCount(track); measure += 1) {
      const entry = domain.derived.cache[cacheKey('rhythm', track.id, measure)]
      if (entry && entry.version < domain.baselineVersion) sum += 1
    }
    return sum
  }, 0)

  return <main className="page">
    <div className="page-head"><div><p className="eyebrow">乐谱、移调与出版准备</p><h1>{data?.title ?? '总谱出版工作台'}</h1><p>总谱力度、指挥批注、分谱换页在三处窗口暂存，汇成同一次排练校订后写入出版基线 v{domain.baselineVersion}。</p></div><Button type="primary" onClick={() => navigate('/score')}>进入总谱编辑</Button></div>
    {recoveredDraft && <Alert type="info" showIcon closable style={{ marginBottom: 16 }} message="已恢复上次未提交的三窗口暂存" description={lastEvent || '音符、批注与换页设置均保留在工作区，可继续编辑后提交。'} onClose={() => dispatch(dismissDraftNotice())} />}
    {pendingConflicts > 0 && <Alert type="warning" showIcon style={{ marginBottom: 16 }} message={`冲突篮有 ${pendingConflicts} 个片段等待处置`} description="两位编辑从同一版谱面提交时，后完成者的重叠小节保留在冲突篮，未覆盖已接受片段。" action={<Button size="small" onClick={() => navigate('/versions')}>处置冲突</Button>} />}
    <Row gutter={[14,14]} className="metrics"><Col xs={24} sm={12} xl={6}><Card className="metric"><span>声部数量</span><strong>{domain.tracks.length}</strong><small>4 个乐手分谱</small></Card></Col><Col xs={24} sm={12} xl={6}><Card className="metric"><span>出版基线版本</span><strong>v{domain.baselineVersion}</strong><small>{domain.revisions.length} 份校订记录</small></Card></Col><Col xs={24} sm={12} xl={6}><Card className="metric"><span>待处理批注 / 冲突</span><strong>{openComments} / {pendingConflicts}</strong><small>指挥意见与冲突篮</small></Card></Col><Col xs={24} sm={12} xl={6}><Card className="metric"><span>暂存改动</span><strong>{staged.length}</strong><small>三窗口合并计数</small></Card></Col></Row>
    <Alert type={pendingConflicts ? 'warning' : 'info'} showIcon message={lastEvent || '派生结果按小节增量维护'} description={`共缓存 ${totalMeasures * 3} 项节奏/换页/基线结果：累计重算 ${domain.derived.recomputeCount} 次，复用未涉及小节 ${domain.derived.reuseCount} 次；${staleRhythm ? `${staleRhythm} 项节奏缓存早于基线待随提交重算。` : '所有已并入小节均为最新版本。'}`} action={<Button size="small" onClick={() => navigate('/versions')}>查看派生日志</Button>} style={{ marginBottom: 16 }} />
    <Row gutter={[16,16]}><Col xs={24} xl={16}><Card title="声部与出版状态"><Table rowKey="id" pagination={false} dataSource={domain.tracks} columns={[{title:'声部',dataIndex:'name'},{title:'乐器',dataIndex:'instrument'},{title:'移调',render:(_value,row)=><Tag color={row.transposition ? 'purple' : 'blue'}>{row.transposition ? `${row.transposition > 0 ? '+' : ''}${row.transposition} 半音` : '不移调'}</Tag>},{title:'小节',render:(_value,row)=>`${measureCount(row)} 小节 / ${row.notes.length} 音`},{title:'节奏缓存',render:(_value,row)=>{ const stale = Array.from({length:measureCount(row)},(_v,i)=>i+1).filter((measure)=>domain.derived.cache[cacheKey('rhythm',row.id,measure)]!.version < domain.baselineVersion).length; return <Tag color={stale ? 'orange' : 'green'}>{stale ? `${stale} 小节待重算` : '全部最新'}</Tag> }}]} /></Card></Col><Col xs={24} xl={8}><Card title="出版检查"><div className="check-row"><span>节奏完整性（按小节缓存）</span><b className={staleRhythm ? 'warning' : 'success'}>{staleRhythm ? `${staleRhythm} 项待重算` : '通过'}</b></div><div className="check-row"><span>换页与提示音</span><b className={pendingConflicts ? 'danger' : 'success'}>{pendingConflicts ? `${pendingConflicts} 项冲突待决` : '已与基线同步'}</b></div><div className="check-row"><span>出版基线</span><b className="success">v{domain.baselineVersion}</b></div><div className="check-row"><span>崩溃续做日志</span><b className="success">提交标记可续</b></div><Progress percent={Math.min(100, 60 + domain.revisions.length * 8 + (pendingConflicts ? -10 : 10))} strokeColor="#2563eb" /><p className="muted">冲突篮清空、批注处理完成后可锁定出版版本。</p></Card></Col></Row>
  </main>
}
