## Problem

Adding a connector to Executor today requires the user to manually open the app, click "Connect", paste a URL, and pick a plugin. Third-party platforms (Supabase, PostHog, Vercel, …) cannot offer the kind of one-click "Add to …" flow they already ship for Claude Code, Cursor, and similar:

- Claude Code: `claude mcp add --scope project --transport http supabase "https://mcp.supabase.com/mcp?project_ref=..."`
- Cursor / PostHog: copy-paste JSON snippet, or `npx @posthog/wizard mcp add`

The foundation is partly in place but the last-mile pieces are missing:

- **Route exists** — `packages/app/src/routes/sources.add.$pluginKey.tsx` resolves `/sources/add/{pluginKey}?url=...&preset=...` and forwards to `SourcesAddPage` (`packages/react/src/pages/sources-add.tsx:9-65`), which feeds `initialUrl` / `initialPreset` / `initialNamespace` into the plugin's add form.
- **Route schema is incomplete** — `SearchParams` at `sources.add.$pluginKey.tsx:5-10` only validates `url` and `preset`. `namespace` is supported by the page but silently dropped by the route. `SourcesAddPage` is also never given the parsed `namespace` (`tsx:17`).
- **No desktop protocol handler** — `apps/desktop/src/main/index.ts` does not call `app.setAsDefaultProtocolClient(...)`. A click on `executor://add-source/...` from a webpage cannot open the desktop app. The file already has the prerequisite `requestSingleInstanceLock` / `second-instance` plumbing (`index.ts:46-57`).
- **No CLI add command** — `apps/cli/src/main.ts` exposes `call`, `tools …`, `daemon …`, `web`, `mcp` (1526 lines) but no `source add`. Headless / server installs and scripted setups have no path.

### Storage model (background for the proposal)

Executor has two persistence layers, and they are **not** in conflict — PR #807 ("Remove executor jsonc source sync") explicitly removed the previous bidirectional sync.

- **`executor.jsonc`** (`packages/core/config/src/load-plugins.ts`) — code-as-config. Read once at boot, merged with static `executor.config.ts` plugins. Sources declared here surface in the UI as `canEdit: false`, `canRemove: false` (see e.g. MCP plugin `packages/plugins/mcp/src/sdk/plugin.ts:1380-1382, 1524`). Intended for team-shared, version-controlled declarations. **Not used by cloud.**
- **FumaDB store** (`apps/local`: SQLite at `~/.executor/data.db`; `apps/cloud`: Postgres via Hyperdrive) — runtime mutable state. UI add forms write here. Cloud is DB-only.

UI add today does a **DB write with optional jsonc write-through**: the plugin's `addSource` always calls `ctx.storage.putSource(...)`, and additionally calls `configFile.upsertSource(...)` if a `ConfigFileSink` is configured (e.g. `packages/plugins/mcp/src/sdk/plugin.ts:1418-1422`; sink in `packages/core/config/src/sink.ts:40-72`, errors swallowed best-effort).

Implication for this issue: a CLI `source add` and deep-link add should follow the same pattern as the UI (DB primary, optional jsonc write-through). Picking jsonc-only for CLI would silently make CLI-added sources immutable in the UI, which is surprising. Picking DB-only would break parity with the UI. Same-as-UI is the safe default.

## Proposal

A small URL contract plus the two glue pieces (desktop protocol handler, CLI command) so third parties can ship "Add to Executor" buttons / commands.

### URL contract

Public deep-link shape, stable across desktop, local web, and cloud:

```
executor://add-source/<pluginKey>?url=...&preset=...&namespace=...&auth=...
http://localhost:4788/sources/add/<pluginKey>?url=...&preset=...&namespace=...&auth=...
https://executor.sh/sources/add/<pluginKey>?url=...&preset=...&namespace=...&auth=...
```

- `pluginKey`: `mcp` | `openapi` | `graphql` | `google-discovery`, or `auto` for URL-based plugin detection (see below).
- `url`: source URL (MCP endpoint, OpenAPI spec, GraphQL endpoint).
- `preset`: optional preset id consumed by the plugin's add form.
- `namespace`: optional override.
- `auth`: optional. `auto` triggers the OAuth popup on form mount for plugins that need it (default: user clicks "Sign in").

**Always lands on the prefilled form** — the deep link never auto-submits. The user always sees what's about to be added and clicks "Add this source". This protects against clickjacking from a malicious link.

Extend `SearchParams` in `packages/app/src/routes/sources.add.$pluginKey.tsx:5-10` with `namespace` and `auth`; pass them through to `SourcesAddPage` (`tsx:17`).

### Plugin auto-detect (`pluginKey=auto`)

The existing "Connect" dialog in `packages/react/src/pages/sources.tsx` already sniffs URLs to pick a plugin (MCP / OpenAPI / GraphQL / Google Discovery). Lift that detection into a shared helper and use it when the deep-link path is `/sources/add/auto?url=...`:

- Resolve to the detected plugin, redirect to `/sources/add/<detectedPlugin>?url=...` preserving other params.
- If detection is ambiguous, render the picker with the URL prefilled and the candidates highlighted.

This lets third parties ship a single "Add to Executor" link without having to know whether their endpoint is MCP or OpenAPI.

