/**
 * Provider slug for MCP-backed deployments — these are the deployments
 * that back an installable MCP server (`dosu mcp add <tool>`).
 *
 * Other provider slugs (`dosu_app`, `dosu_knowledge_store`, `github`,
 * `slack`, `teams`, …) exist on the same account but are not valid
 * targets for agent setup — they don't expose an MCP endpoint.
 */
export const MCP_PROVIDER_SLUG = "dosu_mcp";
