'use client';

import { Button, Form, Modal } from 'antd';
import type { ActivityDetail } from '@artzoo/domain';
import { ErrorNotice } from '../account/account-ui';
import { RequirementIcon, requirementLabel } from './activity-ui';

type Seat = ActivityDetail['seats'][number];
export interface ActivityRegistrationDialogProps {
  readonly activity: ActivityDetail;
  readonly registrationOpen: boolean;
  readonly isMoving: boolean;
  readonly isOffline: boolean;
  readonly retryingMove: boolean;
  readonly busy: boolean;
  readonly registrationSeat: Seat | undefined;
  readonly selectedSeat: Seat | undefined;
  readonly availableJobs: readonly { readonly name: string }[];
  readonly job: string | undefined;
  readonly allowed: boolean;
  readonly error: string | null;
  readonly onCancel: () => void;
  readonly onReturn: () => void;
  readonly onChooseJob: (name: string) => void;
  readonly onSubmit: () => Promise<void>;
}

export default function ActivityRegistrationDialog({
  activity,
  registrationOpen,
  isMoving,
  isOffline,
  retryingMove,
  busy,
  registrationSeat,
  selectedSeat,
  availableJobs,
  job,
  allowed,
  error,
  onCancel,
  onReturn,
  onChooseJob,
  onSubmit
}: ActivityRegistrationDialogProps) {
  return (
    <Modal
      open={registrationOpen}
      title={isMoving || retryingMove ? '确认换席位' : '确认报名'}
      centered
      footer={null}
      className="activity-detail-registration-modal"
      onCancel={onCancel}
      closable={!busy}
      mask={{ closable: !busy }}
      keyboard={!busy}
    >
      <Form
        autoComplete="off"
        id="activity-registration-form"
        layout="vertical"
        onFinish={onSubmit}
        disabled={busy}
      >
        {isOffline ? (
          <p>{activity.title}</p>
        ) : (
          <>
            <Form.Item label={isMoving ? '目标席位' : '报名席位'}>
              <div
                className="activity-registration-target"
                aria-label={isMoving ? '目标席位' : '报名席位'}
                data-seat-id={registrationSeat?.id}
              >
                <RequirementIcon value={registrationSeat?.requirement ?? null} />
                <span>
                  {registrationSeat
                    ? `${registrationSeat.groupKey ? registrationSeat.groupKey + '队 · ' : ''}席位${registrationSeat.groupKey ? (registrationSeat.position % 8) + 1 : registrationSeat.position + 1} · ${requirementLabel(registrationSeat.requirement)}`
                    : '席位已变化，请返回后重新选择。'}
                </span>
              </div>
            </Form.Item>
            {activity.category === 'DUNGEON' ? (
              <Form.Item label="参加职业" required>
                <div className="activity-registration-job-grid" role="group" aria-label="参加职业">
                  {availableJobs.map((item) => (
                    <Button
                      key={item.name}
                      htmlType="button"
                      className="activity-registration-job-option"
                      aria-label={item.name}
                      aria-pressed={job === item.name}
                      disabled={!selectedSeat || busy || !!retryingMove || !allowed}
                      onClick={() => onChooseJob(item.name)}
                    >
                      <span className="activity-registration-job-content">
                        <RequirementIcon value={{ kind: 'JOB', job: item.name }} />
                        <span className="activity-registration-job-name">{item.name}</span>
                      </span>
                    </Button>
                  ))}
                </div>
                {!availableJobs.length ? (
                  <p role="alert">该席位当前没有可选职业，请返回后重新选择。</p>
                ) : null}
              </Form.Item>
            ) : null}
          </>
        )}
        <ErrorNotice message={error} />
        <div className="activity-detail-confirm-actions">
          <Button htmlType="button" disabled={busy} onClick={onReturn}>
            返回
          </Button>
          <Button
            type="primary"
            htmlType="submit"
            loading={busy}
            disabled={
              busy ||
              (!retryingMove &&
                (!allowed ||
                  (!isOffline &&
                    (!selectedSeat ||
                      (activity.category === 'DUNGEON' &&
                        !availableJobs.some((item) => item.name === job))))))
            }
          >
            {retryingMove ? '重试原换位' : isMoving ? '确认换席位' : '确认报名'}
          </Button>
        </div>
      </Form>
    </Modal>
  );
}
