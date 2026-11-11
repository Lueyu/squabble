#!/usr/bin/env bash
set -euo pipefail

# Only the disposable hosted archive runner may reclaim this unused SDK.
if [[ "${GITHUB_ACTIONS:-}" != true || "${RUNNER_OS:-}" != Linux ||
      "${BUNDLE_RUNNER_ENVIRONMENT:-}" != github-hosted || "$(uname -s)" != Linux ]]; then
  echo 'BUNDLE_DISK_RUNNER_GUARD: requires a disposable GitHub-hosted Linux runner.' >&2
  exit 78
fi

readonly required_bytes=$((25 * 1024 * 1024 * 1024))
readonly android_root=/usr/local/lib/android
available_bytes() { df -PB1 / | awk 'NR == 2 {print $4}'; }

df -h /
available=$(available_bytes)
printf 'Bundle archive disk: required=%s bytes (25 GiB), available=%s bytes\n' "$required_bytes" "$available"
if (( available < required_bytes )); then
  if [[ -e "$android_root" ]]; then
    canonical=$(realpath -- "$android_root")
    if [[ "$canonical" != "$android_root" || ! -d "$android_root" || -L "$android_root" ]]; then
      echo 'BUNDLE_DISK_PATH_GUARD: unused Android directory is not the exact canonical target.' >&2
      exit 1
    fi
    du -sh -- "$android_root"
    echo 'Removing only the unused Android SDK from this disposable archive runner.'
    sudo rm -rf -- "$android_root"
  fi
  df -h /
  available=$(available_bytes)
fi
if (( available < required_bytes )); then
  printf 'BUNDLE_DISK_INSUFFICIENT: need %s bytes (25 GiB), have %s; no suite gate was skipped.\n' "$required_bytes" "$available" >&2
  exit 1
fi
