/**
 * Starts one sandbox run as an Azure Container Apps Job execution (per-run billing, nothing resident).
 * The web/worker identity may start the job; the job itself runs under the separate sandbox identity.
 */
import type { RunSpec } from '../../browser/runner.js';

export interface SandboxLauncher {
  start(spec: RunSpec): Promise<{ executionName: string }>;
}

export interface AzureJobConfig {
  jobResourceId: string; // /subscriptions/.../resourceGroups/.../providers/Microsoft.App/jobs/sa-<env>-sandbox
  image: string;
  getToken?: () => Promise<string>;
  fetchFn?: typeof fetch;
}

export class AzureJobLauncher implements SandboxLauncher {
  constructor(private cfg: AzureJobConfig) {}

  async start(spec: RunSpec): Promise<{ executionName: string }> {
    const token = await (this.cfg.getToken ?? defaultToken)();
    const body = {
      containers: [
        {
          name: 'sandbox',
          image: this.cfg.image,
          env: [
            { name: 'APP_ROLE', value: 'browser' },
            { name: 'RUN_SPEC', value: Buffer.from(JSON.stringify(spec)).toString('base64') },
          ],
        },
      ],
    };
    const res = await (this.cfg.fetchFn ?? fetch)(`https://management.azure.com${this.cfg.jobResourceId}/start?api-version=2024-03-01`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`job start failed: ${res.status}`);
    const j = (await res.json()) as { name?: string; id?: string };
    return { executionName: j.name ?? j.id ?? 'unknown' };
  }
}

async function defaultToken(): Promise<string> {
  const { DefaultAzureCredential } = await import('@azure/identity');
  const t = await new DefaultAzureCredential().getToken('https://management.azure.com/.default');
  if (!t) throw new Error('no ARM token');
  return t.token;
}
