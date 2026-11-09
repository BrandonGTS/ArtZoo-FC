'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import ContentModerationDialog from '../content-moderation-dialog';
import Link from 'next/link';
import { Button, Modal, Table, Steps } from 'antd';
import { useLotteryDetail } from './use-lottery-detail';
import { ActivityHeading } from '../activities/activity-ui';
import { accountRequest, errorDetail } from '../account/api';
import { useFeedbackMessage } from '../use-feedback-message';
import { useAuthSession } from '../auth-session';
import OperationMenu from '../operation-menu';
import { type LotteryView } from '../../server/lottery/contract';
import LotteryCard from './lottery-card';
import { LoadState, LotteryPaper, timeLabel } from './lottery-ui';
import { lotteryStages } from './lottery-timeline';
import { lotteryControls } from './participation-controls';
export default function LotteryDetail({ id }: { id: string }) {
  const { session } = useAuthSession(),
    resource = useLotteryDetail(id),
    router = useRouter(),
    [moderationTarget, setModerationTarget] = useState<{
      id: string;
      owner: string;
      revision: number;
    } | null>(null),
    [moderationLocked, setModerationLocked] = useState(false),
    [updated, setUpdated] = useState<{ owner: string; value: LotteryView } | null>(null),
    [busy, setBusy] = useState(false),
    [cancelOpen, setCancelOpen] = useState(false),
    { notify, contextHolder } = useFeedbackMessage();
  const row =
    updated &&
    updated.owner === session?.user?.id &&
    updated.value.id === id &&
    (!resource.data || updated.value.serverNow > resource.data.serverNow)
      ? updated.value
      : resource.data;
  // Preserve the original key after uncertain responses; visual changes do not redraw.
  const [pending, setPending] = useState<{ action: string; key: string } | null>(null);
  const canModerate = Boolean(
    row?.id === id && row.canModerate && session?.user?.adminRole === 'SUPER_ADMIN' && !resource.error
  );
  const moderationIdentity =
    id +
    ':' +
    (session?.user?.id ?? '') +
    ':' +
    (session?.expiresAt ?? '') +
    ':' +
    (session?.user?.adminRole ?? 'NONE') +
    ':' +
    canModerate;
  const [moderationGeneration, setModerationGeneration] = useState(moderationIdentity);
  if (moderationGeneration !== moderationIdentity) {
    setModerationGeneration(moderationIdentity);
    setModerationTarget(null);
  }

  async function act(action: 'join' | 'leave' | 'cancel') {
    if (busy || moderationLocked) return;
    setBusy(true);
    const key = pending?.action === action ? pending.key : crypto.randomUUID();
    setPending({ action, key });
    try {
      const result = await accountRequest<{ lottery: LotteryView }>(`/api/lotteries/${id}/${action}`, {
        method: 'POST',
        body: { idempotencyKey: key }
      });
      setUpdated({ owner: session!.user!.id, value: result.lottery });
      setPending(null);
      setCancelOpen(false);
      notify('success', action === 'join' ? '已参加抽奖' : action === 'leave' ? '已退出抽奖' : '抽奖已取消');
    } catch (error) {
      notify('error', errorDetail(error).message);
    } finally {
      setBusy(false);
    }
  }
  const canChange = row?.state === 'OPEN' && Date.parse(row.drawAt) > resource.now;
  const stages = row ? lotteryStages(row, resource.now) : [];
  const activeStage = stages[1]?.tone === 'normal' ? 1 : stages.length - 1;
  return (
    <main className="home-content lottery-content lottery-detail-content" id="main-content">
      {contextHolder}
      <ActivityHeading title="抽奖详情">
        <Link className="activity-text-link" href="/lotteries">
          返回抽奖
        </Link>
      </ActivityHeading>
      <LoadState loading={resource.loading} error={resource.error} />
      {row ? (
        <div className="lottery-layout lottery-detail-layout">
          <div className="lottery-stack">
            <LotteryCard
              row={{ ...row, participation: '' }}
              motion={false}
              detail
              headerAction={
                (row.isCreator && canChange) || canModerate ? (
                  <OperationMenu
                    label="抽奖管理操作"
                    disabled={busy || moderationLocked}
                    items={[
                      ...(row.isCreator && canChange
                        ? [{ key: 'cancel', label: '取消抽奖', danger: true }]
                        : []),
                      ...(canModerate ? [{ key: 'moderate', label: '违规删除', danger: true }] : [])
                    ]}
                    onAction={(key) =>
                      key === 'moderate'
                        ? setModerationTarget({
                            id,
                            owner: session?.user?.id ?? '',
                            revision: row.revision ?? 0
                          })
                        : setCancelOpen(true)
                    }
                  />
                ) : null
              }
            />
            <LotteryPaper className="lottery-progress">
              <h2>开奖进度</h2>
              <div className="lottery-stage-scroll">
                <Steps
                  orientation="horizontal"
                  responsive={false}
                  type="dot"
                  current={activeStage}
                  titlePlacement="vertical"
                  items={stages.map((stage, index) => ({
                    status:
                      stage.tone === 'cancelled'
                        ? 'error'
                        : index < activeStage || row.state === 'DRAWN'
                          ? 'finish'
                          : index === activeStage
                            ? 'process'
                            : 'wait',
                    title: (
                      <span
                        className={index === activeStage ? 'lottery-current-stage' : undefined}
                        aria-current={index === activeStage ? 'step' : undefined}
                      >
                        {stage.title}
                      </span>
                    ),
                    content: stage.time ? (
                      <time dateTime={stage.time}>{timeLabel(stage.time)} · 北京时间</time>
                    ) : null
                  }))}
                />
              </div>
            </LotteryPaper>
            {row.state === 'DRAWN' && row.result ? (
              <LotteryPaper className="lottery-drawn">
                <div className="lottery-stack">
                  <h2>中奖结果</h2>
                  <p>
                    {row.result.participants}位参与者 · 共{row.result.winners.length}位中奖
                  </p>
                  {row.result.participants === 0 ? (
                    <p>本场无参与者。</p>
                  ) : (
                    <Table
                      pagination={false}
                      rowKey={(_, i) => String(i)}
                      dataSource={row.result.winners}
                      columns={[
                        { title: '中奖者游戏名', dataIndex: 'gameNickname' },
                        { title: '奖品', dataIndex: 'prize', render: (prize: string) => `${prize} × 1` }
                      ]}
                    />
                  )}
                  {row.result.unassigned ? <p>剩余{row.result.unassigned}份奖品由发起者自行处理。</p> : null}
                  <p className="lottery-note">本场每人最多中奖一次，结果固定保留，不重抽、不补抽。</p>
                </div>
              </LotteryPaper>
            ) : null}
          </div>
          <aside className="lottery-stack">
            <LotteryPaper className="lottery-my-participation">
              <div className="lottery-stack">
                <h2>我的参与</h2>
                {row.state === 'DRAWN' ? (
                  <p className={row.mine.prize ? 'lottery-success' : ''}>
                    {row.mine.prize ? `你已中奖：${row.mine.prize}` : '本场未中奖'}
                  </p>
                ) : null}
                <div className="lottery-participation-actions">
                  {lotteryControls(row, resource.now).map((control) => (
                    <Button
                      key={control.label}
                      type={
                        control.action === 'join'
                          ? 'primary'
                          : control.action === 'leave'
                            ? 'default'
                            : undefined
                      }
                      danger={control.action === 'leave'}
                      disabled={busy || moderationLocked || control.disabled}
                      onClick={() => control.action && void act(control.action)}
                    >
                      {control.label}
                    </Button>
                  ))}
                </div>
              </div>
            </LotteryPaper>
          </aside>
        </div>
      ) : null}
      {canModerate ? (
        <ContentModerationDialog
          key={moderationIdentity}
          scope="lotteries"
          id={id}
          revision={moderationTarget?.revision ?? 0}
          open={moderationTarget?.id === id && moderationTarget?.owner === session?.user?.id}
          onClose={() => setModerationTarget(null)}
          blocked={busy || !!pending}
          onLockedChange={setModerationLocked}
          onRemoved={() => router.push('/lotteries')}
          onStale={() => {
            setModerationTarget(null);
          }}
        />
      ) : null}
      <Modal
        title="取消本场抽奖"
        open={cancelOpen}
        onCancel={() => !busy && setCancelOpen(false)}
        onOk={() => void act('cancel')}
        okText="确认取消"
        okButtonProps={{ danger: true }}
        cancelText="返回"
        confirmLoading={busy}
        cancelButtonProps={{ disabled: busy }}
        closable={!busy}
        mask={{ closable: !busy }}
      >
        <p>取消后不再开奖，并通知本场参与者。确认取消？</p>
      </Modal>
    </main>
  );
}
