import { parse, type Expr, type ExprRef, type SelectFromStatement, type Statement } from 'pgsql-ast-parser';
import type { DbScope } from './database.js';

const IDENTIFIER = /^[a-z_][a-z0-9_]*$/;
const FUNCTIONS = new Set(['count', 'sum', 'min', 'max', 'avg', 'coalesce', 'lower', 'upper', 'date_trunc']);
const BINARY = new Set(['AND', 'OR', '=', '!=', '<>', '>', '>=', '<', '<=', 'LIKE', 'NOT LIKE', 'ILIKE', 'NOT ILIKE', '+', '-', '*', '/', '%']);
const UNARY = new Set(['NOT', '+', '-', 'IS NULL', 'IS NOT NULL', 'IS TRUE', 'IS NOT TRUE', 'IS FALSE', 'IS NOT FALSE']);
type Context = 'expression' | 'where' | 'join' | 'group' | 'order' | 'having';
interface Binding { table: string; alias: string; explicitAlias: boolean; columns: Set<string>; sensitive: Set<string> }

function fail(reason: string): never { throw new Error(`SELECT template rejected: ${reason}`); }
function shape(value: unknown, keys: readonly string[]): void {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !keys.includes(key))) {
    fail('unsupported AST shape');
  }
}
function identifier(value: unknown): string {
  if (typeof value !== 'string' || !IDENTIFIER.test(value)) fail('unsupported identifier');
  return value;
}

/**
 * Accepts a deliberately small PostgreSQL SELECT grammar. Unknown node types and modifiers fail closed.
 * Qualified columns resolve against their own relation; output aliases never become source columns.
 */
