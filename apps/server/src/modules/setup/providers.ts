/**
 * LLM provider adapters behind the shared LlmProvider contract (PRD §5.4).
 * Plain fetch — no vendor SDK lock-in in business code. Keys are passed in per call and never logged.
 */
import type { ChatRequest, ChatResponse, LlmProvider, LlmProviderId, ModelInfo } from '@superagent/shared';

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export class ProviderHttpError extends Error {
  constructor(public status: number, public kind: 'auth' | 'quota' | 'not_found' | 'forbidden' | 'transient' | 'other', message: string) {
    super(message);
  }
}

function classify(status: number): ProviderHttpError['kind'] {
  if (status === 401) return 'auth';
  if (status === 403) return 'forbidden';
  if (status === 404) return 'not_found';
  if (status === 402 || status === 429) return 'quota';
  if (status >= 500) return 'transient';
  return 'other';
}

async function call(fetchFn: FetchLike, url: string, init: RequestInit): Promise<any> {
  const res = await fetchFn(url, init);
  if (!res.ok) throw new ProviderHttpError(res.status, classify(res.status), `provider responded ${res.status}`);
  return res.json();
}

export interface ProviderConfig {
  provider: LlmProviderId;
  apiKey: string;
  endpoint?: string; // Azure OpenAI resource endpoint
  apiVersion?: string; // Azure OpenAI
  deployments?: string[]; // Azure OpenAI deployment names entered by admin
}

export function createProvider(cfg: ProviderConfig, fetchFn: FetchLike = fetch): LlmProvider {
  switch (cfg.provider) {
    case 'anthropic':
      return anthropic(cfg, fetchFn);
    case 'openai':
      return openai(cfg, fetchFn, 'https://api.openai.com/v1', { Authorization: `Bearer ${cfg.apiKey}` });
    case 'azure-openai':
      return azureOpenai(cfg, fetchFn);
  }
}

function anthropic(cfg: ProviderConfig, fetchFn: FetchLike): LlmProvider {
  const headers = { 'x-api-key': cfg.apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' };
  return {
    id: 'anthropic',
    async listModels(): Promise<ModelInfo[]> {
      const j = await call(fetchFn, 'https://api.anthropic.com/v1/models?limit=100', { headers });
      return (j.data ?? []).map((m: any) => ({ id: m.id, provider: 'anthropic', displayName: m.display_name, verified: null }));
    },
    async chat(req: ChatRequest): Promise<ChatResponse> {
      const system = req.messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n');
      const body = {
        model: req.model,
        max_tokens: req.maxOutputTokens,
        ...(system ? { system } : {}),
        messages: req.messages.filter((m) => m.role !== 'system').map((m) => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: m.content })),
        ...(req.tools?.length ? { tools: req.tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.inputSchema })) } : {}),
      };
      const j = await call(fetchFn, 'https://api.anthropic.com/v1/messages', { method: 'POST', headers, body: JSON.stringify(body) });
      const content: any[] = j.content ?? [];
      return {
        text: content.filter((c) => c.type === 'text').map((c) => c.text).join(''),
        toolCalls: content.filter((c) => c.type === 'tool_use').map((c) => ({ id: c.id, name: c.name, input: c.input })),
        usage: { inputTokens: j.usage?.input_tokens ?? 0, outputTokens: j.usage?.output_tokens ?? 0 },
        stopReason: j.stop_reason ?? 'unknown',
      };
    },
    async structured<T>(req: ChatRequest, schema: Record<string, unknown>): Promise<T> {
      return structuredViaTool<T>(this, req, schema);
    },
  };
}

function openai(cfg: ProviderConfig, fetchFn: FetchLike, base: string, auth: Record<string, string>, id: LlmProviderId = 'openai', modelsUrl = `${base}/models`, chatUrl = (_m: string) => `${base}/chat/completions`): LlmProvider {
  const headers = { ...auth, 'content-type': 'application/json' };
  return {
    id,
    async listModels(): Promise<ModelInfo[]> {
      const j = await call(fetchFn, modelsUrl, { headers });
      return (j.data ?? []).map((m: any) => ({ id: m.id, provider: id, verified: null }));
    },
    async chat(req: ChatRequest): Promise<ChatResponse> {
      const body = {
        model: req.model,
        max_completion_tokens: req.maxOutputTokens,
        messages: req.messages.map((m) => ({ role: m.role === 'tool' ? 'user' : m.role, content: m.content })),
        ...(req.tools?.length ? { tools: req.tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.inputSchema } })) } : {}),
      };
      const j = await call(fetchFn, chatUrl(req.model), { method: 'POST', headers, body: JSON.stringify(body) });
      const msg = j.choices?.[0]?.message ?? {};
      return {
        text: msg.content ?? '',
        toolCalls: (msg.tool_calls ?? []).map((t: any) => ({ id: t.id, name: t.function?.name, input: safeJson(t.function?.arguments) })),
        usage: { inputTokens: j.usage?.prompt_tokens ?? 0, outputTokens: j.usage?.completion_tokens ?? 0 },
        stopReason: j.choices?.[0]?.finish_reason ?? 'unknown',
      };
    },
    async structured<T>(req: ChatRequest, schema: Record<string, unknown>): Promise<T> {
      return structuredViaTool<T>(this, req, schema);
    },
  };
}

function azureOpenai(cfg: ProviderConfig, fetchFn: FetchLike): LlmProvider {
  if (!cfg.endpoint) throw new Error('Azure OpenAI requires an endpoint');
  const base = cfg.endpoint.replace(/\/$/, '');
  const v = cfg.apiVersion ?? '2024-10-21';
  const inner = openai(cfg, fetchFn, base, { 'api-key': cfg.apiKey }, 'azure-openai', `${base}/openai/deployments?api-version=${v}`, (m) => `${base}/openai/deployments/${encodeURIComponent(m)}/chat/completions?api-version=${v}`);
  return {
    ...inner,
    // Deployments are what Azure callers address; fall back to admin-entered names when listing is not permitted.
    async listModels(): Promise<ModelInfo[]> {
      try {
        return await inner.listModels();
      } catch (e) {
        if (cfg.deployments?.length) return cfg.deployments.map((d) => ({ id: d, provider: 'azure-openai', verified: null }));
        throw e;
      }
    },
  };
}

async function structuredViaTool<T>(p: LlmProvider, req: ChatRequest, schema: Record<string, unknown>): Promise<T> {
  const res = await p.chat({ ...req, tools: [{ name: 'emit_result', description: 'Return the result as structured data.', inputSchema: schema }] });
  const call0 = res.toolCalls.find((c) => c.name === 'emit_result');
  if (call0) return call0.input as T;
  return JSON.parse(res.text) as T;
}

function safeJson(s: unknown): unknown {
  if (typeof s !== 'string') return s;
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
}
