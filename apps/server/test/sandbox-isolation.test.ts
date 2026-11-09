/**
 * Isolation evidence for T-43.
 * 1) Static policy test over the compiled ARM template (infra/main.json, built by `az bicep build` in CI):
 *    the sandbox identity has no role on Key Vault, PostgreSQL or the storage account as a whole — only AcrPull and
 *    Blob Data Contributor scoped to the screenshots container. Without a Key Vault role, any secret read by that
 *    identity is denied by Azure RBAC.
 * 2) Runtime guard: the browser role refuses to start when given main-app settings.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertSandboxEnvironment } from '../src/browser/runner.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const armPath = path.resolve(here, '../../../infra/main.json');
const hasArm = fs.existsSync(armPath);

const ROLE = {
  acrPull: '7f951dda-4ed3-4680-a7ca-43fe172d538d',
  blobContributor: 'ba92f5b4-2d11-453d-a403-e96b0029c9fe',
  kvSecretsOfficer: 'b86a8fe4-44ce-4948-aee5-eccb2c155cd7',
};

(hasArm ? describe : describe.skip)('sandbox identity RBAC (compiled template)', () => {
  const arm = JSON.parse(fs.readFileSync(armPath, 'utf8'));
  const resources: any[] = Array.isArray(arm.resources) ? arm.resources : Object.values(arm.resources);
  const assignments = resources.filter((r) => r.type === 'Microsoft.Authorization/roleAssignments');
  const forSandbox = assignments.filter((r) => JSON.stringify(r.properties.principalId).includes('-sandbox-id'));

  it('finds the sandbox role assignments', () => {
    expect(forSandbox.length).toBe(2);
  });

  it('grants the sandbox only AcrPull and Blob contributor on the screenshots container', () => {
    const roles = forSandbox.map((r) => String(r.properties.roleDefinitionId));
    expect(roles.some((x) => x.includes(ROLE.acrPull))).toBe(true);
    const blob = forSandbox.find((r) => String(r.properties.roleDefinitionId).includes(ROLE.blobContributor));
    expect(String(blob.scope)).toContain('screenshots');
  });

  it('never grants the sandbox any Key Vault or database role', () => {
    for (const r of forSandbox) {
      expect(String(r.properties.roleDefinitionId)).not.toContain(ROLE.kvSecretsOfficer);
      expect(String(r.scope ?? '')).not.toMatch(/Microsoft\.KeyVault|DBforPostgreSQL/);
    }
    const pgAdmins = resources.filter((r) => r.type === 'Microsoft.DBforPostgreSQL/flexibleServers/administrators');
    for (const a of pgAdmins) expect(JSON.stringify(a)).not.toContain('-sandbox-id');
  });

  it('the sandbox job does not receive Key Vault or database settings', () => {
    const job = resources.find((r) => r.type === 'Microsoft.App/jobs' && JSON.stringify(r.name).includes('-sandbox'));
    const env = JSON.stringify(job.properties.template.containers[0].env);
    expect(env).not.toMatch(/KEY_VAULT_URL|PG_HOST|DATABASE_URL/);
  });
});

describe('sandbox runtime guard', () => {
  it('refuses to start with main-app secrets or database settings', () => {
    expect(() => assertSandboxEnvironment({ KEY_VAULT_URL: 'https://kv' })).toThrow(/KEY_VAULT_URL/);
    expect(() => assertSandboxEnvironment({ PG_HOST: 'x' })).toThrow(/PG_HOST/);
    expect(() => assertSandboxEnvironment({ APP_ROLE: 'browser', SCREENSHOT_BLOB_URL: 'https://st' })).not.toThrow();
  });
});
