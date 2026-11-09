/** Operator-owned source configuration. Contains scope and credential REFERENCES only, never source passwords. */
import { Pool } from 'pg';
import type { SecretStore, SecretVersion } from '../setup/secrets.js';
import { entraTokenProvider } from '../../db/client.js';
import { DatabaseGateway, postgresResource } from './database.js';
import type { DbScope } from './plugins/database.js';
export interface SourceDatabaseConfig { id: string; name: string; host: string; port?: number; database: string; user: string; secret?: SecretVersion; scope: DbScope; projectIds: string[] }
const string = (v: unknown, max = 160): v is string => typeof v === 'string' && !!v && v.length <= max && !/[\x00-\x1f]/.test(v);
const strings = (v: unknown, max = 200): v is string[] => Array.isArray(v) && v.length <= max && v.every(x => string(x, 200));
export function parseSourceDatabaseConfig(raw: string | undefined): SourceDatabaseConfig[] {
  if (!raw) return [];
  try {
    if (raw.length > 50_000) throw Error();
    const data: unknown = JSON.parse(raw);
    if (!Array.isArray(data) || data.length > 10) throw Error();
    const seen = new Set<string>();
    for (const x of data) {
      if (!x || typeof x !== 'object' || Object.keys(x).some(k => !['id','name','host','port','database','user','secret','scope','projectIds'].includes(k)) || !string(x.id,80) || !/^[a-zA-Z0-9_-]+$/.test(x.id) || seen.has(x.id) || !string(x.name) || !string(x.host,253) || !/^(?=.{1,253}$)[a-zA-Z0-9](?:[a-zA-Z0-9.-]*[a-zA-Z0-9])?$/.test(x.host) || !string(x.database,128) || !string(x.user,128) || (x.port !== undefined && (!Number.isSafeInteger(x.port) || x.port < 1 || x.port > 65535)) || !strings(x.projectIds)) throw Error();
      seen.add(x.id);
      if (x.secret && (Object.keys(x.secret).some(k=>!['name','version'].includes(k)) || !string(x.secret.name,127) || !/^db-source-[a-zA-Z0-9-]+$/.test(x.secret.name) || !string(x.secret.version,100) || !/^[a-zA-Z0-9-]+$/.test(x.secret.version))) throw Error();
      const scope = x.scope;
      if (!scope || Object.keys(scope).some(k=>!['tables','audience','maxRows'].includes(k)) || !strings(scope.audience) || !scope.audience.length || !Number.isSafeInteger(scope.maxRows) || scope.maxRows < 1 || scope.maxRows > 1000 || !scope.tables || typeof scope.tables !== 'object' || Array.isArray(scope.tables) || !Object.keys(scope.tables).length || Object.keys(scope.tables).length > 50) throw Error();
      for (const [table, rawColumns] of Object.entries(scope.tables)) {
        const columns = rawColumns as {columns?:unknown;sensitive?:unknown};
        if (!columns || Object.keys(columns).some(k=>!['columns','sensitive'].includes(k)) || !/^[a-z_][a-z0-9_]*$/.test(table) || !strings(columns.columns,100) || !columns.columns.length || columns.columns.some(c=>!/^[a-z_][a-z0-9_]*$/.test(c)) || (columns.sensitive !== undefined && (!strings(columns.sensitive,100) || columns.sensitive.some(c=>!(columns.columns as string[]).includes(c))))) throw Error();
      }
    }
    return data as SourceDatabaseConfig[];
  } catch { throw Error('Invalid SOURCE_DATABASES_JSON: expected approved read-only source endpoints, scope and Key Vault references; credential values are forbidden'); }
}
export function configuredDatabases(configs: SourceDatabaseConfig[], secrets: SecretStore) {
  const pools = configs.map(c => new Pool({ host: c.host, port: c.port ?? 5432, database: c.database, user: c.user,
    password: c.secret ? () => secrets.get(c.secret!) : entraTokenProvider(), ssl: { rejectUnauthorized: true },
    max: 2, connectionTimeoutMillis: 5000, query_timeout: 7000, statement_timeout: 5000,
  }));
  return { gateway: new DatabaseGateway(configs.map((c,i)=>postgresResource(pools[i]!,c))), close: async () => { await Promise.all(pools.map(p=>p.end())); } };
}
