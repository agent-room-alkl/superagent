# Knowledge source runtime

The production bootstrap supplies the one platform PostgreSQL pool, Blob endpoint, Document Intelligence endpoint and budgeted LLM gateway. Knowledge stores source versions, confirmations, ACLs, references and durable parse/analysis jobs in PostgreSQL. Migration 0002 must run before traffic switches. Both web and worker use the same store; the worker owns one leased start/poll step per tick. Unknown billable outcomes stay held for reconciliation. There is no direct-provider model fallback.

Source files use the private `sources` Blob container. Text imports retain original line offsets. PDF, scans and Office imports persist the Azure operation reference and respect RetryAfter. Successful parsing still requires human confirmation of the current version. Preview, retrieval, history-derived recommendations and live database results all enforce source access; owner/admin roles do not override it.

## Database sources

The operator sets `SOURCE_DATABASES_JSON` on web and worker with approved source endpoints and scope. Configure DBA-owned row-filtered views and a separate SELECT-only account. This is independent of the model API key. The source account must have no CREATE/write privileges and no reads of unapproved public relations. Query execution pins `pg_catalog, public, pg_temp`, uses READ ONLY, a five-second statement limit and approved column/masking rules.

Example shape (all values are placeholders):

```json
[{"id":"finance","name":"Approved finance views","host":"source.example.invalid","database":"source","user":"read-only-principal","projectIds":["finance"],"scope":{"audience":["entra-object-id"],"maxRows":50,"tables":{"approved_invoices":{"columns":["id","status","contact_email"],"sensitive":["contact_email"]}}}}]
```

The default authentication uses the deployment managed identity's PostgreSQL audience token. If the source needs a password, provision it separately in Key Vault and add `"secret":{"name":"db-source-finance","version":"specific-version"}`. Passwords, model-key references and connection strings are refused in this configuration. TLS certificate validation is always enabled. The source pool is separate from the platform write pool and closes on shutdown.

The UI selects an approved resource, confirms the connection, syncs structure and approves SELECT templates separately from running them by ID. Schema/view-definition or scope changes invalidate a template and require reapproval. Returned rows are time-stamped current facts; they are never added as policy knowledge. No resources are simulated when configuration is absent.

## Validation scope

Unit/service tests use labeled fixtures. CI exercises native PostgreSQL including an isolated source database, a SELECT-only role, a filtered view, hostile session search_path, masking, binding and privilege changes. Chromium tests call real HTTP handlers with explicit test storage/model. Live Azure Document Intelligence/Blob/Entra deployment validation requires configured cloud resources and is separate from these tests.
