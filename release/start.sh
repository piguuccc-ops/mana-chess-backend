#!/bin/sh
# Mana Chess backend indítása (macOS / Linux): ./start.sh
cd "$(dirname "$0")" || exit 1
if ! command -v node >/dev/null 2>&1; then
  echo "Ehhez Node.js kell: https://nodejs.org (LTS verzió)"
  exit 1
fi
exec node backend.mjs "$@"
