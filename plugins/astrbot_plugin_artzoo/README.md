# ArtZoo AstrBot official QQ bridge candidate

Reviewable local artifact for **AstrBot 4.29.3 / Python 3.12 / qq-botpy 1.2.1**.
This artifact is developed locally. This agent has not installed, connected,
enabled or tested it against real QQ. Remote testing is owned exclusively by the
root operator task under its separate user authorization. No remote AstrBot,
shared local 3100, production service or real credential was accessed here.

Copy the contents of this directory into AstrBot's plugin directory only after a
separate operator review. This task does not perform that installation. It adds
no package dependency and never initializes another QQ client.

## Defaults and identity

`config.example.json` and `_conf_schema.json` keep `enabled=false`,
`simulation=true`, `allow_real_send=false`, `allow_passive_replies=false`,
`allow_proactive_send=false`, zero direction budgets and empty identities/allowlists.
Disabled initialization creates no background task, network client or journal.
Simulation requires `mock_`-prefixed app/bot/group/member identities. The website
must compare the request's simulation mode to its configured mode.

Configure one exact `platform_id`; verify the existing adapter's
`meta().name == qq_official`, `appid`, and authenticated `client.robot.id`.
A missing/unready/mismatched bot or literal `qq_official` identity fails closed.
Do not use AstrBot `message_obj.self_id` as a stable bot identity: unmentioned
group messages may contain a placeholder. `allow_groups` names exact group
OpenIDs under that fixed app and bot. Actual sends additionally need
`simulation=false`, `allow_real_send=true`, and a separately approved target
in `approved_test_groups`. The matching direction switch must also be true.
Current defaults approve no target. Live operation accepts one exact group only;
the root operator supplies and verifies the approved scope in private config.

Only the named environment variable `ARTZOO_QQ_BRIDGE_SECRET` is read for the
website HMAC client. The operator supplies an already approved key of at least
32 UTF-8 bytes; this artifact does not create, print, store or invent one.
It never reads QQ AppSecret, token, existing env files or private credentials.
Bridge origin requires HTTPS; explicit HTTP permission works only with loopback
for isolated mocks. No redirects or inherited proxy configuration are used.

## Incoming events

The group handler checks exact platform identity, stops handled events before
any await, and reads the native GroupMessage's `raw_data` dict. It forwards
only `绑定 <public_code>`, `确认绑定 <final_proof>` and content starting
`报名` to the deterministic website parser. Example registration forms:
`报名 H1 白魔`, `报名 MT 骑士`, `报名 A队 H1 白魔`, or offline `报名`.
The website decides validity, activity type, qualification, seat and occupation.
No model tools, AI interpretation, account IDs or activity IDs are introduced.

`退出`, `取消报名`, `换职业` and `换位置` are website-only instructions;
the plugin never forwards a mutation for them. Replies use fixed safe text.
Keyword recognition uses Unicode whitespace (including tabs, newlines and
ideographic spaces); strict binding validation and the website parser remain
authoritative. Malformed or unavailable handled commands cannot fall through to a model.
Ordinary chat is untouched. Disabled plugin handlers do not intercept events.

The exact original `raw_data.content` is forwarded (including native mentions);
the website must validate/remove only the authenticated bot's own mention.
Normalized AstrBot text is used solely to classify the command. Event content
is capped at 2048 characters and normalized command text at 512. Group-only
native event type validation rejects private/user OpenIDs. There is no private
`user_openid` to group `member_openid` mapping.

`message_scene.ext` is a string array. `msg_idx` is the command's own index;
`ref_msg_idx` is the quoted message index. Parsing splits on the first `=`
and preserves Base64 padding. Missing, malformed or duplicate quote references
are rejected. There is no most-recent activity, ordinary message ID, explicit
activity ID, reply-chain or cross-group fallback.

## Bridge protocol

All endpoints are POST, with an `{ok:true,data:{...}}` response envelope:

| Path                                | Request / result                                                                                                             |
| ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `/api/qq-official/commands`         | scope, `event_id,sender_openid,message_idx,event_timestamp,content,ref_idx?`, `simulation`; returns safe plaintext `message` |
| `/api/qq-official/deliveries/claim` | scope and `simulation`; returns `delivery:null` or task                                                                      |
| `/api/qq-official/deliveries/begin` | scope, `delivery_id,claim_token,simulation`; returns `dispatch,simulation`                                                   |
| `/api/qq-official/deliveries/ack`   | scope, `delivery_id,claim_token,simulation,outcome`, optional receipt                                                        |

