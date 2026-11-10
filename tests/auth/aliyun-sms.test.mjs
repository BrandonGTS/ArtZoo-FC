import test from 'node:test';
import assert from 'node:assert/strict';
import { createAliyunSms, signAliyunRpcRequest } from '../../apps/web/server/auth/aliyun-sms.ts';
// Synthetic values only. Every send uses injected transport; never read environment credentials.
const options = {
  accessKeyId: 'syntheticId',
  accessKeySecret: 'syntheticSecret!$#',
  signName: "测试 !'()*~ 签名",
  registerTemplateCode: '100001',
  resetTemplateCode: '100003'
};
const input = { phone: '+8613800000001', code: '123456', purpose: 'REGISTER' };
const accepted = () => Response.json({ Code: 'OK', Success: true });
const signedNames = 'host;x-acs-action;x-acs-content-sha256;x-acs-date;x-acs-signature-nonce;x-acs-version';

test('ACS3 matches official fixed vector byte-for-byte (offline, no transport)', () => {
  // Published values from the official V3 "固定参数示例", steps 1–3.
  // https://help.aliyun.com/zh/sdk/product-overview/v3-request-structure-and-signature
  const signed = signAliyunRpcRequest({
    accessKeyId: 'YourAccessKeyId',
    accessKeySecret: 'YourAccessKeySecret',
    host: 'ecs.cn-shanghai.aliyuncs.com',
    action: 'RunInstances',
    version: '2014-05-26',
    date: '2023-10-26T10:22:32Z',
    nonce: '3156853299f313e23d1673dc12e1703d',
    parameters: { RegionId: 'cn-shanghai', ImageId: 'win2019_1809_x64_dtc_zh-cn_40G_alibase_20230811.vhd' }
  });
  assert.equal(
    signed.query,
    'ImageId=win2019_1809_x64_dtc_zh-cn_40G_alibase_20230811.vhd&RegionId=cn-shanghai'
  );
  assert.equal(
    signed.headers['x-acs-content-sha256'],
    'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'
  );
  assert.equal(
    signed.headers.Authorization,
    'ACS3-HMAC-SHA256 Credential=YourAccessKeyId,SignedHeaders=' +
      signedNames +
      ',Signature=06563a9e1b43f5dfe96b81484da74bceab24a1d853912eee15083a6f0f3283c0'
  );
});

test('ACS3 RFC3986 encodes Unicode, JSON, spaces and reserved characters without plus encoding', () => {
  const signed = signAliyunRpcRequest({
    accessKeyId: 'fake',
    accessKeySecret: 'fake',
    host: 'dypnsapi.aliyuncs.com',
    action: 'SendSmsVerifyCode',
    version: '2017-05-25',
    date: '2026-10-13T00:00:00Z',
    nonce: 'fixed-test-nonce',
    parameters: { z: '', b: '{"code":"001234","min":"5"}', a: "中 !'()*~+" }
  });
  assert.equal(
    signed.query,
    'a=%E4%B8%AD%20%21%27%28%29%2A~%2B&b=%7B%22code%22%3A%22001234%22%2C%22min%22%3A%225%22%7D&z='
  );
});

