/**
 * Safety guards for on-demand execution (PRD §3.5 isolated execution, T-43).
 * - Artifact digests are fixed at release and verified before every run.
 * - Outbound network is allow-listed per tool contract.
 * - Credentials are handed to a run as single-use, short-lived grants by the gateway; the sandbox identity itself has no
 *   Key Vault or database access.
 * - Recorded artifacts must not carry login state or secrets.
 */
import { createHash, randomUUID } from 'node:crypto';

// ---------- Artifact digest ----------
export function digestOf(bytes: Uint8Array | string): string {
  return 'sha256:' + createHash('sha256').update(bytes).digest('hex');
}

export class DigestMismatchError extends Error {}

export function verifyArtifact(bytes: Uint8Array | string, releasedDigest: string): void {
  const actual = digestOf(bytes);
  if (actual !== releasedDigest) throw new DigestMismatchError(`artifact digest ${actual} does not match released ${releasedDigest}`);
}

// ---------- Egress allowlist ----------
/** Entries are exact hosts ("app.example.com") or wildcard subdomains ("*.example.com"). */
export function isAllowedUrl(url: string, allowlist: string[]): boolean {
  let host: string;
  let protocol: string;
  try {
    ({ hostname: host, protocol } = new URL(url));
  } catch {
    return false;
  }
  if (protocol !== 'https:' && !(protocol === 'http:' && (host === 'localhost' || host === '127.0.0.1'))) return false;
  host = host.toLowerCase();
  return allowlist.some((entry) => {
    const e = entry.toLowerCase();
    return e.startsWith('*.') ? host.endsWith(e.slice(1)) && host !== e.slice(2) : host === e;
  });
}

// ---------- Single-use, short-lived credential grants ----------
export interface Grant {
  id: string;
  runId: string;
  toolId: string;
  secret: string;
  expiresAt: number;
  used: boolean;
}

export class GrantStore {
  private grants = new Map<string, Grant>();
  constructor(private now: () => number = Date.now) {}

  /** Issued by the gateway (which holds Key Vault access) for exactly one run of one tool. */
  issue(runId: string, toolId: string, secret: string, ttlMs = 5 * 60_000): string {
    const id = randomUUID();
    this.grants.set(id, { id, runId, toolId, secret, expiresAt: this.now() + ttlMs, used: false });
    return id;
  }

  /** Redeemed once by the sandbox run. Wrong run/tool, reuse, or expiry all fail closed. */
  redeem(id: string, runId: string, toolId: string): string {
    const g = this.grants.get(id);
    if (!g || g.runId !== runId || g.toolId !== toolId) throw new Error('grant not valid for this run');
    if (g.used) throw new Error('grant already used');
    if (this.now() > g.expiresAt) throw new Error('grant expired');
    g.used = true;
    g.secret.length; // keep reference until returned
    const s = g.secret;
    g.secret = '';
    return s;
  }
}

// ---------- Recorded artifact hygiene ----------
const FORBIDDEN_KEYS = /^(cookies|origins|storageState|password|passwd|secret|token|authorization|apiKey|api_key|mfa|otp)$/i;

/** Rejects artifacts that contain login state or credential-looking fields (recording must isolate login). */
export function assertNoLoginState(artifact: unknown, path = '$'): void {
  if (Array.isArray(artifact)) return artifact.forEach((v, i) => assertNoLoginState(v, `${path}[${i}]`));
  if (artifact && typeof artifact === 'object') {
    for (const [k, v] of Object.entries(artifact as Record<string, unknown>)) {
      if (FORBIDDEN_KEYS.test(k)) throw new Error(`artifact contains forbidden field ${path}.${k}`);
      assertNoLoginState(v, `${path}.${k}`);
    }
  }
}
