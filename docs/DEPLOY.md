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

Production hardening: set `enablePrivateNetworking=true` to disable public network access on PostgreSQL, Key Vault,
Storage and Document Intelligence (private endpoints and VNet integration must then be added for the environment).

## One-time setup

1. **Resource group**: `az group create -n rg-superagent-staging -l australiaeast`
   Check that every service above (and your chosen model) is available in the region first.
2. **Entra app registration (API)**: create an app registration for the workbench, expose an API, add app roles
   `admin`, `owner`, `employee`, `reviewer`, assign users/groups. Note the tenant id and client id.
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
