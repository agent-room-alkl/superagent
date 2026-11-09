# Module ownership

Each owner changes only their own module directories. Changes to `packages/shared` or `apps/server/src/db/schema.ts`
go in a small separate PR that the other owners can review. Every task has a different verifier.

| Area | Directories | Task | Owner | Verifier |
|---|---|---|---|---|
| Scaffold, shared contracts, CI, Dockerfile, Bicep | root, `packages/shared`, `infra/`, `.github/` | T-39 | Claude | Codex |
| Identity, Setup (provider/key/models/budget), audit, health | `apps/server/src/modules/{setup,audit}`, `apps/web/src/pages/Setup*` | T-39 | Claude | Codex |
| Knowledge source plugins, Document Intelligence, retrieval, analysis | `apps/server/src/modules/{knowledge,analysis}`, `apps/server/src/plugins` | T-40 | Codex | Grok |
| Command room, task runtime, tool gateway, human work items, SOP & triggers | `apps/server/src/modules/{room,runtime,gateway,humanwork,sop}` | T-41 | Grok | Claude |
| Employees & tool card lifecycle | `apps/server/src/modules/{employees,tools}` | follow-up (after round 1) | TBD | TBD |
| On-demand sandbox, browser replay, computer use | `apps/server/src/modules/sandbox`, `Dockerfile.browser` | follow-up (after round 1) | TBD | TBD |

## Rules

- Never commit keys, connection strings, tokens, or real customer material. The repository is public.
- Work on a branch (`feat/<area>`), open a PR, the verifier reviews it. CI must pass.
- UI reuses the accepted v12 prototype: design tokens in `apps/web/src/styles/tokens.css`, page structure and copy.
  Prototype browser assertions are ported to E2E tests as each module's acceptance floor.
- Spec: PRD v1.3 (`docs/prd/`).
