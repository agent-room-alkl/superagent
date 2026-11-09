import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AccountInfo, IPublicClientApplication } from '@azure/msal-browser';
import { InteractionRequiredAuthError } from '@azure/msal-browser';
import { __setClientForTest, bearerToken, initAuth } from '../src/auth';
import { api } from '../src/api';

const account = { homeAccountId: 'h', environment: 'login.microsoftonline.com', tenantId: 't', username: 'pat@example.com', localAccountId: 'l', name: 'Pat' } as AccountInfo;

afterEach(() => {
  __setClientForTest(null, null);
  vi.unstubAllGlobals();
});

describe('browser sign-in', () => {
  it('dev mode: no MSAL, no Authorization header', async () => {
    const user = await initAuth((async () => new Response(JSON.stringify({ mode: 'dev' }))) as typeof fetch);
    expect(user).toEqual({ mode: 'dev' });
    expect(await bearerToken()).toBeNull();
    const seen: Record<string, string>[] = [];
    vi.stubGlobal('fetch', async (_u: string, init: RequestInit) => (seen.push(init.headers as Record<string, string>), new Response('{}')));
    await api('/api/v1/setup/llm');
    expect(seen[0]!.authorization).toBeUndefined();
  });

  it('entra mode: every API call carries the access token as a Bearer header', async () => {
    const silent = vi.fn(async () => ({ accessToken: 'access-token-abc' }));
    __setClientForTest({ acquireTokenSilent: silent } as unknown as IPublicClientApplication, account, ['api://app/access_as_user']);
    const seen: Record<string, string>[] = [];
    vi.stubGlobal('fetch', async (_u: string, init: RequestInit) => (seen.push(init.headers as Record<string, string>), new Response('{}')));
    await api('/api/v1/setup/llm', { method: 'PUT', body: '{}' });
    expect(seen[0]!.authorization).toBe('Bearer access-token-abc');
    expect(seen[0]!['x-dev-user']).toBeUndefined();
    expect(silent).toHaveBeenCalledWith({ scopes: ['api://app/access_as_user'], account });
  });

  it('an expired session goes back through the sign-in redirect instead of calling the API unauthenticated', async () => {
    const redirect = vi.fn(async () => undefined);
    __setClientForTest(
      { acquireTokenSilent: async () => { throw new InteractionRequiredAuthError('login_required'); }, acquireTokenRedirect: redirect } as unknown as IPublicClientApplication,
      account,
      ['s'],
    );
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    await expect(api('/api/v1/setup/llm')).rejects.toBeInstanceOf(InteractionRequiredAuthError);
    expect(redirect).toHaveBeenCalledWith({ scopes: ['s'], account });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('refuses a half-configured entra server instead of signing in against defaults', async () => {
    await expect(initAuth((async () => new Response(JSON.stringify({ mode: 'entra', tenantId: 't' }))) as typeof fetch)).rejects.toThrow(/not configured/);
  });
});
