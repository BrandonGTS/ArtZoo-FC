'use client';

import { useUserRouter as useRouter } from '../user-operation-provider';
import Link from 'next/link';
import { Button, Form, Input, Select } from 'antd';
import {
  WISH_CATEGORIES,
  type WishDetail,
  type WishSummary,
  type WishWrite
} from '../../server/wishes/contract';
import { useAuthSession } from '../auth-session';
import { useFeedbackMessage } from '../use-feedback-message';
import { errorDetail } from '../account/api';
import { ActivityHeading } from '../activities/activity-ui';
import { WishCategoryTag, WishFactIcon, WishPaper, type WishCardData } from './wish-ui';
import '../activities/activity-publisher.css';
import './wish-publisher.css';
import { useWishCommand } from './use-wish-command';

interface Values {
  title: string;
  category: NonNullable<WishSummary['category']>;
  body: string;
  convenientTime: string;
}
export default function WishPublisher({
  initialWish,
  defaultValues
}: { initialWish?: WishDetail; defaultValues?: Partial<Values> } = {}) {
  const { session } = useAuthSession(),
    router = useRouter(),
    [form] = Form.useForm<Values>();
  const values = Form.useWatch([], { form, preserve: true }) as Partial<Values> | undefined;
  const command = useWishCommand(),
    { busy, uncertain } = command,
    { notify, contextHolder } = useFeedbackMessage();
  const initialCategory: Values['category'] | undefined = initialWish
    ? (initialWish.category ?? undefined)
    : 'OTHER';
  const initialValues = {
    title: initialWish?.title ?? defaultValues?.title ?? '',
    body: initialWish ? initialWish.body : (defaultValues?.body ?? ''),
    category: initialWish ? initialCategory : (defaultValues?.category ?? initialCategory),
    convenientTime: initialWish?.convenientTime ?? defaultValues?.convenientTime ?? ''
  };
  const preview: WishCardData = {
    id: 'preview',
    title: values?.title ?? initialValues.title,
    category: values?.category ?? initialValues.category ?? null,
    body: values?.body ?? initialValues.body,
    convenientTime: values?.convenientTime ?? initialValues.convenientTime,
    interestCount: 0,
    interested: false,
    isAuthor: false
  };
  async function submit(values?: Values) {
    try {
      const result = uncertain
        ? await command.retry<WishWrite>()
        : values
          ? await command.send<WishWrite>(
              initialWish ? '/api/wishes/' + initialWish.id + '/edit' : '/api/wishes',
              {
                title: values.title,
                category: values.category,
                body: values.body,
                convenientTime: values.convenientTime,
                ...(initialWish ? { expectedRevision: initialWish.revision } : {})
              }
            )
          : undefined;
      if (result) router.push('/wishes/' + result.wish.id);
    } catch (failure) {
      notify('error', errorDetail(failure).message);
    }
  }
  return (
    <main
      className="home-content wishes-content activity-publisher-content wish-publisher-content"
      id="main-content"
    >
      {contextHolder}
      <ActivityHeading title={initialWish ? '修改心愿' : '发布心愿'}>
        <Link className="activity-text-link" href="/wishes">
          返回心愿板
        </Link>
      </ActivityHeading>
      {(
        initialWish ? initialWish.author.id !== session?.user?.id : session?.user?.membership !== 'MEMBER'
      ) ? (
        <p>{initialWish ? '仅心愿作者可以修改。' : '仅正式成员可以发布心愿。'}</p>
      ) : (
        <Form
          autoComplete="off"
          form={form}
          layout="vertical"
          initialValues={initialValues}
          onFinish={submit}
          disabled={busy || uncertain}
          requiredMark={false}
          scrollToFirstError={{ focus: true }}
        >
          <div className="activity-detail-layout wish-publisher-layout">
            <WishPaper className="wish-publisher-fields">
              <section className="activity-form-section">
                <h2 className="activity-publisher-section-title">基本信息</h2>
                <Form.Item
                  name="title"
                  label="标题"
                  rules={[{ required: true, whitespace: true, message: '请填写标题' }, { max: 100 }]}
                >
                  <Input autoComplete="off" maxLength={100} />
                </Form.Item>
                <Form.Item
                  name="category"
                  label="心愿类型"
                  rules={[{ required: true, message: '请选择心愿类型' }]}
                >
                  <Select options={[...WISH_CATEGORIES]} placeholder="选择心愿类型" />
                </Form.Item>
                <Form.Item
                  name="body"
                  label="想玩的内容"
                  rules={[{ required: true, whitespace: true, message: '请填写想玩的内容' }, { max: 11001 }]}
                >
                  <Input.TextArea autoComplete="off" rows={4} maxLength={11001} />
                </Form.Item>
              </section>
              <section className="activity-form-section wish-publisher-time">
                <h2 className="activity-publisher-section-title">活动时间</h2>
                <Form.Item
                  name="convenientTime"
                  label="方便时间"
                  rules={[{ required: true, whitespace: true, message: '请填写方便时间' }, { max: 500 }]}
                >
                  <Input autoComplete="off" maxLength={500} />
                </Form.Item>
              </section>
            </WishPaper>
            <aside className="wish-publisher-aside">
              <WishPaper className="wish-card wish-preview-card wish-publisher-preview">
                <div className="wish-card-title">
                  <WishCategoryTag category={preview.category} />
                  <h3 title={preview.title}>{preview.title.trim() || '心愿标题'}</h3>
                </div>
                <div className="wish-card-fact">
                  <WishFactIcon kind="content" />
                  <div>
                    <span className="wish-card-fact-title">想玩的内容</span>
                    <p className="wish-card-excerpt">{preview.body.trim() || '想玩的内容'}</p>
                  </div>
                </div>
                <p className="wish-card-fact">
                  <WishFactIcon kind="interest" />
                  <span>0 人感兴趣</span>
                </p>
                <p className="wish-card-fact">
                  <WishFactIcon kind="time" />
                  <span className="wish-card-time">{preview.convenientTime.trim() || '方便时间'}</span>
                </p>
                <div className="activity-publisher-submit">
                  {uncertain ? <p role="status">暂未确认提交结果，请重试本次提交。</p> : null}
                  <Button
                    type="primary"
                    block
                    htmlType={uncertain ? 'button' : 'submit'}
                    disabled={busy}
                    loading={busy}
                    onClick={uncertain ? () => void submit() : undefined}
                  >
                    {uncertain
                      ? initialWish
                        ? '重试本次修改'
                        : '重试本次发布'
                      : initialWish
                        ? '保存修改'
                        : '发布心愿'}
                  </Button>
                </div>
              </WishPaper>
            </aside>
          </div>
        </Form>
      )}
    </main>
  );
}