Scope is always `app_id+bot_id+group_openid`. A task contains
`delivery_id,claim_token,idempotency_key,content,msg_seq,simulation`.
A conflicting task scope is rejected. Only begin with `dispatch=true` may lead
to a single send; a lost/invalid begin response becomes `unknown` without a send.
The server must atomically begin once, derive/compare the original delivery
mode, prevent replay of claims, and never requeue uncertain or begun delivery
automatically. The plugin cannot prove external delivery after a lost receipt.

Headers are `X-ArtZoo-Timestamp` (Unix seconds), `X-ArtZoo-Nonce` (32 random hex
characters) and `X-ArtZoo-Signature` (lowercase HMAC-SHA256 hex). Body is UTF-8
JSON, compact, sorted keys, no NaN. Canonical HMAC material, joined with newline:

`timestamp + "\\n" + nonce + "\\n" + "POST" + "\\n" + exact_path + "\\n" + sha256(raw_body)`

The website owns timestamp bounds, durable nonce uniqueness, scoped event
idempotency, HTTP authorization, binding proof verification, command freshness,
membership validation, receipt mapping and domain transactions. A fresh nonce
authenticates a repeated idempotent event/ack; it must not repeat business work.

## SDK receipt and delivery safety

AstrBot 4.29.3 `send_by_session` returns None and caches only an ordinary ID.
Its generic helpers can retry or fall back to proactive sending. This plugin
uses a dedicated text-only call through the existing authenticated SDK HTTP
object; it does not call those helpers, reconnect or downgrade payloads.

The pinned qq-botpy 1.2.1 HTTP request method recursively retries a connection
reset. The adapter verifies distribution version, exact BotHttp class/bound
method and its complete executable AST SHA256:
`cc8bdeea4f8d35c9af97b830da1a465afce806c231875fd8c9e53c08a52aa19e`.
The current adapter validates that upstream method, then uses the existing
verified HTTP session for one request with redirects disabled. It does not call
the upstream recursively retrying `request` method.
Unrecognized SDK source/class/version or missing source fails closed. Delivery
mode must exactly match the plugin mode before begin. HTTP redirects are disabled. The
upstream source fingerprint was checked with one read-only public source GET;
no SDK was installed. The operator must also verify the runtime adapter and
the official platform's send permission/quota in an approved test group. The
upstream SDK itself contains header-bearing DEBUG logs; audit the existing
runtime log level/redaction before live enable. This artifact does not alter
global logging configuration or print those headers.

### Reviewing a pinned SDK upgrade

Do not copy a new hash into `sdk.py` just to bypass a source mismatch. In an
isolated environment with the proposed SDK already approved and installed,
recompute its fingerprint using the **same Python minor version as deployment**:

```sh
python3 - <<'PY'
import ast
import hashlib
import inspect
import textwrap
from importlib.metadata import version
from botpy.http import BotHttp

source = textwrap.dedent(inspect.getsource(BotHttp.request))
canonical = ast.dump(ast.parse(source), include_attributes=False)
print("qq-botpy", version("qq-botpy"))
print("request AST SHA256", hashlib.sha256(canonical.encode()).hexdigest())
PY
```

This imports the SDK class and reads method source, without creating a client or
loading credentials. Compare against the exact upstream release source; review
session/auth headers, Route, error handling, redirects and retry behavior before
updating the version guard and `PINNED_REQUEST_AST_SHA256` together. Keep the
single-attempt direct-session behavior and fail-closed handling. Rerun all local
plugin tests, including SDK version/class/source mismatch and UNKNOWN/receipt
cases. Mock passing results do not establish real provider compatibility;
installation and any real-send test require their own authorization.

All outbound text converts ASCII angle brackets and @ to visible fullwidth
characters and removes control/format characters. User titles remain readable
without activating QQ mention or markup syntax.

The complete raw dict must contain both ordinary `id` and
`ext_info.ref_idx`. Only this latter reference is mapped to an activity,
under the app/bot/group scope. Missing/equal receipt fields, timeout/None/5xx/429 or
connection reset mean `unknown`, never a blind resend. 401/403 are terminal
`permission_denied`; a definite denied begin is `failed`. Simulation yields
`simulated` with no QQ call and no real receipt mapping.

