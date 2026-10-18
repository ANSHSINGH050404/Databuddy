# AGENTS.md

This is the canonical repository guidance for Codex, Claude Code, and other coding agents. Root `CLAUDE.md` imports this file rather than maintaining a second contract. Verify current package scripts and owning implementations before relying on older session notes or skill examples.

## Overview

Databuddy is a comprehensive analytics platform — a Turborepo monorepo using Bun as the package manager and runtime. It consists of multiple apps (dashboard, API, data collectors) and shared packages, backed by PostgreSQL, ClickHouse, and Redis.

## Guidance Routing

- Internal implementation, debugging, and review: read `.agents/skills/databuddy-internal/SKILL.md`, then the owning package's scripts and source.
- External SDK/API integration help: use `.agents/skills/databuddy/SKILL.md`; do not apply customer integration guidance as a monorepo architecture guide.
- Analytics or workspace operations through Databuddy MCP: use `.agents/skills/databuddy-mcp/SKILL.md` and the server's live instructions, tool schemas, and `databuddy://guide`.
- Dashboard UI: use the shared UI rules below and inspect the relevant implementation in `packages/ui/src/components` before extending it. Load task-specific guidance as needed; do not load the entire skill catalog for a routine change.

## Development Commands

```bash
# Start dashboard + API + Insights worker (most common)
bun run dev:dashboard

# Start all workspace dev services
bun run dev

# Lint
bun run lint

# Format
bun run format

# Type check
bun run check-types

# Run tests
bun run test                 # Turbo runs each workspace's own test script
bun run test:integration     # Shared-service integration suites, serialized
bun run test:watch           # Bun watch over apps only; use package watchers for Vitest

# Database
bun run db:push          # Apply PostgreSQL schema through packages/db
bun run db:studio        # Open Drizzle Studio GUI
bun run workspace [--reset] [--anomaly] [--events N] [--website <ID>]  # Local login, website and seeded analytics

# SDK (for direct package startup; root dev tasks build SDK/devtools)
bun run sdk:build

# Build everything
bun run build
```

Run root commands from the repository root. Scripts that need runtime configuration load the root `.env`; `workspace` intentionally uses local test configuration instead. Check the owning package script for package-specific runners, environment flags, and service requirements. The root `db:migrate` and `db:deploy` aliases currently have no matching package task; they are not working migration commands.

### Running a single test

```bash
# API and basket use Vitest through their package scripts
bun run --cwd apps/api test src/path/to/test.ts
bun run --cwd apps/api test -t "test name"

# Bun-native packages use their own script (which may build or isolate first)
bun run --cwd packages/shared test --test-name-pattern "test name"
```

## Initial Setup

```bash
bun install
cp .env.example .env
docker compose -f docker-compose.yaml up -d  # PostgreSQL, ClickHouse, Redis
bun run db:push
bun run clickhouse:init       # Root script routes into packages/db
bun run dev:dashboard         # Turbo builds SDK/devtools first
```

## Architecture

### Monorepo Structure

```
apps/
  dashboard/   # Next.js 16 frontend (React 19, TailwindCSS 4), port 3000
  api/         # Elysia.js backend (Bun), port 3001
  basket/      # Analytics event ingestion service, port 4000
  insights/    # Investigation generation and verification worker
  uptime/      # Uptime monitoring
  cron/        # Standalone scheduled scripts (not a Turbo workspace)
  links/       # Short link service
  docs/        # Next.js + Fumadocs documentation/marketing site, port 3005
  status/      # Public status pages, port 3002
  slack/       # Slack agent adapter

packages/
  db/          # Drizzle PostgreSQL schemas/clients + ClickHouse helpers
  rpc/         # Shared oRPC router, procedures, and auth-aware context
  auth/        # Better Auth integration + permission system
  sdk/         # Public analytics SDK (React, Vue, Node.js)
  sdk-swift/   # Swift analytics SDK
  nuxt/        # Nuxt module for the SDK
  ui/          # Shared design system (@databuddy/ui)
  ai/          # AI agent, analytics query builders, and MCP tools
  redis/       # Redis clients, cacheable() caching, pub/sub, BullMQ, rate limiting
  shared/      # Shared types, utilities, constants
  validation/  # Zod schemas
  services/    # Business logic services
  email/       # Email via Resend
  notifications/ # Notification system
  tracker/     # Lightweight client-side tracking scripts
  mapper/      # Data transformation utilities
  env/         # Type-safe environment configuration
  devtools/    # Browser analytics devtools
  encryption/  # Encryption utilities
  api-keys/    # API key management and scopes
  test/        # Shared test env, factories, contexts, and assertions
  migrate/     # Competitor tracker-source migration (not database migrations)
  scan/        # Analytics instrumentation scanner CLI
  pulumi/      # Infrastructure configuration
```

