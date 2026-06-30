#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
export PORTONE_MODULE_VERSION=v1
exec npx ts-node scripts/smoke-payment-portone-v1.ts "$@"
