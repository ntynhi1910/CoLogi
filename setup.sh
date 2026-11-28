#!/bin/sh
set -eu
cd "$(dirname "$0")"
command -v docker >/dev/null || { echo 'Docker CLI is required.' >&2; exit 1; }
docker compose version >/dev/null
if [ ! -e .env ]; then
  command -v openssl >/dev/null || { echo 'OpenSSL is required to generate .env.' >&2; exit 1; }
  umask 077
  set -C
  { for key in COLOGI_DB_ADMIN_PASSWORD COLOGI_DB_RUNTIME_PASSWORD COLOGI_DEMO_PASSWORD DJANGO_SECRET_KEY; do
      printf '%s=%s\n' "$key" "$(openssl rand -hex 32)"
    done
    printf '%s\n' 'COLOGI_FRONTEND_PORT=15173'
  } > .env
fi
docker compose up -d --build --wait
echo 'See COLOGI_FRONTEND_PORT in .env and accounts in DEMO_ACCOUNTS.md.'
