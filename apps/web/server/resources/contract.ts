import { AccountError, isMemberId } from '@artzoo/domain';
export interface ResourceCategory {
  id: string;
  name: string;
  revision: number;
}
export interface ResourceView {
  id: string;
  name: string;
  purpose: string;
  url: string;
  categoryId: string;
  revision: number;
  categoryName: string;
}
export function invalidResource(message: string): never {
  throw new AccountError('VALIDATION_ERROR', message, 400);
}
export function resourceId(value: unknown): string {
  if (typeof value !== 'string' || !isMemberId(value)) invalidResource('标识无效');
  return value.toLowerCase();
}
export function resourceText(value: unknown, max: number, label: string): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\u0000-\u001f\u007f]/.test(value))
    invalidResource(`${label}无效或过长`);
  return value.trim();
}
export function resourceUrl(value: unknown): string {
  const raw = resourceText(value, 2048, '链接');
  if (!/^https?:\/\//i.test(raw) || /[\s\\]/.test(raw)) invalidResource('请输入完整的 HTTP 或 HTTPS 链接');
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    invalidResource('链接格式无效');
  }
  if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password)
    invalidResource('链接格式无效');
  return url.href;
}
export function resourceRevision(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) invalidResource('版本无效');
  return value;
}
export function resourceFields(body: Record<string, unknown>, category = false) {
  const allowed = category ? ['name', 'revision'] : ['name', 'purpose', 'url', 'categoryId', 'revision'];
  if (Object.keys(body).some((k) => !allowed.includes(k))) invalidResource('请求字段无效');
  return category
    ? { name: resourceText(body.name, 40, '分类名称') }
    : {
        name: resourceText(body.name, 80, '名称'),
        purpose: resourceText(body.purpose, 200, '用途'),
        url: resourceUrl(body.url),
        categoryId: resourceId(body.categoryId)
      };
}
