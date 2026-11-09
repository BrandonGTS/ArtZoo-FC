import { AccountError } from '@artzoo/domain';

export type ContactStatus = 'PENDING' | 'PROCESSED';
export interface ContactMessage {
  id: string;
  qq: string;
  message: string;
  status: ContactStatus;
  revision: number;
  createdAt: string;
  processedAt: string | null;
  processedBy: { id: string; displayName: string | null } | null;
}
export interface ContactList {
  items: ContactMessage[];
  page: number;
  pageSize: number;
  total: number;
}
export function invalid(message: string): never {
  throw new AccountError('VALIDATION_ERROR', message, 400);
}
export function fields(body: Record<string, unknown>, allowed: string[]) {
  if (Object.keys(body).some((key) => !allowed.includes(key))) invalid('提交字段无效');
}
export function contactInput(body: Record<string, unknown>) {
  fields(body, ['qq', 'message', 'submissionKey']);
  const qq = typeof body.qq === 'string' ? body.qq.trim() : '';
  const message = typeof body.message === 'string' ? body.message.trim() : '';
  if (!/^[1-9]\d{4,11}$/.test(qq)) invalid('QQ号码须为5至12位数字，且不能以0开头');
  if (!message || message.length > 500 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(message))
    invalid('请填写500字以内的纯文本留言');
  if (typeof body.submissionKey !== 'string' || !/^[-_a-zA-Z0-9]{16,128}$/.test(body.submissionKey))
    invalid('提交标识无效');
  return { qq, message, submissionKey: body.submissionKey };
}
export function processInput(id: string, body: Record<string, unknown>) {
  fields(body, ['expectedRevision']);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) invalid('留言标识无效');
  if (
    !Number.isSafeInteger(body.expectedRevision) ||
    Number(body.expectedRevision) < 0 ||
    Number(body.expectedRevision) >= 2147483647
  )
    invalid('版本无效');
  return Number(body.expectedRevision);
}
export function contactPage(url: URL): {
  status: ContactStatus;
  query: string;
  page: number;
  pageSize: number;
} {
  const positive = (name: string, fallback: number, max: number) => {
    const raw = url.searchParams.get(name);
    if (raw === null) return fallback;
    if (!/^[1-9]\d{0,6}$/.test(raw) || Number(raw) > max) invalid('分页参数无效');
    return Number(raw);
  };
  const status = url.searchParams.get('status') ?? 'PENDING';
  if (status !== 'PENDING' && status !== 'PROCESSED') invalid('留言状态无效');
  const query = (url.searchParams.get('query') ?? '').trim();
  if (query.length > 100) invalid('搜索内容过长');
  return { status, query, page: positive('page', 1, 1000000), pageSize: positive('pageSize', 12, 100) };
}