### Data Flow

```
Browser (SDK/tracker) → basket → Redpanda → Vector → ClickHouse

Dashboard (Next.js) ←→ API (Elysia + shared oRPC) → PostgreSQL + ClickHouse + Redis
```

The basket producer also supports direct ClickHouse fallback, including self-host/no-broker operation; inspect `apps/basket/src/lib/producer.ts` and `infra/ingest/vector.yaml` for the configured delivery path.

### Key Patterns

**RPC Layer (`packages/rpc`)**: The central type-safe API contract and shared procedure logic between dashboard and API. Dashboard uses the oRPC client with TanStack Query; the API hosts the shared router and injects host-specific capabilities. Start a shared endpoint in `packages/rpc`; change `apps/api` when its host wiring or service-owned behavior also needs to change.

**Database Layer (`packages/db`)**: Single source of truth for all schemas. Uses Drizzle ORM for PostgreSQL (relational data: users, websites, settings) and a ClickHouse client for analytics data (events, sessions, pageviews). PostgreSQL schema changes use `db:push`; the current deployment initializer (`init.Dockerfile`) also runs the owning package's `db:push`. Do not infer a working production migration runner from the root aliases. Shipped ClickHouse changes need the existing tracked forward-migration path as well as reference DDL; bootstrap `CREATE IF NOT EXISTS` does not alter deployed tables. Apply production changes only within the task's authorization.

**Caching (`packages/redis`)**: `cacheable()` wraps repeated lookups with single-flight deduplication, optional stale-while-revalidate, and a Redis fallback. Keys and TTLs are defined alongside the owning queries. Pass `reviveDates: false` when an output schema expects ISO-string timestamps. There is no standalone `packages/cache`.

**Investigations (`apps/insights`)**: Generation and verification belong in the worker and reuse `@databuddy/ai`. API/RPC surfaces read product state or queue durable runs. `SPEC.md` is the intelligence product contract. Analytics query builders live in `packages/ai/src/query`, not a standalone `packages/query`.

**Auth (`packages/auth`)**: Better-Auth handles sessions. The package also contains the permission system used across all apps.

**State management in Dashboard**: Jotai for local UI state, TanStack Query for server state.

**Dashboard design system (`@databuddy/ui`)**: `bun run lint` enforces component-library use, semantic color tokens, and shared HTTP error responses for new code. Dashboard feature code should use `@databuddy/ui`; native controls and direct Radix/Base UI imports belong in shared component implementations or explicitly permitted local wrappers. Intentional exceptions require an adjacent `policy-ignore` comment with a specific reason.

For picker controls, use the component that matches the interaction:
- Use `DropdownMenu` for menu-style folder/status/filter/sort/action pickers.
- Use `Select` only when the established UI pattern is explicitly a select/combobox.
- Use `Field` with shared inputs for form labeling, descriptions, errors, ids, and accessibility wiring.

### Tech Stack

- **Runtime**: Bun (currently pinned to `bun@1.4.1` by root `packageManager`)
- **Frontend**: Next.js 16, React 19, TailwindCSS 4, shared Base UI/Radix components, Recharts
- **Backend**: Elysia.js (Bun-native HTTP framework)
- **API layer**: ORPC (type-safe RPC with OpenAPI generation)
- **Auth**: Better-Auth
- **ORM**: Drizzle ORM
- **Databases**: PostgreSQL 17, ClickHouse 25.5, Redis 7
- **Validation**: Zod 4
- **Linting/Formatting**: Biome via Ultracite
- **Build**: Turborepo + Bun

## Code Style

