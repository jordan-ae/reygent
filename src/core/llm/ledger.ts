/** Instrumented cost ledger and the hard daily stop-loss circuit breaker. */

import type { BudgetConfig } from "@/core/config";
import { type Repository, toIso } from "@/core/db/repository";
import { HttpError } from "@/core/llm/transport";
import { type Notifier, notify } from "@/core/notify/macos";

const BREAKER_STATE_KEY = "circuit_breaker";
const DEFAULT_BUDGET: BudgetConfig = { daily_cap_usd: 1.5, day_utc_offset_hours: 1 };

export interface BreakerState {
  day: string;
  tripped_at: string;
  spent_usd: number;
}

/** Thrown instead of making a paid call once the daily spend cap is reached. */
export class CircuitBreakerError extends Error {
  constructor(
    readonly spentUsd: number,
    readonly capUsd: number,
  ) {
    super(
      `Daily spend cap reached: $${spentUsd.toFixed(5)} of $${capUsd.toFixed(2)}. ` +
        "Paid calls are paused until the next budget day.",
    );
    this.name = "CircuitBreakerError";
  }
}

const round6 = (value: number) => Math.round(value * 1e6) / 1e6;

export interface Settlement {
  costUsd: number;
  latencyMs: number;
  outcome: string;
  promptTokens?: number;
  completionTokens?: number;
}

/**
 * Records every paid call and guarantees the daily cap is never exceeded.
 *
 * Each call first *reserves* its worst-case cost in the same transaction that checks
 * the day's total, then *settles* to the amount actually billed. Because the
 * reservation counts as spend, concurrent callers (even in separate processes) cannot
 * jointly overshoot the cap. The first refused call trips the breaker: the user is
 * notified once and every further call is refused until the budget day rolls over.
 */
export class CostLedger {
  private readonly budget: BudgetConfig;
  private readonly notifier: Notifier;
  private readonly clock: () => Date;

  constructor(
    private readonly repo: Repository,
    options: { budget?: BudgetConfig; notifier?: Notifier; clock?: () => Date } = {},
  ) {
    this.budget = options.budget ?? DEFAULT_BUDGET;
    this.notifier = options.notifier ?? notify;
    this.clock = options.clock ?? (() => new Date());
  }

  get capUsd(): number {
    return this.budget.daily_cap_usd;
  }

  /** The budget day containing `now` (YYYY-MM-DD) and the UTC instant at which it started. */
  day(now: Date = this.clock()): { day: string; startIso: string } {
    const offsetMs = this.budget.day_utc_offset_hours * 3_600_000;
    const local = new Date(now.getTime() + offsetMs);
    const midnightLocal = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate());
    return { day: local.toISOString().slice(0, 10), startIso: toIso(new Date(midnightLocal - offsetMs)) };
  }

  spentToday(): number {
    return round6(this.repo.spendSince(this.day().startIso));
  }

  remainingToday(): number {
    return Math.max(0, round6(this.capUsd - this.spentToday()));
  }

  isTripped(): boolean {
    const state = this.repo.getState<BreakerState>(BREAKER_STATE_KEY);
    return Boolean(state) && state!.day === this.day().day;
  }

  /** Reserve the worst-case cost of one call, or throw CircuitBreakerError. */
  reserve(provider: string, model: string, taskType: string, maxCostUsd: number): number {
    const now = this.clock();
    const { day, startIso } = this.day(now);
    const outcome = this.repo.transaction(() => {
      const spent = this.repo.spendSince(startIso);
      const tripped = this.repo.getState<BreakerState>(BREAKER_STATE_KEY)?.day === day;
      if (!tripped && round6(spent + maxCostUsd) <= round6(this.capUsd)) {
        const entryId = this.repo.recordTelemetry({
          provider, model, taskType, costUsd: maxCostUsd, outcome: "pending", timestamp: toIso(now),
        });
        return { entryId, spent, newlyTripped: false };
      }
      if (!tripped) {
        const state: BreakerState = { day, tripped_at: toIso(now), spent_usd: round6(spent) };
        this.repo.setState(BREAKER_STATE_KEY, state);
      }
      return { entryId: null, spent, newlyTripped: !tripped };
    });
    if (outcome.entryId === null) {
      if (outcome.newlyTripped) {
        this.notifier(
          `Daily spend cap reached ($${outcome.spent.toFixed(4)} of $${this.capUsd.toFixed(2)}). ` +
            "Reygent is paused until tomorrow.",
        );
      }
      throw new CircuitBreakerError(outcome.spent, this.capUsd);
    }
    return outcome.entryId;
  }

  /** Replace a reservation with the tokens, latency and cost actually incurred. */
  settle(entryId: number, settlement: Settlement): void {
    this.repo.settleTelemetry(entryId, {
      promptTokens: settlement.promptTokens ?? 0,
      completionTokens: settlement.completionTokens ?? 0,
      costUsd: Math.round(settlement.costUsd * 1e8) / 1e8,
      latencyMs: settlement.latencyMs,
      outcome: settlement.outcome,
    });
  }

  /**
   * Run a reserved request and return its response and latency.
   *
   * On failure the reservation is settled before re-throwing: an HTTP error status
   * means the provider rejected the request, so nothing was billed; any other failure
   * (timeout, dropped connection) leaves billing unknown, so the worst-case
   * reservation stays on the books.
   */
  async execute<T>(entryId: number, reservedUsd: number, send: () => Promise<T>): Promise<{ response: T; latencyMs: number }> {
    const started = performance.now();
    const elapsed = () => Math.round(performance.now() - started);
    try {
      const response = await send();
      return { response, latencyMs: elapsed() };
    } catch (error) {
      if (error instanceof HttpError) {
        this.settle(entryId, { costUsd: 0, latencyMs: elapsed(), outcome: `http_${error.status}` });
      } else {
        this.settle(entryId, { costUsd: reservedUsd, latencyMs: elapsed(), outcome: "transport_error" });
      }
      throw error;
    }
  }
}
