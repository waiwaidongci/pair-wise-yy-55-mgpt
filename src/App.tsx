import { Layout, Menu, Button, Tag, Space, Alert } from 'antd'
import { AudioOutlined, FileTextOutlined, HistoryOutlined, SaveOutlined, CloudSyncOutlined } from '@ant-design/icons'
import { Link, Navigate, Route, Routes, useLocation } from 'react-router-dom'
import { useDispatch, useSelector } from 'react-redux'
import type { AppDispatch, RootState } from './store'
import { discardPendingCommit, resumePending, saveRevision, selectDirty } from './store'
import Overview from './pages/Overview'
import ScoreEditor from './pages/ScoreEditor'
import Parts from './pages/Parts'
import Versions from './pages/Versions'

export default function App() {
  const location = useLocation()
  const dispatch = useDispatch<AppDispatch>()
  const dirty = useSelector(selectDirty)
  const pending = useSelector((state: RootState) => state.score.pendingCommit)
  const interrupted = useSelector((state: RootState) => state.score.writeInterrupted)
  const baselineVersion = useSelector((state: RootState) => state.score.domain.baselineVersion)
  const items = [
    { key: '/', icon: <AudioOutlined />, label: <Link to="/">作品总览</Link> },
    { key: '/score', icon: <FileTextOutlined />, label: <Link to="/score">总谱编辑</Link> },
    { key: '/parts', icon: <FileTextOutlined />, label: <Link to="/parts">分谱出版</Link> },
    { key: '/versions', icon: <HistoryOutlined />, label: <Link to="/versions">版本与冲突</Link> },
  ]
  return (
    <Layout className="app-shell">
      <Layout.Sider width={224} style={{ background: '#0f172a', color: '#fff', minHeight: '100vh' }}>
        <div className="brand"><span className="brand-mark">谱</span><div><b>总谱出版台</b><small>REHEARSAL REVISIONS</small></div></div>
        <Menu theme="dark" mode="inline" selectedKeys={[location.pathname]} items={items} style={{ background: 'transparent', border: 0 }} />
        <div className="side-status"><b>《潮汐线》</b><small>出版基线 v{baselineVersion} · 总谱 12 小节 · 分谱 4 册</small></div>
      </Layout.Sider>
      <Layout>
        <Layout.Header className="top-header">
          <div><b>沈青 · 室内交响作品</b><Tag style={{ marginLeft: 10 }} color={pending ? 'red' : dirty ? 'orange' : 'green'}>{pending ? `提交标记 ${pending.token.slice(-5)} 未完成` : dirty ? '三个窗口有未提交校订' : `出版基线 v${baselineVersion} 已同步`}</Tag></div>
          <Space>
            <Button>打印预览</Button>
            <Button type="primary" icon={pending ? <CloudSyncOutlined /> : <SaveOutlined />} danger={Boolean(pending)} onClick={() => dispatch(pending ? resumePending() : saveRevision())} disabled={!dirty && !pending}>
              {pending ? (interrupted ? `按标记 ${pending.token.slice(-5)} 续做` : '等待写盘完成') : '汇成一次校订提交'}
            </Button>
          </Space>
        </Layout.Header>
        {pending && interrupted && (
          <Alert
            className="commit-banner" type="error" showIcon banner
            message={`写盘中断：提交标记 ${pending.token} 已写入续做日志（依据 v${pending.request.baseVersion}，含 ${pending.request.edits.length} 处改动）`}
            description="谱面快照可能只写了一半。续做时凭提交标记识别，同一校订不会多出第二份记录；也可以丢弃该标记。"
            action={<Space><Button size="small" type="primary" icon={<CloudSyncOutlined />} onClick={() => dispatch(resumePending())}>按提交标记续做</Button><Button size="small" danger onClick={() => dispatch(discardPendingCommit())}>丢弃标记</Button></Space>}
          />
        )}
        <Layout.Content><Routes><Route path="/" element={<Overview />} /><Route path="/score" element={<ScoreEditor />} /><Route path="/parts" element={<Parts />} /><Route path="/versions" element={<Versions />} /><Route path="*" element={<Navigate to="/" replace />} /></Routes></Layout.Content>
      </Layout>
    </Layout>
  )
}
