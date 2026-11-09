"""Production-only atomic reply capacity, no command content or credentials stored."""
import hashlib
import json
import secrets
from .core import Rejected, canonical_json

LEASE_SECONDS=30
HEARTBEAT_SECONDS=5
MAX_REPLY_SECONDS=120

def schema(db):
    db.execute("CREATE TABLE IF NOT EXISTS provider_refusal_resolutions(attempt_key TEXT PRIMARY KEY,scope TEXT NOT NULL,direction TEXT NOT NULL,resolved REAL NOT NULL,http_status INTEGER NOT NULL,provider_code INTEGER NOT NULL,log_evidence_sha256 TEXT NOT NULL,attempt_evidence_sha256 TEXT NOT NULL)")
    db.execute("CREATE TABLE IF NOT EXISTS provider_resolution_invalidations(attempt_key TEXT PRIMARY KEY,observed REAL NOT NULL,outcome TEXT NOT NULL)")
    db.execute("CREATE TABLE IF NOT EXISTS reply_pre_send_failures(attempt_key TEXT PRIMARY KEY,category TEXT NOT NULL,created REAL NOT NULL)")
    db.execute("CREATE TABLE IF NOT EXISTS reply_pause_resolutions(attempt_key TEXT PRIMARY KEY,scope TEXT NOT NULL,direction TEXT NOT NULL,prior_reason TEXT NOT NULL,resolved REAL NOT NULL,proof TEXT NOT NULL)")
    db.execute("CREATE TABLE IF NOT EXISTS reply_late_outcomes(attempt_key TEXT PRIMARY KEY,outcome TEXT NOT NULL,observed REAL NOT NULL)")
    db.execute("""CREATE TABLE IF NOT EXISTS reply_slots(
        attempt_key TEXT PRIMARY KEY, scope TEXT NOT NULL, member_hash TEXT NOT NULL,
        command_hash TEXT NOT NULL, owner_hash TEXT NOT NULL, state TEXT NOT NULL,
        created REAL NOT NULL, lease_until REAL NOT NULL)""")

RESOLVED_PRE_SDK="resolved_pre_sdk"
RESOLVED_PROVIDER_REFUSAL="resolved_provider_refusal"

def pause(db, scope, direction, reason):
    db.execute("INSERT INTO direction_pauses VALUES(?,?,?) ON CONFLICT(scope,direction) DO UPDATE SET reason=excluded.reason WHERE direction_pauses.reason IN (?,?)",(scope,direction,reason,RESOLVED_PRE_SDK,RESOLVED_PROVIDER_REFUSAL))

def pre_sdk_evidence(db,key):
    row=db.execute("""SELECT a.digest,a.outcome,a.receipt,a.ack,a.created,
        r.command_hash,r.state,r.created,b.direction,r.scope,b.scope
        FROM attempts a JOIN reply_slots r ON r.attempt_key=a.delivery_key
        JOIN send_budgets b ON b.attempt_key=a.delivery_key WHERE a.delivery_key=?""",(key,)).fetchone()
    valid=bool(row and row[0]==row[5] and row[1]=='unknown' and row[2]=='{}' and row[3]=='{}'
                and row[4]==row[7] and row[6]=='UNKNOWN' and row[8]=='passive'
                and row[9]==row[10] and key.startswith(row[9]+':reply:')
                and not db.execute('SELECT 1 FROM reply_late_outcomes WHERE attempt_key=?',(key,)).fetchone())
    return hashlib.sha256(canonical_json({'key':key,'row':list(row)})).hexdigest() if valid else None

def verified_pre_sdk_placeholder(db,key):
    return pre_sdk_evidence(db,key) is not None

def resolved_placeholder(db,key):
    row=db.execute('SELECT proof FROM reply_pause_resolutions WHERE attempt_key=?',(key,)).fetchone()
    if not row:return False
    try:
        proof=json.loads(row[0]);evidence=pre_sdk_evidence(db,key)
        return bool(evidence and proof=={'rule':'NO_SDK_START_PLACEHOLDER','evidenceDigest':evidence})
    except (ValueError,TypeError):return False

