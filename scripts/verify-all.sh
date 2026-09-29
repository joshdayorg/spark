#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="${REPO:-$(cd -- "$SCRIPT_DIR/.." && pwd)}"
SELF_NAME="$(basename -- "${BASH_SOURCE[0]}")"

section() {
  printf '\n=== %s ===\n' "$*"
}

count=0

while IFS= read -r script; do
  script_name="$(basename -- "$script")"
  if [[ "$script_name" == "$SELF_NAME" ]]; then
    continue
  fi

  count=$((count + 1))
  section "$script_name"
  REPO="$REPO_ROOT" bash "$script"
done < <(find "$SCRIPT_DIR" -maxdepth 1 -type f -name '*.sh' -print | sort)

if [[ "$count" -eq 0 ]]; then
  printf 'No other shell verification scripts found in %s.\n' "$SCRIPT_DIR"
  exit 1
fi

printf '\nAll %s verification scripts passed.\n' "$count"
