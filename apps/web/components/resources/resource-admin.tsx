'use client';
import { AdminReturnLink } from '../admin-return-link';
import { useEffect, useRef, useState } from 'react';
import { Button, Empty, Form, Input, Select, Spin } from 'antd';
import type { ResourceCategory, ResourceView } from '../../server/resources/contract';
import { PageHeading } from '../home-content';
import { AccountTheme, ErrorNotice } from '../account/account-ui';
import { accountRequest, errorDetail } from '../account/api';
import { useFeedbackMessage } from '../use-feedback-message';
import { useAuthSession } from '../auth-session';
import { useResourceCatalog } from './use-resource-catalog';
import styles from '../invitation/admin.module.css';
import { CollectionSearch } from '../collection-controls';
import './resources.css';
type Values = { name: string; purpose: string; categoryId: string; url: string };
export default function ResourceAdmin() {
  const { session } = useAuthSession(),
    actor = session?.user;
  return actor && (actor.adminRole === 'ADMIN' || actor.adminRole === 'SUPER_ADMIN') ? (
    <OwnedResourceAdmin key={[actor.id, actor.membership, actor.adminRole].join(':')} />
  ) : null;
}
function OwnedResourceAdmin() {
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const [category, setCategory] = useState(''),
    [draftQuery, setDraftQuery] = useState(''),
    [query, setQuery] = useState(''),
    [revision, setRevision] = useState(0);
  const [selected, setSelected] = useState<ResourceView | null>(null),
    [categoryEdit, setCategoryEdit] = useState<ResourceCategory | null>(null),
    [categoryName, setCategoryName] = useState('');
  const [saving, setSaving] = useState<'resource' | 'category' | null>(null),
    busy = saving !== null,
    pending = useRef(false),
    [form] = Form.useForm<Values>(),
    { notify, contextHolder } = useFeedbackMessage();
  const catalog = useResourceCatalog(category, query, revision);
  function choose(row: ResourceView | null) {
    setSelected(row);
    form.resetFields();
    if (row) form.setFieldsValue(row);
  }
  async function save(values: Values) {
    if (!mounted.current || pending.current) return;
    pending.current = true;
    setSaving('resource');
    try {
      await accountRequest('/api/resources' + (selected ? '/' + selected.id : ''), {
        method: selected ? 'PATCH' : 'POST',
        body: {
          name: values.name,
          purpose: values.purpose,
          url: values.url,
          categoryId: values.categoryId,
          ...(selected ? { revision: selected.revision } : {})
        }
      });
      if (!mounted.current) return;
      notify('success', '资源已保存');
      choose(null);
      setRevision((r) => r + 1);
    } catch (e) {
      if (mounted.current) notify('error', errorDetail(e).message);
    } finally {
      pending.current = false;
      if (mounted.current) setSaving(null);
    }
  }
  async function saveCategory() {
    if (!mounted.current || pending.current) return;
    pending.current = true;
    setSaving('category');
    try {
      await accountRequest('/api/resources/categories' + (categoryEdit ? '/' + categoryEdit.id : ''), {
        method: categoryEdit ? 'PATCH' : 'POST',
        body: { name: categoryName, ...(categoryEdit ? { revision: categoryEdit.revision } : {}) }
      });
      if (!mounted.current) return;
      notify('success', '分类已保存');
      setCategoryEdit(null);
      setCategoryName('');
      setRevision((r) => r + 1);
    } catch (e) {
      if (mounted.current) notify('error', errorDetail(e).message);
    } finally {
      pending.current = false;
      if (mounted.current) setSaving(null);
    }
  }
  return (
    <AccountTheme>
      <main id="main-content" className={`${styles.main} resource-admin`}>
        {contextHolder}
        <div className={styles.heading}>
          <PageHeading level={1} decoration="burger">
            常用资源管理
          </PageHeading>
          <AdminReturnLink />
        </div>
        <div className="resource-admin-filters">
          <Select
            aria-label="分类筛选"
            value={category}
            onChange={setCategory}
            options={[
              { value: '', label: '全部分类' },
              ...(catalog?.categories ?? []).map((c) => ({ value: c.id, label: c.name }))
            ]}
          />
          <CollectionSearch
            searchLabel="搜索名称或用途"
            placeholder="搜索名称或用途"
            query={draftQuery}
            onQueryChange={setDraftQuery}
            onSearch={setQuery}
            onClear={() => {
              setDraftQuery('');
              setQuery('');
            }}
          />
        </div>
        {catalog?.error ? <ErrorNotice message={catalog.error} /> : null}
        <div className={styles.columns}>
          <section className={styles.panel} aria-label="资源列表">
            <div className="resource-panel-heading">
              <h2>资源列表</h2>
              <Button disabled={busy} onClick={() => choose(null)}>
                新增资源
              </Button>
            </div>
            {!catalog || catalog.loading ? (
              <Spin />
            ) : catalog.items.length ? (
              <div className="resource-admin-list">
                {catalog.items.map((row) => (
                  <Button
                    key={row.id}
                    type="text"
                    className="resource-select-row"
                    aria-pressed={row.id === selected?.id}
                    disabled={busy}
                    onClick={() => choose(row)}
                  >
                    <span>{row.name}</span>
                    <span>{row.purpose}</span>
                  </Button>
                ))}
              </div>
            ) : !catalog.error ? (
              <Empty description="暂无资源" image={Empty.PRESENTED_IMAGE_SIMPLE} />
            ) : null}
          </section>
          <section className={styles.panel}>
            <h2>{selected ? '编辑资源' : '新增资源'}</h2>
            <Form
              autoComplete="off"
              form={form}
              layout="vertical"
              disabled={busy}
              onFinish={(values) => {
                void save(values);
              }}
            >
              <Form.Item
                label="名称"
                name="name"
                rules={[
                  { required: true, whitespace: true, message: '请输入名称' },
                  { max: 80, message: '名称最多80字' }
                ]}
              >
                <Input autoComplete="off" maxLength={80} />
              </Form.Item>
              <Form.Item
                label="简短用途"
                name="purpose"
                rules={[
                  { required: true, whitespace: true, message: '请输入简短用途' },
                  { max: 200, message: '用途最多200字' }
                ]}
              >
                <Input.TextArea autoComplete="off" maxLength={200} autoSize={{ minRows: 2, maxRows: 4 }} />
              </Form.Item>
              <Form.Item label="分类" name="categoryId" rules={[{ required: true, message: '请选择分类' }]}>
                <Select options={catalog?.categories.map((c) => ({ value: c.id, label: c.name })) ?? []} />
              </Form.Item>
              <Form.Item
                label="链接"
                name="url"
                rules={[{ required: true, whitespace: true, message: '请输入链接' }]}
              >
                <Input autoComplete="off" maxLength={2048} />
              </Form.Item>
              <div className={styles.actions}>
                <Button onClick={() => choose(null)}>取消</Button>
                <Button type="primary" htmlType="submit" loading={saving === 'resource'}>
                  保存资源
                </Button>
              </div>
            </Form>
          </section>
        </div>
        <section className={styles.panel} aria-label="分类维护">
          <h2>分类维护</h2>
          <div className="resource-category-layout">
            <div className="resource-category-list">
              {catalog?.categories.map((c) => (
                <Button
                  key={c.id}
                  aria-pressed={c.id === categoryEdit?.id}
                  disabled={busy}
                  onClick={() => {
                    setCategoryEdit(c);
                    setCategoryName(c.name);
                  }}
                >
                  {c.name}
                </Button>
              ))}
              {catalog && !catalog.categories.length && !catalog.error ? (
                <Empty description="暂无分类" image={Empty.PRESENTED_IMAGE_SIMPLE} />
              ) : null}
            </div>
            <div className="resource-category-editor">
              <label htmlFor="resource-category-name">分类名称</label>
              <Input
                autoComplete="off"
                id="resource-category-name"
                maxLength={40}
                value={categoryName}
                disabled={busy}
                onChange={(e) => setCategoryName(e.target.value)}
              />
              <div className={styles.actions}>
                <Button
                  disabled={busy}
                  onClick={() => {
                    setCategoryEdit(null);
                    setCategoryName('');
                  }}
                >
                  新增分类
                </Button>
                <Button
                  type="primary"
                  loading={saving === 'category'}
                  disabled={busy || !categoryName.trim()}
                  onClick={() => {
                    void saveCategory();
                  }}
                >
                  保存分类
                </Button>
              </div>
            </div>
          </div>
        </section>
      </main>
    </AccountTheme>
  );
}
