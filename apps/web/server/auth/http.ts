import { resolveRequestSource } from './request-source';
import { logUnexpectedHttpError } from '../http-error-log';
import { AccountError, anonymousSession } from '@artzoo/domain';
import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';
import { authConfig, mainlandChinaPhone } from './ports';
import { loadSmsSender } from './sms-config';
import { getAccountService } from './runtime';
import { securityPolicy } from './security';

export const responseHeaders = {
  'Cache-Control': 'no-store',
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff'
};
export function success(data: unknown, status = 200) {
  return NextResponse.json({ ok: true, data }, { status, headers: responseHeaders });
}
export function failure(error: unknown, route = 'auth/http') {
  if (
    !(error instanceof AccountError) &&
    !(typeof error === 'object' && error !== null && 'code' in error && error.code === 'P2002')
  ) {
    logUnexpectedHttpError(error, route);
  }
  let known =
    error instanceof AccountError
      ? error
      : new AccountError('SERVICE_UNAVAILABLE', '服务暂时不可用，请稍后再试', 503);
  // Never serialize Prisma details, raw request inputs or provider errors.
  if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'P2002')
    known = new AccountError('CONFLICT', '此操作与已有数据冲突，请确认后再试', 409);
  return NextResponse.json(
    {
      ok: false,
      error: {
        code: known.code,
        message: known.message,
        ...(known.fieldErrors ? { fieldErrors: known.fieldErrors } : {}),
        ...(known.retryAfterSeconds ? { retryAfterSeconds: known.retryAfterSeconds } : {})
      }
    },
    {
      status: known.status,
      headers: {
        ...responseHeaders,
        ...(known.retryAfterSeconds ? { 'Retry-After': String(known.retryAfterSeconds) } : {})
      }
    }
  );
}
export function validateOrigin(request: Request): void {
  const allowed = securityPolicy(request.url).origin;
  if (
    request.headers.get('origin') !== allowed ||
    request.headers.get('x-artzoo-request') !== '1' ||
    request.headers.get('sec-fetch-site') === 'cross-site' ||
    request.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() !== 'application/json'
  ) {
    throw new AccountError('FORBIDDEN', '请求来源或格式无效', 403);
  }
}
export async function readBody(request: Request): Promise<Record<string, unknown>> {
  if (Number(request.headers.get('content-length')) > 8192)
    throw new AccountError('VALIDATION_ERROR', '请求内容过大', 400);
  const reader = request.body?.getReader();
  if (!reader) throw new AccountError('VALIDATION_ERROR', '请求内容不能为空', 400);
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  for (;;) {
    const chunk = await reader.read();
    if (chunk.done) break;
    bytes += chunk.value.byteLength;
    if (bytes > 8192) {
      await reader.cancel();
      throw new AccountError('VALIDATION_ERROR', '请求内容过大', 400);
    }
    chunks.push(chunk.value);
  }
  let value: unknown;
  try {
    value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new AccountError('VALIDATION_ERROR', '请求JSON格式无效', 400);
  }
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new AccountError('VALIDATION_ERROR', '请求格式无效', 400);
  return value as Record<string, unknown>;
}
export async function sessionToken() {
  return (await cookies()).get(securityPolicy().cookieName)?.value;
}
function setSession(response: NextResponse, token: string, expiresAt: Date, request: Request) {
  const policy = securityPolicy(request.url);
  response.cookies.set(policy.cookieName, token, {
    httpOnly: true,
    sameSite: 'lax',
    path: '/',
    secure: policy.secure,
    expires: expiresAt
  });
}
function clearSession(response: NextResponse, request: Request) {
  setSession(response, '', new Date(0), request);
}
export async function handle(request: Request, action: string, parameter?: string): Promise<NextResponse> {
  try {
    if (action === 'config') return success(authConfig(mainlandChinaPhone, loadSmsSender(process.env)));
    const write = request.method !== 'GET';
    let body: Record<string, unknown> = {};
    // Reject invalid traffic before acquiring a database service or consuming legitimate quota.
    if (write) {
      validateOrigin(request);
      body = await readBody(request);
    }
    const token = await sessionToken();
    // A genuine missing cookie needs no DB connection. DB failures with a cookie are not anonymous success.
    if (action === 'session' && !token) return success(anonymousSession());
    if (action === 'logout' && !token) {
      const response = success({ loggedOut: true });
      clearSession(response, request);
      return response;
    }
    const service = getAccountService();
    if (write) {
      await service.limitWriteSource(resolveRequestSource(request), token);
    }
    if (action === 'session') return success(await service.session(token));
    if (action === 'login') {
      const login = await service.login(body, resolveRequestSource(request));
      const response = success(login.snapshot);
      setSession(response, login.token, login.expiresAt, request);
      return response;
    }
    if (action === 'logout') {
      const response = success(await service.logout(token));
      clearSession(response, request);
      return response;
    }
    if (action === 'verification-codes') return success(await service.sendCode(body));
    if (action === 'register') return success(await service.register(body), 201);
    if (action === 'reset-password' || action === 'change-password') {
      const data =
        action === 'reset-password'
          ? await service.resetPassword(body)
          : await service.changePassword(body, token);
      const response = success(data);
      clearSession(response, request);
      return response;
    }
    if (action === 'invitation') return success(await service.invitation(parameter));
    if (action === 'invitations' && write) return success(await service.createInvitation(body, token), 201);
    if (action === 'invitation-link') return success(await service.invitationLink(parameter!, token));
    if (action === 'remove-invitation')
      return success(await service.removeInvitation(parameter!, body, token));
    if (action === 'revoke') return success(await service.revokeInvitation(parameter!, body, token));
    if (action === 'membership') return success(await service.changeMembership(parameter!, body, token));
    if (action === 'invitations' || action === 'accounts' || action === 'audit')
      return success(await service.list(action, new URL(request.url), token));
    throw new AccountError('NOT_FOUND', '接口不存在', 404);
  } catch (error) {
    return failure(error);
  }
}
