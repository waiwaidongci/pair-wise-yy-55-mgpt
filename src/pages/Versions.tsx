import { Card, Button, Tag, Tabs, Timeline, Alert, Empty, Space, Typography } from 'antd'
import { CheckOutlined, CloseOutlined, CommentOutlined, CloudSyncOutlined, ThunderboltOutlined } from '@ant-design/icons'
import { useDispatch, useSelector } from 'react-redux'
import type { AppDispatch, RootState } from '../store'
import { discardConflict, reapplyConflict, resolveComment, simulateRemoteEditor } from '../store'

const { Text } = Typography

export default function Versions() {
  const dispatch = useDispatch<AppDispatch>()
  const { commits, comments, conflictBasket, baseline, draftBaseVersion } = useSelector((state: RootState) => state.score)
  const activeComments = comments.filter((item) => !item.resolved)

  return (
    <main className="page">
      <div className="page-head">
        <div>
          <p className="eyebrow">版本、评论与出版基线</p>
          <h1>差异比较与审阅</h1>
          <p>
            每次保存都把总谱力度、指挥批注与分谱换页汇成同一次校订，记下修改小节、当时谱面版本与提交标记；
            先完成者成为出版基线，后到者留在冲突篮，不覆盖已接受片段。
          </p>
        </div>
        <Space>
          <Button icon={<ThunderboltOutlined />} onClick={() => dispatch(simulateRemoteEditor())}>
            模拟另一窗口提交
          </Button>
          <Button type="primary">锁定出版基线</Button>
        </Space>
      </div>

      {draftBaseVersion !== baseline.version && (
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 16 }}
          message="本窗口草稿已落后于出版基线"
          description={`草稿基于 ${draftBaseVersion}，出版基线已推进到 ${baseline.version}。直接保存会把改动留在冲突篮，可在“冲突篮”页签补入未覆盖的小节。`}
        />
      )}

      <Tabs
        items={[
          {
            key: 'diff',
            label: '版本差异',
            children: (
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2,1fr)', gap: 16 }}>
                {commits.map((commit) => (
                  <Card
                    key={commit.commitId}
                    title={
                      <span>
                        {commit.newVersion ?? '冲突'} · {commit.author} <Tag>{commit.time}</Tag>
                      </span>
                    }
                  >
                    <p>{commit.summary}</p>
                    <Space wrap style={{ marginBottom: 8 }}>
                      <Tag icon={<CloudSyncOutlined />} color="blue">
                        提交标记 {commit.commitId.slice(0, 8)}
                      </Tag>
                      <Tag color="default">基于 {commit.baseVersion}</Tag>
                      <Tag color="purple">修改小节 {commit.measures.map((m) => `第 ${m + 1} 小节`).join('、')}</Tag>
                    </Space>
                    {commit.draft.tracks.map((track) => (
                      <div className="diff-row" key={track.id}>
                        <Tag color="red">修改</Tag>
                        <span>{track.name}：本校订涉及的声部改动</span>
                      </div>
                    ))}
                  </Card>
                ))}
              </div>
            ),
          },
          {
            key: 'conflicts',
            label: `冲突篮 ${conflictBasket.length > 0 ? `(${conflictBasket.length})` : ''}`,
            children: conflictBasket.length === 0 ? (
              <Empty description="冲突篮为空。两位编辑从同一版谱面同时提交时，先完成的成为出版基线，另一份会留在这里。" />
            ) : (
              <div style={{ display: 'grid', gridTemplateColumns: '1fr', gap: 16 }}>
                {conflictBasket.map((entry) => (
                  <Card
                    key={entry.commit.commitId}
                    title={
                      <span>
                        {entry.commit.author} <Tag>{entry.commit.time}</Tag>
                        <Tag color="red">未入基线</Tag>
                      </span>
                    }
                  >
                    <Alert type="warning" showIcon message={entry.reason} style={{ marginBottom: 12 }} />
                    <p>{entry.commit.summary}</p>
                    <Space wrap style={{ marginBottom: 12 }}>
                      <Tag icon={<CloudSyncOutlined />} color="blue">
                        提交标记 {entry.commit.commitId.slice(0, 8)}
                      </Tag>
                      <Tag color="default">基于 {entry.commit.baseVersion}</Tag>
                      {entry.conflictingMeasures.map((m) => (
                        <Tag key={m} color="red">
                          冲突 · 第 {m + 1} 小节
                        </Tag>
                      ))}
                      {entry.nonConflictingMeasures.map((m) => (
                        <Tag key={m} color="green">
                          可补入 · 第 {m + 1} 小节
                        </Tag>
                      ))}
                    </Space>
                    <Space>
                      <Button
                        type="primary"
                        icon={<CheckOutlined />}
                        disabled={entry.nonConflictingMeasures.length === 0}
                        onClick={() => dispatch(reapplyConflict(entry.commit.commitId))}
                      >
                        应用可合并部分
                      </Button>
                      <Button danger icon={<CloseOutlined />} onClick={() => dispatch(discardConflict(entry.commit.commitId))}>
                        丢弃
                      </Button>
                    </Space>
                  </Card>
                ))}
              </div>
            ),
          },
          {
            key: 'comments',
            label: `评论锚点 (${activeComments.length})`,
            children: (
              <div style={{ display: 'grid', gridTemplateColumns: '1.3fr .7fr', gap: 16 }}>
                <Card>
                  {comments.map((comment) => (
                    <div
                      key={comment.id}
                      style={{ display: 'grid', gridTemplateColumns: '60px 1fr auto', gap: 12, padding: '14px 0', borderBottom: '1px solid #edf0f5' }}
                    >
                      <Tag icon={<CommentOutlined />}>第 {comment.measure} 小节</Tag>
                      <div>
                        <b>{comment.author}</b>
                        <p>{comment.content}</p>
                      </div>
                      <div>
                        {comment.resolved ? (
                          <Tag color="green">已解决</Tag>
                        ) : (
                          <Button size="small" onClick={() => dispatch(resolveComment(comment.id))}>
                            应用评论
                          </Button>
                        )}
                      </div>
                    </div>
                  ))}
                </Card>
                <Card title="待决事项">
                  <Alert
                    type="warning"
                    showIcon
                    message="第 2 小节力度仍未统一"
                    description="接受评论后会更新圆号分谱，但不会覆盖已接受的片段。"
                  />
                  <div style={{ display: 'flex', gap: 8, marginTop: 14 }}>
                    <Button type="primary" icon={<CheckOutlined />}>
                      接受全部
                    </Button>
                    <Button danger icon={<CloseOutlined />}>
                      拒绝修改
                    </Button>
                  </div>
                </Card>
              </div>
            ),
          },
          {
            key: 'timeline',
            label: '操作历史',
            children: (
              <Card>
                <Timeline
                  items={commits.map((commit) => ({
                    color: commit.status === 'accepted' ? 'green' : 'gray',
                    children: (
                      <span>
                        {commit.time} {commit.author}
                        {commit.newVersion ? ` 提交 ${commit.newVersion}` : ' 提交未入基线'}：{commit.summary}
                        <Text type="secondary">（{commit.commitId.slice(0, 8)}）</Text>
                      </span>
                    ),
                  }))}
                />
              </Card>
            ),
          },
        ]}
      />
    </main>
  )
}
