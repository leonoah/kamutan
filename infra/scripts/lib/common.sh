# shellcheck shell=bash
# Shared helpers for infra/scripts/*.sh (sourced, not executed).
#  - run CMD...   : prints the command (shell-quoted) and executes it, unless DRY_RUN=1 (print only).
#  - capture VAR PLACEHOLDER CMD... : like run, stores stdout in VAR; in dry-run stores PLACEHOLDER.
#  - try CMD...   : like run, but a failure only warns (idempotent "create" commands).
#  - log / warn / die, now_epoch, iso_now.
# Scripts never print secrets: they only call gcloud with ADC / the logged-in user (SEC-49, SEC-53).

DRY_RUN=${DRY_RUN:-0}

log() { printf '%s %s\n' "$(date -u +%H:%M:%SZ)" "$*" >&2; }
warn() { printf '%s WARN %s\n' "$(date -u +%H:%M:%SZ)" "$*" >&2; }
die() {
  printf 'ERROR: %s\n' "$*" >&2
  exit 1
}

quote_cmd() {
  local out="" a
  for a in "$@"; do out+="$(printf '%q' "$a") "; done
  printf '%s' "${out% }"
}

run() {
  printf '+ %s\n' "$(quote_cmd "$@")"
  if [ "$DRY_RUN" = 1 ]; then return 0; fi
  "$@"
}

try() {
  printf '+ %s\n' "$(quote_cmd "$@")"
  if [ "$DRY_RUN" = 1 ]; then return 0; fi
  "$@" || warn "command failed (continuing; it is probably already configured): $1 $2 $3"
}

# capture VAR PLACEHOLDER CMD...
capture() {
  local __var=$1 __placeholder=$2
  shift 2
  printf '+ %s\n' "$(quote_cmd "$@")" >&2
  if [ "$DRY_RUN" = 1 ]; then
    printf -v "$__var" '%s' "$__placeholder"
    return 0
  fi
  local __out
  __out=$("$@")
  printf -v "$__var" '%s' "$__out"
}

now_epoch() { date -u +%s; }
iso_now() { date -u +%Y-%m-%dT%H:%M:%SZ; }

require_tools() {
  local t
  for t in "$@"; do
    if [ "$DRY_RUN" = 1 ]; then continue; fi
    command -v "$t" >/dev/null 2>&1 || die "missing tool: $t"
  done
}
