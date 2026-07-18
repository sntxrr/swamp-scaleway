# shellcheck shell=bash
# Engine for swamp-scaleway live lifecycle tests.
#
# Per service it drives the real create -> sync -> [update] -> delete ->
# verify-idempotent cycle against the sandbox project, threading the
# create-minted resource id into a manager model (methods target the global-arg
# id, which cannot be overridden per-run). Every model definition and every
# real resource is torn down, even on failure.

set -uo pipefail

RESULTS=()          # "svc\tstep\tPASS|FAIL\tdetail"
CREATED_MODELS=()   # model defs to sweep on exit

_ts() { date +%s 2>/dev/null || echo 0; }

log()  { printf '\033[1;34m[live]\033[0m %s\n' "$*"; }
ok()   { printf '  \033[1;32m✓\033[0m %s\n' "$*"; }
bad()  { printf '  \033[1;31m✗\033[0m %s\n' "$*"; }
info() { printf '  \033[2m· %s\033[0m\n' "$*"; }

record() { RESULTS+=("$1"$'\t'"$2"$'\t'"$3"$'\t'"${4:-}"); }

# swamp model method run <model> <method> [--input k=v ...] ; returns JSON on fd1
_run() {
  local model="$1" method="$2"; shift 2
  swamp model method run "$model" "$method" "$@" --json 2>/dev/null
}

# Extract the new resource id produced by a create run (first resource-kind
# dataProduced entry — reports are kind "report" and excluded).
_new_id() {
  jq -r '[.. | .dataProduced? // empty | .[]? | select(.kind=="resource") | .name] | first // empty' 2>/dev/null
}

# mk_model <name> <type> <profile> <idArg> <idValue>
#   profile: regional | zoned | org | account | objstore
mk_model() {
  local name="$1" type="$2" profile="$3" idArg="$4" idVal="$5"
  local args=(--global-arg "secretKey=$VAULT_SECRET_KEY")
  case "$profile" in
    regional) args+=(--global-arg "projectId=$SW_SANDBOX_PROJECT" --global-arg "region=$SW_REGION" --global-arg "$idArg=$idVal") ;;
    zoned)    args+=(--global-arg "projectId=$SW_SANDBOX_PROJECT" --global-arg "zone=$SW_ZONE"      --global-arg "$idArg=$idVal") ;;
    org)      args+=(--global-arg "organizationId=$VAULT_ORG_ID" --global-arg "$idArg=$idVal") ;;
    account)  args+=(--global-arg "organizationId=$VAULT_ORG_ID" --global-arg "projectId=$idVal") ;;
    objstore) args=(--global-arg "accessKey=$VAULT_ACCESS_KEY" --global-arg "secretKey=$VAULT_SECRET_KEY" --global-arg "region=$SW_REGION" --global-arg "bucket=$idVal") ;;
    *) bad "unknown profile: $profile"; return 1 ;;
  esac
  if swamp model create "$type" "$name" "${args[@]}" --json >/dev/null 2>&1; then
    CREATED_MODELS+=("$name")
    return 0
  fi
  return 1
}

rm_model() { swamp model delete "$1" --force >/dev/null 2>&1 || swamp model delete "$1" >/dev/null 2>&1 || true; }

cleanup_models() {
  [ "${#CREATED_MODELS[@]}" -eq 0 ] && return 0
  log "sweeping ${#CREATED_MODELS[@]} test model definitions…"
  local m
  for m in "${CREATED_MODELS[@]}"; do rm_model "$m"; done
  CREATED_MODELS=()
}

