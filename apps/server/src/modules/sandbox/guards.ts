/**
 * Safety guards for on-demand execution (PRD §3.5 isolated execution, T-43).
 * - Artifact digests are fixed at release and verified before every run.
 * - Outbound network is allow-listed per tool contract.
 * - Credentials are handed to a run as single-use, short-lived grants by the gateway; the sandbox identity itself has no
 *   Key Vault or database access.
 * - Recorded artifacts must not carry login state or secrets.
 */
import { createHash, randomUUID } from 'node:crypto';
import dns from 'node:dns/promises';
import net from 'node:net';

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
/** Returns true when an IPv4 or IPv6 address belongs to a private, loopback, link-local, or reserved range. */
export function isPrivateOrReservedIp(rawIp: string): boolean {
  const ip = rawIp.trim().replace(/^\[|\]$/g, '').toLowerCase();
  if (!ip) return true;
  if (ip.startsWith('::ffff:')) {
    const mapped = ip.slice('::ffff:'.length);
    if (net.isIPv4(mapped)) return isPrivateOrReservedIp(mapped);
  }
  const v = net.isIP(ip);
  if (v === 4) {
    const parts = ip.split('.').map((n) => Number(n));
    const [a = -1, b = -1] = parts;
    if (a === 10) return true; // 10.0.0.0/8 private
    if (a === 127) return true; // 127.0.0.0/8 loopback
    if (a === 169 && b === 254) return true; // 169.254.0.0/16 link-local / IMDS
    if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12 private
    if (a === 192 && b === 168) return true; // 192.168.0.0/16 private
    if (a === 0) return true; // 0.0.0.0/8 "this" network
    if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 shared/CGNAT
    if (a >= 224) return true; // multicast / reserved / broadcast
    return false;
  }
  if (v === 6) {
    if (ip === '::1' || ip === '::' || ip === '0:0:0:0:0:0:0:1' || ip === '0:0:0:0:0:0:0:0') return true;
    if (ip.startsWith('fc') || ip.startsWith('fd')) return true; // fc00::/7 unique local
    if (ip.startsWith('fe8') || ip.startsWith('fe9') || ip.startsWith('fea') || ip.startsWith('feb')) return true; // fe80::/10 link-local
    if (ip.startsWith('ff')) return true; // multicast
    return false;
  }
  return true;
}

export type HostIpResolver = readonly string[] | ((host: string) => readonly string[] | string | null | undefined);

/**
 * Entries are exact hosts ("app.example.com") or wildcard subdomains ("*.example.com").
 * Before allowing egress, checks any resolved IP addresses and rejects private, loopback, or link-local ranges.
 */
export function isAllowedUrl(url: string, allowlist: string[], resolvedIps?: HostIpResolver): boolean {
  let host: string;
  let protocol: string;
  try {
    ({ hostname: host, protocol } = new URL(url));
  } catch {
    return false;
  }
  const cleanHost = host.replace(/^\[|\]$/g, '').toLowerCase();
  const isLocalLiteral = cleanHost === 'localhost' || cleanHost === '127.0.0.1';
  if (protocol !== 'https:' && !(protocol === 'http:' && isLocalLiteral)) return false;
  const matched = allowlist.some((entry) => {
    const e = entry.toLowerCase();
    return e.startsWith('*.') ? cleanHost.endsWith(e.slice(1)) && cleanHost !== e.slice(2) : cleanHost === e;
  });
  if (!matched) return false;

  // If the hostname itself is an IP literal (other than an explicitly allow-listed local test server when no DNS override is given), reject private/loopback/link-local IPs.
  if (net.isIP(cleanHost) !== 0 && !(isLocalLiteral && resolvedIps === undefined)) {
    if (isPrivateOrReservedIp(cleanHost)) return false;
  }

  if (resolvedIps !== undefined) {
    const raw = typeof resolvedIps === 'function' ? resolvedIps(cleanHost) : resolvedIps;
    const ips = typeof raw === 'string' ? [raw] : Array.isArray(raw) ? raw : [];
    if (ips.length === 0) return false;
    if (ips.some((ip) => isPrivateOrReservedIp(ip))) return false;
  }
  return true;
}

/** Resolves the URL hostname via DNS (or a supplied lookup function) and rejects private, loopback, or link-local IPs. */
export async function resolveAndCheckUrl(
  url: string,
  allowlist: string[],
  lookupFn?: (host: string) => Promise<readonly string[]>,
): Promise<boolean> {
  if (!isAllowedUrl(url, allowlist)) return false;
  let host: string;
  try {
    host = new URL(url).hostname.replace(/^\[|\]$/g, '').toLowerCase();
  } catch {
    return false;
  }
  if (!lookupFn && (host === '127.0.0.1' || host === 'localhost') && allowlist.some((e) => e.toLowerCase() === host)) {
    return true;
  }
  try {
    const ips = lookupFn
      ? await lookupFn(host)
      : (await dns.lookup(host, { all: true })).map((record) => record.address);
    return isAllowedUrl(url, allowlist, ips);
  } catch {
    return false;
  }
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