for (const [purpose, template] of [
  ['REGISTER', '100001'],
  ['RESET_PASSWORD', '100003']
]) {
  test(
    'PNVS ' + purpose + ': fixed HTTPS POST, explicit flags, local code/min and no redirects',
    async () => {
      let calls = 0,
        timeout;
      const original = AbortSignal.timeout;
      AbortSignal.timeout = (ms) => {
        timeout = ms;
        return new AbortController().signal;
      };
      try {
        const sender = createAliyunSms(options, async (url, init) => {
          calls++;
          const parsed = new URL(url);
          assert.equal(parsed.origin, 'https://dypnsapi.aliyuncs.com');
          assert.equal(parsed.pathname, '/');
          assert.equal(init.method, 'POST');
          assert.equal(init.redirect, 'error');
          assert.equal(init.body, undefined);
          assert.ok(init.signal instanceof AbortSignal);
          assert.deepEqual(Object.fromEntries(parsed.searchParams), {
            AutoRetry: '0',
            CodeLength: '6',
            CodeType: '1',
            CountryCode: '86',
            DuplicatePolicy: '1',
            Interval: '60',
            PhoneNumber: input.phone.slice(3),
            ReturnVerifyCode: 'false',
            SignName: options.signName,
            TemplateCode: template,
            TemplateParam: JSON.stringify({ code: '001234', min: '5' }),
            ValidTime: '300'
          });
          assert.equal(parsed.search.includes('+'), false);
          assert.equal(parsed.search.includes('##code##'), false);
          assert.equal(parsed.search.includes(options.accessKeyId), false);
          assert.equal(parsed.search.includes(options.accessKeySecret), false);
          assert.equal(init.headers.host, 'dypnsapi.aliyuncs.com');
          assert.equal(init.headers['x-acs-action'], 'SendSmsVerifyCode');
          assert.equal(init.headers['x-acs-version'], '2017-05-25');
          assert.match(init.headers['x-acs-date'], /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
          assert.ok(Math.abs(Date.now() - Date.parse(init.headers['x-acs-date'])) < 5000);
          assert.match(init.headers['x-acs-signature-nonce'], /^[0-9a-f-]{36}$/);
          assert.match(
            init.headers.Authorization,
            /^ACS3-HMAC-SHA256 Credential=syntheticId,SignedHeaders=.+,Signature=[0-9a-f]{64}$/
          );
          assert.equal(JSON.stringify(init.headers).includes(options.accessKeySecret), false);
          return accepted();
        });
        assert.equal(calls, 0);
        assert.equal(await sender.send({ ...input, code: '001234', purpose }), undefined);
        assert.equal(calls, 1);
        assert.equal(timeout, 10000);
      } finally {
        AbortSignal.timeout = original;
      }
    }
  );
}

test('PNVS assigns a fresh nonce for each explicit send and ignores provider code/model', async () => {
  const nonces = [];
  const sender = createAliyunSms(options, async (_url, init) => {
    nonces.push(init.headers['x-acs-signature-nonce']);
    return Response.json({
      Code: 'OK',
      Success: true,
      Model: { VerifyCode: 'provider-secret' },
      Message: 'provider-detail'
    });
  });
  assert.equal(await sender.send(input), undefined);
  assert.equal(await sender.send(input), undefined);
  assert.equal(nonces.length, 2);
  assert.notEqual(nonces[0], nonces[1]);
});

for (const mode of [
  'nonOK',
  'httpError',
  'network',
  'timeout',
  'malformed',
  'null',
  'array',
  'missingCode',
  'missingSuccess',
  'falseSuccess',
  'stringSuccess',
  'redirect'
]) {
  test('PNVS failure ' + mode + ': one attempt, fixed error and no secret logging', async () => {
    let calls = 0;
    const logs = [],
      saved = {};
    for (const name of ['log', 'error', 'warn', 'info', 'debug']) {
      saved[name] = console[name];
      console[name] = (...args) => logs.push(args);
    }
    try {
      const sender = createAliyunSms(options, async (url) => {
        calls++;
        if (mode === 'network') throw Error(url + options.accessKeySecret);
        if (mode === 'timeout') throw new DOMException(options.accessKeySecret, 'TimeoutError');
        if (mode === 'malformed') return new Response('not-json ' + options.accessKeySecret);
        let body = {
          Code: 'OK',
          Success: true,
          Message: options.accessKeySecret,
          Model: { VerifyCode: input.code }
        };
        if (mode === 'nonOK') body.Code = 'BUSINESS_ERROR';
        if (mode === 'missingCode') delete body.Code;
        if (mode === 'missingSuccess') delete body.Success;
        if (mode === 'falseSuccess') body.Success = false;
        if (mode === 'stringSuccess') body.Success = 'true';
        if (mode === 'null') body = null;
        if (mode === 'array') body = [];
        return Response.json(body, { status: mode === 'httpError' ? 503 : mode === 'redirect' ? 302 : 200 });
      });
      await assert.rejects(
        () => sender.send(input),
        (error) => {
          assert.equal(error.code, 'SMS_UNAVAILABLE');
          assert.equal(error.status, 503);
          assert.equal(error.message, '短信发送失败，请稍后再试');
          const text = JSON.stringify(error) + error.stack;
          for (const value of [
            options.accessKeyId,
            options.accessKeySecret,
            input.code,
            input.phone,
            'TemplateParam',
            'Authorization'
          ])
            assert.equal(text.includes(value), false);
          assert.equal(error.cause, undefined);
          return true;
        }
      );
      assert.equal(calls, 1);
      assert.deepEqual(logs, []);
    } finally {
      for (const name of Object.keys(saved)) console[name] = saved[name];
    }
  });
}

test('PNVS timeout signal actually aborts an in-flight injected transport without retry', async () => {
  const original = AbortSignal.timeout;
  let calls = 0,
    timer;
  AbortSignal.timeout = (ms) => {
    assert.equal(ms, 10000);
    const controller = new AbortController();
    timer = setTimeout(() => controller.abort(new DOMException('synthetic timeout', 'TimeoutError')), 5);
    return controller.signal;
  };
  try {
    const sender = createAliyunSms(options, async (_url, init) => {
      calls++;
      return await new Promise((_resolve, reject) => {
        init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true });
      });
    });
    await assert.rejects(
      () => sender.send(input),
      (error) => error.code === 'SMS_UNAVAILABLE'
    );
    assert.equal(calls, 1);
  } finally {
    clearTimeout(timer);
    AbortSignal.timeout = original;
  }
});

test('PNVS invalid configuration, unsupported purpose, phone and payload fail before transport', async () => {
  const forbidden = async () => {
    throw Error('must not call');
  };
  for (const patch of [
    { accessKeyId: '' },
    { registerTemplateCode: 'SMS_123' },
    { resetTemplateCode: '100001' },
    { signName: ' bad' }
  ])
    assert.throws(
      () => createAliyunSms({ ...options, ...patch }, forbidden),
      (error) => error.code === 'SMS_UNAVAILABLE'
    );
  let calls = 0;
  const sender = createAliyunSms(options, async () => {
    calls++;
    return accepted();
  });
  for (const patch of [
    { code: '12345' },
    { code: '##code##' },
    { code: 123456 },
    { purpose: 'LOGIN' },
    { purpose: 'toString' },
    { phone: '+12025550123' }
  ])
    await assert.rejects(
      () => sender.send({ ...input, ...patch }),
      (error) => error.code === 'SMS_UNAVAILABLE'
    );
  assert.equal(calls, 0);
});
