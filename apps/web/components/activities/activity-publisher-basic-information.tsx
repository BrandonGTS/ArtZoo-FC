import { Alert, Form, Input, InputNumber, Radio, Select, type FormInstance } from 'antd';
import {
  ACTIVITY_LIMITS,
  DUTY_TYPES,
  PARTY_COMPOSITION_LABELS,
  dutyPresetSeats,
  type ActivityDetail,
  type ActivityCategory,
  type ActivityScene,
  type DutyCatalogList,
  type DutySeatTemplate,
  type DutyType,
  type PartyComposition
} from '@artzoo/domain';
import { categoryLabels } from './activity-ui';
import type { PublishForm } from './activity-publisher';

interface PublisherBasicInformationProps {
  initialActivity?: ActivityDetail;
  offline: boolean;
  category: ActivityCategory;
  catalogError: string | null;
  catalogPending: boolean;
  catalog: DutyCatalogList | null;
  busy: boolean;
  uncertain: boolean;
  canPublish: boolean | undefined;
  customDuty: boolean;
  values: Partial<PublishForm> | undefined;
  savedCatalogDuty: Pick<DutyCatalogList['items'][number], 'id' | 'type' | 'name' | 'enabled'> | null;
  form: FormInstance<PublishForm>;
  applyTemplate(template: readonly DutySeatTemplate[]): void;
  selectedDuty: { partyComposition: PartyComposition } | null | undefined;
  editableCapacity: boolean;
  changeScene(next: ActivityScene): void;
  changeCategory(next: ActivityCategory): void;
  resetDuty(nextType?: DutyType): void;
  resize(value: number | null): void;
}