- **Linter/Formatter**: Ultracite (Biome-based). Run `bun run lint` / `bun run format`.
- **TypeScript**: Strict mode. Always use proper types — avoid `any`.
- **Dashboard UI**: Feature code should consume `@databuddy/ui`; `packages/ui/src/components` is the shared implementation layer; use `@databuddy/ui/client` for client-only exports. Do not hand-roll controls in feature components; extend the shared UI layer first when the current API is missing something.
- **Marketing copy**: Never write staccato sentences on landing pages, docs, or any marketing copy. No runs of clipped fragments like "Fast. Private. Simple." or "No cookies. No banners. No guesswork." Write full sentences that connect the idea to what the reader gets.
- **Commit format**: `<type>(<scope>): <description>` (e.g., `feat(dashboard): add export button`, `fix(api): handle null session`)
- **Commit slicing rule**: Prefer one commit per coherent product or technical slice, not one giant snapshot and not ultra-fragmented file-by-file commits.
  - Split commits by intent: feature, bug fix, refactor, style/copy pass, or migration slice.
  - Use the dominant surface as scope: `dashboard`, `api`, `rpc`, `basket`, `docs`, `db`, `sdk`, `tracker`, `deps`, `ci`.
  - Group closely related UI files into one commit when they ship one visible change.
  - Keep unrelated surfaces in separate commits even if they were edited in the same session.
  - For broad migrations, follow the repo’s existing pattern: one commit per meaningful area, e.g. `feat(dashboard): migrate home, events, insights, and links pages to shared UI components`.
  - Before committing, check `git diff --stat` and `git status --short`; if the diff mixes unrelated intents, split it.
  - Only make a single snapshot commit for the whole worktree when the user explicitly asks to include everything as-is.

## Tests

Runners: `apps/api` and `apps/basket` use vitest; every other package uses `bun test`. Import helpers from the runner the package actually runs (`bun:test` vs `vitest`); `bun run lint:policies` rejects the wrong one. Biome includes tests with test-specific rule overrides; many package `tsconfig.json` files exclude them. Keep tests formatted (tabs, no blank line before a closing `});`), keep imports honest, and check changed test types explicitly when the normal typecheck does not reach them.

**Every test file must be reachable.** A package that contains `*.test.ts(x)` needs a `test` script, and any file path named in a `test*` script must exist; `lint:policies` enforces both, and counts a file as run only when CI reaches it through the package's `test`/`test:integration` script or the root lint script. Env-gated integration files go in the package's `test:integration` script, which sets its own gate flags; CI runs the root `test:integration` script, which serializes package integration suites through Turbo, so never wire a suite as its own `ci.yml` step. A gated file nobody runs is dead, not "for later".

**Integration tests use the shared services only.** Postgres `databuddy_test` on 5432, Redis on 6379, ClickHouse on 8123, via `import "@databuddy/test/env"` as the first import. Never pin a test to a scratch container port; `lint:policies` rejects five-digit loopback ports in test files. A test that needs isolation uses its own organization, website, or table names and cleans them up.

**Do not write these tests.** They were removed in bulk once and will be removed again:
- Constant snapshots: asserting a constant or config equals a literal copy of itself. Drift guards that compare two sources of truth are the exception.
- Mock echo: mocking a dependency and asserting it was called with the arguments the test passed in.
- Library behaviour: zod defaults, drizzle column config, ai-sdk retries, bun or node semantics.
- Duplicates: add a case to the existing `<module>.test.ts` instead of creating `<module>-extra.test.ts`, `<module>-boundary.test.ts`, or a "fuzz" file that reruns fixed inputs.
- `.skip` or `.todo` without an issue link, or a `describe.skip` that never turns on.

```bash
# Run every integration suite (requires Docker: postgres, redis, clickhouse)
bun run test:integration

# One package
cd apps/api && bun run test:integration

# One-time setup for test DB
cd packages/db && DATABASE_URL="postgres://databuddy:databuddy_dev_password@localhost:5432/databuddy_test" bunx drizzle-kit push
```

**Key helpers from `@databuddy/test`:**
- `signUp()` — creates a real user via better-auth with session cookie
- `addToOrganization(userId, orgId, role)` — inserts member row
- `userContext(user, orgId)` / `apiKeyContext(orgId, scopes)` — builds RPC Context
- `insertOrganization()` / `insertWebsite()` / `insertApiKey()` — DB factories
- `expectCode(promise, "FORBIDDEN")` — asserts ORPCError code
- `reset()` / `cleanup()` — truncate tables / close connections
- `import "@databuddy/test/env"` — sets test env vars (must be first import)

**Rules for integration tests:**
- Always `import "@databuddy/test/env"` as the first line
- Use `const iit = hasTestDb ? it : it.skip` for graceful skip when Docker is down
- Use `userContext` / `apiKeyContext` / `expectCode` from the test package — don't redefine locally
- Type API key objects against `Context["apiKey"]` to catch schema drift
- `beforeEach(() => reset())` and `afterAll(() => cleanup())` in every file
- Business context lives in `organization_business_contexts`, never `organization.metadata`; fixtures that write metadata test nothing

## Drift Prevention