Owner-only plugin data holds a SQLite delivery journal: content hashes,
attempt times, receipt identifiers and pending ACK metadata (including the
short-lived upstream claim token). No content, binding code, QQ credential,
long-lived HMAC key or full SDK error is stored. Directory/file modes are
0700/0600; preserve this journal across plugin restarts and operator upgrades.
The immutable hash covers scope, delivery identity, original/rendered text and
mode; renewed claim tokens and message sequence fences are not content.
Reservation commits before begin/send; interrupted `started` entries become
unknown. Only a valid explicit `dispatch=false` response, before any SDK branch,
records local `SAFE_PRE_SEND` evidence. That state emits wire `failed` and may
atomically reserve a renewed claim/fence with unchanged immutable content.
Rearming replaces old ACK lease metadata. Every other existing state, including
legacy generic `failed`, started, unknown, sent and permission denied, forbids
another begin/send. An invalid/lost denial response never grants safe retry. Successful receipts survive restart. ACK transport failure retries
only the ACK on a later poll. No automatic journal deletion or compaction is
performed, because removal could re-enable duplicate sends.

Per-group limits default to 3 attempts/minute and 20/rolling day, configurable
only within 1–10 and 1–100. Attempts include uncertain/failed sends and survive
restart; a positively denied begin consumed no QQ send quota. Passive command responses share that limit and are journaled once per
event. Poll interval defaults to 60 seconds (minimum 30). The website must
enforce its own limit/quota as well. This is a conservative policy, not a claim
about a universal Tencent quota.

### Poll failure handling and local lint configuration

A successful cycle retains the configured interval (management mode still caps
it at 60 seconds). Consecutive failed/rejected cycles wait the normal interval,
then double up to 300 seconds; the first failure is also capped at 300 seconds
if the configured normal interval is longer. The first subsequent success resets
the failure delay. Cancellation is propagated without retry. This retries only
polling; existing delivery journal, independent ACK retry, budget and UNKNOWN
rules continue to decide whether any work is eligible.

Rejected entrypoint branches log only a reviewed fixed `reason_code`, falling
back to `LOCAL_REJECTED`; other cycle failures use `TRANSPORT_OR_INTERNAL`.
Neither exception messages nor payloads are logged. Existing bounded group-proof
diagnostics remain unchanged.

`pyproject.toml` declares Python 3.12 and initial Ruff correctness rules only.
Ruff is not installed or added as a dependency. If an operator separately makes
Ruff available, run `ruff check plugins/astrbot_plugin_artzoo` from the repository
root (or `ruff check .` in this directory); this change does not apply automatic
fixes or claim historical code passes that optional tool.

## Local verification and remaining integration gates

From the repository root:

```sh
python3 -B -m unittest discover -s tests/qq-official-plugin -v
```

Tests use standard Python, temporary SQLite and fake SDK/bridge/event objects.
They open no network socket, install nothing and send no QQ messages. They
cover strict quote parsing, scoped envelopes, modes, HMAC, lifecycle,
claim/begin/ack, concurrency, restart, terminal denials, timeout unknown,
fixed-version rejection and faithful SDK reset retry exhaustion.

Not verified here: actual AstrBot loading/UI configuration, remote Hong Kong
v4.29.3 runtime, actual bot identity/GroupMessage payload, platform permission,
approved group, real SDK HTTP transport or QQ quota. Website integration must
also be tested with its final schema before any later installation. Default
off and simulation remain in effect. Do not describe this candidate as QQ
connected, user accepted, deployed, pushed or production verified.

Primary source references:

