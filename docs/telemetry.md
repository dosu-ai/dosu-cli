# Dosu CLI telemetry and diagnostics

This document is the data contract for Dosu CLI telemetry. It describes what the CLI currently
does, what it must never do, and the operational work required before a production launch.

## Summary

Dosu sends two kinds of telemetry:

1. **Usage analytics** measure whether coarse, named CLI workflows succeed. Signed-in commands use
   the same stable Dosu user ID as the web app; signed-out commands use a random installation ID.
2. **Error diagnostics** send a minimal error fingerprint, Dosu-owned stack frames, and, when the
   local session has a verified identity, only the user's ID and email.

Telemetry is **on by default** and has one persisted global enable/disable switch. Interactive setup
and non-interactive paths do not show a telemetry prompt. `DO_NOT_TRACK` and
`DOSU_TELEMETRY_DISABLED` disable all telemetry before an installation ID, payload, or network
request is created. An unreadable, malformed, or unsupported settings file also disables telemetry
for that run without overwriting the file.

Telemetry is not required for any Dosu command. Delivery failure never changes command output,
exit status, or behavior.

## User controls

These commands do not require login:

```text
dosu telemetry status
dosu telemetry status --json
dosu telemetry enable
dosu telemetry disable
dosu telemetry reset
```

`reset` rotates the random installation ID used while signed out; it does **not** change signed-in
account identity or delete events already retained by PostHog or Sentry.

Environment controls:

| Variable | Behavior |
| --- | --- |
| `DO_NOT_TRACK=1` | Disable all telemetry for this process. |
| `DOSU_TELEMETRY_DISABLED=1` | Disable all telemetry for this process. |
| `DOSU_TELEMETRY_DEBUG=1` | Print the exact safe outbound payload to stderr and send nothing. |
| `DOSU_POSTHOG_PROJECT_TOKEN` | Build-time public PostHog ingestion default. |
| `DOSU_CLI_SENTRY_DSN` | Build-time public Sentry ingestion default. |
| `DOSU_POSTHOG_PROJECT_TOKEN_OVERRIDE` | Override the build-time PostHog project token. |
| `DOSU_CLI_SENTRY_DSN_OVERRIDE` | Override the build-time Sentry DSN. |

For the two disable variables, blank values and `0`, `false`, `no`, or `off` do not disable
telemetry. Any other non-empty value does. A persisted enable never overrides an environment
disable.

`DOSU_POSTHOG_PROJECT_TOKEN` and `DOSU_CLI_SENTRY_DSN` are build-time defaults injected into release
artifacts. They and their runtime overrides must contain only public client-side ingestion
credentials: a PostHog `phc_` project token and a public HTTPS Sentry client DSN. Known management
credential formats are rejected at runtime, and release builds fail instead of baking invalid
non-empty values. Never put a PostHog personal API key, Sentry auth token, or other management secret
in the CLI.

## Data sent by command telemetry

The CLI constructs typed payloads from allowlisted values. It never serializes a command object,
an `Error`, `argv`, configuration, or a log record and then attempts to redact it.

### Usage analytics: PostHog

At most one `cli_command_completed` event is sent for an instrumented command invocation. Its
top-level fields are exactly:

| Field | Value |
| --- | --- |
| `api_key` | Public PostHog project token. |
| `distinct_id` | A validated Dosu user UUID when signed in; otherwise the random installation-scoped UUID from `telemetry.json`. Never a machine or repository identifier. |
| `event` | Always `cli_command_completed`. |
| `properties` | The closed property set below. |

The `properties` allowlist is:

