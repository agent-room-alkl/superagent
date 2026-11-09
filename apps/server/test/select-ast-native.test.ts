/** Native PostgreSQL semantics regression; synthetic isolated relations only. */
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { describe,it,expect,afterAll } from 'vitest';
import { runTemplate,validateTemplate,type DbScope } from '../src/modules/knowledge/plugins/database.js';
const d=process.env.DATABASE_URL?describe:describe.skip;
d('SELECT policy against native PostgreSQL',()=>{
 const pool=new Pool({connectionString:process.env.DATABASE_URL}); afterAll(()=>pool.end());
 it('rejects physical-column and composite leaks while executing approved bound SELECTs',async()=>{
  const suffix=randomUUID().replaceAll('-','').slice(0,16), invoices=`guard_i_${suffix}`, vendors=`guard_v_${suffix}`;
  const scope:DbScope={audience:['test-reader'],maxRows:5,tables:{[invoices]:{columns:['id','vendor','contact_email'],sensitive:['contact_email']},[vendors]:{columns:['id','iban']}}};
  const template=(sql:string)=>({id:'approved-test',sql,params:[],approvedBy:'test-owner'});
  try{
   await pool.query(`CREATE TABLE ${invoices}(id integer,vendor integer,iban text,contact_email text)`);
   await pool.query(`CREATE TABLE ${vendors}(id integer,iban text)`);
   await pool.query(`INSERT INTO ${invoices} VALUES(1,7,'synthetic-hidden','person@synthetic.example')`);
   await pool.query(`INSERT INTO ${vendors} VALUES(7,'synthetic-approved')`);
   // Prove why checking a word union was unsafe: PostgreSQL can resolve these valid statements to hidden data.
   expect((await pool.query(`SELECT i.iban FROM ${invoices} i JOIN ${vendors} v ON i.vendor=v.id`)).rows[0].iban).toBe('synthetic-hidden');
   expect(String((await pool.query(`SELECT i AS whole_row FROM ${invoices} i`)).rows[0].whole_row)).toContain('synthetic-hidden');
   for(const sql of [`SELECT i.iban FROM ${invoices} i JOIN ${vendors} v ON i.vendor=v.id`,`SELECT i FROM ${invoices} i`,`SELECT ${invoices} FROM ${invoices}`,`SELECT iban FROM ${invoices} AS iban`,`SELECT id AS iban,iban FROM ${invoices}`]) expect(()=>validateTemplate(template(sql),scope)).toThrow();
   const client=await pool.connect();
   try{
    const safe=await runTemplate(client,{...template(`SELECT i.id,v.iban,i.contact_email AS masked FROM ${invoices} i JOIN ${vendors} v ON i.vendor=v.id WHERE i.id=$1`),params:['id']},[1],scope,'native-v1');
    expect(safe.rows).toEqual([{id:1,iban:'synthetic-approved',masked:'p***@synthetic.example'}]);
   }finally{client.release();}
  }finally{await pool.query(`DROP TABLE IF EXISTS ${invoices},${vendors}`);}
 },30_000);
});