export function validateSelectAst(sql: string, scope: DbScope, declaredParameterCount: number): { maskedOutputs: Set<string> } {
  if (typeof sql !== 'string' || !sql.trim() || sql.length > 8000) fail('invalid SQL size');
  if (!Number.isSafeInteger(declaredParameterCount) || declaredParameterCount < 0 || declaredParameterCount > 20) fail('invalid parameter declaration count');
  // Existing gateway policy intentionally rejects these even inside string literals.
  if (/;|--|\/\*|"|`/.test(sql)) fail('comments, semicolons and quoted identifiers are unsupported');
  let statements: Statement[];
  try { statements = parse(sql); } catch { fail('invalid PostgreSQL syntax'); }
  if (statements.length !== 1 || statements[0]?.type !== 'select') fail('exactly one plain SELECT is required');
  const select: SelectFromStatement = statements[0];
  shape(select, ['type', 'columns', 'from', 'where', 'groupBy', 'having', 'orderBy', 'distinct']);
  if (select.distinct !== undefined && select.distinct !== null && select.distinct !== 'all' && select.distinct !== 'distinct') fail('DISTINCT ON is unsupported');
  if (!Array.isArray(select.from) || !select.from.length || select.from.length > 20) fail('approved source tables are required');
  if (!Array.isArray(select.columns) || !select.columns.length || select.columns.length > 100) fail('explicit output columns are required');

  const bindings: Binding[] = [];
  const aliases = new Map<string, Binding>();
  for (const [index, from] of select.from.entries()) {
    if (from.type !== 'table') fail('subqueries, functions and derived sources are unsupported');
    shape(from, ['type', 'name', 'join']);
    shape(from.name, ['name', 'schema', 'alias']);
    if (from.name.schema !== undefined && from.name.schema !== 'public') fail('only approved public tables are allowed');
    const table = identifier(from.name.name);
    if (!Object.hasOwn(scope.tables, table)) fail(`${table} is not allow-listed`);
    const approved = scope.tables[table]!;
    if (!Array.isArray(approved.columns) || !approved.columns.length) fail('source has no approved columns');
    const columns = new Set(approved.columns.map(identifier));
    const sensitive = new Set((approved.sensitive ?? []).map(identifier));
    if ([...sensitive].some(column => !columns.has(column))) fail('invalid sensitive-column scope');
    const alias = from.name.alias === undefined ? table : identifier(from.name.alias);
    if (aliases.has(alias)) fail('table aliases must be unique');
    const binding = { table, alias, explicitAlias: from.name.alias !== undefined, columns, sensitive };
    aliases.set(alias, binding); bindings.push(binding);
    if (index === 0 && from.join) fail('unexpected initial join');
    if (index > 0 && !from.join) fail('implicit/cross joins are unsupported');
    if (from.join) {
      shape(from.join, ['type', 'on']);
      if (!['INNER JOIN', 'LEFT JOIN'].includes(from.join.type) || !from.join.on) fail('only INNER/LEFT JOIN ON is supported');
    }
  }

  const explicitOutputAliases = new Set<string>();
  for (const column of select.columns) {
    shape(column, ['expr', 'alias']);
    if (column.alias) { shape(column.alias, ['name']); explicitOutputAliases.add(identifier(column.alias.name)); }
  }
  let nodes = 0;
  function resolve(ref: ExprRef, context: Context, available: ReadonlyMap<string, Binding>): { binding: Binding; name: string } {
    shape(ref, ['type', 'name', 'table']);
    if (ref.name === '*') fail('SELECT * and whole-row wildcards are unsupported');
    const name = identifier(ref.name);
    let binding: Binding | undefined;
    if (ref.table) {
      shape(ref.table, ['name', 'schema']);
      const qualifier = identifier(ref.table.name);
      binding = available.get(qualifier);
      if (!binding) fail(`unknown table or alias ${qualifier} is not available`);
      if (ref.table.schema !== undefined && (ref.table.schema !== 'public' || binding.explicitAlias || qualifier !== binding.table)) fail('invalid qualified source reference');
    } else {
      // An allowlist does not prove that another table lacks an excluded same-named physical column.
      if (available.size !== 1) fail(`qualify ${name} with its table or alias when multiple tables are present`);
      if (['order', 'group', 'having'].includes(context) && explicitOutputAliases.has(name)) fail('output aliases cannot be referenced in inference clauses; qualify the source column');
      binding = [...available.values()][0];
    }
    if (!binding || !binding.columns.has(name)) fail(`${name} is not allow-listed for ${binding?.table ?? 'its source'}; whole-row/table/output aliases are unsupported`);
    return { binding, name };
  }
  function expression(expr: Expr, context: Context, available: ReadonlyMap<string, Binding>, depth = 0): void {
    if (!expr || depth > 32 || ++nodes > 2000) fail('expression exceeds complexity limits');
    switch (expr.type) {
      case 'ref': {
        const resolved = resolve(expr, context, available);
        if (resolved.binding.sensitive.has(resolved.name)) fail('sensitive columns may only be direct SELECT outputs');
        return;
      }
      case 'integer': case 'numeric':
        shape(expr, ['type', 'value']);
        if (typeof expr.value !== 'number' || !Number.isFinite(expr.value) || expr.type === 'integer' && !Number.isSafeInteger(expr.value)) fail('invalid numeric literal');
        return;
      case 'string':
        shape(expr, ['type', 'value']);
        if (typeof expr.value !== 'string' || expr.value.length > 8000) fail('invalid string literal');
        return;
      case 'boolean':
        shape(expr, ['type', 'value']);
        if (typeof expr.value !== 'boolean') fail('invalid boolean literal');
        return;
      case 'null': shape(expr, ['type']); return;
      case 'parameter': {
        shape(expr, ['type', 'name']);
        if (!/^\$[1-9]\d*$/.test(expr.name) || Number(expr.name.slice(1)) > declaredParameterCount) fail('undeclared parameter');
        return;
      }
      case 'unary':
        shape(expr, ['type', 'op', 'operand']);
        if (!UNARY.has(expr.op)) fail('unsupported unary operator');
        expression(expr.operand, context, available, depth + 1); return;
      case 'binary':
        shape(expr, ['type', 'op', 'left', 'right']);
        expression(expr.left, context, available, depth + 1);
        if (expr.op === 'IN' || expr.op === 'NOT IN') {
          if (expr.right.type !== 'list') fail('IN requires a literal/parameter expression list');
          shape(expr.right, ['type', 'expressions']);
          if (!Array.isArray(expr.right.expressions) || !expr.right.expressions.length || expr.right.expressions.length > 200) fail('invalid IN list');
          for (const item of expr.right.expressions) expression(item, context, available, depth + 1);
        } else {
          if (!BINARY.has(expr.op)) fail('unsupported binary operator');
          expression(expr.right, context, available, depth + 1);
        }
        return;
      case 'ternary':
        shape(expr, ['type', 'op', 'value', 'lo', 'hi']);
        if (expr.op !== 'BETWEEN' && expr.op !== 'NOT BETWEEN') fail('unsupported ternary operator');
        expression(expr.value, context, available, depth + 1); expression(expr.lo, context, available, depth + 1); expression(expr.hi, context, available, depth + 1); return;
      case 'call': {
        shape(expr, ['type', 'function', 'args']);
        shape(expr.function, ['name', 'schema']);
        const name = identifier(expr.function.name);
        if (!FUNCTIONS.has(name) || expr.function.schema !== undefined && expr.function.schema !== 'pg_catalog') fail('function is not allow-listed');
        if (!Array.isArray(expr.args) || !expr.args.length || expr.args.length > 20 || name === 'date_trunc' && expr.args.length !== 2 || name !== 'date_trunc' && name !== 'coalesce' && expr.args.length !== 1) fail('invalid function arguments');
        const star = expr.args[0];
        if (name === 'count' && expr.args.length === 1 && star?.type === 'ref' && star.name === '*' && star.table === undefined) {
          shape(star, ['type', 'name']); return;
        }
        for (const argument of expr.args) expression(argument, context, available, depth + 1);
        return;
      }
      default: fail('unsupported expression AST; subqueries, casts, arrays, members and special syntax are disabled');
    }
  }

  // JOIN ON sees only the relations introduced so far, never a later alias.
  const available = new Map<string, Binding>();
  for (const [index, from] of select.from.entries()) {
    const binding = bindings[index]!; available.set(binding.alias, binding);
    if (from.type === 'table' && from.join?.on) expression(from.join.on, 'join', available);
  }
  const maskedOutputs = new Set<string>();
  const outputs = new Set<string>();
  for (const column of select.columns) {
    const expr = column.expr;
    const output = column.alias?.name ?? (expr.type === 'ref' ? expr.name : expr.type === 'call' ? expr.function.name : '?column?');
    if (outputs.has(output)) fail('duplicate output names are unsupported');
    outputs.add(output);
    if (expr.type === 'ref') {
      const resolved = resolve(expr, 'expression', aliases);
      if (resolved.binding.sensitive.has(resolved.name)) maskedOutputs.add(output);
    } else expression(expr, 'expression', aliases);
  }
  if (select.distinct === 'distinct' && maskedOutputs.size > 0) fail('DISTINCT groups sensitive raw values before masking');
  if (select.where) expression(select.where, 'where', aliases);
  if (select.having) expression(select.having, 'having', aliases);
  if (select.groupBy) for (const group of select.groupBy) {
    if (group.type === 'integer' || group.type === 'numeric') fail('GROUP BY ordinals are unsupported');
    expression(group, 'group', aliases);
  }
  if (select.orderBy) for (const order of select.orderBy) {
    shape(order, ['by', 'order', 'nulls']);
    if (order.order !== undefined && order.order !== null && order.order !== 'ASC' && order.order !== 'DESC' || order.nulls !== undefined && order.nulls !== null && order.nulls !== 'FIRST' && order.nulls !== 'LAST') fail('unsupported ordering');
    if (order.by.type === 'integer' || order.by.type === 'numeric') fail('ORDER BY ordinals are unsupported');
    expression(order.by, 'order', aliases);
  }
  return { maskedOutputs };
}