| Property | Rule |
| --- | --- |
| `$geoip_disable` | Always `true`. |
| `$process_person_profile` | Omitted for a verified signed-in user so the event joins the existing web person; otherwise `false` so signed-out command events do not create profiles. |
| `schema_version` | Always `1`. |
| `command` | Canonical command/subcommand name only, up to four safe tokens; otherwise `unknown`. Never the raw command line. |
| `result` | `success`, `validation_error`, or `failure`. |
| `duration_bucket` | One of `<100ms`, `100-499ms`, `500ms-1.9s`, `2-9.9s`, `10-59s`, or `60s+`. |
| `cli_version` | Published CLI version, reduced to a bounded safe string. |
| `install_channel` | Bounded install channel: currently `npm`, `binary`, or `homebrew`. |
| `platform` | Coarse runtime platform, for example `darwin`. |
| `arch` | Coarse runtime architecture, for example `arm64`. |
| `runtime` | `node`, `bun`, or a bounded safe fallback. |
| `runtime_major` | Major runtime version, clamped to `0..9999`. |
| `is_ci` | Boolean. |
| `is_tty` | Boolean for stdout. |
| `mode` | `cloud` or `oss`. |
| `is_authenticated` | Boolean only; it does not duplicate the top-level identity. |
| `exit_code` | Integer clamped to `0..255`. |
| `error_code` | Optional validated, stable, low-cardinality code; never a message. |

Signed-in command events join the existing PostHog person identified by the web app with the same
Dosu user UUID. The CLI does not send email to PostHog on this path and does not alias prior
installation history, avoiding cross-account linkage on shared machines. Signed-out `distinct_id`
is pseudonymous rather than anonymous: it links command events from one installation until the
user rotates it.

### Error diagnostics: Sentry

An error event is sent only when telemetry is enabled and an instrumented command throws or finishes
with a non-validation, nonzero exit code. A nonzero completion becomes a message-free
`CommandExitError`. The CLI builds a Sentry envelope directly; it does not initialize the Sentry SDK
or its automatic integrations.

The envelope header contains exactly `dsn`, `event_id`, and `sent_at`. The item header is exactly
`{"type":"event"}`. The event contains exactly:

| Field | Value |
| --- | --- |
| `event_id` | Random UUID without dashes for this error event. |
| `timestamp` | Event time. |
| `platform` | Always `node`. |
| `level` | Always `error`. |
| `release` | `dosu-cli@<cli_version>`. |
| `tags` | The closed tag set below. |
| `user` | Optional validated `{id, email?}` for the current authenticated Dosu user. |
| `fingerprint` | `dosu-cli`, canonical command, safe error type, stable error code or `unknown`, and newest allowlisted Dosu callsite or `unknown`. |
| `exception` | One value containing only safe type/code and optional Dosu-owned frames. |
| `debug_meta` | Optional npm-bundle source-map debug ID; omitted unless the event has a mapped `bin/dosu.js` frame. |

The exact tag allowlist is `schema_version`, `command`, `cli_version`, `install_channel`, `os`,
`arch`, `runtime`, `runtime_major`, `is_ci`, `is_tty`, `mode`, and `is_authenticated`, plus optional
`error_code`, `http_status`, and `exit_code`. Values are bounded and validated. `error_code` and
error types come from closed known-value allowlists, and `http_status` is an integer from 100
through 599.

The exception value contains only:

- `type`: a known allowlisted error-class name, otherwise `Error`;
- `value`: the stable error code, otherwise the safe error type; and
- optional `stacktrace.frames`: at most 20 frames with only `filename`, `lineno`, `colno`,
  `in_app: true`, and the fixed `app:///bin/dosu.js` `abs_path` for mapped npm-bundle frames.

Frame filenames must be package-relative Dosu CLI paths under `src/` or `bin/dosu.js`. Absolute
prefixes, function names, dependency frames, source context, and local variables are discarded.
Frames are sent oldest-to-newest as required by Sentry. Release builds upload the npm bundle's
external map with the same debug ID before publishing; the map and CI-only Sentry auth token are not
included in the npm package. The random PostHog installation ID is not included in Sentry events.
Authenticated events contain only the validated account ID and optional email; invalid, mismatched,
or signed-out identity is omitted.

### Setup/onboarding analytics

