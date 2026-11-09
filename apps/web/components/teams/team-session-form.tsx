'use client';

import { useRef, useState } from 'react';
import dayjs, { type Dayjs } from 'dayjs';
import { Button, DatePicker, Form, Select, TimePicker, type FormInstance } from 'antd';
import { beijingPickerOffset, beijingPickerTimestamp } from '../beijing-picker';
import { toBeijingPicker, teamSessionInCycle, type TeamDetail, type TeamSessionView } from '@artzoo/domain';
import { beijingDate, beijingFull, beijingTime } from '../activities/activity-ui';

type Cycle = { startsAt: Date; endsAt: Date };
type Times = { date: Dayjs; start: Dayjs; end: Dayjs };
type SessionTimes = { startsAt: string; endsAt: string };
type CommonProps = { team: TeamDetail; disabled: boolean; busy: boolean; onCancel(): void };

function localPicker(value: string) {
  return dayjs(toBeijingPicker(new Date(value), 'second'));
}
function minute(value: Dayjs) {
  return value.hour() * 60 + value.minute();
}

/** A date belongs to the start; an earlier end clock explicitly means next day. */
export function sessionTimes({ date, start, end }: Times): SessionTimes {
  const startMinute = minute(start),
    endMinute = minute(end);
  if (startMinute === endMinute) throw new RangeError('结束时间不能与开始时间相同');
  return {
    startsAt: beijingPickerOffset(date.format('YYYY-MM-DD') + 'T' + start.format('HH:mm') + ':00'),
    endsAt: beijingPickerOffset(
      date.add(endMinute < startMinute ? 1 : 0, 'day').format('YYYY-MM-DD') +
        'T' +
        end.format('HH:mm') +
        ':00'
    )
  };
}
export function sessionFitsClockForm(session: Pick<TeamSessionView, 'startsAt' | 'endsAt'>) {
  try {
    const times = sessionTimes({
      date: localPicker(session.startsAt),
      start: localPicker(session.startsAt),
      end: localPicker(session.endsAt)
    });
    return (
      Date.parse(times.startsAt) === Date.parse(session.startsAt) &&
      Date.parse(times.endsAt) === Date.parse(session.endsAt)
    );
  } catch {
    return false;
  }
}
/** Includes both calendar Tuesdays; the actual boundary is checked per start clock. */
export function cycleDates(cycle: Cycle): string[] {
  const first = localPicker(cycle.startsAt.toISOString()).startOf('day'),
    last = beijingDate(cycle.endsAt);
  const dates: string[] = [];
  for (let date = first; date.format('YYYY-MM-DD') <= last; date = date.add(1, 'day'))
    dates.push(date.format('YYYY-MM-DD'));
  return dates;
}
function cycleLabel(cycle: Cycle) {
  return `开场范围：${beijingFull(cycle.startsAt.toISOString())}（含）至 ${beijingFull(cycle.endsAt.toISOString())}（不含）`;
}

function TimeFields({
  form,
  prefix = [],
  date,
  cycle,
  disabled = false
}: {
  form: FormInstance;
  prefix?: string[];
  date?: string;
  cycle?: Cycle;
  disabled?: boolean;
}) {
  const start = Form.useWatch([...prefix, 'start'], form) as Dayjs | undefined,
    end = Form.useWatch([...prefix, 'end'], form) as Dayjs | undefined;
  const overnight = !!start && !!end && minute(end) < minute(start);
  const first = cycle ? beijingDate(cycle.startsAt) : undefined,
    last = cycle ? beijingDate(cycle.endsAt) : undefined;
  return (
    <>
      <div className="team-date-time">
        <Form.Item
          name={[...prefix, 'start']}
          label="开始时间（北京时间）"
          rules={[
            { required: true, message: '请选择开始时间' },
            () => ({
              validator: async (_, value: Dayjs | undefined) => {
                if (!value || !date || !cycle) return;
                if (
                  !teamSessionInCycle(
                    new Date(beijingPickerTimestamp(date + 'T' + value.format('HH:mm') + ':00')),
                    cycle
                  )
                )
                  throw new Error('开场时间须在所选周范围内');
              }
            })
          ]}
        >
          <TimePicker
            format="HH:mm"
            disabled={disabled}
            disabledTime={() => ({
              disabledHours: () =>
                date && date === first
                  ? Array.from({ length: 16 }, (_, i) => i)
                  : date && date === last
                    ? Array.from({ length: 8 }, (_, i) => i + 16)
                    : []
            })}
          />
        </Form.Item>
        <Form.Item
          name={[...prefix, 'end']}
          label="结束时间（北京时间）"
          dependencies={[[...prefix, 'start']]}
          rules={[
            { required: true, message: '请选择结束时间' },
            ({ getFieldValue }) => ({
              validator: async (_, value: Dayjs | undefined) => {
                const from = getFieldValue([...prefix, 'start']) as Dayjs | undefined;
                if (value && from && minute(value) === minute(from))
                  throw new Error('结束时间不能与开始时间相同');
              }
            })
          ]}
        >
          <TimePicker format="HH:mm" disabled={disabled} />
        </Form.Item>
      </div>
      {start && end ? (
        <p className="auxiliary" role="status">
          {overnight ? `结束于次日${end.format('HH:mm')}` : `结束于当日${end.format('HH:mm')}`}
        </p>
      ) : null}
    </>
  );
}

