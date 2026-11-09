import type { FastifyPluginAsync } from 'fastify';
import type { Role } from '@superagent/shared';
import { setupModule } from './setup/index.js';
import { knowledgeModule } from './knowledge/index.js';
import { roomModule } from './room/index.js';
import { employeesModule } from './employees/index.js';
import { toolsModule } from './tools/index.js';
import { runtimeModule } from './runtime/index.js';
import { gatewayModule } from './gateway/index.js';
import { humanworkModule } from './humanwork/index.js';
import { sopModule } from './sop/index.js';
import { executionModule } from './execution/index.js';

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
  { prefix: 'employees', plugin: employeesModule, roles: ['admin', 'owner'] }, // T-42
  { prefix: 'tools', plugin: toolsModule, roles: ['admin', 'owner', 'reviewer'] }, // T-42
  { prefix: 'runtime', plugin: runtimeModule },   // T-41 Grok
  { prefix: 'gateway', plugin: gatewayModule },   // T-41 Grok
  { prefix: 'work-items', plugin: humanworkModule }, // T-41 Grok
  { prefix: 'sop', plugin: sopModule, roles: ['admin', 'owner'] }, // T-41 Grok (runtime) / T-48 page
  { prefix: 'executions', plugin: executionModule, roles: ['admin', 'owner'] }, // T-56 executor
];
