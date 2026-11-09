#!/usr/bin/env python3
"""Inspect index blobs only; never read ignored/local credential files."""
import re
import subprocess
from pathlib import PurePosixPath

entries = subprocess.check_output(['git', 'ls-files', '--stage', '-z']).decode().split('\0')
bad = []
patterns = [rb'-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----',
            rb'gh[pousr]_[A-Za-z0-9]{20,}', rb'github_pat_[A-Za-z0-9_]{20,}',
            rb'AKIA[0-9A-Z]{16}', rb'(?m)^POSTGRES_PASSWORD=.+$']
for entry in filter(None, entries):
    metadata, name = entry.split('\t', 1)
    mode, object_id, stage = metadata.split()
    p = PurePosixPath(name)
    forbidden = ((p.name.startswith('.env') and p.name != '.env.example') or
                 any(x in p.parts for x in ['.local', 'secrets']) or
                 p.suffix in ['.pem', '.key'] or
                 p.name.startswith(('id_rsa', 'id_ed25519')))
    if forbidden or stage != '0':
        bad.append(name)
        continue
    data = subprocess.check_output(['git', 'cat-file', 'blob', object_id])
    if any(re.search(pattern, data) for pattern in patterns):
        bad.append(name)
if bad:
    print('Index secret check failed; file paths only:')
    print('\n'.join(sorted(set(bad))))
    raise SystemExit(1)
print('Index secret check passed')
