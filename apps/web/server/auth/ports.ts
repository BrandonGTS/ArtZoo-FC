import { AccountError, type AuthConfig, type VerificationPurpose } from '@artzoo/domain';
export interface PhonePolicy {
  ready: boolean;
  defaultRegion: string | null;
  hint: string;
  normalize(input: string): string;
}
export interface SmsSender {
  mode: 'unconfigured' | 'mock' | 'aliyun';
  available: boolean;
  send(input: { phone: string; code: string; purpose: VerificationPurpose }): Promise<void>;
}
export const unconfirmedPhone: PhonePolicy = {
  ready: false,
  defaultRegion: null,
  hint: '手机号适用地区尚未确认，暂不可使用账号验证。',
  normalize() {
    throw new AccountError('PHONE_REGION_UNCONFIRMED', '手机号适用地区尚未确认', 503);
  }
};
export const mainlandChinaPhone: PhonePolicy = {
  ready: true,
  defaultRegion: 'CN',
  hint: '仅支持中国大陆手机号，可输入11位号码或带+86、0086前缀的号码。',
  normalize(input) {
    const compact = input.trim().replace(/[ -]/g, '');
    const national = compact.startsWith('+86')
      ? compact.slice(3)
      : compact.startsWith('0086')
        ? compact.slice(4)
        : compact;
    if (!/^1[3-9]\d{9}$/.test(national))
      throw new AccountError('VALIDATION_ERROR', '请输入有效的中国大陆手机号', 400, {
        phone: '请输入11位中国大陆手机号'
      });
    return `+86${national}`;
  }
};
export const unavailableSms: SmsSender = {
  mode: 'unconfigured',
  available: false,
  async send() {
    throw new AccountError('SMS_UNAVAILABLE', '短信服务尚未配置', 503);
  }
};
export function assertSmsEnvironment(sms: SmsSender, environment: string | undefined): void {
  if (sms.mode === 'mock' && (environment !== 'test' || process.env.NODE_ENV !== 'test'))
    throw new Error('Mock SMS is only permitted in tests');
}
export function authConfig(phone: PhonePolicy, sms: SmsSender): AuthConfig {
  return {
    password: { minLength: 8, maxLength: 30 },
    verification: { length: 6, expiresInSeconds: 300, resendAfterSeconds: 60 },
    sessionDays: 30,
    phone: { ready: phone.ready, defaultRegion: phone.defaultRegion, hint: phone.hint },
    sms: { mode: sms.mode, available: sms.available }
  };
}
