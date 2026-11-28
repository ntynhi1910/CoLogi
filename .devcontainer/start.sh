#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
if [ "${CODESPACES:-false}" = true ]; then
    export COMPOSE_FILE=docker-compose.yml:.devcontainer/compose.codespaces.yml
fi
exec sh ./setup.sh
