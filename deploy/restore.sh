#!/bin/sh
set -eu
[ "$POSTGRES_DB" = cologi ] && [ "$POSTGRES_USER" = cologi_installer ]
[ ! -e "$PGDATA/.cologi-restored" ]
[ "${#COLOGI_DB_RUNTIME_PASSWORD}" -ge 24 ]
cd /release-db
sha256sum -c cologi.dump.sha256
psql -X -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" <<'SQL'
\getenv runtime_password COLOGI_DB_RUNTIME_PASSWORD
CREATE ROLE cologi_cp08_runtime LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE PASSWORD :'runtime_password';
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
SQL
pg_restore --no-owner --no-privileges --exit-on-error --single-transaction -U "$POSTGRES_USER" -d "$POSTGRES_DB" cologi.dump
psql -X -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" --single-transaction -f runtime_acl.sql
touch "$PGDATA/.cologi-restored"
