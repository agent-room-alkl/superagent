/**
 * Fetch wrapper. In Azure (server AUTH_MODE=entra) every call carries the signed-in user's Entra access token;
 * in local dev (server AUTH_MODE=dev) a dev identity header is sent instead.
 */
import { bearerToken } from './auth';

const devUser = (import.meta as unknown as { env?: Record<string, string | undefined> }).env?.VITE_DEV_USER;

export async function api<T>(path: string, init: RequestInit = {}): Promise<{ status: number; body: T }> {
  const headers: Record<string, string> = { 'content-type': 'application/json', ...(init.headers as Record<string, string> | undefined) };
  const token = await bearerToken();
  if (token) headers.authorization = `Bearer ${token}`;
  else if (devUser) headers['x-dev-user'] = devUser;
  const res = await fetch(path, { ...init, headers });
  const body = (await res.json().catch(() => ({}))) as T;
  return { status: res.status, body };
}

/** Authentication headers for calls that cannot use api() (e.g. text/event-stream). Never a client-chosen identity. */
export async function authHeaders(): Promise<Record<string, string>> {
  const token = await bearerToken();
  if (token) return { authorization: `Bearer ${token}` };
  return devUser ? { 'x-dev-user': devUser } : {};
}
