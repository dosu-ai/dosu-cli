/**
 * Default `config` payload used when creating a new GitHub deployment via
 * `workspaces.create`. Mirrors
 * `DEFAULT_DEPLOYMENT_CONFIG_GITHUB_TEST` from
 * `frontend/packages/core/src/utils/deployments.ts` in the Dosu main repo.
 *
 * The CLI copies it verbatim so that CLI-created deployments get the same
 * sensible feature defaults (auto-reply on issues, stale-doc check on PRs,
 * etc.) that web-created deployments do. If this ever drifts from the web
 * default, we should fix by publishing a shared config package rather than
 * by keeping two copies — tracked as a V2 cleanup.
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
    auto_label_config: {
      enabled: false,
      multiple_labels_per_group: false,
      include: [] as string[],
      exclude: [] as string[],
      separator: null,
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
    auto_label_config: {
      enabled: false,
      multiple_labels_per_group: false,
      include: [] as string[],
      exclude: [] as string[],
      separator: null,
    },
    lgtm_label: {
      enabled: false,
      name: "lgtm",
      color: "238636",
      description: "This PR has been approved by a maintainer",
    },
    size_label: {
      enabled: false,
      name: "size",
      separator: ":",
    },
    auto_merge_label_config: {
      enabled: false,
      name: "auto-merge",
      color: "FFA500",
      description: "This PR is set to be merged",
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
