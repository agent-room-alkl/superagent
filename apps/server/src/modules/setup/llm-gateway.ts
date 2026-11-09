/**
 * Budgeted LLM gateway (PRD §3.1, §5.4): the only path from platform code to a model.
 *   Setup config → key from Key Vault → bounded reservation → call → settle / release / freeze.
 * The reservation is a proven upper bound: input tokens ≤ UTF-8 bytes of the serialised request (every token is at
 * least one byte), output tokens ≤ maxOutputTokens. Models without a price, or whose billing cannot be bounded, are
 * refused: there is no soft cap and no fallback "fake" model.
 */
import type { ChatRequest, ChatResponse, LlmProvider } from '@superagent/shared';
import { maxBillableMicroUsd, actualMicroUsd, type BudgetStore, type Price } from './budget.js';
import { createProvider, ProviderHttpError, type ProviderConfig } from './providers.js';
import type { SecretStore } from './secrets.js';
import type { ConfigRepo } from './service.js';

export type LlmUnavailableCode = 'llm_not_configured' | 'llm_key_invalid' | 'model_not_selected' | 'price_unknown' | 'budget_not_set' | 'budget_exhausted';

export class LlmUnavailable extends Error {
  constructor(public code: LlmUnavailableCode, message: string) {
    super(message);
    this.name = 'LlmUnavailable';
  }
}

/** The provider refused or the outcome is unknown; `billing` says what happened to the reservation. */
export class LlmCallFailed extends Error {
  constructor(public billing: 'released' | 'frozen_unknown', public providerStatus: number | null, message: string) {
    super(message);
    this.name = 'LlmCallFailed';
  }
}

/**
 * A verified model record: prices plus the protocol overhead (system/message/tool wrapper tokens) measured by the
 * platform's capability test. Both are needed to state a hard upper bound; a record missing either is unusable.
 */
export interface PricedModel extends Price {
  overheadTokens: { perRequest: number; perMessage: number; perTool: number };
}

export interface PriceBook {
  price(provider: string, model: string): Promise<PricedModel | null>;
  /** Called when a call cost more than its reservation: the record stops being usable until re-verified. */
  markUnbounded(provider: string, model: string, detail: Record<string, unknown>): Promise<void>;
}

const nonNegInt = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;

/** Accepts only finite, non-negative integer prices and overheads with fullyBoundable === true. */
export function validPricedModel(v: unknown): PricedModel | null {
  const p = v as Partial<PricedModel> | null | undefined;
  if (!p || !nonNegInt(p.inputPerMTokMicroUsd) || !nonNegInt(p.outputPerMTokMicroUsd) || p.fullyBoundable !== true) return null;
  const o = p.overheadTokens;
  if (!o || !nonNegInt(o.perRequest) || !nonNegInt(o.perMessage) || !nonNegInt(o.perTool)) return null;
  return { inputPerMTokMicroUsd: p.inputPerMTokMicroUsd, outputPerMTokMicroUsd: p.outputPerMTokMicroUsd, fullyBoundable: true, overheadTokens: { perRequest: o.perRequest, perMessage: o.perMessage, perTool: o.perTool } };
}

export interface LlmGatewayDeps {
  repo: ConfigRepo;
  secrets: SecretStore;
  budget: BudgetStore;
  prices: PriceBook;
  providerFactory?: (cfg: ProviderConfig) => LlmProvider;
  now?: () => Date;
  /** Deadline for one provider call (default 120 s). Expiry is an unknown outcome: the reservation is frozen. */
  timeoutMs?: number;
}

export type Tier = 'primary' | 'economy';
export type BudgetedRequest = Omit<ChatRequest, 'model'>;
export interface BudgetedResponse extends ChatResponse {
  model: string;
  reservedMicroUsd: number;
  costMicroUsd: number;
}

/**
 * Input-token upper bound: every content token is at least one UTF-8 byte of the serialised request, plus the
 * protocol overhead the platform measured for this model (per request, per message, per tool definition).
 */
export function inputTokenUpperBound(req: BudgetedRequest, overhead: PricedModel['overheadTokens']): number {
  const bytes = Buffer.byteLength(JSON.stringify({ messages: req.messages, tools: req.tools ?? [] }), 'utf8');
  return bytes + overhead.perRequest + overhead.perMessage * req.messages.length + overhead.perTool * (req.tools?.length ?? 0);
}

export interface LlmGateway {
  chat(tenantId: string, tier: Tier, req: BudgetedRequest): Promise<BudgetedResponse>;
  /** Cheap readiness for callers that must block a feature (e.g. analysis) up front. */
  check(tenantId: string, tier: Tier): Promise<{ ok: true; model: string } | { ok: false; code: LlmUnavailableCode }>;
}