Setup analytics use the same global switch but are a separate, existing path through the typed Dosu
`/api/cli-trpc` endpoint. Pre-auth setup events carry a random per-run `onboarding_run_id`.
They use a validated Dosu web-app URL rather than sending the PostHog token to that endpoint, but a
valid configured `phc_` token is also required as the shared analytics release kill switch. `dosu
telemetry status` reports command and setup destinations separately. Both paths remain inert unless
the shared gate and respective destination are configured. Production URLs must use
HTTPS. An explicit `DOSU_DEV=true` permits HTTP only for `localhost`, `127.0.0.1`, or `::1`
development origins.
When authentication completes, the server aliases that run ID to the signed-in user ID, identifies
the PostHog person with user ID and email, and captures subsequent events under the user ID.
Authenticated events may also include `org_id`, `deployment_id`, and `space_id`.

Current common setup properties are `cli_version`, `install_channel`, `platform`, `arch`, and `mode`.
Current callers also use only these workflow properties: `onboarding_run_id`,
`has_deployment_option`, `mode_option`, `flow_kind`, `reason`, `provider_count`, `providers`,
`completed_mcp`, `completed_skill`, and `completed_agents_md`. Setup events use stable names in the
`cli_onboarding_*` family. They do not include raw authentication errors. This path uses a dedicated
no-refresh client, runs without blocking setup, refuses redirects, and aborts its request after
500ms. The public API input remains a generic property record for generated-client compatibility,
so the CLI applies the strict allowlist and drops unknown or invalid fields before transport. The
server does not repeat that filtering.

These procedures use the server's standard tRPC observability. Sampled server spans or errors can
therefore include setup RPC input and the normal authenticated server user context. This is an
accepted residual risk of keeping setup telemetry client-filtered rather than maintaining a
separate server-side privacy boundary.

## Data excluded from CLI-built telemetry fields

The payloads constructed by the CLI never include:

- prompts, questions, search text, documents, source code, file contents, or model output;
- raw command lines, free-form arguments or option values, stdin, stdout, or stderr (only the
  documented coarse setup fields listed above are allowed);
- user or project file names and paths, working directory, home directory, repository name,
  remote, branch, diff, or directory listing;
- arbitrary environment-variable names or values (the explicitly configured public PostHog token
  and Sentry DSN are transport metadata, not event properties);
- configuration contents other than the validated session user ID/email and setup identifiers
  listed above, cookies, vendor management keys, or command/API request and response bodies.
  Telemetry event fields never contain Dosu credentials; authenticated setup requests necessarily
  carry the existing Dosu session token as a transport header to the Dosu API, where it is used for
  authorization and is not forwarded to PostHog or Sentry;
- raw error messages, raw stack lines, function names, local variables, source context,
  breadcrumbs, attachments, arbitrary `extra` data, or exception causes;
- person name, username, hostname, MAC address, hardware serial, or a hash derived from any of them;
  signed-in command analytics uses only the validated user ID, and signed-in error diagnostics use
  only that ID and optional email; or
- the contents of `debug.log` or another local log file.

Authenticated setup still uses a session-token transport header, and the Dosu server enriches
successful setup analytics with the documented account identity. The exclusions above describe
fields constructed by the official CLI; standard server observability can also retain setup RPC
input and its normal authenticated user context.

The analytics payload itself does not contain an IP address. As with any HTTPS request, the network
destination can observe connection metadata; production launch must verify the Vercel proxy and
vendor settings actually discard IP/GeoIP data before making a stronger privacy promise.

## Local files are a separate boundary

Both files live under the Dosu config directory (`~/.config/dosu-cli/` by default, the XDG config
directory when configured, or the isolated development directory when `DOSU_DEV=true`).

### `telemetry.json`

This owner-only file stores only:

```json
{
  "schema_version": 1,
  "disabled": true,
  "install_id": "optional-random-uuid"
}
```

