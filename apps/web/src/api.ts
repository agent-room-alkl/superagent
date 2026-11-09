/** Fetch wrapper. In local dev (server AUTH_MODE=dev) a dev identity header is sent; in Azure, Entra tokens are used. */
const devUser = (import.meta as unknown as { env?: Record<string, string | undefined> }).env?.VITE_DEV_USER;

export async function api<T>(path: string, init: RequestInit = {}): Promise<{ status: number; body: T }> {
  const headers: Record<string, string> = { 'content-type': 'application/json', ...(init.headers as Record<string, string> | undefined) };
  if (devUser) headers['x-dev-user'] = devUser;
  const res = await fetch(path, { ...init, headers });
  const body = (await res.json().catch(() => ({}))) as T;
  return { status: res.status, body };
}
