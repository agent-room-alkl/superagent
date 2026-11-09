/**
 * Secret storage for Setup (PRD §3.1, §7.1). The model API key lives only here.
 * Production: Azure Key Vault via managed identity. Tests/dev: in-memory store.
 */
export interface SecretVersion {
  name: string;
  version: string;
}

export interface SecretStore {
  /** Writes a new version and returns it. Must throw if the write did not succeed. */
  put(name: string, value: string): Promise<SecretVersion>;
  get(ref: SecretVersion): Promise<string>;
  /** Disables a specific version (never deletes the whole secret — that would affect all versions). */
  disable(ref: SecretVersion): Promise<void>;
}

export class InMemorySecretStore implements SecretStore {
  private data = new Map<string, { value: string; enabled: boolean }>();
  private counter = 0;
  async put(name: string, value: string): Promise<SecretVersion> {
    const version = `v${++this.counter}`;
    this.data.set(`${name}/${version}`, { value, enabled: true });
    return { name, version };
  }
  async get(ref: SecretVersion): Promise<string> {
    const e = this.data.get(`${ref.name}/${ref.version}`);
    if (!e || !e.enabled) throw new Error('secret version unavailable');
    return e.value;
  }
  async disable(ref: SecretVersion): Promise<void> {
    const e = this.data.get(`${ref.name}/${ref.version}`);
    if (e) e.enabled = false;
  }
  /** Test helper: is a version enabled? */
  isEnabled(ref: SecretVersion): boolean {
    return this.data.get(`${ref.name}/${ref.version}`)?.enabled ?? false;
  }
}

/** Azure Key Vault implementation. Loaded lazily so local dev/tests need no Azure packages at runtime. */
export async function createKeyVaultStore(vaultUrl: string): Promise<SecretStore> {
  const { SecretClient } = await import('@azure/keyvault-secrets');
  const { DefaultAzureCredential } = await import('@azure/identity');
  const client = new SecretClient(vaultUrl, new DefaultAzureCredential());
  return {
    async put(name, value) {
      const s = await client.setSecret(name, value, { contentType: 'llm-api-key' });
      if (!s.properties.version) throw new Error('Key Vault did not return a version');
      return { name, version: s.properties.version };
    },
    async get(ref) {
      const s = await client.getSecret(ref.name, { version: ref.version });
      if (!s.value) throw new Error('empty secret');
      return s.value;
    },
    async disable(ref) {
      await client.updateSecretProperties(ref.name, ref.version, { enabled: false });
    },
  };
}

/** Redacts anything that looks like an API key from strings before logging (PRD §7.1). */
export function redact(text: string): string {
  return text.replace(/(sk-[A-Za-z0-9_-]{6})[A-Za-z0-9_-]+/g, '$1…').replace(/([A-Za-z0-9]{4})[A-Za-z0-9]{28,}/g, '$1…');
}
