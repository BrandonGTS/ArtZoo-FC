import { Checkbox, DatePicker, Form, Input, InputNumber, Radio, Select } from 'antd';
import type { Dispatch, SetStateAction } from 'react';
import type { generateSeriesPeriods } from '@artzoo/domain';
import { ErrorNotice } from '../account/account-ui';
import { beijingFull } from './activity-ui';
import { manualWeekdaysAfterSelection } from './publisher-rules';
import type { PickerDate, PublishForm } from './activity-publisher';

interface PublisherTimingProps {
  offline: boolean;
  seriesMode: boolean;
  cutoff: string;
  automaticWeekday: number | null;
  setManualWeekdays: Dispatch<SetStateAction<number[]>>;
  values: Partial<PublishForm> | undefined;
  periodError: string | null;
  periodPreview: ReturnType<typeof generateSeriesPeriods>;
  toBeijing(value: PickerDate): string;
}

export default function PublisherTiming({
  offline,
  seriesMode,
  cutoff,
  automaticWeekday,
  setManualWeekdays,
  values,
  periodError,
  periodPreview,
  toBeijing
}: PublisherTimingProps) {
  return (
    <section className="activity-form-section">
      <h2 className="activity-publisher-section-title">活动时间 · 北京时间</h2>
      <div className="activity-form-columns" data-help-target="activity-publish-time">
        <Form.Item name="startsAt" label="开始时间" rules={[{ required: true, message: '请选择开始时间' }]}>
          <DatePicker
            classNames={{ popup: { root: 'activity-publisher-date-popup' } }}
            popupAlign={{
              offset: [0, 0],
              overflow: { adjustX: true, adjustY: true, shiftX: true, shiftY: true }
            }}
            showTime={{ format: 'HH:mm' }}
            format="YYYY-MM-DD HH:mm"
            placeholder="选择开始日期与时间"
          />
        </Form.Item>
        {!seriesMode ? (
          <Form.Item
            name="endsAt"
            label="预定结束时间"
            dependencies={['startsAt']}
            rules={[
              { required: true, message: '请选择预定结束时间' },
              ({ getFieldValue }) => ({
                validator(_, value: PickerDate) {
                  const start = getFieldValue('startsAt') as PickerDate | undefined;
                  return !value || !start || toBeijing(value) > toBeijing(start)
                    ? Promise.resolve()
                    : Promise.reject(new Error('预定结束时间必须晚于开始时间'));
                }
              })
            ]}
          >
            <DatePicker
              classNames={{ popup: { root: 'activity-publisher-date-popup' } }}
              popupAlign={{
                offset: [0, 0],
                overflow: { adjustX: true, adjustY: true, shiftX: true, shiftY: true }
              }}
              showTime={{ format: 'HH:mm' }}
              format="YYYY-MM-DD HH:mm"
              placeholder="选择预定结束日期与时间"
            />
          </Form.Item>
        ) : (
          <Form.Item
            name="durationMinutes"
            label="每期时长（分钟）"
            rules={[
              { required: true, message: '请填写每期时长' },
              { type: 'integer', min: 1, message: '请填写正整数分钟' }
            ]}
          >
            <InputNumber min={1} precision={0} suffix="分钟" />
          </Form.Item>
        )}
      </div>
      {offline ? (
        <Form.Item
          name="registrationClosesAt"
          label="报名截止"
          dependencies={['startsAt']}
          rules={[
            { required: true, message: '请选择报名截止时间' },
            ({ getFieldValue }) => ({
              validator(_, value: PickerDate) {
                const start = getFieldValue('startsAt') as PickerDate | undefined;
                return !value || !start || toBeijing(value) <= toBeijing(start)
                  ? Promise.resolve()
                  : Promise.reject(new Error('报名截止不能晚于开始时间'));
              }
            })
          ]}
        >
          <DatePicker
            classNames={{ popup: { root: 'activity-publisher-date-popup' } }}
            popupAlign={{
              offset: [0, 0],
              overflow: { adjustX: true, adjustY: true, shiftX: true, shiftY: true }
            }}
            showTime={{ format: 'HH:mm' }}
            format="YYYY-MM-DD HH:mm"
            placeholder="选择报名截止日期与时间"
          />
        </Form.Item>
      ) : (
        <Form.Item label={seriesMode ? '首期报名截止' : '报名截止'}>
          <Input autoComplete="off" readOnly value={cutoff} aria-label="自动计算的报名截止时间" />
        </Form.Item>
      )}
      {seriesMode ? (
        <>
          <Form.Item label="重复周期">
            <Select disabled value="WEEKLY" options={[{ value: 'WEEKLY', label: '每周' }]} />
          </Form.Item>
          <Form.Item
            name="weekdays"
            label="重复日期"
            rules={[{ required: true, type: 'array', min: 1, message: '请选择每周重复日期' }]}
          >
            <Checkbox.Group
              options={['周一', '周二', '周三', '周四', '周五', '周六', '周日'].map((label, index) => ({
                label,
                value: index + 1,
                disabled: index + 1 === automaticWeekday ? true : undefined
              }))}
              onChange={(selected) =>
                setManualWeekdays((current) =>
                  manualWeekdaysAfterSelection(selected as number[], current, automaticWeekday)
                )
              }
            />
          </Form.Item>
          <Form.Item name="seriesEndKind" label="结束方式">
            <Radio.Group
              options={[
                { value: 'COUNT', label: '总期数' },
                { value: 'DATE', label: '结束日期' }
              ]}
            />
          </Form.Item>
          {values?.seriesEndKind === 'DATE' ? (
            <Form.Item
              name="seriesEndDate"
              label="结束日期"
              rules={[{ required: true, message: '请选择结束日期' }]}
            >
              <DatePicker
                classNames={{ popup: { root: 'activity-publisher-date-popup' } }}
                popupAlign={{
                  offset: [0, 0],
                  overflow: { adjustX: true, adjustY: true, shiftX: true, shiftY: true }
                }}
                format="YYYY-MM-DD"
              />
            </Form.Item>
          ) : (
            <Form.Item
              name="periodCount"
              label="总期数"
              rules={[
                { required: true, message: '请填写总期数' },
                { type: 'integer', min: 2, max: 10, message: '总期数须为2至10期' }
              ]}
            >
              <InputNumber min={2} max={10} precision={0} suffix="期" />
            </Form.Item>
          )}
          <p className="activity-note">每个选定日期算一期，总计2至10期。</p>
          {periodError ? (
            <ErrorNotice message={periodError} />
          ) : periodPreview.length ? (
            <p className="activity-note">
              共{periodPreview.length}期 · 最后一期{' '}
              {beijingFull(periodPreview.at(-1)!.startsAt.toISOString())}
            </p>
          ) : null}
        </>
      ) : null}
    </section>
  );
}
