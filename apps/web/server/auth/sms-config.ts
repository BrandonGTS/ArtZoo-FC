import { AccountError } from '@artzoo/domain';
import { createAliyunSms } from './aliyun-sms';
import { unavailableSms, type SmsSender } from './ports';

type SmsEnvironment = Readonly<Record<string, string | undefined>>;
const fields = [
  'ARTZOO_SMS_ACCESS_KEY_ID',
  'ARTZOO_SMS_ACCESS_KEY_SECRET',
  'ARTZOO_SMS_SIGN_NAME',
  'ARTZOO_SMS_REGISTER_TEMPLATE_CODE',
  'ARTZOO_SMS_RESET_TEMPLATE_CODE'
] as const;
function invalidConfiguration(): never {
  throw new AccountError('SMS_UNAVAILABLE', '短信配置不完整或无效，请由本机操作者检查配置', 503);
}

/** Server-only configuration. No dotenv discovery, logging, test mode or network request. */
export function loadSmsSender(environment: SmsEnvironment, transport: typeof fetch = fetch): SmsSender {
  // Presence, including an empty legacy field, is an explicit migration error.
  if (environment.ARTZOO_SMS_TEMPLATE_CODE !== undefined) invalidConfiguration();
  const mode = environment.ARTZOO_SMS_PROVIDER || 'unconfigured';
  const values = fields.map((field) => environment[field] ?? '');
  if (mode === 'unconfigured' && values.every((value) => value === '')) return unavailableSms;
  if (mode !== 'aliyun-pnvs') invalidConfiguration();
  const [accessKeyId, accessKeySecret, signName, registerTemplateCode, resetTemplateCode] = values;
  if (values.some((value) => !value || value !== value.trim() || /[\u0000-\u001f\u007f]/u.test(value)))
    invalidConfiguration();
  if (
    !/^[A-Za-z0-9]{1,256}$/.test(accessKeyId!) ||
    !/^[\x21-\x7e]{1,256}$/.test(accessKeySecret!) ||
    signName!.length > 128 ||
    registerTemplateCode !== '100001' ||
    resetTemplateCode !== '100003'
  )
    invalidConfiguration();
  return createAliyunSms(
    {
      accessKeyId: accessKeyId!,
      accessKeySecret: accessKeySecret!,
      signName: signName!,
      registerTemplateCode,
      resetTemplateCode
    },
    transport
  );
}
