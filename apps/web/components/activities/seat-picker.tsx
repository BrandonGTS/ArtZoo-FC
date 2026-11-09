'use client';

import { useState } from 'react';
import Image from 'next/image';
import { Button, Popover, Tooltip } from 'antd';
import { type ActivityRole, type SeatRequirement } from '@artzoo/domain';
import { allowedSeatJobs } from './publisher-rules';
import { JOB_GROUPS } from '../members/job-catalog';
import { anyIcon, RequirementIcon, requirementLabel, roles } from './activity-ui';

export default function SeatPicker({
  value,
  onChange,
  disabled,
  index,
  templateRole,
  allowAny = true
}: {
  value: SeatRequirement | null;
  onChange(value: SeatRequirement | null): void;
  disabled?: boolean;
  index: number;
  templateRole?: ActivityRole;
  allowAny?: boolean;
}) {
  const [open, setOpen] = useState(false);
  function select(next: SeatRequirement | null) {
    onChange(next);
    setOpen(false);
  }
  const jobs = allowedSeatJobs(templateRole);
  const content = (
    <div
      className="activity-seat-menu"
      onKeyDown={(event) => {
        if (event.key === 'Escape') setOpen(false);
      }}
    >
      <div className="activity-seat-menu-heading">
        <span>选择要求</span>
      </div>
      <div className="activity-seat-menu-row activity-seat-roles">
        <span>职能</span>
        <div className="activity-seat-options">
          {roles
            .filter((role) => !templateRole || role.value === templateRole)
            .map((role) => (
              <Tooltip key={role.value} title={role.label} trigger={['hover', 'focus']}>
                <Button
                  aria-label={role.label}
                  aria-pressed={value?.kind === 'ROLE' && value.role === role.value}
                  className="activity-icon-button"
                  icon={<Image src={role.icon} alt="" width={24} height={24} unoptimized />}
                  onClick={() => select({ kind: 'ROLE', role: role.value })}
                />
              </Tooltip>
            ))}
          {allowAny ? (
            <Tooltip title="不限" trigger={['hover', 'focus']}>
              <Button
                aria-label="不限"
                aria-pressed={value?.kind === 'ANY'}
                className="activity-icon-button"
                icon={<Image src={anyIcon} alt="" width={24} height={24} unoptimized />}
                onClick={() => select({ kind: 'ANY' })}
              />
            </Tooltip>
          ) : null}
        </div>
      </div>
      {JOB_GROUPS.map((group) => ({ ...group, jobs: group.jobs.filter((job) => jobs.includes(job.name)) }))
        .filter((group) => group.jobs.length)
        .map((group) => (
          <div className="activity-seat-menu-row" key={group.label}>
            <span>{group.label === '输出' ? 'DPS' : group.label}</span>
            <div className="activity-seat-options">
              {group.jobs.map((job) => (
                <Tooltip key={job.name} title={job.name} trigger={['hover', 'focus']}>
                  <Button
                    aria-label={job.name}
                    aria-pressed={value?.kind === 'JOB' && value.job === job.name}
                    className="activity-icon-button"
                    icon={<Image src={job.icon} alt="" width={24} height={24} unoptimized />}
                    onClick={() => select({ kind: 'JOB', job: job.name })}
                  />
                </Tooltip>
              ))}
            </div>
          </div>
        ))}
    </div>
  );
  return (
    <Popover
      open={!disabled && open}
      onOpenChange={setOpen}
      trigger="click"
      placement="bottomRight"
      arrow={false}
      content={content}
      classNames={{ root: 'activity-seat-popover-root', container: 'activity-seat-popover' }}
    >
      <Button
        disabled={disabled}
        aria-label={`席位 ${index + 1}：${requirementLabel(value)}`}
        aria-expanded={open}
        className={`activity-seat-trigger${open ? ' activity-selected' : ''}`}
        icon={<RequirementIcon value={value} />}
      >
        {requirementLabel(value)}
      </Button>
    </Popover>
  );
}
