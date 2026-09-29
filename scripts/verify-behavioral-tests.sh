#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="${REPO:-$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)}"
cd "$REPO_ROOT"

# Behavioral layer: real function execution against an in-memory Convex
# backend (convex-test + vitest). Complements the static verify scripts with
# behavior: ingest idempotency, api-key auth, installation linking, usage and
# budget math, scheduler claim semantics, finding-upsert ownership.
npx vitest run --reporter=dot 2>&1 | tail -5