# lifecycle <svc> <type> <profile> <idArg> <createInputs> <updateInputs>
#   createInputs / updateInputs: space-separated "k=v" (or "" to skip update).
#   Special: profile=objstore => create/delete take no inputs, id==bucket name.
lifecycle() {
  local svc="$1" type="$2" profile="$3" idArg="$4" createInputs="$5" updateInputs="$6"
  local mC="${SW_PREFIX}-${svc}-c" mM="${SW_PREFIX}-${svc}-m"
  log "$svc  ($type, $profile)"

  # ---- CREATE -------------------------------------------------------------
  local newId="" out
  if [ "$profile" = "objstore" ]; then
    # bucket name IS the resource id; the model must be keyed to it up front.
    newId="${SW_PREFIX}-obj-${RANDOM}${RANDOM}"   # S3 bucket names are globally unique
    if ! mk_model "$mM" "$type" objstore bucket "$newId"; then bad "model create failed"; record "$svc" create FAIL "mk_model"; return 1; fi
    if out=$(_run "$mM" create); then ok "create bucket=$newId"; record "$svc" create PASS "$newId"; else bad "create"; record "$svc" create FAIL ""; return 1; fi
  else
    if ! mk_model "$mC" "$type" "$profile" "$idArg" "$SW_PLACEHOLDER_ID"; then bad "factory model create failed"; record "$svc" create FAIL "mk_model"; return 1; fi
    # shellcheck disable=SC2086
    if out=$(_run "$mC" create ${createInputs:+$(printf ' --input %s' $createInputs)}); then
      newId=$(printf '%s' "$out" | _new_id)
      if [ -z "$newId" ]; then bad "create ran but no resource id captured"; record "$svc" create FAIL "no-id"; return 1; fi
      ok "create -> $newId"; record "$svc" create PASS "$newId"
    else
      bad "create"; record "$svc" create FAIL ""; return 1
    fi
    # re-key a manager model to the created id for the mutating verbs
    if ! mk_model "$mM" "$type" "$profile" "$idArg" "$newId"; then bad "manager model create failed"; record "$svc" manage FAIL "mk_model"; return 1; fi
  fi

  # ---- SYNC ---------------------------------------------------------------
  if _run "$mM" sync >/dev/null; then ok "sync"; record "$svc" sync PASS ""; else bad "sync"; record "$svc" sync FAIL ""; fi

  # ---- UPDATE (optional) --------------------------------------------------
  if [ -n "$updateInputs" ]; then
    # shellcheck disable=SC2086
    if _run "$mM" update $(printf ' --input %s' $updateInputs) >/dev/null; then ok "update"; record "$svc" update PASS ""; else bad "update"; record "$svc" update FAIL ""; fi
  else
    info "update: n/a (no update method)"; record "$svc" update SKIP "no-method"
  fi

  # ---- DELETE -------------------------------------------------------------
  if _run "$mM" delete >/dev/null; then ok "delete"; record "$svc" delete PASS ""; else bad "delete"; record "$svc" delete FAIL ""; fi

  # ---- DELETE idempotency (404-tolerant per §3) ---------------------------
  if _run "$mM" delete >/dev/null; then ok "delete idempotent (already gone)"; record "$svc" idempotent PASS ""; else bad "second delete errored (not 404-tolerant)"; record "$svc" idempotent FAIL ""; fi
}

print_summary() {
  echo
  log "==================== SUMMARY ===================="
  local pass=0 fail=0 skip=0 r svc step st detail
  printf '  %-20s %-12s %-6s %s\n' SERVICE STEP RESULT DETAIL
  printf '  %-20s %-12s %-6s %s\n' "-------" "----" "------" "------"
  for r in "${RESULTS[@]}"; do
    IFS=$'\t' read -r svc step st detail <<<"$r"
    case "$st" in PASS) pass=$((pass+1));; FAIL) fail=$((fail+1));; SKIP) skip=$((skip+1));; esac
    printf '  %-20s %-12s %-6s %s\n' "$svc" "$step" "$st" "$detail"
  done
  echo
  printf '  \033[1mTotals:\033[0m %d passed, %d failed, %d skipped\n' "$pass" "$fail" "$skip"
  [ "$fail" -eq 0 ]
}
