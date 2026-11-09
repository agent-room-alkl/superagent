import type { FastifyPluginAsync } from 'fastify';
import type { Role } from '@superagent/shared';
import { setupModule } from './setup/index.js';
import { knowledgeModule } from './knowledge/index.js';
import { roomModule } from './room/index.js';

export interface ModuleDef {
  prefix: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  plugin: FastifyPluginAsync<any>;
  /** Roles allowed to call this module (server-side check). Omit = any signed-in user. */
  roles?: Role[];
}

/** Mount points. Add your module here in its own PR; do not edit other owners' modules. */
export const modules: ModuleDef[] = [
  { prefix: 'setup', plugin: setupModule, roles: ['admin', 'owner'] }, // T-39 Claude
  { prefix: 'knowledge', plugin: knowledgeModule }, // T-40 Codex
  { prefix: 'room', plugin: roomModule },         // T-41 Grok
];