`disabled` is present only after `dosu telemetry disable`; the ID is optional. Writes use an
owner-only temporary file and atomic rename; new directories are mode `0700` and files mode `0600`.
The file contains no Dosu token, account profile, command history, or diagnostic event queue. There
is no offline telemetry spool.

### `debug.log`

`debug.log` is the existing local diagnostic log, not a telemetry source. It is created with
owner-only permissions and is truncated on logger initialization after it grows beyond 1 MiB,
keeping roughly the newest 512 KiB. `dosu logs` lets the user locate, inspect, or delete it.

The logger redacts common credential shapes, but local log text can still contain detailed errors,
URLs, IDs, and paths. Treat it as potentially sensitive. It is never attached to PostHog or Sentry
and is never uploaded automatically. `--debug` mirrors local log entries to stderr; it is distinct
from `DOSU_TELEMETRY_DEBUG=1`, which prints safe telemetry payloads and disables sending.

## Destinations and failure behavior

```text
command analytics
  -> HTTPS https://<Dosu web app>/ph-api/i/v0/e/
  -> Vercel same-origin PostHog ingestion proxy
  -> PostHog

error diagnostics
  -> HTTPS Sentry envelope endpoint derived from the public DSN
  -> Sentry

setup/onboarding analytics
  -> HTTPS https://<Dosu web app>/api/cli-trpc
  -> authenticated or pre-auth Dosu API procedure
  -> PostHog
  -> standard server observability can include setup RPC input and authenticated user context
```

Command telemetry has these delivery guarantees:

- HTTPS destinations only, with redirects refused to prevent protocol downgrade;
- one attempt per destination, with a hard 500ms deadline;
- analytics and error requests run in parallel when both apply;
- no retry, disk queue, background daemon, or replay on the next invocation;
- missing/invalid destination configuration is a no-op;
- timeout, offline state, non-2xx response, serialization error, and provider error are swallowed;
- telemetry writes nothing to stdout; and
- debug mode writes the exact safe payload to stderr and makes no request.

The PostHog project token and Sentry DSN are public ingestion credentials, not authorization for
querying, deleting, or administering data. Management credentials, when operationally required,
remain in controlled Dosu/vendor infrastructure or CI and are never placed in these variables.

## Coverage and current limitations

- `install_channel` measures active CLI executions from `npm`, `homebrew`, or `binary` builds; it is
  not a download counter. Exact downloads remain in npm, Homebrew, and GitHub Release analytics.
- `dosu telemetry ...` controls are themselves excluded, so changing or inspecting the switch does
  not emit an analytics event or create an installation ID.
- Commander lifecycle telemetry can observe commands that return normally or set
  `process.exitCode`. Several legacy command modules still call `process.exit(...)` directly; those
  paths terminate before the completion/error flush and can be missing from analytics and Sentry.
  Do not interpret event absence as command success. Migrate those paths deliberately rather than
  monkey-patching `process.exit`.
- Commander can reject a malformed option or missing required argument before the command
  `preAction` hook. Those parser-level failures are currently not emitted; their raw token is never
  captured as a fallback.
- Unknown or unsafe command names become `unknown`; they are never preserved as raw input.
- Compiled binary/homebrew error events can be frame-less because the executable has no verifiable
  package-relative source files. The npm bundle can include allowlisted `bin/dosu.js` frames. Safe
  omission is preferred to guessing a path or symbolicating user-owned code.
- There is no automatic raw-log upload, diagnostic bundle, performance tracing, session replay,
  autocapture, or repository identity. Signed-in commands use the existing web user ID, but the CLI
  deliberately never aliases prior installation history to an account.

## Maintainer contract

Any new event, tag, property, identifier, stack-frame category, or setup property is a privacy
schema change. Its review must state the product/support question it answers, cardinality,
retention, access, and deletion impact. Update this document and the exact-key/forbidden-sentinel
tests in the same change. Do not add a generic property bag to command telemetry or enable vendor
SDK defaults as policy.