export function SingleSessionForm({
  team,
  future,
  editing,
  disabled,
  busy,
  onCancel,
  onSubmit
}: CommonProps & {
  future: TeamSessionView[];
  editing?: { sessionId?: string };
  onSubmit(fields: Record<string, unknown>, editing: boolean): Promise<boolean>;
}) {
  const [form] = Form.useForm(),
    [selected, setSelected] = useState(editing?.sessionId);
  const existing = future.find((s) => s.id === selected),
    unrepresentable = !!existing && !sessionFitsClockForm(existing);
  const initial = existing
    ? {
        date: localPicker(existing.startsAt),
        start: localPicker(existing.startsAt),
        end: localPicker(existing.endsAt)
      }
    : undefined;
  function select(id: string) {
    setSelected(id);
    const session = future.find((s) => s.id === id);
    form.setFieldsValue(
      session
        ? {
            date: localPicker(session.startsAt),
            start: localPicker(session.startsAt),
            end: localPicker(session.endsAt)
          }
        : { date: undefined, start: undefined, end: undefined }
    );
  }
  return (
    <Form
      autoComplete="off"
      form={form}
      layout="vertical"
      disabled={disabled}
      initialValues={initial}
      onFinish={(values: Times) => {
        if (unrepresentable || (editing && !selected)) return;
        void onSubmit({ ...sessionTimes(values), ...(editing ? { sessionId: selected } : {}) }, !!editing);
      }}
    >
      <p>{team.name}</p>
      {editing ? (
        <Form.Item label="具体场次">
          <Select
            aria-label="调整具体场次"
            value={selected}
            options={future.map((s) => ({ value: s.id, label: beijingFull(s.startsAt) }))}
            onChange={select}
          />
        </Form.Item>
      ) : null}
      {unrepresentable && existing ? (
        <p role="alert" className="team-description">
          原排期：{beijingFull(existing.startsAt)} 至 {beijingFull(existing.endsAt)}
          。此跨多日排期无法由当日或次日结束的时间表单完整表达，暂不能在此修改；原排期将保留。
        </p>
      ) : null}
      <Form.Item name="date" label="活动日期" rules={[{ required: true, message: '请选择活动日期' }]}>
        <DatePicker format="YYYY-MM-DD" disabled={disabled || unrepresentable} />
      </Form.Item>
      <TimeFields form={form} disabled={disabled || unrepresentable} />
      {editing ? <p>修改本场时间后，原反馈将失效，本场需重新确认。</p> : null}
      <div className="team-actions">
        <Button disabled={busy} onClick={onCancel}>
          取消
        </Button>
        <Button
          type="primary"
          htmlType="submit"
          loading={busy}
          disabled={disabled || unrepresentable || !!(editing && !selected)}
        >
          保存排期
        </Button>
      </div>
    </Form>
  );
}

type NewWeeklyRow = { key: string; date: string };

