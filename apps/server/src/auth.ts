/**
 * Entra ID authentication (PRD §3.9, §7.2). Every request is authorised server-side by role and project scope.
 * AUTH_MODE=dev allows an `x-dev-user` header for local development and tests; it is refused in production.
 */
import type { FastifyReply, FastifyRequest, preHandlerHookHandler } from 'fastify';
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from 'jose';
import { ROLES, type Role, type UserContext } from '@superagent/shared';

declare module 'fastify' {
  interface FastifyRequest {
    user?: UserContext;
  }
}

export interface AuthConfig {
  mode: 'entra' | 'dev';
  tenantId?: string; // Entra directory (tenant) id
  clientId?: string; // API app registration audience
  /** Platform tenant the deployment serves (single-tenant deployment). */
  platformTenantId: string;
  /** Optional lookup of project scopes / extra roles from the users table. */
  resolveUser?: (oid: string, tokenRoles: Role[]) => Promise<Pick<UserContext, 'roles' | 'projectScopes'> | null>;
}

export function authConfigFromEnv(env = process.env): AuthConfig {
  const mode = env.AUTH_MODE === 'dev' ? 'dev' : 'entra';
  if (mode === 'dev' && env.NODE_ENV === 'production') throw new Error('AUTH_MODE=dev is not allowed in production');
  return { mode, tenantId: env.ENTRA_TENANT_ID, clientId: env.ENTRA_CLIENT_ID, platformTenantId: env.PLATFORM_TENANT_ID ?? 'default' };
}

const toRoles = (v: unknown): Role[] => (Array.isArray(v) ? v.filter((r): r is Role => (ROLES as readonly string[]).includes(String(r))) : []);

export function createAuthenticate(cfg: AuthConfig): preHandlerHookHandler {
  const jwks =
    cfg.mode === 'entra' && cfg.tenantId
      ? createRemoteJWKSet(new URL(`https://login.microsoftonline.com/${cfg.tenantId}/discovery/v2.0/keys`))
      : null;

  return async function authenticate(req: FastifyRequest, reply: FastifyReply) {
    if (cfg.mode === 'dev') {
      const raw = req.headers['x-dev-user'];
      if (typeof raw !== 'string') return reply.code(401).send({ error: 'unauthenticated' });
      const [userId, roles = '', scopes = ''] = raw.split('|');
      if (!userId?.trim()) return reply.code(401).send({ error: 'unauthenticated' }); // blank identity is no identity
      req.user = { tenantId: cfg.platformTenantId, userId: userId!, roles: toRoles(roles.split(',')), projectScopes: scopes ? scopes.split(',') : [] };
      return;
    }
    const header = req.headers.authorization;
    if (!jwks || !header?.startsWith('Bearer ')) return reply.code(401).send({ error: 'unauthenticated' });
    let payload: JWTPayload;
    try {
      ({ payload } = await jwtVerify(header.slice(7), jwks, {
        issuer: `https://login.microsoftonline.com/${cfg.tenantId}/v2.0`,
        // v2 tokens for this API carry the client id; v1-style audiences use the api:// URI. Both name this app only.
        audience: cfg.clientId ? [cfg.clientId, `api://${cfg.clientId}`] : undefined,
      }));
    } catch {
      return reply.code(401).send({ error: 'invalid_token' });
    }
    const oid = String(payload.oid ?? payload.sub ?? '');
    const tokenRoles = toRoles(payload.roles);
    const resolved = cfg.resolveUser ? await cfg.resolveUser(oid, tokenRoles) : { roles: tokenRoles, projectScopes: [] };
    if (!resolved) return reply.code(403).send({ error: 'user_not_provisioned' });
    req.user = { tenantId: cfg.platformTenantId, userId: oid, ...resolved };
  };
}

export function requireRole(...allowed: Role[]): preHandlerHookHandler {
  return async (req, reply) => {
    if (!req.user) return reply.code(401).send({ error: 'unauthenticated' });
    if (!req.user.roles.some((r) => allowed.includes(r))) return reply.code(403).send({ error: 'forbidden' });
  };
}

/** True if the user may act on an object in `projectId` (empty scope list = no project access granted). */
export function canAccessProject(user: UserContext, projectId: string | null): boolean {
  if (projectId === null) return true;
  return user.roles.includes('owner') || user.roles.includes('admin') || user.projectScopes.includes(projectId);
}
