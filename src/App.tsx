import { Layout, Menu, Button, Tag, Space, Alert } from 'antd'
import { AudioOutlined, FileTextOutlined, HistoryOutlined, SaveOutlined, CloudSyncOutlined } from '@ant-design/icons'
import { Link, Navigate, Route, Routes, useLocation } from 'react-router-dom'
import { useDispatch, useSelector } from 'react-redux'
import type { AppDispatch, RootState } from './store'
import { commitDraft } from './store'
import Overview from './pages/Overview'
import ScoreEditor from './pages/ScoreEditor'
import Parts from './pages/Parts'
import Versions from './pages/Versions'

export default function App() {
  const location = useLocation()
  const dispatch = useDispatch<AppDispatch>()
  const { dirty, baseline, lastCommitId, recoveredCommitId, migrated, migrationNote, conflictBasket } = useSelector(
    (state: RootState) => state.score,
  )
  const items = [
    { key: '/', icon: <AudioOutlined />, label: <Link to="/">作品总览</Link> },
    { key: '/score', icon: <FileTextOutlined />, label: <Link to="/score">总谱编辑</Link> },
    { key: '/parts', icon: <FileTextOutlined />, label: <Link to="/parts">分谱出版</Link> },
    { key: '/versions', icon: <HistoryOutlined />, label: <Link to="/versions">版本与评论</Link> },
  ]
  return (
    <Layout className="app-shell">
      <Layout.Sider width={224} style={{ background: '#0f172a', color: '#fff', minHeight: '100vh' }}>
        <div className="brand">
          <span className="brand-mark">谱</span>
          <div>
            <b>总谱出版台</b>
            <small>SCORE PUBLISHING</small>
          </div>
        </div>
        <Menu theme="dark" mode="inline" selectedKeys={[location.pathname]} items={items} style={{ background: 'transparent', border: 0 }} />
        <div className="side-status">
          <b>《潮汐线》</b>
          <small>总谱 12 小节 · 分谱 4 册</small>
        </div>
      </Layout.Sider>
      <Layout>
        <Layout.Header className="top-header">
          <div>
            <b>沈青 · 室内交响作品</b>
            <Tag style={{ marginLeft: 10 }} color={dirty ? 'orange' : 'green'}>
              {dirty ? '未保存修改' : `基线 ${baseline.version} 已保存`}
            </Tag>
            {conflictBasket.length > 0 && <Tag color="red" style={{ marginLeft: 6 }}>{conflictBasket.length} 份待处理冲突</Tag>}
          </div>
          <Space>
            <span className="commit-marker" title="提交标记：写盘中断后按它续做，同一校订不产生两份记录">
              <CloudSyncOutlined /> 提交标记：{lastCommitId ? lastCommitId.slice(0, 8) : '—'}
            </span>
            <Button>打印预览</Button>
            <Button type="primary" icon={<SaveOutlined />} onClick={() => dispatch(commitDraft())}>
              形成版本
            </Button>
          </Space>
        </Layout.Header>
        <Layout.Content style={{ padding: '16px 22px 0' }}>
          {recoveredCommitId && (
            <Alert
              type="info"
              showIcon
              style={{ marginBottom: 12 }}
              message="已按提交标记恢复写盘"
              description={`检测到中断的写盘（提交标记 ${recoveredCommitId.slice(0, 8)}），已按标记续做，未产生重复记录。`}
            />
          )}
          {migrated && !recoveredCommitId && (
            <Alert type="success" showIcon style={{ marginBottom: 12 }} message="旧数据已升级" description={migrationNote} />
          )}
          <Routes>
            <Route path="/" element={<Overview />} />
            <Route path="/score" element={<ScoreEditor />} />
            <Route path="/parts" element={<Parts />} />
            <Route path="/versions" element={<Versions />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </Layout.Content>
      </Layout>
    </Layout>
  )
}
