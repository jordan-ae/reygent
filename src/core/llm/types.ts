/**
 * The two model capabilities the pipeline depends on, as narrow interfaces.
 *
 * JevClient satisfies `Decider` and FireworksClient satisfies `Generator`. Pipeline
 * modules take these instead of the concrete clients, so each step can run with a
 * fake in tests and can degrade to its deterministic path when no key is configured.
 */

export interface DecisionLike {
  value: boolean | string | number;
  /** Calibrated 0–1; act above a threshold, escalate below it. */
  confidence: number;
  probabilities: Record<string, number>;
}

/** Tier 1: typed, single-pass decisions (TypeSafe Jev). */
export interface Decider {
  decideBool(state: unknown, instructions: string, taskType: string): Promise<DecisionLike>;
  decideEnum(state: unknown, instructions: string, options: Record<string, string>, taskType: string): Promise<DecisionLike>;
  decideScore(state: unknown, instructions: string, levels: string[], taskType: string): Promise<DecisionLike>;
}

/** Tier 2: text generation (Fireworks), used only when prose must be written. */
export interface Generator {
  generate(
    prompt: string,
    options: { taskType: string; system?: string; maxTokens?: number; temperature?: number; model?: string },
  ): Promise<{ text: string; costUsd?: number }>;
}
