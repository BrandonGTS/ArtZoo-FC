"""Production-only atomic reply capacity, no command content or credentials stored."""
import hashlib
import secrets
from .core import Rejected, canonical_json

LEASE_SECONDS=30
HEARTBEAT_SECONDS=5
MAX_REPLY_SECONDS=120

def schema(db):
    db.execute("CREATE TABLE IF NOT EXISTS reply_pre_send_failures(attempt_key TEXT PRIMARY KEY,category TEXT NOT NULL,created REAL NOT NULL)")
    db.execute("CREATE TABLE IF NOT EXISTS reply_late_outcomes(attempt_key TEXT PRIMARY KEY,outcome TEXT NOT NULL,observed REAL NOT NULL)")
    db.execute("""CREATE TABLE IF NOT EXISTS reply_slots(
        attempt_key TEXT PRIMARY KEY, scope TEXT NOT NULL, member_hash TEXT NOT NULL,
        command_hash TEXT NOT NULL, owner_hash TEXT NOT NULL, state TEXT NOT NULL,
        created REAL NOT NULL, lease_until REAL NOT NULL)""")

def pause(db, scope, direction, reason):
    # The first recorded reason is kept; a pause is never lifted automatically.
    db.execute("INSERT INTO direction_pauses VALUES(?,?,?) ON CONFLICT(scope,direction) DO NOTHING",(scope,direction,reason))

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
