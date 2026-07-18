# shellcheck shell=bash
# Live-test configuration for the swamp-scaleway extension suite.
#
# Credentials are read live from 1Password via the `scaleway` swamp vault
# (backend @swamp/1password, item "Scaleway-swamp" in the Private vault).
# Nothing secret is stored here — only vault *references*.

# --- Sandbox scope -----------------------------------------------------------
# Dedicated throwaway project (created via `sw-account create`). ALL live tests
# target this project so nothing touches the real `akbar` homelab project.
: "${SW_SANDBOX_PROJECT:=1e122db9-0f70-48ca-9048-6d5dc86dd0de}"
: "${SW_REGION:=fr-par}"
: "${SW_ZONE:=fr-par-1}"

# Placeholder id for factory (create-only) models — real ids are threaded in
# after create. A well-formed UUID keeps schema/pre-flight checks happy.
: "${SW_PLACEHOLDER_ID:=00000000-0000-0000-0000-000000000000}"

# Prefix for all test model definitions + created resources, so they're easy to
# spot and sweep. Keep it short + dns-safe (some resources reject long names).
: "${SW_PREFIX:=lt}"

# --- Vault references (NOT secrets) ------------------------------------------
# Build the CEL vault.get(...) expressions. The key contains a '/', so it must
# be quoted inside the expression; assemble with an explicit single-quote char.
_q="'"
VAULT_SECRET_KEY="\${{ vault.get(${_q}scaleway${_q}, ${_q}Scaleway-swamp/scw_secret_key${_q}) }}"
VAULT_ORG_ID="\${{ vault.get(${_q}scaleway${_q}, ${_q}Scaleway-swamp/scw_organization_id${_q}) }}"
VAULT_PROJECT_ID="\${{ vault.get(${_q}scaleway${_q}, ${_q}Scaleway-swamp/scw_project_id${_q}) }}"
VAULT_ACCESS_KEY="\${{ vault.get(${_q}scaleway${_q}, ${_q}Scaleway-swamp/scw_access_key${_q}) }}"
unset _q

export SW_SANDBOX_PROJECT SW_REGION SW_ZONE SW_PLACEHOLDER_ID SW_PREFIX
export VAULT_SECRET_KEY VAULT_ORG_ID VAULT_PROJECT_ID VAULT_ACCESS_KEY
