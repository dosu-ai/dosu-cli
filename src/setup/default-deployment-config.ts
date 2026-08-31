/**
 * Default `config` payload used when creating a new GitHub deployment via
 * `workspaces.create`. Mirrors
 * `DEFAULT_DEPLOYMENT_CONFIG_GITHUB_TEST` from
 * `frontend/packages/core/src/utils/deployments.ts` in the Dosu main repo.
 *
 * The CLI copies it verbatim so CLI-created deployments use the same supported
 * feature defaults as web-created deployments. The hosted schema rejects
 * unknown fields, so keep this copy synchronized with the web default.
 */
export const DEFAULT_DEPLOYMENT_CONFIG_GITHUB: Readonly<Record<string, unknown>> = {
  default_maintainer: "",
  issues: {
    enabled: true,
    agent_objectives: {
      deduplicate_request: false,
      surface_documentation: true,
      surface_conversations: true,
      surface_tickets: true,
      surface_code: true,
      suggest_changes_and_workarounds: false,
    },
    auto_reply: {
      enabled: true,
      review_required: true,
    },
    voting: {
      enabled: false,
    },
    quality_checklist: null,
  },
  pull_requests: {
    enabled: true,
    auto_reply: {
      enabled: false,
      review_required: true,
    },
    agent_objectives: {
      deduplicate_request: true,
      surface_documentation: true,
      surface_conversations: true,
      surface_tickets: true,
      surface_code: true,
      suggest_changes_and_workarounds: true,
    },
    diff_review_policies: [] as unknown[],
  },
  discussions: {
    enabled: true,
    agent_objectives: {
      deduplicate_request: false,
      surface_documentation: true,
      surface_conversations: true,
      surface_tickets: true,
      surface_code: true,
      suggest_changes_and_workarounds: false,
    },
    auto_reply: {
      enabled: true,
      review_required: true,
    },
    included_categories: ["Q&A", "Questions"],
    quality_checklist: null,
  },
  changelogs: {
    visibility: false,
    enabled: false,
  },
};
