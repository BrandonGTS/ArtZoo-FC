'use client';
import { useEffect, type CSSProperties } from 'react';
import { Button, Collapse, Progress, theme } from 'antd';
import type { SiteHelpLessonId } from '@artzoo/domain';
import { HELP_LESSONS, completedHelpSteps } from './help-content';
import { useSiteHelp } from './site-help-provider';
export default function SiteHelpPanel({ onClose }: { onClose(): void }) {
  const help = useSiteHelp(),
    { refresh } = help,
    { token } = theme.useToken();
  useEffect(() => {
    void refresh();
  }, [refresh]);
  async function launch(lessonId: SiteHelpLessonId, restart = false) {
    if (await help.start(lessonId, restart)) onClose();
  }
  return (
    <section
      className="site-help-panel"
      style={
        {
          '--site-help-restart-bg': token.colorError,
          '--site-help-restart-active-bg': token.colorErrorActive,
          '--site-help-restart-color': token.colorWhite
        } as CSSProperties
      }
      role="dialog"
      aria-label="网站使用帮助面板"
      aria-busy={help.loading || help.starting}
    >
      <Button block disabled className="site-help-quick-start" icon={<PlayIcon />}>
        快速开始
      </Button>
      {!help.signedIn ? <p className="site-help-guest-note">访客体验，不记录账号进度</p> : null}
      {help.error ? (
        <div className="site-help-read-error">
          <p role="alert">{help.error}</p>
          <Button type="text" disabled={help.loading} onClick={() => void help.refresh()}>
            重新读取
          </Button>
        </div>
      ) : null}
      <Collapse
        ghost
        defaultActiveKey={['guide']}
        expandIconPlacement="end"
        className="site-help-guide"
        styles={{ header: { padding: '12px 0' }, body: { padding: 0 } }}
        items={[
          {
            key: 'guide',
            label: '新手引导',
            children: (
              <div className="site-help-lessons">
                {HELP_LESSONS.map((lesson) => {
                  const count = completedHelpSteps(lesson, help.progress).length,
                    total = lesson.steps.length,
                    known = !help.signedIn || help.progress !== null;
                  const complete = known && count === total,
                    label = complete ? '已完成' : count > 0 ? '继续引导' : '开始引导';
                  return (
                    <section
                      className="site-help-lesson"
                      aria-label={lesson.title + '学习进度'}
                      key={lesson.lessonId}
                    >
                      <div className="site-help-lesson-heading">
                        <span className="site-help-lesson-title">
                          <LessonIcon lessonId={lesson.lessonId} />
                          {lesson.title}
                        </span>
                        <Button
                          size="small"
                          type={known && count === 0 ? 'primary' : 'default'}
                          className={complete ? 'site-help-completed' : undefined}
                          aria-label={lesson.title + '：' + (complete ? '已完成，重新引导' : label)}
                          disabled={help.loading || help.starting || !known}
                          onClick={() => void launch(lesson.lessonId, complete)}
                        >
                          {complete ? (
                            <>
                              <span className="site-help-completed-label">已完成</span>
                              <span className="site-help-restart-label" aria-hidden>
                                重新引导
                              </span>
                            </>
                          ) : (
                            label
                          )}
                        </Button>
                      </div>
                      {!complete ? (
                        <Progress
                          percent={(count / total) * 100}
                          size="small"
                          format={() => (known ? count : '—') + ' / ' + total}
                          aria-label={
                            known
                              ? lesson.title + '已完成' + count + '步，共' + total + '步'
                              : lesson.title + '学习进度未读取'
                          }
                        />
                      ) : null}
                    </section>
                  );
                })}
              </div>
            )
          }
        ]}
      />
    </section>
  );
}
function LessonIcon({ lessonId }: { lessonId: SiteHelpLessonId }) {
  const paths = {
    home: 'm3 10 9-7 9 7v10H3V10M9 20v-7h6v7',
    albums: 'M3 4h18v16H3V4m0 12 6-6 5 5 3-3 4 4M16 8h.01',
    daily: 'M4 4h16v12H9l-5 4V4m4 4h8m-8 4h5',
    activities: 'M4 6h16v15H4V6m0 5h16M8 3v6m8-6v6',
    wishes: 'M12 21 3 12a5 5 0 0 1 9-6 5 5 0 0 1 9 6L12 21',
    lotteries: 'M3 8h18v13H3V8M2 4h20v4H2V4M12 4v17',
    knowledge: 'M12 6C8 3 4 4 3 5v15c3-2 6-1 9 1m0-15c4-3 8-2 9-1v15c-3-2-6-1-9 1V6'
  };
  return (
    <svg
      aria-hidden="true"
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d={paths[lessonId]} />
    </svg>
  );
}

function PlayIcon() {
  return (
    <svg
      aria-hidden="true"
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="m8 4 12 8-12 8V4Z" />
    </svg>
  );
}