### OAuth auto-trigger

When `auth=auto` and the resolved plugin requires OAuth (e.g. MCP with a `connectionId`), the form mounts, then immediately invokes the existing OAuth popup (`packages/react/src/plugins/oauth-sign-in.tsx`). The user sees the form, the popup opens, they sign in, the form completes — one click to "Add this source" remains.

### Namespace collision handling

The deep-link path must not silently overwrite an existing source. On the prefilled form:

- If `namespace` is taken in the current scope, surface the conflict inline with two options: pick a new namespace (auto-suggest a suffix like `supabase-2`), or "Replace existing" with a confirmation step.
- Reuse the existing inline-validation surface the add forms already have for the manual path; do not branch the UX between manual and deep-link.

### Desktop protocol handler

In `apps/desktop/src/main/index.ts`:

- Call `app.setAsDefaultProtocolClient("executor")` before `whenReady`.
- On macOS, handle `app.on("open-url", (e, url) => …)` (fires both at cold start and while running).
- On Windows / Linux, parse the deep link from `process.argv` on cold start and from the `argv` parameter passed to the existing `second-instance` handler (`index.ts:51-55`).
- Map `executor://add-source/<plugin>?<search>` → renderer navigation to `/sources/add/<plugin>?<search>`. The form's "never auto-submit" guarantee (see URL contract) is what protects against malicious links.

### CLI command

In `apps/cli/src/main.ts`:

```
executor source add <plugin> --url <url> [--namespace <ns>] [--preset <preset>]
executor source add mcp     --url https://mcp.supabase.com/mcp --namespace supabase
executor source add openapi --url https://api.example.com/openapi.json
executor source add graphql --url https://api.example.com/graphql
```

Writes through the same `addSource` path the UI uses — DB primary, optional jsonc write-through if a `ConfigFileSink` is configured for the scope. No new source-of-truth.

For OAuth-required MCP sources, follow the existing flow (`packages/core/api/src/oauth/api.ts`): the CLI prints the auth URL and waits for completion, or opens the browser if `--open` is passed.

### Cloud variant

Cloud (`apps/cloud`, Cloudflare Workers + Postgres via Hyperdrive) shares the same React app and `/sources/add/...` route, but the surrounding constraints differ:

- **DB-only.** No `executor.jsonc`. The optional jsonc write-through path is a no-op in cloud. CLI / deep-link adds write to the FumaDB-backed Postgres.
- **Auth required.** `apps/cloud/src/routes/__root.tsx:207-236` gates all routes behind a WorkOS session. Unauthenticated deep-link clicks land on the login page first, then bounce to the prefilled form post-login.
- **Per-org scopes, no per-tenant subdomain.** The deployment is single-host (`https://executor.sh` per `apps/cloud/wrangler.jsonc`). A third-party "Add to Executor" button cannot pre-select an org for the user; the deep link adds into whatever org the user currently has active. If the user has multiple orgs, the form should make the target org explicit before the user clicks "Add this source".
- **Plugin gating.** `apps/cloud/executor.config.ts:42-44` sets `dangerouslyAllowStdioMCP: false` and omits filesystem-bound plugins (`keychainPlugin`, `fileSecretsPlugin`, `onepasswordHttpPlugin`, `desktopSettingsPlugin`, `googleDiscoveryHttpPlugin`). Deep links to unsupported plugins must render an inline message with a deep link to the desktop variant: "This connector isn't available in Executor Cloud — open in Desktop instead." (`executor://add-source/...` with the same params).

Out of scope here but worth noting for follow-up: a public `https://executor.sh/add?...` entry point that routes to the user's currently-active org would be the cleanest target for third-party buttons; today third parties have to link directly into `/sources/add/<plugin>`.

### Third-party affordance

Document the deep-link shape under `docs/` so platforms can render either:

```html
<a href="executor://add-source/mcp?url=https%3A%2F%2Fmcp.supabase.com%2Fmcp&namespace=supabase">
  Add to Executor
</a>
```

…or, for non-desktop users, the equivalent localhost URL.

## Open questions

1. **CLI auth on cloud.** Cloud has API keys (`apps/cloud/src/auth/api-keys.ts`) scoped to an organization. Should `executor source add` support `--api-key` for headless cloud setup, or is cloud-via-CLI out of scope for v1?
2. **Cloud public entry point.** Is `https://executor.sh/add?plugin=...&url=...` (auto-routes to the user's active org) worth doing in this issue, or split into a follow-up? Without it, third-party cloud buttons have to deep-link directly into `/sources/add/<plugin>` and rely on the user being logged in.
3. **Org disambiguation in cloud.** If a user belongs to multiple orgs, the deep link adds to whichever is currently active. Show an org picker on the prefilled form when there's more than one, or trust the active one?
4. **Mac vs Win/Linux protocol UX.** macOS fires `open-url` cleanly; Win/Linux parse the deep link from `argv` on cold start and via `second-instance`. The two paths converge on the same renderer navigation — worth calling out that the existing `requestSingleInstanceLock` (`apps/desktop/src/main/index.ts:46-57`) is what makes the second-instance path work.
5. **Preset registry surface.** `preset` is plugin-specific today. Worth a public list of supported presets (per plugin) so third parties know what to encode, or leave it implicit?
