# Deploying to Azure

One resource group per environment (`staging`, `prod`). Everything is created by `infra/main.bicep`.
No secret is ever passed as a deployment parameter: the model API key is entered later in the app's Setup page and
stored in Key Vault by the app itself.

## What gets created

| Resource | Purpose | Notes |
|---|---|---|
| Container Apps environment | Hosts web, worker and jobs | Logs to Log Analytics |
| `sa-<env>-web` | Workbench + API | Scales 0–3; external HTTPS ingress |
| `sa-<env>-worker` | Queue, schedules, sync, model calls | **minReplicas = 1** — no ingress, so it must never scale to zero |
| `sa-<env>-migrate` (Job) | Applies `apps/server/migrations/*.sql` | Started by the deploy workflow before smoke test |
| `sa-<env>-sandbox` (Job) | Tool sandbox / browser replay / computer use | Per-run billing; **separate identity** with no access to the app Key Vault or database |
| Container Registry (Basic) | Images | Pulled with managed identity, admin user disabled |
| PostgreSQL Flexible Server 16 | Business state, queue, audit | **Entra auth only** (password auth disabled); `pg_trgm` and `vector` allow-listed |
| Storage account | Source originals, artifacts, screenshots | No public blob access, no shared keys |
| Key Vault (RBAC) | Model API key, connector credentials | Purge protection on; app identity = Secrets Officer |
| Document Intelligence (S0) | PDF / scanned document parsing | Local auth disabled; app identity = Cognitive Services User |
| Application Insights | Telemetry | 50% sampling, 30-day log retention |

Production hardening (both optional parameters):

- `enablePrivateNetworking=true` deploys `infra/network.bicep`: a VNet with an apps subnet (Container Apps environment is
  injected into it) and a private-endpoint subnet; private endpoints + private DNS zones for PostgreSQL, Key Vault, Blob
  and Document Intelligence; public network access on those services is disabled.
- `enableFrontDoor=true` adds Azure Front Door Premium with a managed WAF policy (Default Rule Set 2.1, prevention mode)
  in front of the web app, HTTPS only. Follow-up: restrict the Container App ingress to Front Door traffic
  (`X-Azure-FDID` header check or IP restrictions) so the origin cannot be called directly.

## One-time setup

1. **Resource group**: `az group create -n rg-superagent-staging -l australiaeast`
   Check that every service above (and your chosen model) is available in the region first.
2. **Entra app registration (workbench + API, one registration)**: note the tenant id and client id.
   - **Expose an API**: Application ID URI `api://<client-id>`, add the scope `access_as_user` (admins and users can consent).
   - **App roles**: add `admin`, `owner`, `employee` and `reviewer`, then assign users or groups to them.
   - **Authentication → Single-page application**: add the redirect URI `https://<web app FQDN>` (and
     `http://localhost:5173` for local work against a dev tenant). No client secret is created: the browser uses
     authorization code + PKCE.
   - **Manifest**: set `"accessTokenAcceptedVersion": 2`. The server validates the issuer
     `https://login.microsoftonline.com/<tenant>/v2.0` and the audience (`<client-id>` or `api://<client-id>`).
   - The browser reads `/auth/config` (tenant id, client id, scope; no secrets), signs in with MSAL using session storage
     only, and sends `Authorization: Bearer <token>` on every API call.
3. **PostgreSQL admin group**: create an Entra group for database administrators; note its object id and name.
4. **GitHub OIDC**: create a federated credential on a deployment identity for this repository and environment, grant it
   Contributor + User Access Administrator on the resource group, and set repository variables:
   `AZURE_CLIENT_ID`, `AZURE_TENANT_ID`, `AZURE_SUBSCRIPTION_ID`, `AZURE_RESOURCE_GROUP`,
   `ENTRA_TENANT_ID`, `ENTRA_CLIENT_ID`, `PG_ADMIN_GROUP_ID`, `PG_ADMIN_GROUP_NAME`.
5. **Production approval**: configure the `prod` GitHub environment with required reviewers.

## Deploy

Run the **deploy** workflow (Actions → deploy → Run workflow → staging). It:
1. creates or updates infrastructure,
2. builds and pushes `superagent:<git sha>` to the registry,
3. deploys the new revision of web, worker and jobs,
4. runs the migration job and waits for success,
5. smoke-tests `/healthz`.

Database access for the app identity: after the first deploy, a member of the PostgreSQL admin group runs once
(replace the identity name, shown as `sa-<env>-app-id`):

```sql
SELECT * FROM pgaadauth_create_principal('sa-staging-app-id', false, false);
GRANT superagent_app TO "sa-staging-app-id";
```

## First start

1. Open the web URL from the deployment output and sign in with an account that has the `admin` or `owner` role.
2. Go to **管理设置 → Setup**, choose the provider, paste the API key, test, choose allow-listed models, save.
   The key goes to Key Vault; only the last four characters are shown afterwards.
3. Upload or connect knowledge sources and confirm them before analysis.

## Validate the template locally

```bash
az bicep build --file infra/main.bicep
az deployment group what-if -g <rg> -f infra/main.bicep -p @infra/main.parameters.json
```

## Approved mail and SharePoint sources

Configure the optional GitHub environment variables `KNOWLEDGE_SOURCES_JSON` and `SOURCE_DATABASES_JSON` for the manual deploy workflow. Both infrastructure passes apply these values through a generated parameter file, so redeploys retain the configured registry. Empty variables intentionally configure no resources. Neither variable may contain credentials.

`KNOWLEDGE_SOURCES_JSON` (Bicep parameter `knowledgeSourcesJson`) contains only deployment-approved metadata scopes. The web and worker receive the same registry. Example with placeholders:

```json
[{"id":"finance-mail","name":"Finance inbox","pluginId":"email","scope":{"mailbox":"finance@example.invalid","folder":"Inbox","receivedSince":"2026-01-01T00:00:00Z"},"audience":["<entra-user-object-id>"],"projectIds":["P-1"]}]
```

For SharePoint, use `pluginId: "sharepoint"` and `scope: {"driveId":"<approved-drive-id>","folderPath":"/Policies"}`. Missing, malformed, oversized or credential-bearing configuration is rejected. Dates may be narrowed in requests; mailbox, folder, drive, source audience and project grants cannot be expanded by a client. The registry is an application boundary; the Graph identity must also have the corresponding upstream permission. An owner role does not bypass source ACLs.

The app managed identity uses Graph `.default`: grant read-only `Mail.Read` limited to approved mailboxes (Exchange application RBAC/access policy) and/or `Sites.Selected` with per-site read grants. These are administrator prerequisites; installing a plugin in the workbench does not grant Graph permissions or create a business tool. No mail send/write permission is requested.

First install the source plugin, explicitly acknowledge the read-only scope, create and independently confirm the connection. Metadata preview exposes only ACL-permitted titles, versions and locators. Select and import those items, then review and confirm each imported version before analysis. Sync keeps that explicit selection; permission loss, plugin pause, schema/version changes and reauthorization withdraw usable references. New versions require confirmation again.

Database sources continue to use `SOURCE_DATABASES_JSON` and independent SELECT-only identities. Current facts are never copied into knowledge. Their freshness token binds the source change signal to the current user, template, schema and approved scope. PostgreSQL uses `pg_current_snapshot()` conservatively: unrelated transactions may expire a result. Missing or changing signals cannot establish freshness. Requery to read current values.

For simultaneous E2E worktrees set `E2E_PORT` to an unused unprivileged port. The browser fixture is test-only and explicitly models external sources, models and database data; it is not proof of live Azure or Graph access.