export function createLlmGateway(deps: LlmGatewayDeps): LlmGateway {
  const timeoutMs = deps.timeoutMs ?? 120_000;
  const factory =
    deps.providerFactory ?? ((cfg) => createProvider(cfg, (url, init) => fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) })));

  async function resolve(tenantId: string, tier: Tier) {
    const rec = await deps.repo.get(tenantId);
    if (rec.status === 'key_invalid') throw new LlmUnavailable('llm_key_invalid', 'the model key was rejected by the provider; an admin must replace it in Setup');
    if (rec.status !== 'configured' || !rec.provider || !rec.secret) throw new LlmUnavailable('llm_not_configured', 'no active model key; an admin must complete Setup');
    const model = (tier === 'economy' ? rec.economyModel : null) ?? rec.primaryModel;
    if (!model) throw new LlmUnavailable('model_not_selected', 'no model selected in Setup');
    const price = validPricedModel(await deps.prices.price(rec.provider, model));
    if (!price) throw new LlmUnavailable('price_unknown', `no verified, fully boundable price and overhead record for ${model}; the budget cannot be enforced`);
    return { rec, model, price };
  }

  return {
    async check(tenantId, tier) {
      try {
        const { model } = await resolve(tenantId, tier);
        return { ok: true, model };
      } catch (e) {
        if (e instanceof LlmUnavailable) return { ok: false, code: e.code };
        throw e;
      }
    },

    async chat(tenantId, tier, req) {
      if (!Number.isInteger(req.maxOutputTokens) || req.maxOutputTokens <= 0) throw new Error('maxOutputTokens must be a positive integer');
      const { rec, model, price } = await resolve(tenantId, tier);
      const reserved = maxBillableMicroUsd(inputTokenUpperBound(req, price.overheadTokens), req.maxOutputTokens, price);
      const month = (deps.now?.() ?? new Date()).toISOString().slice(0, 7);
      if ((await deps.budget.capFor(tenantId, month)) === null) throw new LlmUnavailable('budget_not_set', 'no monthly model budget is set for this tenant');
      const r = await deps.budget.reserve(tenantId, month, reserved, { provider: rec.provider!, model, taskId: req.taskId });
      if (!r) throw new LlmUnavailable('budget_exhausted', 'the monthly model budget would be exceeded');

      let res: ChatResponse;
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const apiKey = await deps.secrets.get(rec.secret!);
        const deadline = new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error(`provider call exceeded ${timeoutMs} ms`)), timeoutMs);
        });
        res = await Promise.race([factory({ provider: rec.provider!, apiKey, endpoint: rec.endpoint ?? undefined }).chat({ ...req, model }), deadline]);
      } catch (e) {
        // A definite refusal by the provider bills nothing; anything else may have been billed.
        const definite = e instanceof ProviderHttpError && e.status >= 400 && e.status < 500;
        if (definite) await deps.budget.release(r);
        else await deps.budget.freeze(r);
        const status = e instanceof ProviderHttpError ? e.status : null;
        if (e instanceof ProviderHttpError && e.kind === 'auth') throw new LlmUnavailable('llm_key_invalid', 'the provider rejected the model key');
        throw new LlmCallFailed(definite ? 'released' : 'frozen_unknown', status, e instanceof Error ? e.message : String(e));
      } finally {
        if (timer) clearTimeout(timer);
      }
      const u = res.usage;
      if (!u || !nonNegInt(u.inputTokens) || !nonNegInt(u.outputTokens)) {
        await deps.budget.freeze(r);
        throw new LlmCallFailed('frozen_unknown', null, 'provider returned unusable usage figures; reservation frozen for reconciliation');
      }
      const cost = actualMicroUsd(u.inputTokens, u.outputTokens, price);
      if (cost > reserved) {
        // The stated upper bound did not hold: never truncate silently. Hold the reservation and stop using the record.
        await deps.budget.freeze(r, { costMicroUsd: cost, inputTokens: u.inputTokens, outputTokens: u.outputTokens });
        await deps.prices.markUnbounded(rec.provider!, model, { reserved, cost, inputTokens: u.inputTokens, outputTokens: u.outputTokens, maxOutputTokens: req.maxOutputTokens });
        throw new LlmCallFailed('frozen_unknown', null, `cost ${cost} exceeded the reserved upper bound ${reserved}; model record suspended until re-verified`);
      }
      await deps.budget.settle(r, cost, u);
      return { ...res, model, reservedMicroUsd: reserved, costMicroUsd: cost };
    },
  };
}

/** Prices live with the verified-model record (model_capabilities.capabilities.price), maintained by the platform. */
export class StaticPriceBook implements PriceBook {
  readonly violations: { key: string; detail: Record<string, unknown> }[] = [];
  constructor(private prices: Record<string, PricedModel>) {}
  async price(provider: string, model: string) {
    return this.prices[`${provider}/${model}`] ?? null;
  }
  async markUnbounded(provider: string, model: string, detail: Record<string, unknown>) {
    delete this.prices[`${provider}/${model}`];
    this.violations.push({ key: `${provider}/${model}`, detail });
  }
}