def resolve_incident_pre_sdk_pause(journal,scope,key,now):
    """Operator-only exact incident recovery; retains every historical row and charge."""
    wire=scope_key(scope)
    with journal.db:
        journal.db.execute('BEGIN IMMEDIATE')
        if wire=='*' or journal.db.execute("SELECT 1 FROM direction_pauses WHERE scope='*'").fetchone():
            raise Rejected('global_pause_requires_review')
        blockers=journal.db.execute("SELECT a.delivery_key FROM attempts a JOIN send_budgets b ON b.attempt_key=a.delivery_key WHERE b.scope=? AND b.direction='passive' AND a.outcome IN ('started','unknown','permission_denied')",(wire,)).fetchall()
        if blockers!=[(key,)] or not verified_pre_sdk_placeholder(journal.db,key):
            raise Rejected('incident_has_unresolved_send_risk')
        if journal.db.execute("SELECT 1 FROM reply_late_outcomes l JOIN send_budgets b ON b.attempt_key=l.attempt_key WHERE b.scope=? AND b.direction='passive'",(wire,)).fetchone():raise Rejected('incident_has_late_outcome')
        if journal.db.execute("SELECT 1 FROM reply_slots WHERE scope=? AND state IN ('RESERVED','SENDING')",(wire,)).fetchone():
            raise Rejected('incident_has_inflight_reply')
        reason=journal.db.execute("SELECT reason FROM direction_pauses WHERE scope=? AND direction='passive'",(wire,)).fetchone()
        if not reason or reason[0] not in ('reply_outcome_unknown','unknown',RESOLVED_PRE_SDK):
            raise Rejected('incident_pause_reason_requires_review')
        prior=journal.db.execute('SELECT 1 FROM reply_pause_resolutions WHERE attempt_key=?',(key,)).fetchone()
        if reason[0]==RESOLVED_PRE_SDK and prior:return False
        if prior:raise Rejected('incident_resolution_already_used')
        journal.db.execute('INSERT INTO reply_pause_resolutions VALUES(?,?,?,?,?,?)',(key,wire,'passive',reason[0],current_time(now),json.dumps({'rule':'NO_SDK_START_PLACEHOLDER','evidenceDigest':pre_sdk_evidence(journal.db,key)},sort_keys=True)))
        journal.db.execute("UPDATE direction_pauses SET reason=? WHERE scope=? AND direction='passive'",(RESOLVED_PRE_SDK,wire))
        return True

def provider_refusal_evidence(db,key):
    row=db.execute("""SELECT a.digest,a.outcome,a.receipt,a.created,a.ack,a.acknowledged,
        b.scope,b.direction,b.charged,b.created FROM attempts a JOIN send_budgets b
        ON b.attempt_key=a.delivery_key WHERE a.delivery_key=?""",(key,)).fetchone()
    if not(row and row[1] in ('unknown','permission_denied') and row[2]=='{}'
            and row[5]==1 and row[7]=='proactive' and row[8]==1
            and key.startswith(row[6]+':') and not key.startswith(row[6]+':reply:')
            and not db.execute('SELECT 1 FROM reply_slots WHERE attempt_key=?',(key,)).fetchone()
            and not db.execute('SELECT 1 FROM provider_resolution_invalidations WHERE attempt_key=?',(key,)).fetchone()):
        return None
    return hashlib.sha256(canonical_json({'key':key,'row':list(row)})).hexdigest()

def resolved_provider_refusal(db,key):
    row=db.execute('SELECT scope,direction,http_status,provider_code,log_evidence_sha256,attempt_evidence_sha256 FROM provider_refusal_resolutions WHERE attempt_key=?',(key,)).fetchone()
    if not row:return False
    scope=db.execute('SELECT scope FROM send_budgets WHERE attempt_key=?',(key,)).fetchone()
    return bool(scope and row[0]==scope[0] and row[1]=='proactive' and row[2]==400
                and row[3]==40034105 and isinstance(row[4],str) and len(row[4])==64
                and all(x in '0123456789abcdef' for x in row[4])
                and row[5]==provider_refusal_evidence(db,key))

