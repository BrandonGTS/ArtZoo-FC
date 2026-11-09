import { resolveRequestSource } from '../auth/request-source';
import { BotGroupService } from '../bot-management/groups';
import { BotManagementBridge } from '../bot-management/service';
import { AccountError } from '@artzoo/domain';
import { resolveQqGroup, loadQqOfficialConfig } from '@artzoo/db';
import { failure, readBody, sessionToken, success, validateOrigin } from '../auth/http';
import { getAccountService } from '../auth/runtime';
import { QqBindingService } from './binding';
import { QqBridgeService } from './bridge';
import { verifyQqSignature } from './signature';

export async function handleQqBinding(
  request: Request,
  action: 'status' | 'initiate' | 'select' | 'progress' | 'confirm' | 'unlink' | 'cancel'
) {
  try {
    if (action === 'status' || action === 'progress' ? request.method !== 'GET' : request.method !== 'POST')
      throw new AccountError('VALIDATION_ERROR', '请刷新后使用新版绑定流程', 400);
    const write = request.method !== 'GET';
    let body: Record<string, unknown> = {};
    if (write) {
      validateOrigin(request);
      body = await readBody(request);
    }
    if (action === 'progress') body.requestId = new URL(request.url).searchParams.get('requestId');
    const auth = getAccountService(),
      token = await sessionToken();
    let config = loadQqOfficialConfig();
    const selected = body.groupOpenId ?? new URL(request.url).searchParams.get('group');
    if (
      config.managedGroups &&
      selected !== null &&
      selected !== undefined &&
      action !== 'status' &&
      action !== 'unlink' &&
      action !== 'progress' &&
      action !== 'cancel'
    ) {
      if (typeof selected !== 'string') throw new AccountError('VALIDATION_ERROR', '请选择群', 400);
      const target = await auth.db.$transaction((tx) => resolveQqGroup(tx, config, selected));
      if (!target) throw new AccountError('FORBIDDEN', '群未启用', 403);
      config = { ...config, target };
    }
    const service = new QqBindingService(auth, config);
    if (write) await auth.limitWriteSource(resolveRequestSource(request), token);
    if (action === 'status') return success(await service.status(token));
    if (action === 'initiate') return success(await service.initiate(token), 201);
    return success(await service[action](body, token));
  } catch (error) {
    return failure(error, 'qq-official/http');
  }
}
export async function handleQqBridge(
  request: Request,
  action:
    | 'commands'
    | 'claim'
    | 'begin'
    | 'ack'
    | 'management-sync'
    | 'test-claim'
    | 'test-begin'
    | 'test-ack'
    | 'group-proof'
) {
  let groupLengths: Record<string, number | null> | null = null;
  try {
    let config = loadQqOfficialConfig();
    if (!config.target?.enabled || !config.bridgeSecret)
      throw new AccountError('FORBIDDEN', 'QQ集成未启用', 403);
    if (
      request.method !== 'POST' ||
      new URL(request.url).search ||
      request.headers.get('content-type')?.split(';')[0]?.trim() !== 'application/json'
    )
      throw new AccountError('FORBIDDEN', 'Bridge请求格式无效', 403);
    if (Number(request.headers.get('content-length')) > 8192)
      throw new AccountError('VALIDATION_ERROR', '请求内容过大', 400);
    const reader = request.body?.getReader();
    if (!reader) throw new AccountError('VALIDATION_ERROR', '请求内容不能为空', 400);
    const chunks: Uint8Array[] = [];
    let size = 0;
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > 8192) {
        await reader.cancel();
        throw new AccountError('VALIDATION_ERROR', '请求内容过大', 400);
      }
      chunks.push(chunk.value);
    }
    const raw = Buffer.concat(chunks).toString('utf8'),
      path = new URL(request.url).pathname;
    const proof = verifyQqSignature(request.headers, path, raw, config.bridgeSecret, new Date());
    let value: unknown;
    try {
      value = JSON.parse(raw);
    } catch {
      throw new AccountError('VALIDATION_ERROR', 'JSON无效', 400);
    }
    if (!value || typeof value !== 'object' || Array.isArray(value))
      throw new AccountError('VALIDATION_ERROR', '请求无效', 400);
    const body = value as Record<string, unknown>,
      auth = getAccountService();
    if (action === 'group-proof')
      groupLengths = Object.fromEntries(
        ['event_id', 'message_idx'].map((k) => [
          k,
          typeof body[k] === 'string' ? (body[k] as string).length : null
        ])
      );
    if (action === 'group-proof') {
      const service = new QqBridgeService(auth, config);
      await service.consumeNonce(proof.nonce, proof.expiresAt);
      return success(await new BotGroupService(auth, config).proof(body));
    }
    if (config.managedGroups && action !== 'management-sync') {
      if (
        body.app_id !== config.target!.appId ||
        body.bot_id !== config.target!.botId ||
        typeof body.group_openid !== 'string'
      )
        throw new AccountError('FORBIDDEN', '机器人身份不匹配', 403);
      const target = await auth.db.$transaction((tx) =>
        resolveQqGroup(tx, config, body.group_openid as string, action === 'ack' || action === 'test-ack')
      );
      if (!target) throw new AccountError('FORBIDDEN', '群未绑定或已停用', 403);
      config = { ...config, target };
    }
    const service = new QqBridgeService(auth, config);
    service.scope(
      body,
      action === 'commands' || action === 'claim' || action === 'management-sync' || action === 'test-claim',
      action === 'ack' || action === 'test-ack'
    );
    await service.consumeNonce(proof.nonce, proof.expiresAt);
    if (action === 'management-sync') return success(await new BotManagementBridge(auth, config).sync(body));
    if (action === 'test-claim' || action === 'test-begin' || action === 'test-ack')
      return success(await new BotManagementBridge(auth, config).test(action, body));
    return success(await (action === 'commands' ? service.command(body) : service[action](body)));
  } catch (error) {
    if (action === 'group-proof' && groupLengths) {
      const known = error instanceof AccountError;
      const fields = known
        ? Object.keys(error.fieldErrors ?? {}).filter((k) =>
            [
              'event_id',
              'message_idx',
              'event_timestamp',
              'app_id',
              'bot_id',
              'group_openid',
              'sender_openid',
              'content'
            ].includes(k)
          )
        : [];
      console.warn(
        '[ArtZoo group-proof]',
        JSON.stringify({
          category: known ? error.code : 'INTERNAL',
          invalidFields: fields,
          lengths: groupLengths
        })
      );
    }
    return failure(error, 'qq-official/http');
  }
}
