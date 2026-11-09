import { it, expect } from 'vitest';
import type { ChatResponse } from '@superagent/shared';
import { GatewayAnalysisModel, type AnalysisGateway } from '../src/modules/analysis/gateway-model.js';
it('analysis uses only the budget gateway, bounded output and an untrusted-source system instruction', async () => {
 let request: unknown; const gateway: AnalysisGateway = { check: async () => ({ok:true,model:'m'}), chat: async (_tenant,_tier,req) => { request=req; return {text:'[]',toolCalls:[],usage:{inputTokens:1,outputTokens:1},stopReason:'end'}; } };
 const model = new GatewayAnalysisModel(gateway); await model.check('t'); expect(await model.recommend({tenantId:'t',runId:'r',evidence:[],maxOutputTokens:4096})).toEqual([]);
 expect(request).toMatchObject({maxOutputTokens:4096,taskId:'r'}); expect((request as {messages:{content:string}[]}).messages[0]!.content).toContain('untrusted data');
});
it('model readiness preserves specific setup errors before a job is created', async () => {
 const model = new GatewayAnalysisModel({check:async()=>({ok:false,code:'llm_not_configured'}),chat:async()=>{throw Error('must not call')}});
 await expect(model.check('t')).rejects.toMatchObject({code:'llm_not_configured',statusCode:503});
});
it('invalid model JSON and tool calls cannot become organization drafts', async () => {
 const response: ChatResponse = {text:'```json\n[]\n```',toolCalls:[],usage:{inputTokens:1,outputTokens:1},stopReason:'end'};
 const model = new GatewayAnalysisModel({check:async()=>({ok:true,model:'m'}),chat:async()=>response});
 await expect(model.recommend({tenantId:'t',runId:'r',evidence:[],maxOutputTokens:4096})).rejects.toMatchObject({code:'invalid_model_output'});
 response.text='[]'; response.toolCalls=[{id:'t',name:'publish',input:{}}]; await expect(model.recommend({tenantId:'t',runId:'r',evidence:[],maxOutputTokens:4096})).rejects.toMatchObject({code:'invalid_model_output'});
});