- **Time series bucket in the site's timezone.** Query builders bucket with `toDate(toTimeZone(time, {timezone:String}))` (or `toStartOfHour`), passing `ctx.timezone || "UTC"`; a bare `toDate(time)` buckets by UTC day and shifts evening traffic to the next day. Date-only ranges are bound in the same timezone: `SimpleQueryBuilder` turns `toDateTime({startDate:String})` and `toDateTime(concat({endDate:String}, ' 23:59:59'))` into timezone-aware bounds for non-UTC requests, so write those forms and never convert dates by hand; totals and daily buckets then cover the same local days.
- **AI agent analytics has one source per list.** The agent registry (ids, names, products, purposes) is `packages/shared/src/utils/bot-detection/ai-agents.ts`, generated from the vendored `well-known-bots.json`; the lists the dashboard needs (`FEATURED_AI_PRODUCTS`, `CONTENT_FORMATS`, `AgentPurpose`, `ROBOTS_ACCESS`) live in the lightweight `bot-detection/types.ts`, because importing `ai-agents.ts` into the dashboard pulls the large vendored bot JSON into the bundle. Name crawlers and products from the registry by `agent_id`, never from the stored `bot_name` (rows written before the October 2026 detector fix can hold browser engines like "WebKit" or "unknown"). The logo list (`AI_ICON_COLORS`, resolved with `aiProductIcon`) also lives in `bot-detection/types.ts` and must match `apps/dashboard/public/ai/*.svg` and the email logos in `apps/dashboard/public/ai/email/*.png`; `apps/dashboard/components/icon.test.ts` enforces both and that every featured product has a logo.
- **Type test objects against their source type.** Fake API keys must be typed as `Context["apiKey"]`, fake users as `User`, etc. Many normal package typechecks exclude tests; source typing makes a partial fixture visible in review and the editor, and explicit test typechecking catches it before shipping.
- **Never hand-write dependency versions.** Use `bun add <pkg>` to add dependencies. Hand-written version ranges drift from lockfile reality and cause phantom resolution bugs.
- **Shared test helpers over local copies.** `expectCode`, `userContext`, `apiKeyContext`, env setup — these live in `@databuddy/test`. If you're about to define a helper that already exists there, import it instead.
- **Scope maps must match.** If `RESOURCE_SCOPE_OVERRIDES` changes in `packages/api-keys/src/scopes.ts`, the integration tests in `packages/rpc/src/routers/links.test.ts` and `packages/rpc/src/procedures/with-workspace.test.ts` must be updated to match. The link resource is mapped there (`read:links` for read, `write:links` for create/update/delete), as is the flag resource (`manage:flags` for create/update/delete). Both are enforced solely by `withWorkspace`; there are no separate pre-check layers. New resources also need role grants in `packages/auth/src/permissions.ts` (statement plus each role).
- **Identity columns are governed by `packages/db/src/clickhouse/identity.ts`.** `PROFILE_ID_TABLES` lists every ClickHouse table carrying `profile_id`; `identity.test.ts` enforces that each entry has a CREATE column and `profile_id` + `anonymous_id` in the agent SQL allowlist. A shipped table change also needs the existing forward migration; the test alone does not prove deployed schema readiness. Adding `profile_id` to a table means adding it there and following the failing test. Query-side identity stitching must use `EVENTS_VISITOR_KEY` / `CUSTOM_EVENTS_VISITOR_KEY` / `visitorMatch()` from that module — never inline the expression. Analytics columns labelled visitors use `uniq(anonymous_id)` so every page reports the same number as the overview; `uniq(session_id)` counts sessions and must be labelled that way. Profile write semantics (trait splitting, upserts) live in `@databuddy/services/identity`; `profile_id` values are customer-supplied and are never salted, unlike `anonymous_id`.

## Data and Credential Privacy

- Never use production/customer data as tests, fixtures, snapshots, examples, or copied output. Use synthetic/local data; summarize authorized production investigations as anonymized aggregates.
- For Cortad, reuse the dedicated synthetic-user account identified in private local instructions and sign in through the local app. Read credentials only when needed; never print them, copy them into repository files, or commit them. Do not use this account for customer data.

## UX and Value Evidence

- For every meaningful change, identify the user and workflow, the observed behavior before the change, the issue, and the value lost (such as time, trust, task completion, or money).
- Ground priorities in concrete evidence from source, reproduction, runtime behavior, or authorized user data. Separate observed problems from hypotheses; do not treat missing implementation alone as proof of user demand.
- Before implementation, state the intended improvement and an observable success criterion. Prefer the smallest coherent change that delivers meaningful value.
- Verify the affected journey before and after where feasible, including failure, recovery, and asynchronous follow-up. Use synthetic or local test data and disclose any unavailable evidence.
- Report the before, issue and lost value, changed behavior, evidence of improvement, and remaining uncertainty. Passing tests establish the behavior they exercise; do not claim measured time savings, adoption, revenue, or causality without supporting measurements.
- For internal or technical work, connect the change to a concrete downstream user or operational benefit. Scale the evidence and reporting to the impact of the change.

