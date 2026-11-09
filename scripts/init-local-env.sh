#!/usr/bin/env bash
set -euo pipefail
cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.."
test -t 0 && test -t 1 || { printf 'Run this yourself in an interactive terminal.\n' >&2; exit 1; }
test ! -e .env && test ! -L .env || { printf 'Refusing to overwrite existing .env.\n' >&2; exit 1; }
umask 077
read -r -s -p 'New local database password (16+ characters; letters/digits/_/-): ' password
printf '\n'
read -r -s -p 'Confirm password: ' confirmation
printf '\n'
test "$password" = "$confirmation" || { printf 'Passwords do not match. Nothing saved.\n' >&2; exit 1; }
[[ "$password" =~ ^[A-Za-z0-9_-]{16,128}$ ]] || { printf 'Use 16–128 letters, digits, underscores or hyphens. Nothing saved.\n' >&2; exit 1; }
# Noclobber creates the final file exclusively, including race protection.
(set -o noclobber; printf 'POSTGRES_PASSWORD=%s\n' "$password" > .env)
chmod 600 .env
unset password confirmation
printf 'Local database configuration saved with mode 600. No password printed.\n'
