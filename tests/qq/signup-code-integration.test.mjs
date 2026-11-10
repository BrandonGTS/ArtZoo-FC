import test from 'node:test';
import assert from 'node:assert/strict';
import { loadQqOfficialPlanningConfig } from '../../packages/db/src/qq-official-config.ts';
import { buttonProbeOpen } from '../../apps/web/server/bot-management/button-probe.ts';
import {
  signupRuntimeReady,
  QQ_SIGNUP_PLUGIN_VERSION
} from '../../apps/web/server/qq-official/signup-code.ts';
const now = new Date('2030-06-01T10:00:00Z');
const env = {
  NODE_ENV: 'test',
  ARTZOO_QQ_MODE: 'live',
  ARTZOO_QQ_LIVE_SEND_ENABLED: '1',
  ARTZOO_QQ_TARGET_KIND: 'TEST',
  ARTZOO_QQ_TEST_GROUP_APPROVED: '1',
  ARTZOO_QQ_APP_ID: 'synthetic_app',
  ARTZOO_QQ_BOT_ID: 'synthetic_bot',
  ARTZOO_QQ_GROUP_OPENID: 'synthetic_group',
  ARTZOO_QQ_ENABLED_AT: '2030-01-01T00:00:00Z'
};
test('signup button opt-in cannot open or renew the independent expired probe window', () => {
  const config = loadQqOfficialPlanningConfig({
    ...env,
    ARTZOO_QQ_SIGNUP_BUTTONS_ENABLED: '1',
    ARTZOO_QQ_BUTTON_PROBE_UNTIL: '2030-06-01T09:59:00Z'
  });
  assert.equal(config.signupButtons, true);
  assert.equal(buttonProbeOpen(config, now), false);
  const onlyProbe = loadQqOfficialPlanningConfig({
    ...env,
    ARTZOO_QQ_BUTTON_PROBE_UNTIL: '2030-06-01T10:01:00Z'
  });
  assert.equal(onlyProbe.signupButtons, undefined);
  assert.equal(buttonProbeOpen(onlyProbe, now), true);
  assert.equal(loadQqOfficialPlanningConfig(env).signupButtons, undefined);
});
test('new live notices wait for current, fresh and unpaused signup-capable plugin adoption', () => {
  const seen = {
    observedAt: now,
    applyError: null,
    telemetry: { plugin_version: QQ_SIGNUP_PLUGIN_VERSION, ready: true, proactive_paused: false }
  };
  assert.equal(signupRuntimeReady(seen, now), true);
  assert.equal(signupRuntimeReady(null, now), false);
  for (const version of ['0.3.4', '0.3.5', '0.3.7'])
    assert.equal(
      signupRuntimeReady({ ...seen, telemetry: { ...seen.telemetry, plugin_version: version } }, now),
      false
    );
  for (const change of [
    { applyError: 'not adopted' },
    { observedAt: new Date(now.getTime() - 120001) },
    { telemetry: { ...seen.telemetry, ready: false } },
    { telemetry: { ...seen.telemetry, proactive_paused: true } }
  ])
    assert.equal(signupRuntimeReady({ ...seen, ...change }, now), false);
});

test('actual Python button payload plus user seat input produces the server parser target', async () => {
  const { execFileSync } = await import('node:child_process');
  const { parseQqSignupTarget } = await import('../../apps/web/server/qq-official/signup-parser.ts');
  const script = `import json
from plugins.astrbot_plugin_artzoo import sdk,core
rows=[]
for suffix in ['MT 骑士','A队 H1 白魔','','T 骑士','H 白魔','B队 T 骑士','C队 D5 武僧']:
 payload=sdk.signup_button_payload('合成活动消息','7K4M2Q9R')
 action=payload['keyboard']['content']['rows'][0]['buttons'][0]['action']
 text=(action['data']+suffix).strip()
 raw={'id':'synthetic_event','group_openid':'synthetic_group','content':text,'timestamp':'2030-06-01T10:00:00+00:00','author':{'member_openid':'synthetic_member'},'message_scene':{'ext':['msg_idx=synthetic_message']}}
 body=core.command_envelope(raw,text,core.Scope('synthetic_app','synthetic_bot','synthetic_group'))
 rows.append({'action':action,'body':body})
print(json.dumps(rows))`;
  const rows = JSON.parse(
    execFileSync('python3', ['-c', script], {
      cwd: new URL('../.././', import.meta.url),
      encoding: 'utf8',
      timeout: 10000
    })
  );
  assert.equal(rows.length, 7);
  for (const [i, row] of rows.entries()) {
    assert.equal(row.action.type, 2);
    assert.equal(row.action.enter, false);
    assert.equal(row.action.reply, false);
    assert.equal(row.body.activity_code, '7K4M2Q9R');
    assert.equal(row.body.ref_idx, undefined);
    const parsed = parseQqSignupTarget(row.body.content);
    assert.equal(parsed.activityCode, row.body.activity_code);
    assert.equal(parsed.command.kind, i === 2 ? 'OFFLINE' : 'GAME');
  }
});