def resolve_confirmed_provider_refusal(journal,scope,key,log_evidence_sha256,now):
    """Operator only: exact externally confirmed 400/40034105, never automatic."""
    if not(isinstance(log_evidence_sha256,str) and len(log_evidence_sha256)==64
           and all(x in '0123456789abcdef' for x in log_evidence_sha256)):
        raise Rejected('invalid_provider_refusal_evidence')
    wire=scope_key(scope)
    with journal.db:
        journal.db.execute('BEGIN IMMEDIATE')
        prior=journal.db.execute('SELECT log_evidence_sha256 FROM provider_refusal_resolutions WHERE attempt_key=?',(key,)).fetchone()
        if prior:
            if prior[0]==log_evidence_sha256 and resolved_provider_refusal(journal.db,key):return False
            raise Rejected('provider_resolution_already_used')
        if journal.db.execute("SELECT 1 FROM direction_pauses WHERE scope='*'").fetchone():
            raise Rejected('global_pause_requires_review')
        own=journal.db.execute('SELECT scope FROM send_budgets WHERE attempt_key=?',(key,)).fetchone()
        evidence=provider_refusal_evidence(journal.db,key)
        if own!=(wire,) or not evidence:raise Rejected('provider_refusal_record_not_verified')
        blockers=journal.db.execute("SELECT a.delivery_key FROM attempts a JOIN send_budgets b ON b.attempt_key=a.delivery_key WHERE b.scope=? AND b.direction='proactive' AND a.outcome IN ('started','unknown','permission_denied')",(wire,)).fetchall()
        if any(k!=key and not resolved_provider_refusal(journal.db,k) for(k,)in blockers):
            raise Rejected('other_send_risk_requires_review')
        if journal.db.execute("SELECT 1 FROM reply_slots WHERE scope=? AND state IN ('RESERVED','SENDING')",(wire,)).fetchone():
            raise Rejected('scope_has_inflight_reply')
        pause_row=journal.db.execute("SELECT reason FROM direction_pauses WHERE scope=? AND direction='proactive'",(wire,)).fetchone()
        if pause_row and pause_row[0]not in('unknown','permission_denied','provider_40034105'):
            raise Rejected('pause_reason_requires_review')
        journal.db.execute('INSERT INTO provider_refusal_resolutions VALUES(?,?,?,?,?,?,?,?)',
            (key,wire,'proactive',current_time(now),400,40034105,log_evidence_sha256,evidence))
        journal.db.execute("INSERT INTO direction_pauses VALUES(?,'proactive',?) ON CONFLICT(scope,direction) DO UPDATE SET reason=excluded.reason",(wire,RESOLVED_PROVIDER_REFUSAL))
        return True

def current_time(value):
    return value() if callable(value) else value

def scope_key(scope):
    return canonical_json(scope.wire()).decode()

def member_hash(scope, member):
    return hashlib.sha256(canonical_json([scope.wire(), member])).hexdigest()

def capacity(journal, scope, direction, now, minute, day, group_minute,
             member=None, user_minute=3):
    rows = journal.db.execute("""SELECT b.direction,b.created,r.member_hash,
        (r.state IN ('RESERVED','SENDING') OR a.outcome='started') pending
        FROM send_budgets b LEFT JOIN reply_slots r ON r.attempt_key=b.attempt_key
        LEFT JOIN attempts a ON a.delivery_key=b.attempt_key
        WHERE b.scope=? AND b.charged=1 AND
        (b.created>? OR r.state IN ('RESERVED','SENDING') OR a.outcome='started')""",
        (scope_key(scope), now-86400)).fetchall()
    current = [r for r in rows if r[1] > now-60 or r[3]]
    if len(current) >= group_minute:
        return False
    if direction == 'proactive':
        own = [r for r in rows if r[0] == direction]
        return (sum(r[1] > now-60 or bool(r[3]) for r in own) < minute
                and sum(r[1] > now-86400 or bool(r[3]) for r in own) < day)
    if member is not None:
        # Old replies have no per-member metadata: conservatively count them for
        # every member during their minute rather than inventing an owner.
        own = [r for r in current if r[0] == 'passive'
               and (r[2] is None or r[2] == member)]
        return len(own) < user_minute
    return True

def _unknown(journal, row):
    key, scope, command, created = row
    journal.db.execute("UPDATE reply_slots SET state='UNKNOWN' WHERE attempt_key=?",(key,))
    journal.db.execute("INSERT OR IGNORE INTO attempts VALUES(?,?,?,?,?,?,0)",
                       (key,command,'unknown','{}',created,'{}'))
    journal.db.execute("UPDATE attempts SET outcome='unknown' WHERE delivery_key=? AND outcome='started'",(key,))
    pause(journal.db,scope,'passive','reply_outcome_unknown')

def recover(journal, now):
    with journal.db:
        journal.db.execute('BEGIN IMMEDIATE')
        now=current_time(now)
        for key,scope,direction in journal.db.execute('SELECT attempt_key,scope,direction FROM provider_refusal_resolutions').fetchall():
            if not resolved_provider_refusal(journal.db,key):
                pause(journal.db,scope,direction,'invalid_provider_resolution')
        rows=journal.db.execute("""SELECT attempt_key,scope,command_hash,created
            FROM reply_slots WHERE state IN ('RESERVED','SENDING') AND lease_until<=?""",(now,)).fetchall()
        for row in rows:
            _unknown(journal,row)