export function WeeklySessionForm({
  team,
  cycle,
  disabled,
  busy,
  onCancel,
  onSubmit
}: CommonProps & { cycle: Cycle; onSubmit(fields: Record<string, unknown>): Promise<boolean> }) {
  const [form] = Form.useForm(),
    [rows, setRows] = useState<NewWeeklyRow[]>([]),
    nextKey = useRef(0),
    dates = cycleDates(cycle);
  const existing = (team.sessions ?? [])
    .filter((s) => s.state !== 'CANCELLED' && teamSessionInCycle(new Date(s.startsAt), cycle))
    .sort((a, b) => Date.parse(a.startsAt) - Date.parse(b.startsAt));
  function add(date: string) {
    if (disabled) return;
    const row = { key: 'new-' + nextKey.current++, date };
    setRows((values) => [...values, row]);
  }
  function remove(key: string) {
    if (disabled) return;
    setRows((values) => values.filter((row) => row.key !== key));
    form.setFieldValue(['sessions', key], undefined);
  }
  return (
    <Form
      autoComplete="off"
      form={form}
      layout="vertical"
      disabled={disabled}
      preserve={false}
      onFinish={(values: { sessions: Record<string, { start: Dayjs; end: Dayjs }> }) => {
        if (!rows.length) return;
        const sessions = rows.map((row) =>
          sessionTimes({ date: dayjs(row.date), ...values.sessions[row.key]! })
        );
        if (sessions.some((times) => !teamSessionInCycle(new Date(times.startsAt), cycle))) return;
        void onSubmit({ cycleStart: cycle.startsAt.toISOString(), sessions });
      }}
    >
      <p>{team.name}</p>
      <p>{cycleLabel(cycle)}</p>
      <p>已有排期仅供查看，点击＋可在同一天新增独立场次。只保存新增行；删除新增行不会修改已有排期。</p>
      <div className="team-weekly-sessions">
        {dates.map((date, index) => {
          const scheduled = existing.filter((s) => beijingDate(s.startsAt) === date),
            added = rows.filter((row) => row.date === date);
          return (
            <section className="team-weekly-session" key={date} aria-label={date + '排期'}>
              <div className="team-section-heading team-weekly-date-heading">
                <h4>
                  {date.replaceAll('-', '/')}
                  {index === 0 ? ' · 16:00起' : index === dates.length - 1 ? ' · 16:00前' : ''}
                </h4>
                <Button
                  type="primary"
                  htmlType="button"
                  className="team-weekly-add"
                  aria-label={date + '新增场次'}
                  disabled={disabled}
                  onClick={() => add(date)}
                >
                  ＋
                </Button>
              </div>
              {scheduled.map((session) => (
                <div className="team-weekly-existing" key={session.id}>
                  <div className="team-weekly-existing-copy" aria-label="已有排期，只读">
                    <span>{date.replaceAll('-', '/')}</span>
                    <span>
                      {beijingTime(session.startsAt)}–
                      {beijingDate(session.endsAt) === date
                        ? beijingTime(session.endsAt)
                        : beijingFull(session.endsAt)}
                    </span>
                    <span>已有排期</span>
                  </div>
                </div>
              ))}
              {!scheduled.length && !added.length ? <p className="auxiliary">暂无排期</p> : null}
              {added.map((row, rowIndex) => (
                <div className="team-weekly-new" key={row.key}>
                  <div className="team-section-heading">
                    <h5>新增场次 {rowIndex + 1}</h5>
                    <Button
                      type="text"
                      htmlType="button"
                      aria-label={date + '删除新增场次 ' + (rowIndex + 1)}
                      disabled={disabled}
                      onClick={() => remove(row.key)}
                    >
                      删除新增行
                    </Button>
                  </div>
                  <TimeFields
                    form={form}
                    prefix={['sessions', row.key]}
                    date={date}
                    cycle={cycle}
                    disabled={disabled}
                  />
                </div>
              ))}
            </section>
          );
        })}
      </div>
      <div className="team-actions">
        <Button disabled={busy} onClick={onCancel}>
          取消
        </Button>
        <Button type="primary" htmlType="submit" loading={busy} disabled={disabled || !rows.length}>
          保存下周排期
        </Button>
      </div>
    </Form>
  );
}
