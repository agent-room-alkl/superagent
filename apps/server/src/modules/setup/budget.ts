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

export interface BudgetStore {
  /** Atomically reserve; returns a reservation id or null when the cap would be exceeded. */
  reserve(tenantId: string, month: string, amountMicroUsd: number): Promise<string | null>;
  /** Settle a reservation with the actual amount (≤ reserved). Returns the refunded difference. */
  settle(reservationId: string, actualMicroUsd: number): Promise<number>;
  /** Release a reservation when the provider confirmed nothing was billed. */
  release(reservationId: string): Promise<void>;
  /** Keep the reservation frozen: outcome unknown, reconcile later. */
  freeze(reservationId: string): Promise<void>;
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
    const key = `${tenantId}/${month}`;
    const b = this.budgets.get(key);
    if (!b || b.spent + b.reserved + amount > b.cap) return null;
    b.reserved += amount;
    const id = `r${++this.seq}`;
    this.reservations.set(id, { key, amount, status: 'reserved' });
    return id;
  }
  async settle(id: string, actual: number): Promise<number> {
    const r = this.mustBe(id, ['reserved', 'frozen_unknown']);
    const b = this.budgets.get(r.key)!;
    const charged = Math.min(actual, r.amount); // provider cannot bill above the bounded reservation
    b.reserved -= r.amount;
    b.spent += charged;
    r.status = 'settled';
    return r.amount - charged;
  }
  async release(id: string): Promise<void> {
    const r = this.mustBe(id, ['reserved', 'frozen_unknown']);
    this.budgets.get(r.key)!.reserved -= r.amount;
    r.status = 'released';
  }
  async freeze(id: string): Promise<void> {
    this.mustBe(id, ['reserved']).status = 'frozen_unknown';
  }
  private mustBe(id: string, allowed: ReservationStatus[]) {
    const r = this.reservations.get(id);
    if (!r || !allowed.includes(r.status)) throw new Error(`reservation ${id} not in ${allowed.join('/')}`);
    return r;
  }
}
