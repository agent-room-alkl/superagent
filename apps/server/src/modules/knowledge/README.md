# Knowledge source runtime

The production bootstrap supplies the one platform PostgreSQL pool, Blob endpoint, Document Intelligence endpoint and budgeted LLM gateway. Knowledge stores source versions, confirmations, ACLs, references and durable parse/analysis jobs in PostgreSQL. Migration 0002 must run before traffic switches. Both web and worker use the same store; the worker owns one leased start/poll step per tick. Unknown billable outcomes stay held for reconciliation. There is no direct-provider model fallback.

Source files use the private `sources` Blob container. Text imports retain original line offsets. Local PDF, scans and Office uploads persist the Azure operation reference and respect RetryAfter. Successful parsing still requires human confirmation of the current version. Preview, retrieval, history-derived recommendations and live database results all enforce source access; owner/admin roles do not override it.

## Database sources

The operator sets `SOURCE_DATABASES_JSON` on web and worker with approved source endpoints and scope. Configure DBA-owned row-filtered views and a separate SELECT-only account. This is independent of the model API key. The source account must have no CREATE/write privileges and no reads of unapproved public relations. Query execution pins `pg_catalog, public, pg_temp`, uses READ ONLY, a five-second statement limit and approved column/masking rules.

Example shape (all values are placeholders):

```json
[{"id":"finance","name":"Approved finance views","host":"source.example.invalid","database":"source","user":"read-only-principal","projectIds":["finance"],"scope":{"audience":["entra-object-id"],"maxRows":50,"tables":{"approved_invoices":{"columns":["id","status","contact_email"],"sensitive":["contact_email"]}}}}]
```

The default authentication uses the deployment managed identity's PostgreSQL audience token. If the source needs a password, provision it separately in Key Vault and add `"secret":{"name":"db-source-finance","version":"specific-version"}`. Passwords, model-key references and connection strings are refused in this configuration. TLS certificate validation is always enabled. The source pool is separate from the platform write pool and closes on shutdown.

The UI installs the database plugin, selects an approved resource, explicitly acknowledges independent read-only access, confirms the connection, syncs structure and approves SELECT templates separately from running them by ID. Schema/view-definition or scope changes invalidate a template and require reapproval. Returned rows carry query time and an opaque, scope/template-bound data revision. The freshness endpoint rechecks current permission, schema and source revision; missing or unstable signals expire the result. PostgreSQL snapshots conservatively expire on unrelated transactions. Rows are never added as policy knowledge. No resources are simulated when configuration is absent.

## Validation scope

Unit/service tests use labeled fixtures. CI exercises native PostgreSQL including an isolated source database, a SELECT-only role, a filtered view, hostile session search_path, masking, binding and privilege changes. Chromium tests call real HTTP handlers with explicit test storage/model. Live Azure Document Intelligence/Blob/Entra deployment validation requires configured cloud resources and is separate from these tests.

## Source lifecycle and confirmation

Only the local-file plugin is initially installed. `POST /plugins/:id/install` records capability availability; it creates no connection, source item, recommendation or employee business tool. Pause/resume stays separate. Remote connection creation requires literal `readOnlyAcknowledged: true`; raw credential references and write effects are refused. Database requests select only `scope.resourceId`, with tables, columns, row bounds and projects derived from the operator registry.

`KNOWLEDGE_SOURCES_JSON` defines approved mail/SharePoint metadata scopes, audiences and project grants, using managed identity for Graph. `GET /connections/:id/preview` reads metadata after per-item ACL checks and exposes opaque version-bound selection IDs; denied titles/bodies remain hidden. `POST /connections/:id/import {ids}` rechecks those permissions and persists the selected external IDs. Every sync filters the same selection and checks the current actor ACL before any body read. Imported versions remain unconfirmed. Revocation/deletion clears retrievable chunks and confirmation; same-version recovery rereads content and requires confirmation again. Folder hierarchy changes force a bounded full SharePoint reconciliation so omitted descendants lose old references.

Remote production connectors currently support mail bodies and text files. Non-text remote documents require durable parse-job integration; use the local binary upload queue for PDF/Office/image files. The synchronous parser bridge is deliberately not wired into remote production sync because it does not persist uncertain billable submissions.

`PUT /space {name}` updates only the logical namespace label. `POST /manual-roles {name,description}` creates an explicitly manual, human-locked role with no document evidence and does not unlock analysis. Inferred roles still require confirmed evidence. Human-locked metadata remains visible as stale after a permitted source version changes; old quotes are withheld and edits/adoption require valid current evidence.

The 51 original T-40 assertion IDs are real browser cases in `apps/e2e/tests/knowledge.spec.ts`. Explicit synthetic external drivers are documented in `docs/e2e/KNOWLEDGE-COVERAGE.md`; no live cloud access is claimed.
