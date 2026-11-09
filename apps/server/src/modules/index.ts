import type { FastifyPluginAsync } from 'fastify';
import { setupModule } from './setup/index.js';
import { knowledgeModule } from './knowledge/index.js';
import { roomModule } from './room/index.js';

export interface ModuleDef {
  prefix: string;
  plugin: FastifyPluginAsync;
}

/** Mount points. Add your module here in its own PR; do not edit other owners' modules. */
export const modules: ModuleDef[] = [
  { prefix: 'setup', plugin: setupModule },       // T-39 Claude
  { prefix: 'knowledge', plugin: knowledgeModule }, // T-40 Codex
  { prefix: 'room', plugin: roomModule },         // T-41 Grok
];
