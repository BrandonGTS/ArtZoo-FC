import { Button } from 'antd';
import { TEAM_POSITIONS, type TeamDetail } from '@artzoo/domain';

interface TeamApplicationReviewListProps {
  readonly pendingApplications: TeamDetail['applications'];
  readonly busy: boolean;
  readonly changed: boolean;
  readonly retryAvailable: boolean;
  readonly send: (action: string, fields: Record<string, unknown>, keep?: boolean) => Promise<boolean>;
}

export function TeamApplicationReviewList({
  pendingApplications,
  busy,
  changed,
  retryAvailable,
  send
}: TeamApplicationReviewListProps) {
  return (
    <>
      <h4>入队申请 · {pendingApplications.length}</h4>
      {pendingApplications.length ? (
        pendingApplications.map((a) => (
          <div className="team-application-row" key={a.id}>
            <div>
              <p>{a.person.displayName || '成员'}</p>
              <p>
                {TEAM_POSITIONS[a.seatPosition]} · {a.job}
              </p>
              {a.note ? <p className="team-description">{a.note}</p> : null}
            </div>
            <div className="team-actions">
              <Button
                disabled={busy || changed || retryAvailable}
                onClick={() => void send('decisions', { applicationId: a.id, decision: 'ACCEPT' }, true)}
              >
                接受
              </Button>
              <Button
                type="link"
                danger
                className="activity-text-link"
                disabled={busy || changed || retryAvailable}
                onClick={() => void send('decisions', { applicationId: a.id, decision: 'REJECT' }, true)}
              >
                拒绝
              </Button>
            </div>
          </div>
        ))
      ) : (
        <p>暂无待审核申请。</p>
      )}
    </>
  );
}
