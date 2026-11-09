import { createHash, createHmac, randomUUID } from 'node:crypto';
import { AccountError } from '@artzoo/domain';
import { mainlandChinaPhone, type SmsSender } from './ports';

export interface AliyunSmsOptions {
  // Server-only configuration, never supplied by an HTTP request.
  accessKeyId: string;
  accessKeySecret: string;
  signName: string;
  registerTemplateCode: string;
  resetTemplateCode: string;
}
const encode = (value: string) =>
  encodeURIComponent(value).replace(
    /[!'()*]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`
  );
const sha256 = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex');

/**
 * Narrow ACS3 signer: POST, RPC path "/", query parameters, empty body.
 * Official algorithm and fixed vector:
 * https://help.aliyun.com/zh/sdk/product-overview/v3-request-structure-and-signature
 * Pure helper for offline verification; do not log its inputs or outputs.
 */
export function signAliyunRpcRequest(input: {
  accessKeyId: string;
  accessKeySecret: string;
  host: string;
  action: string;
  version: string;
  date: string;
  nonce: string;
  parameters: Readonly<Record<string, string>>;
}): { query: string; headers: Record<string, string> } {
  const query = Object.keys(input.parameters)
    .sort()
    .map((key) => `${encode(key)}=${encode(input.parameters[key]!)}`)
    .join('&');
  const payloadHash = sha256('');
  const headers: Record<string, string> = {
    host: input.host,
    'x-acs-action': input.action,
    'x-acs-version': input.version,
    'x-acs-date': input.date,
    'x-acs-signature-nonce': input.nonce,
    'x-acs-content-sha256': payloadHash
  };
  const names = Object.keys(headers).sort();
  const signedHeaders = names.join(';');
  const canonicalHeaders = names.map((name) => `${name}:${headers[name]!.trim()}\n`).join('');
  const canonicalRequest = ['POST', '/', query, canonicalHeaders, signedHeaders, payloadHash].join('\n');
  const signature = createHmac('sha256', input.accessKeySecret)
    .update(`ACS3-HMAC-SHA256\n${sha256(canonicalRequest)}`, 'utf8')
    .digest('hex');
  headers.Authorization = `ACS3-HMAC-SHA256 Credential=${input.accessKeyId},SignedHeaders=${signedHeaders},Signature=${signature}`;
  return { query, headers };
}

/** PNVS SendSmsVerifyCode. Creating the adapter never sends anything. */
export function createAliyunSms(options: AliyunSmsOptions, transport: typeof fetch = fetch): SmsSender {
  const { accessKeyId, accessKeySecret, signName, registerTemplateCode, resetTemplateCode } = options;
  if (
    ![accessKeyId, accessKeySecret, signName].every(
      (value) =>
        typeof value === 'string' &&
        value.length > 0 &&
        value === value.trim() &&
        !/[\u0000-\u001f\u007f]/u.test(value)
    ) ||
    registerTemplateCode !== '100001' ||
    resetTemplateCode !== '100003'
  ) {
    throw new AccountError('SMS_UNAVAILABLE', '短信配置不完整或无效，请由本机操作者检查配置', 503);
  }
  return {
    // Public contract reports vendor; configuration explicitly selects the PNVS product.
    mode: 'aliyun',
    available: true,
    async send({ phone, code, purpose }) {
      if (
        (purpose !== 'REGISTER' && purpose !== 'RESET_PASSWORD') ||
        typeof code !== 'string' ||
        !/^\d{6}$/.test(code)
      ) {
        throw new AccountError('SMS_UNAVAILABLE', '短信参数无效', 503);
      }
      try {
        const destination = mainlandChinaPhone.normalize(phone).slice(3);
        const parameters = {
          CountryCode: '86',
          PhoneNumber: destination,
          SignName: signName,
          TemplateCode: purpose === 'REGISTER' ? registerTemplateCode : resetTemplateCode,
          TemplateParam: JSON.stringify({ code, min: '5' }),
          ValidTime: '300',
          Interval: '60',
          CodeLength: '6',
          CodeType: '1',
          DuplicatePolicy: '1',
          ReturnVerifyCode: 'false',
          AutoRetry: '0'
        };
        // Official dypnsapi-20170525 SDK puts these fields in query, not JSON/form body.
        const { query, headers } = signAliyunRpcRequest({
          accessKeyId,
          accessKeySecret,
          host: 'dypnsapi.aliyuncs.com',
          action: 'SendSmsVerifyCode',
          version: '2017-05-25',
          date: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
          nonce: randomUUID(),
          parameters
        });
        const response = await transport(`https://dypnsapi.aliyuncs.com/?${query}`, {
          method: 'POST',
          headers,
          signal: AbortSignal.timeout(10_000),
          redirect: 'error'
        });
        const result: unknown = await response.json();
        if (
          !response.ok ||
          !result ||
          typeof result !== 'object' ||
          !('Code' in result) ||
          result.Code !== 'OK' ||
          !('Success' in result) ||
          result.Success !== true
        )
          throw new Error('SMS delivery rejected');
        // Never expose Model.VerifyCode, raw Message, authorization or request URL.
      } catch {
        throw new AccountError('SMS_UNAVAILABLE', '短信发送失败，请稍后再试', 503);
      }
    }
  };
}