## Branch and PR Lifecycle

**Local default for Codex and Claude Code:** Work directly in this repository's local `staging` checkout and preserve existing edits. Create a task branch, worktree, or PR only when the user explicitly requests that workflow. Do not switch or reset an existing checkout to force this default. Commit, push, merge, deploy, or publish only within the task's granted authorization; a cleanup request alone does not authorize a release. The lifecycle below applies to those requested branch/PR workflows.

- **One task, one branch, one PR**: Keep a branch to one independently reviewable and reversible slice. If work can land separately, split it before it becomes a mixed PR.
- **Start fresh**: Check for an existing PR that owns the same surface, public contract, schema, or deployment configuration, then create the branch from an up-to-date `origin/staging`. Do not use an unmerged feature branch as a base unless the dependency is explicit, approved, and named as `Depends on #…` in both PRs.
- **Make ownership visible**: Push and open a draft PR against `staging` once the slice has a first commit. State its scope, dependencies, and known overlaps.
- **Keep integration linear**: Rebase a slice onto current `origin/staging` before it is ready for review; do not merge `staging` into the slice merely to refresh it. Request fresh review when a rebase changes reviewed code.
- **Resolve all review feedback before merging**: Mark the PR ready and wait for configured reviewers to finish on the final head; green CI alone is insufficient. Read every page of general comments, reviews, and inline threads, including outdated threads. Fix actionable findings or document a supported reason for declining them, then resolve each thread. Immediately before merging, re-fetch feedback and verify zero unresolved threads and no unaddressed comments or pending reviews. Never merge immediately after marking a draft ready or pushing review fixes while reviewers are still running.
- **Isolate parallel work**: Use one worktree per active branch. Never let two agents or contributors mutate the same branch or reuse a task branch for a different concern.
- **Retire completed work**: Merged PR source branches are automatically deleted. Delete closed PR branches manually, remove clean finished worktrees, and create a new branch from current `staging` for any follow-up—never revive or repurpose an old PR branch.

## CI and Review Lessons

- Always run `bun run lint`, `bun run check-types`, and relevant tests before pushing; formatter-only drift can fail CI.
- Keep workspace dependencies explicit in each package's `package.json`; typecheck can pass locally from hoisting while CI or package boundaries fail.
- Process lifecycle code must fail safe: `uncaughtException` handlers should log/capture then exit non-zero, and graceful shutdown must have a timeout plus a concurrent-signal guard.
- API error handlers must preserve valid 4xx statuses (400/401/403/404/422/429, etc.) instead of collapsing everything to 500.
- Avoid regexes with broad wildcards over user/model text or tagged prompt payloads; prefer deterministic delimiter parsing.
- Avoid O(n²) accumulator patterns such as spreading arrays inside loops; mutate local arrays with `push` when grouping buffered items.
- Empty `catch {}` blocks need a reason comment or minimal logging, especially in instrumentation paths.
- Eval guardrail regexes should be precise and bounded; avoid broad `.*` patterns that can fail unrelated output.
- CI service containers should mirror local Docker requirements; ClickHouse needs the high `nofile` ulimit, generous health startup time, and a health command supported inside the ClickHouse image.
- Dashboard Playwright web servers should not use `bash -lc`; login shells can reset PATH on CI and hide Bun. Use `bash -c` or an explicit Bun path, build dist-only workspace packages such as `@databuddy/sdk`/`@databuddy/devtools` before starting the API/dashboard, and set E2E boolean env vars as `"true"`/`"false"` because `readBooleanEnv` does not treat `"1"` as enabled.
- Bun `mock.module` state can affect files in the same package test command; mocks for shared modules like `../lib/logger` must include every method later tests may call.
- Client-side `NEXT_PUBLIC_*` checks must use direct `process.env.NEXT_PUBLIC_NAME` access (or a helper that does); dynamic helpers like `readBooleanEnv("NEXT_PUBLIC_...")` are not inlined into the browser bundle.

## AI Policy Note

The project has a formal AI usage policy (`AI_POLICY.md`). For contributions: all AI usage must be disclosed, PRs must reference an accepted issue, and all AI-generated code must be fully human-verified. Maintainers are exempt and may use AI at their discretion.
