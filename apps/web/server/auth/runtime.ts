import { getDatabase } from '@artzoo/db';
import { AccountService } from './service';
import { mainlandChinaPhone } from './ports';
import { loadSmsSender } from './sms-config';
import { loadInvitationCipher } from './invitation-cipher';

// Normal application execution deliberately has no environment-variable mock bypass.
// Real SMS requires explicit, complete server configuration; loading does not send.
export function getAccountService(): AccountService {
  const sms = loadSmsSender(process.env);
  return new AccountService(getDatabase(), {
    phone: mainlandChinaPhone,
    sms,
    invitationCipher: loadInvitationCipher(process.env),
    environment: process.env.NODE_ENV,
    loginPhoneLimit: Number(process.env.AUTH_LOGIN_PHONE_LIMIT),
    loginSourceLimit: Number(process.env.AUTH_LOGIN_SOURCE_LIMIT),
    loginPhoneSourceLimit: Number(process.env.AUTH_LOGIN_PHONE_SOURCE_LIMIT),
    writeAccountLimit: Number(process.env.AUTH_WRITE_ACCOUNT_LIMIT),
    writeGlobalLimit: Number(process.env.AUTH_WRITE_GLOBAL_LIMIT),
    smsDailyLimit: Number(process.env.AUTH_SMS_DAILY_LIMIT),
    writeSourceLimit: Number(process.env.AUTH_WRITE_SOURCE_LIMIT)
  });
}