export default function PublisherBasicInformation({
  initialActivity,
  offline,
  category,
  catalogError,
  catalogPending,
  catalog,
  busy,
  uncertain,
  canPublish,
  customDuty,
  values,
  savedCatalogDuty,
  form,
  applyTemplate,
  selectedDuty,
  editableCapacity,
  changeScene,
  changeCategory,
  resetDuty,
  resize
}: PublisherBasicInformationProps) {
  return (
    <section className="activity-form-section">
      <h2 className="activity-publisher-section-title">基本信息</h2>
      <Form.Item
        name="title"
        label="活动名称"
        rules={[
          { required: true, whitespace: true, message: '请填写活动名称' },
          { max: ACTIVITY_LIMITS.title, message: '活动名称最多100字' }
        ]}
      >
        <Input
          autoComplete="off"
          maxLength={ACTIVITY_LIMITS.title}
          className="activity-title-input"
          data-help-target="activity-publish-name"
        />
      </Form.Item>
      <div className="activity-form-columns" data-help-target="activity-publish-type">
        <Form.Item name="scene" label="活动类型" rules={[{ required: true, message: '请选择活动类型' }]}>
          <Select
            disabled={!!initialActivity}
            options={[
              { value: 'GAME', label: '游戏内活动' },
              { value: 'OFFLINE', label: '线下活动' }
            ]}
            onChange={changeScene}
          />
        </Form.Item>
        {!offline ? (
          <Form.Item name="mode" label="单次 / 长期" rules={[{ required: true, message: '请选择活动模式' }]}>
            <Select
              disabled={!!initialActivity}
              options={[
                { value: 'SINGLE', label: '单次' },
                { value: 'SERIES', label: '普通长期' }
              ]}
            />
          </Form.Item>
        ) : null}
      </div>
      <Form.Item
        name="category"
        label="游戏内容"
        hidden={offline}
        rules={offline ? [] : [{ required: true, message: '请选择游戏内容' }]}
      >
        <Select
          options={Object.entries(categoryLabels).map(([value, label]) => ({ value, label }))}
          onChange={changeCategory}
        />
      </Form.Item>
      {!offline && category === 'DUNGEON' ? (
        <>
          {catalogError ? <Alert type="error" title="副本目录暂时不可用" description={catalogError} /> : null}
          <div className="activity-form-columns" data-help-target="activity-publish-duty">
            <Form.Item
              name="dutyType"
              label="副本类型"
              rules={[{ required: true, message: '请选择副本类型' }]}
            >
              <Select
                placeholder="选择副本类型"
                loading={catalogPending}
                disabled={!catalog || busy || uncertain || !canPublish}
                options={DUTY_TYPES.map((type) => ({ ...type }))}
                onChange={resetDuty}
              />
            </Form.Item>
            {!offline && customDuty ? (
              <Form.Item
                name="customDutyName"
                label="自定义副本名称"
                rules={[
                  { required: true, whitespace: true, message: '请填写副本名称' },
                  { max: 100, message: '副本名称最多100字' }
                ]}
              >
                <Input autoComplete="off" maxLength={100} placeholder="填写其他副本名称" />
              </Form.Item>
            ) : (
              <Form.Item
                name="dutyId"
                label="具体副本"
                rules={[{ required: true, message: '请选择具体副本' }]}
              >
                <Select
                  key={values?.dutyType || 'unselected'}
                  placeholder={values?.dutyType ? '搜索并选择副本' : '先选择副本类型'}
                  showSearch={{ optionFilterProp: 'label' }}
                  disabled={!catalog || !values?.dutyType || busy || uncertain || !canPublish}
                  notFoundContent="没有符合条件的副本"
                  options={[
                    ...(catalog?.items || []),
                    ...(savedCatalogDuty &&
                    !catalog?.items.some((item) => item.enabled && item.id === savedCatalogDuty.id)
                      ? [savedCatalogDuty]
                      : [])
                  ]
                    .filter((item) => item.enabled && item.type === values?.dutyType)
                    .map((item) => ({ value: item.id, label: item.name }))}
                  onChange={(id: string) => {
                    const entry = catalog?.items.find(
                      (item) => item.enabled && item.id === id && item.type === form.getFieldValue('dutyType')
                    );
                    applyTemplate(entry?.defaultSeats || []);
                  }}
                />
              </Form.Item>
            )}
          </div>
        </>
      ) : null}
      <div className="activity-form-columns">
        {!offline && customDuty ? (
          <Form.Item
            name="partyComposition"
            label="队伍构成"
            rules={[{ required: true, message: '请选择人数预设' }]}
          >
            <Select
              options={Object.entries(PARTY_COMPOSITION_LABELS).map(([value, label]) => ({
                value,
                label
              }))}
              onChange={(composition: PartyComposition) =>
                applyTemplate(
                  composition === 'CUSTOM'
                    ? Array.from({ length: 4 }, () => ({
                        groupKey: null,
                        requirement: { kind: 'ANY' }
                      }))
                    : dutyPresetSeats(composition)
                )
              }
            />
          </Form.Item>
        ) : !offline && category === 'DUNGEON' ? (
          <Form.Item label="队伍构成">
            <Select
              aria-label="队伍构成"
              disabled
              value={selectedDuty?.partyComposition}
              placeholder="选择副本后自动确定"
              options={Object.entries(PARTY_COMPOSITION_LABELS)
                .filter(([value]) => value !== 'CUSTOM')
                .map(([value, label]) => ({ value, label }))}
            />
          </Form.Item>
        ) : null}
        {offline ? (
          <Form.Item
            name="capacityMode"
            label="报名人数"
            rules={[{ required: true, message: '请选择报名人数方式' }]}
          >
            <Radio.Group
              options={[
                { value: 'LIMITED', label: '设置上限' },
                { value: 'UNLIMITED', label: '不限人数' }
              ]}
            />
          </Form.Item>
        ) : null}
        <Form.Item
          name="capacity"
          hidden={!editableCapacity}
          label="活动人数"
          rules={
            !editableCapacity
              ? []
              : [
                  { required: true, message: '请选择副本或填写活动人数' },
                  {
                    type: 'integer',
                    min: 1,
                    max: ACTIVITY_LIMITS.seats,
                    message: '请填写1至200的整数'
                  }
                ]
          }
        >
          <InputNumber
            min={1}
            max={ACTIVITY_LIMITS.seats}
            precision={0}
            readOnly={!editableCapacity}
            controls={editableCapacity}
            onChange={resize}
            suffix="人"
          />
        </Form.Item>
      </div>
      {offline ? (
        <Form.Item
          name="location"
          label="活动地点"
          rules={[
            { required: true, whitespace: true, message: '请填写活动地点' },
            { max: 500, message: '活动地点内容过长' }
          ]}
        >
          <Input autoComplete="off" maxLength={500} />
        </Form.Item>
      ) : null}
    </section>
  );
}
