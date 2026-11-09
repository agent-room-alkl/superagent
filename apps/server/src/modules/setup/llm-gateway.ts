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

export interface PriceBook {
  price(provider: string, model: string): Promise<Price | null>;
}

export interface LlmGatewayDeps {
  repo: ConfigRepo;
  secrets: SecretStore;
  budget: BudgetStore;
  prices: PriceBook;
  providerFactory?: (cfg: ProviderConfig) => LlmProvider;
  now?: () => Date;
}

export type Tier = 'primary' | 'economy';
export type BudgetedRequest = Omit<ChatRequest, 'model'>;
export interface BudgetedResponse extends ChatResponse {
  model: string;
  reservedMicroUsd: number;
  costMicroUsd: number;
}

export function inputTokenUpperBound(req: BudgetedRequest): number {
  return Buffer.byteLength(JSON.stringify({ messages: req.messages, tools: req.tools ?? [] }), 'utf8');
}

export interface LlmGateway {
  chat(tenantId: string, tier: Tier, req: BudgetedRequest): Promise<BudgetedResponse>;
  /** Cheap readiness for callers that must block a feature (e.g. analysis) up front. */
  check(tenantId: string, tier: Tier): Promise<{ ok: true; model: string } | { ok: false; code: LlmUnavailableCode }>;
}

export function createLlmGateway(deps: LlmGatewayDeps): LlmGateway {
  const factory = deps.providerFactory ?? ((cfg) => createProvider(cfg));

  async function resolve(tenantId: string, tier: Tier) {
    const rec = await deps.repo.get(tenantId);
    if (rec.status === 'key_invalid') throw new LlmUnavailable('llm_key_invalid', 'the model key was rejected by the provider; an admin must replace it in Setup');
    if (rec.status !== 'configured' || !rec.provider || !rec.secret) throw new LlmUnavailable('llm_not_configured', 'no active model key; an admin must complete Setup');
    const model = (tier === 'economy' ? rec.economyModel : null) ?? rec.primaryModel;
    if (!model) throw new LlmUnavailable('model_not_selected', 'no model selected in Setup');
    const price = await deps.prices.price(rec.provider, model);
    if (!price) throw new LlmUnavailable('price_unknown', `no verified price for ${model}; the budget cannot be enforced`);
    if (!price.fullyBoundable) throw new LlmUnavailable('price_unknown', `${model} bills items the request cannot bound; refused under a hard cap`);
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
      const reserved = maxBillableMicroUsd(inputTokenUpperBound(req), req.maxOutputTokens, price);
      const month = (deps.now?.() ?? new Date()).toISOString().slice(0, 7);
      if ((await deps.budget.capFor(tenantId, month)) === null) throw new LlmUnavailable('budget_not_set', 'no monthly model budget is set for this tenant');
      const r = await deps.budget.reserve(tenantId, month, reserved, { provider: rec.provider!, model, taskId: req.taskId });
      if (!r) throw new LlmUnavailable('budget_exhausted', 'the monthly model budget would be exceeded');

      let res: ChatResponse;
      try {
        const apiKey = await deps.secrets.get(rec.secret!);
        res = await factory({ provider: rec.provider!, apiKey, endpoint: rec.endpoint ?? undefined }).chat({ ...req, model });
      } catch (e) {
        // A definite refusal by the provider bills nothing; anything else may have been billed.
        const definite = e instanceof ProviderHttpError && e.status >= 400 && e.status < 500;
        if (definite) await deps.budget.release(r);
        else await deps.budget.freeze(r);
        const status = e instanceof ProviderHttpError ? e.status : null;
        if (e instanceof ProviderHttpError && e.kind === 'auth') throw new LlmUnavailable('llm_key_invalid', 'the provider rejected the model key');
        throw new LlmCallFailed(definite ? 'released' : 'frozen_unknown', status, e instanceof Error ? e.message : String(e));
      }
      const cost = actualMicroUsd(res.usage.inputTokens, res.usage.outputTokens, price);
      await deps.budget.settle(r, cost, res.usage);
      return { ...res, model, reservedMicroUsd: reserved, costMicroUsd: Math.min(cost, reserved) };
    },
  };
}

/** Prices live with the verified-model record (model_capabilities.capabilities.price), maintained by the platform. */
export class StaticPriceBook implements PriceBook {
  constructor(private prices: Record<string, Price>) {}
  async price(provider: string, model: string) {
    return this.prices[`${provider}/${model}`] ?? null;
  }
}
