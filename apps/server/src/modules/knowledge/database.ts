import type { KnowledgeSourcePlugin, UserContext } from '@superagent/shared';
import { Pool } from 'pg';
import { createDatabasePlugin, runTemplate, validateTemplate, type DbClient, type DbScope, type QueryTemplate } from './plugins/database.js';
import { hash, KnowledgeError } from './domain.js';
/** Provisioned by the deployment operator with a separate SELECT-only source identity; never the platform pool. */
export interface DatabaseResource {
  id: string; name: string; scope: DbScope; projectIds: string[];
  inspect(): Promise<{ version: string; tables: Record<string, { column: string; type: string }[]> }>;
  verifyReadOnly(): Promise<boolean>;
  open(): Promise<{ client: DbClient; release(): void }>;
}
export interface StoredQueryTemplate extends QueryTemplate { connectionId: string; scopeSignature: string; schemaVersion: string }
export class DatabaseGateway {
  private resources: Map<string, DatabaseResource>;
  readonly plugin: KnowledgeSourcePlugin;
  constructor(resources: DatabaseResource[]) {
    this.resources = new Map(resources.map(r => [r.id, r]));
    const base = createDatabasePlugin(async scope => {
      const resource = this.resource((scope as DbScope & { resourceId?: string }).resourceId);
      if (!await resource.verifyReadOnly()) throw new KnowledgeError('readonly_account_required', '数据库来源必须使用经核验的独立只读账号。', 409);
      const schema = await resource.inspect();
      const tables = Object.fromEntries(Object.entries(schema.tables).filter(([name]) => !!scope.tables[name]).map(([name, cols]) => [name, cols.filter(c => scope.tables[name]!.columns.includes(c.column))]));
      return { version: schema.version, tables };
    });
    this.plugin = { ...base, manifest: { ...base.manifest, id: 'database' } };
  }
  private resource(resourceId: unknown) { const r = typeof resourceId === 'string' ? this.resources.get(resourceId) : undefined; if (!r) throw new KnowledgeError('unknown_database', '未配置此只读数据库来源。', 404); return r; }
  permitted(ctx: UserContext, resource: DatabaseResource) { return resource.scope.audience.includes(ctx.userId) && resource.projectIds.every(p => ctx.projectScopes.includes(p)); }
  list(ctx: UserContext) { return [...this.resources.values()].filter(r => this.permitted(ctx, r)).map(r => ({ id: r.id, name: r.name, tables: r.scope.tables, maxRows: r.scope.maxRows })); }
  scope(ctx: UserContext, requested: Record<string, unknown>): DbScope & { resourceId: string; projectIds: string[] } {
    const r = this.resource(requested.resourceId); if (!this.permitted(ctx, r)) throw new KnowledgeError('source_denied', '当前账号没有数据库来源的读取范围。', 403);
    // The server resource defines the DBA-approved row-filtered views, columns, masks and audience. User JSON cannot expand it.
    const audience = requested.audience ?? [ctx.userId];
    if (!Array.isArray(audience) || !audience.length || audience.some(p => typeof p !== 'string' || !r.scope.audience.includes(p))) throw new KnowledgeError('scope_denied', '连接读者必须在数据库授权范围内。', 403);
    return { ...structuredClone(r.scope), audience, resourceId: r.id, projectIds: r.projectIds };
  }
  async approve(ctx: UserContext, connectionId: string, scope: Record<string, unknown>, input: Record<string, unknown>): Promise<StoredQueryTemplate> {
    const effective = this.scope(ctx, scope), resource = this.resource(effective.resourceId);
    if (typeof input.sql !== 'string' || input.sql.length > 8000 || !Array.isArray(input.params) || input.params.length > 20 || input.params.some(v => typeof v !== 'string' || !/^[a-zA-Z_][a-zA-Z0-9_]{0,63}$/.test(v))) throw new KnowledgeError('invalid_template', '查询模板或参数声明无效。');
    const schema = await resource.inspect();
    const scopeSignature = hash(JSON.stringify(effective));
    const template = { id: hash(JSON.stringify([connectionId, input.sql, input.params, schema.version, scopeSignature])), connectionId, sql: input.sql, params: input.params as string[], approvedBy: ctx.userId, scopeSignature, schemaVersion: schema.version };
    try { validateTemplate(template, effective); } catch { throw new KnowledgeError('invalid_template', '查询必须为批准范围内的单条 SELECT，敏感列和参数必须遵守查询网关规则。', 422); }
    return template;
  }
  async run(ctx: UserContext, scope: Record<string, unknown>, template: StoredQueryTemplate, args: unknown[]) {
    const effective = this.scope(ctx, scope), resource = this.resource(effective.resourceId), schema = await resource.inspect();
    if (template.scopeSignature !== hash(JSON.stringify(effective)) || template.schemaVersion !== schema.version) throw new KnowledgeError('template_stale', '数据库结构或范围已变化，请重新审批查询模板。', 409);
    if (!Array.isArray(args) || args.length > 20 || args.some(v => v !== null && typeof v !== 'boolean' && !(typeof v === 'number' && Number.isFinite(v)) && !(typeof v === 'string' && v.length <= 4000))) throw new KnowledgeError('invalid_parameters', '查询参数无效。');
    if (args.length !== template.params.length) throw new KnowledgeError('invalid_parameters', '查询参数数量与已审批模板不符。');
    if (!await resource.verifyReadOnly()) throw new KnowledgeError('readonly_account_required', '数据库账号不满足只读要求。', 409);
    const db = await resource.open();
    const pinned: DbClient = { query: async (sql, params) => {
      const result = await db.client.query(sql, params);
      if (sql === 'BEGIN READ ONLY') {
        try { await db.client.query('SET LOCAL search_path = pg_catalog, public, pg_temp'); }
        catch (error) { await db.client.query('ROLLBACK').catch(() => undefined); throw error; }
      }
      return result;
    } };
    try {
      const result = await runTemplate(pinned, template, args, effective, schema.version, 5000);
      if (hash(JSON.stringify(this.scope(ctx, scope))) !== template.scopeSignature) throw new KnowledgeError('template_stale', '查询期间来源权限或范围变化，结果已撤回。', 409);
      return result;
    } finally { db.release(); }
  }
}
/** Actual PostgreSQL driver adapter. Row visibility is provided by DBA-owned filtered views, never a client predicate. */
export function postgresResource(pool: Pool, config: Omit<DatabaseResource, 'inspect' | 'verifyReadOnly' | 'open'>): DatabaseResource {
  const allowed = Object.keys(config.scope.tables);
  const safe = /^[a-z_][a-z0-9_]*$/;
  if (!allowed.length || allowed.some(t => !safe.test(t)) || Object.values(config.scope.tables).some(t => !t.columns.length || t.columns.some(c => !safe.test(c)))) throw Error('Database views/columns require simple allow-listed identifiers');
  return {
    ...config,
    async inspect() {
      const result = await pool.query<{ table_name: string; column_name: string; data_type: string }>("SELECT table_name,column_name,data_type FROM information_schema.columns WHERE table_schema='public' AND table_name=ANY($1::text[]) ORDER BY table_name,ordinal_position", [allowed]);
      const tables: Record<string, { column: string; type: string }[]> = {};
      for (const table of allowed) { const columns = result.rows.filter(r => r.table_name === table && config.scope.tables[table]!.columns.includes(r.column_name)); if (columns.length !== config.scope.tables[table]!.columns.length) throw new KnowledgeError('schema_changed', '批准的表或列不存在。', 409); tables[table] = columns.map(r => ({ column: r.column_name, type: r.data_type })); }
      const views = await pool.query("SELECT c.relname, pg_get_viewdef(c.oid,true) AS definition FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind IN ('v','m') AND c.relname=ANY($1::text[]) ORDER BY c.relname", [allowed]);
      return { version: hash(JSON.stringify([tables, views.rows])), tables };
    },
    async verifyReadOnly() {
      const result = await pool.query<{ elevated: boolean }>(`SELECT (r.rolsuper OR r.rolcreatedb OR r.rolcreaterole OR r.rolbypassrls OR
        has_database_privilege(current_user,current_database(),'CREATE') OR
        EXISTS(SELECT 1 FROM pg_namespace n WHERE n.nspname NOT LIKE 'pg_%' AND n.nspname<>'information_schema' AND has_schema_privilege(current_user,n.oid,'CREATE')) OR
        EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname NOT LIKE 'pg_%' AND n.nspname<>'information_schema' AND c.relkind IN ('r','p','v','m') AND
          (has_table_privilege(current_user,c.oid,'INSERT,UPDATE,DELETE,TRUNCATE,TRIGGER') OR has_any_column_privilege(current_user,c.oid,'INSERT,UPDATE') OR
          (n.nspname='public' AND c.relname <> ALL($1::text[]) AND (has_table_privilege(current_user,c.oid,'SELECT') OR has_any_column_privilege(current_user,c.oid,'SELECT')))))) AS elevated
        FROM pg_roles r WHERE r.rolname=current_user`, [allowed]);
      return result.rows[0]?.elevated === false;
    },
    async open() { const client = await pool.connect(); return { client: { query: async (sql, params) => { const result = await client.query(sql, params); return { rows: result.rows }; } }, release: () => client.release() }; },
  };
}
