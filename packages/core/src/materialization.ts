// Bump whenever generated read bytes change for otherwise identical remote content.
export const CURRENT_MATERIALIZATION_VERSION = "references-v7"

const SUBSCRIPTION_ROUTER_MATERIALIZATION_VERSION = `${CURRENT_MATERIALIZATION_VERSION}:multi-member-router-v1`

export function currentMaterializationVersion(recordIdentity: string): string {
  return recordIdentity.startsWith("notion_subscription:")
    ? SUBSCRIPTION_ROUTER_MATERIALIZATION_VERSION
    : CURRENT_MATERIALIZATION_VERSION
}