- [AstrBot v4.29.3 adapter](https://github.com/AstrBotDevs/AstrBot/blob/v4.29.3/astrbot/core/platform/sources/qqofficial/qqofficial_platform_adapter.py)
- [AstrBot v4.29.3 message event](https://github.com/AstrBotDevs/AstrBot/blob/v4.29.3/astrbot/core/platform/sources/qqofficial/qqofficial_message_event.py)
- [Pinned qq-botpy HTTP implementation](https://github.com/tencent-connect/botpy/blob/v1.2.1/botpy/http.py)
- [QQ group event specification](https://bot.q.qq.com/wiki/develop/api-v2/autogen/event/group_at_message_create.html)
- [QQ group send specification](https://bot.q.qq.com/wiki/develop/api-v2/autogen/api/v2_groups_group_openid_messages.post.html)

The QQ documentation URLs could not be rendered by the browsing tool in this
environment; quote/receipt fields follow the provided official contract and
must be confirmed against an operator-supplied sanitized real test payload
during a separately approved integration test.

## Separately authorized test directions and lifetime budgets

The master `allow_real_send` remains necessary. `allow_passive_replies` and
`allow_proactive_send` independently default false. A false proactive switch
prevents claim and begin requests entirely; existing pending ACKs may still be
flushed. An exhausted or paused live proactive direction also makes no new
claim/begin. Disabling passive replies leaves deterministic website handling and
model-propagation stops in place, while preventing the QQ response.

Runtime always passes an explicit policy. The default `operation_mode=test_batch`
uses `max_proactive_attempts` (0–7) and `max_passive_attempts` (0–11), both default
zero and fail closed. These are lifetime totals for the batch scope, independent
of rolling per-minute/day limits. Eleven passive attempts are the remaining authorization after SID1;
this plugin does not invent a receipt for that earlier external attempt.

SQLite `send_budgets` reserves a charged attempt atomically before begin/SDK.
Potentially sent, interrupted, unknown and terminal denied attempts count.
Only positive no-SDK begin denial or a simulation outcome uncharges the entry;
the evidence row is retained. Simulations never consume actual quota. Existing
historical actual journal records are conservatively imported, never removed,
and started/unknown history pauses the corresponding direction. Preserve all
journal tables across restart, reload and upgrades; there is no auto-reset.

UNKNOWN (including missing/partial receipt and ambiguous begin) and every
`permission_denied` outcome pause that actual direction durably, including
Forbidden/AuthenticationFailed and provider code 40034105, including when
found in bounded exception code/body/message fields. No raw error body is
logged or stored. The other direction remains independent. Reload, a new event,
new claim or renewed fence cannot clear a pause. This candidate provides no
automatic pause reset or budget-reset command.

## Operator-only identity diagnostic without sends

Set `diagnostic_mode=true` and the exact `platform_id` (for the currently
identified adapter, `default`), configured AppID and one known group. Bot ID may
remain empty until observed. Diagnostic mode overrides enabled=true and creates
no bridge, journal, poll task or QQ call. On plugin initialize it emits exactly
one existing AstrBot logger line prefixed `[ArtZoo identity]`, containing only
actual adapter metadata name/id, AppID, primitive robot ID plus its type/readiness,
and configured scope comparisons. No full config, credential, client object,
payload, binding proof or vendor error is printed. The root operator can read
this line through the existing authenticated dashboard and explicitly reload
once if the adapter was not ready. There is no new HTTP route, QQ command or
model tool. The synchronous `plugin.identity_status()` helper returns the same
read-only snapshot. Strict string bot identity validation for sends is unchanged.

Private mounted-data credential option: `bridge_secret_from_data_file=true` reads only
the fixed `bridge.secret` file under this plugin's StarTools data directory. The file
must be a regular non-symlink file owned by the running user, with no group/world
permissions, 32–256 bytes and no newline. Generate and store it privately; never put
it in plugin config or Git. This avoids recreating an existing AstrBot container just
to add an environment variable. Default is false; diagnostics never read this file.

## Explicit continuous production policy

`operation_mode` accepts only `test_batch` (default, including old configs) or
explicit `production`. Production requires `simulation=false`; otherwise
configuration is rejected. It changes only the batch lifetime-total policy.
It retains enabled/master/direction switches, one exact approved group, exact
platform/AppID/canonical verified bot identity, pinned SDK implementation,
idempotency, rolling quota and durable emergency pauses. The recommended
production batch fields remain zero; no large sentinel value represents infinity.

Production reports the effective lifetime maximum as null while preserving every
old budget/attempt/receipt row. Existing 7 proactive / 9 passive history is never
cleared, and remains part of the rolling minute/day windows while recent. An old
event or delivery key remains deduplicated across policy changes and restarts.
No pause is cleared by switching mode; historical permission denials also pause
the applicable direction when reopening the journal.

Before proactive claim, Runtime checks that direction, approved scope, pause,
mode budget and shared rolling minute/day capacity permit a potential send.
A full day/minute window generates no claim or begin request. Sender reservation
checks the shared rolling quota and policy budget again under SQLite
`BEGIN IMMEDIATE`, before inserting/charging an attempt, so separate connections
cannot exceed a stale preflight snapshot. A rejected capacity reservation
creates no attempt/charge and calls no SDK. Definite no-SDK begin denial and
simulation still retain evidence without consuming actual capacity. Both
directions share the conservative rolling rate (default 3/minute, 20/day),
while permission/unknown pause states remain independent. Pending ACKs can
still flush after the proactive switch is closed.

No continuous policy is enabled or installed by these local source edits.
Deployment, private production configuration and real verification are owned
by the separately authorized root executor.
