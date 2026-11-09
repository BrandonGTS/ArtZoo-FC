import { AccountError } from '@artzoo/domain';
import { resourceId, resourceText, resourceUrl, resourceRevision } from '../resources/contract';

export interface QuickLinkView {
  id: string;
  name: string;
  url: string;
  revision: number;
  icon: string | null;
  ordinal: number;
}
export interface QuickLinkList {
  items: QuickLinkView[];
  revision: number;
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
}
export interface QuickLinkResult {
  id: string;
  revision: number;
  replayed: boolean;
  name?: string;
}
export type QuickLinkAction = 'create' | 'update' | 'remove' | 'move';
export function quickInvalid(message: string): never {
  throw new AccountError('VALIDATION_ERROR', message, 400);
}
export function quickPage(url: URL) {
  const number = (key: string, fallback: number, max: number) => {
    const raw = url.searchParams.get(key);
    if (raw === null) return fallback;
    if (!/^[1-9]\d{0,6}$/.test(raw) || Number(raw) > max) quickInvalid('分页参数无效');
    return Number(raw);
  };
  const query = (url.searchParams.get('query') ?? '').trim();
  if (query.length > 100) quickInvalid('搜索内容过长');
  return { page: number('page', 1, 1000000), pageSize: number('pageSize', 6, 50), query };
}
export function quickCommand(body: Record<string, unknown>) {
  const action = body.action as QuickLinkAction;
  if (!['create', 'update', 'remove', 'move'].includes(action)) quickInvalid('操作无效');
  const allowed = [
    'action',
    'expectedRevision',
    'idempotencyKey',
    ...(action === 'create' ? ['name', 'url'] : ['id', 'revision']),
    ...(action === 'update' ? ['name', 'url'] : []),
    ...(action === 'move' ? ['direction', 'targetId'] : [])
  ];
  if (Object.keys(body).some((key) => !allowed.includes(key))) quickInvalid('提交字段无效');
  const expectedRevision = resourceRevision(body.expectedRevision);
  if (expectedRevision >= 2147483646) quickInvalid('版本无效');
  if (typeof body.idempotencyKey !== 'string' || !/^[-_a-zA-Z0-9]{16,128}$/.test(body.idempotencyKey))
    quickInvalid('提交标识无效');
  const id = action === 'create' ? null : resourceId(body.id);
  const revision = action === 'create' ? null : resourceRevision(body.revision);
  const name =
    action === 'create' && body.name === undefined
      ? null
      : action === 'create' || action === 'update'
        ? resourceText(body.name, 80, '名称')
        : null;
  const url = action === 'create' || action === 'update' ? resourceUrl(body.url) : null;
  if (action === 'move' && body.targetId !== undefined) {
    if (body.direction !== undefined) quickInvalid('排序目标无效');
    const targetId = resourceId(body.targetId);
    if (targetId === id) quickInvalid('排序目标无效');
    return {
      action,
      expectedRevision,
      idempotencyKey: body.idempotencyKey,
      id,
      revision,
      name,
      url,
      direction: null,
      targetId
    };
  }
  if (action === 'move' && body.direction !== 'up' && body.direction !== 'down') quickInvalid('排序方向无效');
  return {
    action,
    expectedRevision,
    idempotencyKey: body.idempotencyKey,
    id,
    revision,
    name,
    url,
    direction: action === 'move' ? (body.direction as 'up' | 'down') : null
  };
}
