# shellcheck shell=bash
# Live-test configuration for the swamp-scaleway extension suite.
#
# Credentials are read live from 1Password through swamp vaults (backend
# @swamp/1password). Nothing secret is stored here — only vault *references*.
#
# Two credentials, on purpose:
#   SW_VAULT / SW_ITEM          Tier A: an application key whose IAM policy is
#                               scoped to the sandbox project only.
#   SW_ORG_VAULT / SW_ORG_ITEM  Tier A-org (iam, account): these lifecycles create
#                               IAM applications and projects, which needs
#                               organization rights. Organization-scope IAM
#                               policy management is owner-equivalent, so it is
#                               kept off the routine key and run deliberately.
#
# Operator-specific names go in tests/live/config.local.sh (gitignored), which
# is sourced first if present.
_here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=/dev/null
[ -f "$_here/config.local.sh" ] && source "$_here/config.local.sh"
unset _here

# --- Sandbox scope -----------------------------------------------------------
# Dedicated throwaway project. ALL project-scoped live tests target it, and the
# Tier A key's policy grants nothing outside it, so a misdirected test is denied
# rather than run against a real project.
: "${SW_SANDBOX_PROJECT:=9e251da2-2b78-4708-9a58-8321320c6def}"
: "${SW_REGION:=fr-par}"
: "${SW_ZONE:=fr-par-1}"

# Placeholder id for factory (create-only) models — real ids are threaded in
# after create. A well-formed UUID keeps schema/pre-flight checks happy.
: "${SW_PLACEHOLDER_ID:=00000000-0000-0000-0000-000000000000}"

# Prefix for all test model definitions + created resources, so they're easy to
# spot and sweep. Keep it short + dns-safe (some resources reject long names).
: "${SW_PREFIX:=lt}"

# --- Vault references (NOT secrets) ------------------------------------------
: "${SW_VAULT:=scaleway}"
: "${SW_ITEM:=Scaleway-swamp}"
: "${SW_ORG_VAULT:=scaleway-org}"
: "${SW_ORG_ITEM:=Scaleway-org}"

# vault_refs <swamp-vault> <item>: point VAULT_* at that credential.
# Builds the CEL vault.get(...) expressions. The key contains a '/', so it must
# be quoted inside the expression; assemble with an explicit single-quote char.
# There is deliberately no project-id reference: the project always comes from
# SW_SANDBOX_PROJECT, never from a vault item.
vault_refs() {
  local v="$1" i="$2" q=$'\x27'
  VAULT_SECRET_KEY="\${{ vault.get(${q}${v}${q}, ${q}${i}/scw_secret_key${q}) }}"
  VAULT_ORG_ID="\${{ vault.get(${q}${v}${q}, ${q}${i}/scw_organization_id${q}) }}"
  VAULT_ACCESS_KEY="\${{ vault.get(${q}${v}${q}, ${q}${i}/scw_access_key${q}) }}"
  export VAULT_SECRET_KEY VAULT_ORG_ID VAULT_ACCESS_KEY
}
vault_refs "$SW_VAULT" "$SW_ITEM"

export SW_SANDBOX_PROJECT SW_REGION SW_ZONE SW_PLACEHOLDER_ID SW_PREFIX
export SW_VAULT SW_ITEM SW_ORG_VAULT SW_ORG_ITEM
