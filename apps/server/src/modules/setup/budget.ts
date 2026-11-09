/**
 * Hard monthly cap via bounded reservation (PRD §3.1).
 * reserve = measured input tokens × input price + maxOutputTokens × output price + tool fee cap.
 * Because output is capped by request parameters, the billed amount cannot exceed the reservation.
 * Unknown outcomes keep the reservation frozen until reconciled.
 */
export interface Price {
  inputPerMTokMicroUsd: number; // micro-USD per million input tokens
  outputPerMTokMicroUsd: number; // micro-USD per million output tokens
  /** False when the provider bills items request parameters cannot bound → cap is "soft". */
  fullyBoundable: boolean;
}

export function maxBillableMicroUsd(inputTokens: number, maxOutputTokens: number, price: Price, toolFeeCapMicroUsd = 0): number {
  const input = Math.ceil((inputTokens * price.inputPerMTokMicroUsd) / 1_000_000);
  const output = Math.ceil((maxOutputTokens * price.outputPerMTokMicroUsd) / 1_000_000);
  return input + output + toolFeeCapMicroUsd;
}

export function actualMicroUsd(inputTokens: number, outputTokens: number, price: Price): number {
  return Math.ceil((inputTokens * price.inputPerMTokMicroUsd) / 1_000_000) + Math.ceil((outputTokens * price.outputPerMTokMicroUsd) / 1_000_000);
}

export type ReservationStatus = 'reserved' | 'settled' | 'released' | 'frozen_unknown';

export interface ObservedUsage {
  costMicroUsd: number;
  inputTokens: number;
  outputTokens: number;
}

/** Settlement above the reservation: the bound did not hold. The reservation is frozen with the real figures. */
export class SettlementRefused extends Error {
  constructor(public reservedMicroUsd: number, public actualMicroUsd: number) {
    super(`actual ${actualMicroUsd} exceeds the reservation ${reservedMicroUsd}; reservation frozen for reconciliation`);
    this.name = 'SettlementRefused';
  }
}

/** Settlement amounts must be non-negative safe integers. */
export function assertSettleable(actualMicroUsd: number): void {
  if (!Number.isSafeInteger(actualMicroUsd) || actualMicroUsd < 0) throw new Error(`invalid settlement amount ${actualMicroUsd}`);
}

/** Reservations must be positive safe integers: a zero/negative/fractional amount could release budget. */
export function assertReservable(amountMicroUsd: number): void {
  if (!Number.isSafeInteger(amountMicroUsd) || amountMicroUsd <= 0) throw new Error(`invalid reservation amount ${amountMicroUsd}`);
}

export interface ReservationMeta {
  provider: string;
  model: string;
  taskId?: string;
}

export interface BudgetStore {
  /**
   * Atomically reserve against the tenant's CURRENT cap (read inside the reservation, never supplied by the caller,
   * so a request holding an old Setup snapshot cannot write an old cap back). Returns null when no cap is set or
   * the cap would be exceeded.
   */
  reserve(tenantId: string, month: string, amountMicroUsd: number, meta?: ReservationMeta): Promise<string | null>;
  /**
   * Settle with the actual amount. Must be a non-negative safe integer (else throws, nothing changes). An amount
   * above the reservation is never clamped: the reservation is frozen with the real figures and SettlementRefused
   * is thrown. Returns the refunded difference.
   */
  settle(reservationId: string, actualMicroUsd: number, usage?: { inputTokens: number; outputTokens: number }): Promise<number>;
  /** Release a reservation when the provider confirmed nothing was billed. */
  release(reservationId: string): Promise<void>;
  /** Keep the reservation frozen: outcome unknown, reconcile later. `observed` records what the provider reported. */
  freeze(reservationId: string, observed?: ObservedUsage): Promise<void>;
}

/**
 * Single-statement atomic reservation for PostgreSQL. Concurrency-safe across workers because the
 * check and the increment happen in one UPDATE with a row lock.
 */
export const RESERVE_SQL = `
UPDATE llm_budget
   SET reserved_micro_usd = reserved_micro_usd + $3
 WHERE tenant_id = $1 AND month = $2
   AND spent_micro_usd + reserved_micro_usd + $3 <= cap_micro_usd
RETURNING tenant_id`;

/** In-memory store with the same semantics, used in unit tests and local dev. */
export class InMemoryBudgetStore implements BudgetStore {
  /** capOf: the current cap source (Setup). Without it, caps come from setCap (unit tests). */
  constructor(private opts: { capOf?: (tenantId: string) => Promise<number | null> | number | null } = {}) {}
  private budgets = new Map<string, { cap: number; reserved: number; spent: number }>();
  private reservations = new Map<string, { key: string; amount: number; status: ReservationStatus }>();
  private seq = 0;

  setCap(tenantId: string, month: string, capMicroUsd: number): void {
    const key = `${tenantId}/${month}`;
    const b = this.budgets.get(key) ?? { cap: 0, reserved: 0, spent: 0 };
    b.cap = capMicroUsd;
    this.budgets.set(key, b);
  }
  snapshot(tenantId: string, month: string) {
    return { ...(this.budgets.get(`${tenantId}/${month}`) ?? { cap: 0, reserved: 0, spent: 0 }) };
  }
  async reserve(tenantId: string, month: string, amount: number): Promise<string | null> {
    assertReservable(amount);
    const key = `${tenantId}/${month}`;
    if (this.opts.capOf) {
      const cap = await this.opts.capOf(tenantId); // read now; the check below runs without yielding
      if (cap == null) return null;
      this.setCap(tenantId, month, cap);
    }
    const b = this.budgets.get(key);
    if (!b || b.spent + b.reserved + amount > b.cap) return null;
    b.reserved += amount;
    const id = `r${++this.seq}`;
    this.reservations.set(id, { key, amount, status: 'reserved' });
    return id;
  }
  async settle(id: string, actual: number, usage?: { inputTokens: number; outputTokens: number }): Promise<number> {
    assertSettleable(actual);
    const r = this.mustBe(id, ['reserved', 'frozen_unknown']);
    if (actual > r.amount) {
      r.status = 'frozen_unknown';
      this.observed.set(id, { costMicroUsd: actual, inputTokens: usage?.inputTokens ?? 0, outputTokens: usage?.outputTokens ?? 0 });
      throw new SettlementRefused(r.amount, actual);
    }
    const b = this.budgets.get(r.key)!;
    b.reserved -= r.amount;
    b.spent += actual;
    r.status = 'settled';
    return r.amount - actual;
  }
  async release(id: string): Promise<void> {
    const r = this.mustBe(id, ['reserved', 'frozen_unknown']);
    this.budgets.get(r.key)!.reserved -= r.amount;
    r.status = 'released';
  }
  readonly observed = new Map<string, ObservedUsage>();
  async freeze(id: string, observed?: ObservedUsage): Promise<void> {
    this.mustBe(id, ['reserved']).status = 'frozen_unknown';
    if (observed) this.observed.set(id, observed);
  }
  private mustBe(id: string, allowed: ReservationStatus[]) {
    const r = this.reservations.get(id);
    if (!r || !allowed.includes(r.status)) throw new Error(`reservation ${id} not in ${allowed.join('/')}`);
    return r;
  }
}