## Production launch checklist

This implementation is not proof that the production data pipeline or privacy program is ready.
Complete and record each item before enabling release destinations:

- **Release credentials:** the public GitHub Actions repository variables
  `DOSU_POSTHOG_PROJECT_TOKEN` and `DOSU_CLI_SENTRY_DSN` are passed to release builds. The separate
  `DOSU_CLI_SENTRY_AUTH_TOKEN` Actions secret is used only to upload source maps and is never baked
  into an artifact. Do not put a PostHog personal API key or Sentry auth token in a public variable.
- **Notice and legal review:** publish a user-facing privacy notice naming PostHog and Sentry,
  purposes, exact fields, pseudonymous installation ID, signed-in account linkage, controls,
  connection metadata, retention, deletion route, and contact. Confirm the default-on notice and
  processor agreements with counsel.
- **Retention:** configure and verify actual vendor retention, then put those exact values in the
  notice. A conservative starting cap is 90 days for raw analytics and 30 days for error events;
  these are recommendations, not current vendor guarantees.
- **Deletion:** run a tested deletion drill. Signed-in PostHog/Sentry events can be found by user ID
  (and Sentry by email); signed-out PostHog events use the installation `distinct_id`. Signed-out
  Sentry errors intentionally have no install identifier. Document that ID rotation stops future
  signed-out linkage but does not delete prior data.
- **Access controls:** use separate development/staging/production projects, least-privilege RBAC,
  MFA/SSO where available, audited administrative access, and a small named support/engineering
  access group. Keep management tokens out of source, binaries, and developer-visible logs.
- **PostHog proxy:** verify the Vercel rewrite, origin/host, rate limits, abuse controls, personless
  signed-out events, signed-in user association, and actual IP/GeoIP discard behavior in production.
- **Sentry projects:** disable attachments, automatic request data, local variables, and unrelated
  performance/session features. Verify project-side scrubbing as a second line of defense. Setup
  telemetry currently trusts the official CLI allowlist; modified clients or future regressions can
  send additional fields into the server's normal PostHog/Sentry path. Revisit this accepted risk if
  the privacy or compliance requirements change.
- **Source maps:** the release pipeline builds and uploads a debug-ID-matched external npm source map
  before publishing, then publishes the exact bundle without the map. Inspect a real processed event
  before release. Define and test a separate native-symbolication strategy before promising frames
  for binary/homebrew builds. `sourcesContent` contains this public open-source repository and its
  bundled dependencies; the CI auth token is never baked into the CLI.
- **End-to-end evidence:** in isolated vendor projects, inspect real received payloads for enabled,
  disabled, `DO_NOT_TRACK`, debug, timeout, malformed-error, and JSON/NDJSON cases.
  Confirm stdout and exit codes are unchanged and that disabled runs create neither IDs nor network
  traffic.
- **Operations:** document vendor outage behavior, public-key abuse response, a provider-side kill
  switch, access review cadence, deletion ownership, and a periodic field/retention review.

## References

- [PostHog: capture API contract](https://posthog.com/docs/api/capture)
- [PostHog: privacy and data collection](https://posthog.com/docs/privacy/data-collection)
- [PostHog: data storage, retention, and deletion](https://posthog.com/docs/privacy/data-storage)
- [Sentry: envelope protocol](https://develop.sentry.dev/sdk/data-model/envelopes/)
- [Sentry Node: scrubbing sensitive data](https://docs.sentry.io/platforms/javascript/guides/node/data-management/sensitive-data/)
- [Sentry: hosted data retention periods](https://docs.sentry.io/security-legal-pii/security/data-retention-periods/)
- [OWASP Logging Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Logging_Cheat_Sheet.html)
- [OpenTelemetry: handling sensitive data](https://opentelemetry.io/docs/security/handling-sensitive-data/)
- [OpenTelemetry semantic conventions for CLI spans](https://opentelemetry.io/docs/specs/semconv/cli/cli-spans/)
