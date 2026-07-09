#!/usr/bin/env bash
#
# Runs the official OCI distribution-spec conformance suite against a local
# `wrangler dev`, which exercises the real Worker, the real Durable Objects,
# and Miniflare's R2 and D1 implementations.
#
#   ./scripts/conformance.sh            # all four workflow categories
#   ./scripts/conformance.sh -run Push  # a single ginkgo focus
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SPEC="$ROOT/references/opencontainers-distribution-spec/conformance"
OUT="$ROOT/.conformance"
PORT="${PORT:-8787}"

mkdir -p "$OUT"

# Build the suite once; it is a plain Go test binary.
if [[ ! -x "$OUT/conformance.test" ]]; then
  echo "==> building conformance suite"
  (cd "$SPEC" && go test -c -o "$OUT/conformance.test")
fi

# wrangler spawns workerd as a child that outlives a plain SIGTERM to the parent.
# A survivor keeps the port and answers with the *previous* build against state
# this script is about to delete, which looks exactly like a catastrophic
# regression. Free the port explicitly, both before and after.
free_port() {
  local pids
  pids="$(lsof -ti "tcp:$PORT" 2>/dev/null || true)"
  if [[ -n "$pids" ]]; then
    echo "$pids" | while read -r pid; do kill -9 "$pid" 2>/dev/null || true; done
    sleep 1
  fi
}

echo "==> freeing port $PORT"
free_port

echo "==> resetting local state"
rm -rf "$ROOT/apps/registry/.wrangler/state"

# The Worker binds the dashboard's built assets. wrangler dev refuses to start
# if that directory is missing, so guarantee it exists even on a fresh checkout
# where the UI has not been built (the conformance suite only touches /v2).
mkdir -p "$ROOT/apps/web/dist"

echo "==> applying migrations"
(cd "$ROOT/apps/registry" && npx wrangler d1 migrations apply registry --local >/dev/null)

echo "==> starting wrangler dev on :$PORT"
(cd "$ROOT/apps/registry" && exec npx wrangler dev --port "$PORT" --local >"$OUT/wrangler.log" 2>&1) &
WRANGLER_PID=$!

cleanup() {
  kill "$WRANGLER_PID" 2>/dev/null || true
  wait "$WRANGLER_PID" 2>/dev/null || true
  free_port
}
trap cleanup EXIT

echo -n "==> waiting for the registry"
for _ in $(seq 1 60); do
  if curl -fsS "http://127.0.0.1:$PORT/healthz" >/dev/null 2>&1; then
    echo " up"
    break
  fi
  echo -n "."
  sleep 1
done

if ! curl -fsS "http://127.0.0.1:$PORT/healthz" >/dev/null 2>&1; then
  echo " failed"
  tail -40 "$OUT/wrangler.log"
  exit 1
fi

export OCI_ROOT_URL="http://127.0.0.1:$PORT"
export OCI_NAMESPACE="myorg/myrepo"
export OCI_CROSSMOUNT_NAMESPACE="myorg/other"
export OCI_USERNAME="conformance"
export OCI_PASSWORD="conformance-password"

export OCI_TEST_PULL=1
export OCI_TEST_PUSH=1
export OCI_TEST_CONTENT_DISCOVERY=1
export OCI_TEST_CONTENT_MANAGEMENT=1

# We serve a blob from any repository that holds it, so `mount` needs no `from`.
export OCI_AUTOMATIC_CROSSMOUNT=1
export OCI_HIDE_SKIPPED_WORKFLOWS=0
export OCI_DEBUG="${OCI_DEBUG:-0}"
export OCI_REPORT_DIR="$OUT"

echo "==> running conformance suite"
set +e
(cd "$OUT" && ./conformance.test "$@")
STATUS=$?
set -e

if [[ $STATUS -ne 0 ]]; then
  echo
  echo "==> worker log (last 60 lines)"
  tail -60 "$OUT/wrangler.log"
fi

echo "==> report: $OUT/report.html"
exit $STATUS
