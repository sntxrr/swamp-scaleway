#!/usr/bin/env bash
# Live lifecycle tests for the swamp-scaleway extension suite.
#
# Usage:  tests/live/run.sh [tier]        tier = A (default) | A-org | B | C | ...
#
# Runs the real create -> sync -> [update] -> delete -> verify-idempotent cycle
# against the sandbox project defined in config.sh, with guaranteed teardown.
#
#   Tier A — free / trivial cost (~$0): safe to run anytime. Sandbox-scoped key.
#   Tier A-org — iam + account: free, but needs the organization credential
#                (SW_ORG_VAULT / SW_ORG_ITEM). Run deliberately.
#   Tier B+ — billable; run deliberately (see README.md).

set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$HERE/../.." || exit 1
# shellcheck source=config.sh
source "$HERE/config.sh"
# shellcheck source=lib.sh
source "$HERE/lib.sh"

TIER="${1:-A}"
trap 'cleanup_models' EXIT

tier_A() {
  log "TIER A — free / trivial-cost services (create→sync→[update]→delete→idempotent)"
  lifecycle vpc            @sntxrr/scaleway-vpc            regional vpcId         "name=${SW_PREFIX}-vpc-$RANDOM"                 "name=${SW_PREFIX}-vpc-upd"
  lifecycle registry       @sntxrr/scaleway-registry       regional namespaceId   "name=${SW_PREFIX}-reg-$RANDOM"                 "description=updated-by-live-test"
  lifecycle secret-manager @sntxrr/scaleway-secret-manager regional secretId      "name=${SW_PREFIX}-secret-$RANDOM"              "description=updated-by-live-test"
  lifecycle key-manager    @sntxrr/scaleway-key-manager    regional keyId         "name=${SW_PREFIX}-key-$RANDOM unprotected=true" ""
  lifecycle messaging      @sntxrr/scaleway-messaging       regional natsAccountId "name=${SW_PREFIX}-nats-$RANDOM"                "name=${SW_PREFIX}-nats-upd"
  lifecycle cockpit        @sntxrr/scaleway-cockpit         regional dataSourceId  "name=${SW_PREFIX}-ds-$RANDOM type=metrics"    ""
  lifecycle object-storage @sntxrr/scaleway-object-storage  objstore bucket        ""                                             ""
}

tier_A_org() {
  log "TIER A-org — organization-scoped services, with the organization credential ($SW_ORG_VAULT)"
  vault_refs "$SW_ORG_VAULT" "$SW_ORG_ITEM"
  lifecycle iam            @sntxrr/scaleway-iam             org      applicationId "name=${SW_PREFIX}-app-$RANDOM"                 "description=updated-by-live-test"
  lifecycle account        @sntxrr/scaleway-account         account  projectId     "name=${SW_PREFIX}-proj-$RANDOM"                "description=updated-by-live-test"
}

case "$TIER" in
  A|a) tier_A ;;
  A-org|a-org) tier_A_org ;;
  *) echo "Tier '$TIER' not yet implemented in run.sh"; exit 2 ;;
esac

print_summary