def reserve_reply(sender, scope, event_id, member, command_hash, now):
    journal=sender.journal
    recover(journal,now)
    clock=now
    key=scope_key(scope)+':reply:'+event_id
    owner=secrets.token_hex(16)
    hashed=member_hash(scope,member)
    with journal.db:
        journal.db.execute('BEGIN IMMEDIATE')
        now=current_time(clock)
        old=journal.db.execute('SELECT command_hash FROM reply_slots WHERE attempt_key=?',(key,)).fetchone()
        if old:
            if old[0]!=command_hash:
                raise Rejected('event_content_changed')
            return None
        if journal.db.execute('SELECT 1 FROM attempts WHERE delivery_key=?',(key,)).fetchone():
            return None
        if not journal.budget_available(scope,'passive',0,'production'):
            raise Rejected('passive_direction_paused')
        if not capacity(journal,scope,'passive',now,sender.minute,sender.day,
                        sender.group_minute,hashed,sender.user_minute):
            raise Rejected('rate_limited_before_command')
        journal.db.execute('INSERT INTO send_budgets VALUES(?,?,?,?,?)',(key,scope_key(scope),'passive',1,now))
        journal.db.execute('INSERT INTO reply_slots VALUES(?,?,?,?,?,?,?,?)',
            (key,scope_key(scope),hashed,command_hash,hashlib.sha256(owner.encode()).hexdigest(),'RESERVED',now,now+LEASE_SECONDS))
    return {'key':key,'owner':owner,'command_hash':command_hash}

def start_reply(journal, reservation, key, reply_digest, scope, now, sdk_timeout):
    valid=False
    with journal.db:
        journal.db.execute('BEGIN IMMEDIATE')
        now=current_time(now)
        row=journal.db.execute('SELECT scope,command_hash,owner_hash,state,created,lease_until FROM reply_slots WHERE attempt_key=?',(key,)).fetchone()
        if (not row or reservation.get('key')!=key or row[0]!=scope_key(scope)
                or row[1]!=reservation.get('command_hash')
                or row[2]!=hashlib.sha256(reservation.get('owner','').encode()).hexdigest()):
            raise Rejected('invalid_reply_reservation')
        if row[3]!='RESERVED':
            raise Rejected('reply_already_started')
        if (row[5]<=now or row[4]+MAX_REPLY_SECONDS-now < sdk_timeout+5
                or not journal.budget_available(scope,'passive',0,'production')):
            _unknown(journal,(key,row[0],row[1],row[4]))
        else:
            journal.db.execute('INSERT INTO attempts VALUES(?,?,?,?,?,?,0)',(key,reply_digest,'started','{}',now,'{}'))
            journal.db.execute("UPDATE reply_slots SET state='SENDING',lease_until=? WHERE attempt_key=?",(min(row[4]+MAX_REPLY_SECONDS,max(row[5],now+sdk_timeout+10)),key))
            journal.db.execute('UPDATE send_budgets SET created=? WHERE attempt_key=?',(now,key))
            valid=True
    if not valid:
        raise Rejected('reply_reservation_unknown')

def fail_reply(journal,reservation,*,safe_before_sdk=False,now=0):
    with journal.db:
        journal.db.execute('BEGIN IMMEDIATE')
        row=journal.db.execute('SELECT scope,command_hash,created,state,owner_hash FROM reply_slots WHERE attempt_key=?',(reservation['key'],)).fetchone()
        if (row and row[3] in ('RESERVED','SENDING')
                and row[4]==hashlib.sha256(reservation['owner'].encode()).hexdigest()):
            if safe_before_sdk and row[3]=='RESERVED' and not journal.db.execute('SELECT 1 FROM attempts WHERE delivery_key=?',(reservation['key'],)).fetchone():
                journal.db.execute("UPDATE reply_slots SET state='PRE_SEND_FAILED' WHERE attempt_key=?",(reservation['key'],))
                journal.db.execute('INSERT OR IGNORE INTO reply_pre_send_failures VALUES(?,?,?)',(reservation['key'],'GROUP_PROOF_NO_SDK_START',current_time(now)))
                return True
            _unknown(journal,(reservation['key'],row[0],row[1],row[2]))
        return False

def owns_pending(db,key):
    return db.execute("SELECT 1 FROM reply_slots WHERE attempt_key=? AND state IN ('RESERVED','SENDING')",(key,)).fetchone() is not None

def renew(journal,reservation,now):
    valid=False
    with journal.db:
        journal.db.execute('BEGIN IMMEDIATE')
        now=current_time(now)
        row=journal.db.execute('SELECT scope,command_hash,owner_hash,state,created,lease_until FROM reply_slots WHERE attempt_key=?',(reservation['key'],)).fetchone()
        if row and row[2]==hashlib.sha256(reservation['owner'].encode()).hexdigest() and row[3] in ('RESERVED','SENDING'):
            if row[5]<=now or now>=row[4]+MAX_REPLY_SECONDS:
                _unknown(journal,(reservation['key'],row[0],row[1],row[4]))
            else:
                journal.db.execute('UPDATE reply_slots SET lease_until=? WHERE attempt_key=?',(min(row[4]+MAX_REPLY_SECONDS,max(row[5],now+LEASE_SECONDS)),reservation['key']))
                valid=True
    return valid
