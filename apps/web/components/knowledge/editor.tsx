'use client';
import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Button, Form, Input, Modal, Select } from 'antd';
import { PageHeading } from '../home-content';
import { accountRequest, errorDetail } from '../account/api';
import { useAuthSession } from '../auth-session';
import { useFeedbackMessage } from '../use-feedback-message';
import type { Article, Category } from '../../server/knowledge/contract';
import { publishCategoryOptions } from './category-options';
import dynamic from 'next/dynamic';
import { validateKnowledgeBody, type BodyFormat } from '../../content/knowledge-document';
import './knowledge.css';
import './rich-editor.css';
const KnowledgeRichEditor = dynamic(() => import('./rich-editor'), {
  ssr: false,
  loading: () => (
    <p className="knowledge-meta" role="status">
      正在打开编辑器…
    </p>
  )
});
type Draft = { title: string; body: string; bodyFormat: BodyFormat; categoryId?: string; savedAt: number };
export type KnowledgeEditorDemoValues = {
  title: string;
  body: string;
  bodyFormat: BodyFormat;
  categoryId: string;
};
export default function KnowledgeEditor({ id, demo }: { id?: string; demo?: KnowledgeEditorDemoValues }) {
  const { session } = useAuthSession(),
    actor = session?.user;
  return actor ? (
    <OwnedKnowledgeEditor
      key={[actor.id, actor.membership, actor.adminRole, id ?? 'new'].join(':')}
      actorId={actor.id}
      id={id}
      demo={demo}
    />
  ) : null;
}
function OwnedKnowledgeEditor({
  id,
  actorId,
  demo
}: {
  id?: string;
  actorId: string;
  demo?: KnowledgeEditorDemoValues;
}) {
  const router = useRouter(),
    lock = useRef(false),
    submission = useRef<string | null>(null),
    mounted = useRef(false),
    draft = useRef<Draft | null>(null),
    { notify, contextHolder } = useFeedbackMessage();
  const draftKey = 'artzoo:knowledge:draft:v1:' + actorId + ':' + (id ?? 'new');
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const [article, setArticle] = useState<Article | null>(null),
    [categories, setCategories] = useState<Category[]>([]),
    [loading, setLoading] = useState(true),
    [pending, setPending] = useState(false),
    [uploadBusy, setUploadBusy] = useState(false),
    [bodyFormat, setBodyFormat] = useState<BodyFormat>(demo?.bodyFormat ?? 'PLAIN'),
    [loadFailed, setLoadFailed] = useState(false);
  const [title, setTitle] = useState(demo?.title ?? ''),
    [body, setBody] = useState(demo?.body ?? ''),
    [categoryId, setCategoryId] = useState<string | undefined>(demo?.categoryId),
    [draftAvailable, setDraftAvailable] = useState(false),
    [draftTime, setDraftTime] = useState<number | null>(null),
    [draftOpen, setDraftOpen] = useState(false),
    [editorRevision, setEditorRevision] = useState(0),
    [draftNotice, setDraftNotice] = useState<string | null>(null);
  const dirty = useRef(false);
  useEffect(() => {
    if (demo) return;
    const timer = setTimeout(() => {
      try {
        const raw = sessionStorage.getItem(draftKey);
        if (raw) {
          const candidate = JSON.parse(raw);
          if (
            typeof candidate.title === 'string' &&
            typeof candidate.body === 'string' &&
            ['PLAIN', 'RICH_V1'].includes(candidate.bodyFormat) &&
            typeof candidate.savedAt === 'number' &&
            (candidate.categoryId === undefined || typeof candidate.categoryId === 'string')
          ) {
            draft.current = {
              title: candidate.title,
              body: candidate.body,
              bodyFormat: candidate.bodyFormat,
              categoryId: candidate.categoryId,
              savedAt: candidate.savedAt
            };
            setDraftAvailable(true);
            setDraftTime(candidate.savedAt);
          }
        }
      } catch {
        setDraftNotice('此浏览器无法读取草稿');
      }
    }, 0);
    return () => clearTimeout(timer);
  }, [draftKey, demo]);
  useEffect(() => {
    const abort = new AbortController();
    Promise.all([
      accountRequest<{ items: Category[] }>('/api/knowledge/categories', { signal: abort.signal }),
      id ? accountRequest<Article>('/api/knowledge/' + id, { signal: abort.signal }) : Promise.resolve(null)
    ])
      .then(([c, a]) => {
        if (abort.signal.aborted) return;
        setCategories(c.items);
        if (a) {
          setArticle(a);
          setTitle(a.title);
          setBody(a.body);
          setBodyFormat(a.bodyFormat);
          setCategoryId(a.category.id);
        }
      })
      .catch((e) => {
        if (!abort.signal.aborted) {
          setLoadFailed(true);
          notify('error', errorDetail(e).message);
        }
      })
      .finally(() => {
        if (!abort.signal.aborted) setLoading(false);
      });
    return () => abort.abort();
  }, [id, notify]);
  const canEdit = !id || !!article?.canEdit;
  useEffect(() => {
    if (demo || loading || !canEdit || !dirty.current || pending) return;
    const timer = setTimeout(() => {
      const value: Draft = { title, body, bodyFormat, categoryId, savedAt: Date.now() };
      try {
        sessionStorage.setItem(draftKey, JSON.stringify(value));
        if (!draft.current) {
          draft.current = value;
          setDraftAvailable(true);
          setDraftTime(value.savedAt);
        }
        setDraftNotice('草稿已保存在此浏览器标签页');
      } catch {
        setDraftNotice('草稿保存失败，请保留当前页面');
      }
    }, 800);
    return () => clearTimeout(timer);
  }, [title, body, bodyFormat, categoryId, loading, canEdit, draftKey, pending, demo]);
  function restoreDraft() {
    const selected = draft.current;
    if (!selected) return;
    try {
      if (selected.body.trim()) validateKnowledgeBody(selected.body, selected.bodyFormat);
      setTitle(selected.title);
      setBody(selected.body);
      setBodyFormat(selected.bodyFormat);
      setCategoryId(selected.categoryId);
      setEditorRevision((n) => n + 1);
      dirty.current = true;
      setDraftOpen(false);
      setDraftNotice('已恢复草稿，请检查后保存');
    } catch {
      setDraftOpen(false);
      notify('error', '草稿正文格式无效，当前输入已保留');
    }
  }
  async function save() {
    if (demo) return;
    if (lock.current || !canEdit || uploadBusy) return;
    if (!categoryId?.trim()) {
      notify('error', '请选择分区');
      return;
    }
    lock.current = true;
    setPending(true);
    submission.current ??= crypto.randomUUID();
    const data = {
      title,
      body,
      bodyFormat,
      categoryId,
      ...(!id ? { jobs: [], playstyles: [], gameVersions: [], editMode: 'AUTHOR' } : {})
    };
    try {
      const result = await accountRequest<{ id: string }>(id ? '/api/knowledge/' + id : '/api/knowledge', {
        method: id ? 'PATCH' : 'POST',
        body: {
          ...data,
          ...(id ? { expectedRevision: article!.revision } : { submissionKey: submission.current })
        }
      });
      if (mounted.current) {
        try {
          sessionStorage.removeItem(draftKey);
        } catch {}
        router.push('/knowledge/' + result.id + '?saved=1');
      }
    } catch (e) {
      if (mounted.current) {
        const message = errorDetail(e).message;
        notify('error', message);
      }
    } finally {
      lock.current = false;
      if (mounted.current) setPending(false);
    }
  }
  const categoryOptions = publishCategoryOptions(categories, article?.category);
  return (
    <main className="home-content knowledge-content" id="main-content">
      {contextHolder}
      <div className="knowledge-heading">
        <PageHeading level={1} decoration="burger">
          {id ? '编辑分享' : '发表分享'}
        </PageHeading>
        <Link className="knowledge-link" href={id ? '/knowledge/' + id : '/knowledge'}>
          {id ? '返回内容详情' : '返回内容分享'}
        </Link>
      </div>
      {loading ? (
        <p role="status">正在读取分享…</p>
      ) : !loadFailed && canEdit ? (
        <Form
          autoComplete="off"
          layout="vertical"
          onFinish={save}
          className="knowledge-editor knowledge-editor-form-v2"
        >
          <div className="knowledge-editor-fields">
            <Form.Item label="标题" required>
              <Input
                autoComplete="off"
                aria-label="标题"
                maxLength={200}
                value={title}
                disabled={pending}
                onChange={(e) => {
                  dirty.current = true;
                  setTitle(e.target.value);
                }}
              />
            </Form.Item>
            <Form.Item label="分区" required>
              <Select
                aria-label="分区"
                placeholder="请选择分区"
                value={categoryId}
                options={categoryOptions}
                disabled={pending}
                onChange={(value) => {
                  dirty.current = true;
                  setCategoryId(value);
                }}
              />
            </Form.Item>
          </div>
          <KnowledgeRichEditor
            key={editorRevision}
            body={body}
            bodyFormat={bodyFormat}
            disabled={pending}
            onError={(message) => notify('error', message)}
            onBusy={setUploadBusy}
            onChange={(value) => {
              dirty.current = true;
              setBody(value);
              setBodyFormat('RICH_V1');
            }}
            draftAvailable={draftAvailable}
            onRestoreDraft={() => setDraftOpen(true)}
          />
          {draftNotice ? (
            <p className="knowledge-draft-status" role="status">
              {draftNotice}
            </p>
          ) : null}
          <div className="knowledge-editor-submit">
            <Button type="primary" htmlType="submit" disabled={uploadBusy || pending}>
              {pending ? '正在保存…' : id ? '保存修改' : '发表'}
            </Button>
          </div>
        </Form>
      ) : !loadFailed ? (
        <p role="alert">只有作者可以编辑此分享</p>
      ) : null}
      <Modal
        title="恢复草稿"
        open={draftOpen}
        onCancel={() => setDraftOpen(false)}
        onOk={restoreDraft}
        okText="确认恢复"
        cancelText="保留当前输入"
      >
        <p>恢复将覆盖当前标题、分区和正文。请先确认当前输入已妥善保留。</p>
        {draftTime ? <p>草稿保存于 {new Date(draftTime).toLocaleString('zh-CN')}</p> : null}
      </Modal>
    </main>
  );
}
