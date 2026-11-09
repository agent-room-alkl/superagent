import { it, expect } from 'vitest';
import { parseSourceDatabaseConfig } from '../src/modules/knowledge/database-config.js';
const valid = { id:'finance',name:'Approved views',host:'source.example.invalid',database:'source',user:'reader',scope:{audience:['alice'],maxRows:50,tables:{approved_invoices:{columns:['id','email'],sensitive:['email']}}},projectIds:['finance'] };
it('accepts explicit source scope with Entra or a source-only Vault reference',()=>{
 expect(parseSourceDatabaseConfig(undefined)).toEqual([]); expect(parseSourceDatabaseConfig(JSON.stringify([valid]))).toEqual([valid]);
 const keyed={...valid,secret:{name:'db-source-finance',version:'v1'}}; expect(parseSourceDatabaseConfig(JSON.stringify([keyed]))).toEqual([keyed]);
});
it.each([
 {password:'not-accepted'}, {connectionString:'not-accepted'}, {host:'https://source.invalid/path'}, {port:0}, {secret:{name:'llm-provider-key',version:'v1'}}, {secret:{name:'db-source-finance',version:'v1',password:'not-accepted'}},
 {scope:{...valid.scope,maxRows:0}}, {scope:{...valid.scope,maxRows:1.5}}, {scope:{...valid.scope,audience:[]}}, {scope:{...valid.scope,tables:{bad:{columns:['bad;drop']}}}}, {scope:{...valid.scope,tables:{approved_invoices:{columns:['id'],sensitive:['missing']}}}},
])('rejects credentials and invalid resource scope without echoing supplied values (%j)',bad=>{
 const raw=JSON.stringify([{...valid,...bad}]); expect(()=>parseSourceDatabaseConfig(raw)).toThrow('SOURCE_DATABASES_JSON');
 try { parseSourceDatabaseConfig(raw); } catch(error) { expect((error as Error).message).not.toContain('not-accepted'); }
});
it('rejects duplicate resource ids and excessive or malformed configuration',()=>{
 expect(()=>parseSourceDatabaseConfig(JSON.stringify([valid,valid]))).toThrow(); expect(()=>parseSourceDatabaseConfig('invalid')).toThrow(); expect(()=>parseSourceDatabaseConfig(' '.repeat(50001))).toThrow();
});
