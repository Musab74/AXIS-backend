#!/usr/bin/env bash
# Wrapper for PortOne VA payment smoke (writes test registration + payment rows).
set -euo pipefail
cd "$(dirname "$0")/.."
exec npx ts-node scripts/smoke-payment-portone.ts "$@"
