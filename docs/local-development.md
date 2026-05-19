# Local Development

This repository is an early Next.js/TypeScript platform scaffold for Continuous
Core. It includes a static admin surface, health/core API routes, Drizzle schema
definitions, npm scripts, Docker Compose packaging, and DigitalOcean deployment
helpers.

## Prerequisites

Current work requires:

| Tool | Purpose |
|---|---|
| Git | Inspect changes and coordinate with other contributors |
| Node.js 22+ | Run the app, tests, type checks, and builds |
| npm 11+ | Install dependencies and package scripts |
| PostgreSQL | Run the future persisted graph, ledger, budget, and evidence store locally |
| Docker | Exercise the container/Compose path locally if needed |
| `doctl` | Operate DigitalOcean resources for deployment |
| Markdown editor | Edit docs and specs |

The package manifest currently uses npm and `package-lock.json`.

## Current Workflow

1. Check for existing work before editing:

   ```sh
   git status --short
   ```

2. Read the strategy before changing platform direction:

   ```sh
   open STRATEGY.md
   ```

3. Install dependencies:

   ```sh
   npm ci
   ```

4. Create a local environment file:

   ```sh
   cp .env.example .env.local
   ```

   `DATABASE_URL` is required by the database client. The example value expects
   Postgres on `localhost:5432` with database/user/password `continuous`.

5. Start the app:

   ```sh
   npm run dev
   ```

6. Open:

   ```text
   http://localhost:3000
   http://localhost:3000/api/health
   http://localhost:3000/api/core
   ```

7. Keep documentation machine-actionable where possible. Prefer direct object,
   field, capability, workflow, and policy names over verbose transitional names.

8. Record decisions and tradeoffs in `implementation.md` when the strategy or a
   future spec does not decide something.

9. Keep follow-up tasks that need the owner in `tasks.md` once that file exists
   or the owner asks for it. Do not create operational tasks in source files.

## Checks

Run the package-level verification command before handing off runtime changes:

```sh
npm run check
```

That expands to lint, typecheck, tests, and build:

```sh
npm run lint
npm run typecheck
npm run test
npm run build
```

For documentation-only changes, `git status --short` plus a focused Markdown
readthrough is enough unless the docs change runtime commands.

## Database

The scaffold uses Drizzle with PostgreSQL:

| Command | Purpose |
|---|---|
| `npm run db:generate` | Generate migrations from `src/db/schema.ts` |
| `npm run db:migrate` | Apply migrations using `DATABASE_URL` |
| `npm run db:studio` | Open Drizzle Studio |
| `npm run db:seed` | Seed bootstrap Continuous Core data |

Current schema coverage includes tenants, users, workers, capabilities,
capability grants, adapters, connections, model providers, model routes, budget
policies, budget pools, budget accounts, budget allocations, canonical objects,
customer/lead/offer/quote/job/invoice/payment projections, object links,
object versions, tasks, events, evidence, inferences, usage events, and
generated UI contracts.

## Documentation Conventions

| Rule | Reason |
|---|---|
| Use simple names | Humans and intelligent systems should infer meaning from context |
| Keep docs scoped | Strategy belongs in `STRATEGY.md`; setup, dev, and deployment details belong in `docs/` |
| Make contracts explicit | Workers need typed capabilities, schemas, policies, budgets, evidence, and evals |
| Document decisions | Future contributors need to know where strategy ended and implementation judgment began |
| Avoid hidden behavior | Approval, budget, privacy, and evidence behavior must be visible in specs |

## Local Environment Shape

The local environment should mirror the core platform boundaries as they land:

| Local service | Purpose |
|---|---|
| App/API | Current Next.js app, `/api/health`, and `/api/core` |
| Database | Drizzle/Postgres schema for graph, ledger, budgets, evidence, and adapters |
| Worker runtime | Future agentic worker execution, planning, capability calls, and eval hooks |
| AI gateway | Future model routing, budget reservation, usage ledger, redaction, and eval events |
| Adapter workers | Future external sync, webhook handling, retries, and reconciliation |
| Generated UI | Current admin surface, future owner brief, approvals, task queue, budget dashboard, and evidence views |
| Data stores | Current Postgres target, future queue, cache, object storage, and search if needed |

## Shared Repo Safety

This repo may have concurrent edits. Before editing, inspect `git status`. Do not
overwrite or revert work you did not create. Keep source, package, deploy, and CI
files untouched unless the owner explicitly expands the scope.
