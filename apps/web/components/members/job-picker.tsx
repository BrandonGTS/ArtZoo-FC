'use client';

import Image from 'next/image';
import { Button, Tooltip } from 'antd';
import { JOB_GROUPS, JOBS, toggleJob } from './job-catalog';
import './job-picker.css';

type JobPickerProps = {
  value?: string[];
  onChange?: (value: string[]) => void;
  disabled?: boolean;
  id?: string;
};
export function JobPicker({ value = [], onChange, disabled = false, id }: JobPickerProps) {
  const unknown = value.filter((name) => !JOBS.some((job) => job.name === name));
  function toggle(name: string) {
    if (!disabled) onChange?.(toggleJob(value, name));
  }
  return (
    <div id={id} className="member-job-picker" role="group" aria-label="擅长的职业">
      {JOB_GROUPS.map((group) => (
        <div className="member-job-row" key={group.label} role="group" aria-label={group.label}>
          <div className="member-job-options">
            {group.jobs.map((job) => (
              <Tooltip key={job.name} title={job.name} trigger={['hover', 'focus']}>
                <Button
                  htmlType="button"
                  aria-label={job.name}
                  aria-pressed={value.includes(job.name)}
                  disabled={disabled}
                  className={`member-job-button${value.includes(job.name) ? ' member-job-selected' : ''}`}
                  onClick={() => toggle(job.name)}
                  icon={<Image src={job.icon} alt="" width={56} height={56} unoptimized />}
                />
              </Tooltip>
            ))}
          </div>
        </div>
      ))}
      {unknown.length ? (
        <div className="member-job-legacy" role="group" aria-label="已保留的其他职业">
          <span className="member-note">已保留的其他职业</span>
          {unknown.map((name, index) => (
            <Button
              key={`${index}-${name}`}
              htmlType="button"
              disabled={disabled}
              aria-pressed
              aria-label={`取消职业：${name}`}
              onClick={() => toggle(name)}
            >
              {name} ×
            </Button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

export function SelectedJobs({ value }: { value: string[] }) {
  if (!value.length) return <p>暂未填写</p>;
  const unknown = value.filter((name) => !JOBS.some((job) => job.name === name));
  return (
    <div className="member-selected-jobs">
      {JOB_GROUPS.map((group) => (
        <div key={group.label} className="member-selected-job-row" role="group" aria-label={group.label}>
          {group.jobs
            .filter((job) => value.includes(job.name))
            .map((job) => (
              <Tooltip key={job.name} title={job.name} trigger={['hover', 'focus']}>
                <span className="member-selected-job" tabIndex={0} role="img" aria-label={job.name}>
                  <Image src={job.icon} alt="" width={24} height={24} unoptimized />
                </span>
              </Tooltip>
            ))}
        </div>
      ))}
      {unknown.length ? (
        <div className="member-selected-job-legacy">
          {unknown.map((name, index) => (
            <span key={`${index}-${name}`} className="member-legacy-job">
              {name}
            </span>
          ))}
        </div>
      ) : null}
    </div>
  );
}
