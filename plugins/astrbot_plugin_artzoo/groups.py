"""Signed, bounded group registry. No group joins or credential management."""
import hashlib
import hmac
import re
from datetime import datetime, timezone
from .core import Scope, Rejected, canonical_json


def registry_proof(value, scope, secret, now, previous_revision=0, previous_digest=None):
    required={"appId","botId","revision","groups","digest","issuedAt","expiresAt","signature"}
    if type(value) is not dict or set(value)!=required:
        raise Rejected("invalid_group_registry")
    signed={key:item for key,item in value.items() if key!="signature"}
    signature=hmac.new(secret,b"ArtZoo-Qq-Groups\n"+canonical_json(signed),hashlib.sha256).hexdigest()
    if type(value["signature"]) is not str or not hmac.compare_digest(signature,value["signature"]):
        raise Rejected("invalid_group_signature")
    if value["appId"]!=scope.app_id or value["botId"]!=scope.bot_id:
        raise Rejected("group_registry_identity")
    version=value["revision"]
    if type(version) is not int or not previous_revision<=version<=2147483646:
        raise Rejected("group_registry_version")
    try:
        issued=datetime.fromisoformat(value["issuedAt"].replace("Z","+00:00")).timestamp()
        expires=datetime.fromisoformat(value["expiresAt"].replace("Z","+00:00")).timestamp()
    except (ValueError,TypeError,AttributeError):
        raise Rejected("group_registry_expiry")
    if issued>now+60 or expires<=now or not 0<expires-issued<=120:
        raise Rejected("group_registry_expiry")
    rows=value["groups"]
    if type(rows) is not list or len(rows)>20:
        raise Rejected("group_registry_size")
    seen=set()
    for row in rows:
        if type(row) is not dict or set(row)!={"groupOpenId","label","enabled","enabledAt","generation"}:
            raise Rejected("group_registry_row")
        group=row["groupOpenId"]
        Scope(scope.app_id,scope.bot_id,group)
        if group in seen or type(row["enabled"]) is not bool or type(row["generation"]) is not int or not 0<=row["generation"]<=2147483646:
            raise Rejected("group_registry_row")
        if type(row["label"]) is not str or not 1<=len(row["label"])<=60:
            raise Rejected("group_registry_label")
        if row["enabled"]:
            try:
                if datetime.fromisoformat(row["enabledAt"].replace("Z","+00:00")).timestamp()>now+60:
                    raise Rejected("group_registry_epoch")
            except (ValueError,AttributeError,TypeError):
                raise Rejected("group_registry_epoch")
        elif row["enabledAt"] is not None:
            raise Rejected("group_registry_epoch")
        seen.add(group)
    content={key:value[key] for key in ("appId","botId","revision","groups")}
    digest=hashlib.sha256(canonical_json(content)).hexdigest()
    if value["digest"]!=digest or version==previous_revision and previous_digest not in (None,digest):
        raise Rejected("group_registry_digest")
    return version,digest,{Scope(scope.app_id,scope.bot_id,row["groupOpenId"]) for row in rows if row["enabled"]}
