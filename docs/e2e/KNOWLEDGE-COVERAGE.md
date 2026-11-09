# Knowledge E2E evidence

`apps/e2e/tests/knowledge.spec.ts` defines 51 independent cases. Each title preserves one original T-40 assertion ID from `apps/e2e/assertion-map.json`. Test discovery verifies the count; discovery alone does not prove product behavior. The assertion map must be updated only after the corresponding browser case passes.

The browser uses the actual built React app, Fastify HTTP routes, KnowledgeService, MemoryKnowledgeRepository, source synchronization and DatabaseGateway. It does not intercept successful API responses. The source/model/database drivers in `server/knowledge-fixture.ts` are explicitly synthetic. These tests do not prove live Azure, Microsoft Graph, PostgreSQL or model-provider behavior.

Run from the workspace root after building shared/server/web dependencies:

```powershell
npm run typecheck --workspace @superagent/e2e
npm run e2e --workspace @superagent/e2e -- tests/knowledge.spec.ts --workers=1
```

The suite executes sequentially and resets its own knowledge repository before every case. Setup and employee-tool state are not reset or seeded. Browser identity is `e2e-knowledge-owner|owner|P-1`; forged requests also exercise other owners and missing project permission. Every case retains the shared browser script/console-error checks.

## Explicit test-driver seams

The fixture factory and route attachment reject `NODE_ENV=production`. Driver endpoints require the exact knowledge E2E identity and are attached only by the E2E server entrypoint.

| Endpoint | Purpose |
| --- | --- |
| `POST /__test/knowledge/reset` | Replace the knowledge repository and reset synthetic external state. |
| `POST /__test/knowledge/control` | Change synthetic source ACL/availability/content, schema/data revision, or model availability/output revision. |
| `POST /__test/knowledge/advance` | Execute one real durable knowledge worker tick. |
| `GET /__test/knowledge/audit` | Read audit metadata and external-driver call counters; excludes SQL, parameters and row values. |
| `GET /__test/knowledge/metadata` | Inspect source/chunk counts, schema version labels and recommendation/analysis metadata; excludes document text and live row values. |

Remote source controls accept `kind: mail|sharepoint` with `available`, `acl: allowed|revoked|unknown`, `text`, `bumpVersion`, or `resourceAudience`. Database controls accept `kind: database` with `available`, `readOnly`, `rowValue`, `schemaChanged`, or `audience`. Model controls accept `kind: model` with `available` or `suffix`. Controls mutate external-driver state; production service/gateway code still authorizes imports, confirmations, queries and analyses.

The deterministic model proposes roles only from supplied `角色：…；责任：…` source lines and tools from `工具：…；职责：…` lines. It copies exact bounded evidence offsets. Schema-only evidence supports a data analyst and a read-only query-tool draft. It invents no mail workflow or published SOP. Proposal keys remain stable across reanalysis.

## Prototype semantics retained in the product

- Local import uses a real browser `File.setInputFiles` payload, the real upload endpoint, and a server preview checked against the uploaded bytes.
- Plugin installation records capability availability only; connection creation, source selection/import, source-version confirmation and employee-tool installation remain separate operations.
- A logical knowledge-space name changes metadata only. It does not duplicate a database or create authority over its records.
- Personal project selection is enforced by operator-approved resource scopes and server authorization. The product offers no UI control to grant oneself arbitrary projects. Forged project/table/write requests exercise the server boundary directly.
- Current facts carry an external data revision. Checking freshness removes stale rows; the next real query gets the new driver value. Data-only changes leave schema analysis and human edits intact.
- Schema/ACL recovery requires current source-version confirmation. Inferred drafts retain source references; manual roles are visibly labeled and do not unlock analysis.
- Source previews show only authorized metadata. Forged selection hashes and revoked source confirmations are exercised over HTTP; denied source titles and bodies must not reach the page.
- Browser assertions use the product's bounded result table and local horizontal scrolling, rather than the static prototype's mock table.

The 51 original IDs remain in the test titles, including prototype ID gaps. No row is reassigned to unit coverage or removed from scope.
