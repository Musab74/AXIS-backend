#!/bin/bash
# Dev runner that survives pre-existing TS type errors.
# - tsc --watch keeps re-emitting JS into ./dist on file changes (tsc emits even with type errors)
# - node --watch reloads dist/main.js whenever it changes on disk
# Type errors are reported but never block the running server.

set -u

cd "$(dirname "$0")/.."

# Full sync transpile before watch + node. Avoids node booting while tsc is
# mid-emit (which caused intermittent "verifyPublic is not a function" crashes).
echo "[dev-safe] initial full transpile..."
./node_modules/.bin/tsc -p tsconfig.json || true

cleanup() {
  echo "[dev-safe] shutting down..."
  if [ -n "${TSC_PID:-}" ] && kill -0 "$TSC_PID" 2>/dev/null; then
    kill "$TSC_PID" 2>/dev/null || true
  fi
  if [ -n "${NODE_PID:-}" ] && kill -0 "$NODE_PID" 2>/dev/null; then
    kill "$NODE_PID" 2>/dev/null || true
  fi
}
trap cleanup EXIT INT TERM

echo "[dev-safe] starting tsc --watch (errors will not block runtime)"
./node_modules/.bin/tsc -p tsconfig.json --watch --preserveWatchOutput &
TSC_PID=$!

# Let tsc --watch finish its first incremental cycle before Node loads modules.
sleep 2

echo "[dev-safe] starting node --watch dist/main.js"
exec node --watch --watch-path=./dist dist/main.js
