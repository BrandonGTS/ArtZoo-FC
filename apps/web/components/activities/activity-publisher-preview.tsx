import Image from 'next/image';
import type {
  ActivityCategory,
  ActivityPerson,
  ActivityMode,
  ActivityScene,
  SeatRequirement
} from '@artzoo/domain';
import { ActivityTypeTag } from './activity-type-tag';
import { PublisherFactIcon } from './publisher-fact-icon';
import {
  ActivityAvatars,
  beijingDate,
  beijingFull,
  beijingTime,
  categoryLabels,
  requirementLabel,
  RequirementIcon
} from './activity-ui';

interface PublisherPreviewProps {
  readonly scene: ActivityScene;
  readonly mode: ActivityMode;
  readonly category: ActivityCategory;
  readonly offline: boolean;
  readonly seriesMode: boolean;
  readonly customDuty: boolean;
  readonly values:
    | Readonly<
        Partial<{
          title: string;
          location: string;
          customDutyName: string;
          capacityMode: 'LIMITED' | 'UNLIMITED';
          capacity: number;
        }>
      >
    | undefined;
  readonly startsAt: string | null;
  readonly endsAt: string | null;
  readonly periodCount: number;
  readonly selectedDuty: Readonly<{ name: string }> | null | undefined;
  readonly initialActivity:
    Readonly<{ registeredCount: number; participants: readonly ActivityPerson[] }> | undefined;
  readonly seats: readonly (SeatRequirement | null)[];
}

function previewDate(value: string) {
  const [, month, day] = beijingDate(value).split('-');
  return Number(month) + '月' + Number(day) + '日';
}
export default function PublisherPreview({
  scene,
  mode,
  category,
  offline,
  seriesMode,
  customDuty,
  values,
  startsAt,
  endsAt,
  periodCount,
  selectedDuty,
  initialActivity,
  seats
}: PublisherPreviewProps) {
  return (
    <>
      <div className="home-activity-title activity-publisher-preview-title">
        <ActivityTypeTag scene={scene} mode={mode} />
        <h3 title={values?.title?.trim()}>{values?.title?.trim() || '填写活动名称'}</h3>
      </div>
      <p className="activity-note home-activity-fact activity-publisher-preview-fact">
        <PublisherFactIcon kind="period" />
        <span>{seriesMode ? '第1 / ' + (periodCount || '—') + '期' : '单次任务'}</span>
      </p>
      <p className="activity-note home-activity-fact activity-publisher-preview-fact">
        <PublisherFactIcon kind={offline ? 'location' : 'duty'} />
        <span title={offline ? values?.location : customDuty ? values?.customDutyName : selectedDuty?.name}>
          {offline
            ? values?.location?.trim() || '填写活动地点'
            : category === 'SOCIAL'
              ? categoryLabels.SOCIAL
              : customDuty
                ? values?.customDutyName?.trim() || '填写副本名称'
                : selectedDuty?.name || '选择副本后显示'}
        </span>
      </p>
      <p
        className="home-activity-time activity-publisher-preview-fact"
        title={
          startsAt && endsAt
            ? beijingFull(startsAt) + ' - ' + beijingFull(endsAt) + '（北京时间）'
            : undefined
        }
      >
        <Image src="/artzoo/icons/calendar-days.svg" alt="" width={20} height={20} unoptimized />
        <span>
          {startsAt ? previewDate(startsAt) + ' · ' + beijingTime(startsAt) : '选择开始时间'} -{' '}
          {endsAt
            ? (startsAt && beijingDate(startsAt) === beijingDate(endsAt) ? '' : previewDate(endsAt) + ' ') +
              beijingTime(endsAt)
            : '选择结束时间'}
        </span>
      </p>

      <div className="home-activity-participants activity-publisher-preview-fact">
        <div className="home-activity-count">
          <Image src="/artzoo/icons/users.svg" alt="" width={20} height={20} unoptimized />
          <span>
            {offline
              ? values?.capacityMode === 'UNLIMITED'
                ? (initialActivity?.registeredCount ?? 0) + ' 人 · 不限人数'
                : (initialActivity?.registeredCount ?? 0) + ' / ' + (values?.capacity ?? '—') + ' 人'
              : (initialActivity?.registeredCount ?? 0) + ' / ' + seats.length + ' 人'}
          </span>
        </div>
        {initialActivity?.participants.length ? (
          <div className="home-activity-people">
            <ActivityAvatars participants={initialActivity.participants.slice(0, 6)} />
            {initialActivity.registeredCount > 6 ? (
              <span className="home-activity-more">+{initialActivity.registeredCount - 6}</span>
            ) : null}
          </div>
        ) : null}
      </div>
      {!offline ? (
        <section className="activity-publisher-preview-composition">
          <h3>队伍构成</h3>
          <div className="activity-publisher-preview-seats">
            {seats.slice(0, 24).map((seat, index) => (
              <span
                key={index}
                title={requirementLabel(seat)}
                aria-label={'席位' + (index + 1) + ' · ' + requirementLabel(seat)}
              >
                <RequirementIcon value={seat} />
              </span>
            ))}
          </div>
        </section>
      ) : null}
    </>
  );
}
