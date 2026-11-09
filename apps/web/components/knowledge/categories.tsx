'use client';
import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { Button, Input, Radio } from 'antd';
import { PageHeading } from '../home-content';
import { accountRequest, errorDetail } from '../account/api';
import { useAuthSession } from '../auth-session';
import type { Category } from '../../server/knowledge/contract';
import { Failure } from './shared';
import { useFeedbackMessage } from '../use-feedback-message';
import './knowledge.css';
export default function KnowledgeCategories() {
  const { session } = useAuthSession(),
    actor = session?.user;
  return actor ? (
    <OwnedKnowledgeCategories key={[actor.id, actor.membership, actor.adminRole].join(':')} />
  ) : null;
}
function OwnedKnowledgeCategories() {
  const { notify, contextHolder } = useFeedbackMessage();
  const [items, setItems] = useState<Category[]>([]),
    [selected, setSelected] = useState<Category | null>(null),
    [label, setLabel] = useState(''),
    [active, setActive] = useState(true),
    [error, setError] = useState<string | null>(null),
    [pending, setPending] = useState(false),
    lock = useRef(false);
  useEffect(() => {
    const abort = new AbortController();
    accountRequest<{ items: Category[] }>('/api/knowledge/categories?all=1', { signal: abort.signal })
      .then((r) => setItems(r.items))
      .catch((e) => {
        if (!abort.signal.aborted) setError(errorDetail(e).message);
      });
    return () => abort.abort();
  }, []);
  async function save() {
    if (lock.current) return;
    lock.current = true;
    setPending(true);
    setError(null);
    try {
      const result = await accountRequest<Category>('/api/knowledge/categories', {
        method: 'POST',
        body: { label, active, ...(selected ? { id: selected.id, expectedRevision: selected.revision } : {}) }
      });
      setItems((old) => [...old.filter((c) => c.id !== result.id), result]);
      setSelected(result);
      notify('success', '分类已保存');
    } catch (e) {
      notify('error', errorDetail(e).message);
    } finally {
      lock.current = false;
      setPending(false);
    }
  }
  return (
    <main className="home-content knowledge-content" id="main-content">
      {contextHolder}
      <div className="knowledge-heading">
        <PageHeading level={1} decoration="burger">
          知识分类
        </PageHeading>
        <Link className="knowledge-link" href="/admin">
          返回管理
        </Link>
      </div>
      <Failure message={error} />
      <div className="knowledge-category-layout">
        <div className="knowledge-category-list">
          <Button
            disabled={pending}
            onClick={() => {
              setSelected(null);
              setLabel('');
              setActive(true);
            }}
          >
            新增分类
          </Button>
          {items.map((c) => (
            <Button
              type="text"
              disabled={pending}
              key={c.id}
              aria-pressed={selected?.id === c.id}
              onClick={() => {
                setSelected(c);
                setLabel(c.label);
                setActive(c.active);
              }}
            >
              {c.label}
              {!c.active ? '（已停用）' : ''}
            </Button>
          ))}
        </div>
        <form
          autoComplete="off"
          className="knowledge-category-form"
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
        >
          <label htmlFor="category-label">分类名称</label>
          <Input
            autoComplete="off"
            id="category-label"
            value={label}
            disabled={pending}
            onChange={(e) => setLabel(e.target.value)}
          />
          <Radio.Group
            aria-label="分类状态"
            value={active}
            disabled={pending}
            onChange={(e) => setActive(e.target.value)}
            options={[
              { label: '启用', value: true },
              { label: '停用', value: false }
            ]}
          />
          <Button type="primary" htmlType="submit" loading={pending}>
            保存分类
          </Button>
        </form>
      </div>
    </main>
  );
}
