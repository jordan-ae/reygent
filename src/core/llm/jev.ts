/**
 * Typed client for TypeSafe AI's Jev System-One decision model (Tier 1 decisions).
 *
 * Jev is not generative: a call sends one `state` plus a set of typed questions and
 * gets back, in a single pass, a typed answer with calibrated probabilities for each.
 *
 *     noul   -> boolean  (yes/no, with the probability of "yes")
 *     choice -> string   (one of the offered options)
 *     score  -> number   (position on an ordered scale, 0 = first level)
 *
 * API reference: https://docs.typesafe.ai/api
 */

import { type JevConfig, defaultConfig } from "@/core/config";
import type { CostLedger } from "@/core/llm/ledger";
import { type Transport, postJson } from "@/core/llm/transport";
import { resolveApiKey } from "@/core/secrets";

export const PROVIDER = "typesafe";

/** One typed question, in the shape the API expects it on the wire. */
export type Question =
  | { type: "noul"; instructions: string }
  | { type: "choice"; instructions: string; criteria: Record<string, string> }
  | { type: "score"; instructions: string; criteria: string[] };

export interface Decision {
  value: boolean | string | number;
  /** Calibrated; act above a threshold, escalate below it. */
  confidence: number;
  probabilities: Record<string, number>;
}

/** Jev returned something that does not answer the questions asked. */
export class JevResponseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "JevResponseError";
  }
}

/** A yes/no question. */
export function noul(instructions: string): Question {
  return { type: "noul", instructions };
}

/** Pick one of `options` (option name -> what qualifies for it). */
export function choice(instructions: string, options: Readonly<Record<string, string>>): Question {
  const count = Object.keys(options).length;
  if (count < 2 || count > 255) throw new RangeError("A choice question needs between 2 and 255 options");
  return { type: "choice", instructions, criteria: { ...options } };
}

/** Rate on an ordered scale; `levels` describes each step from lowest to highest. */
export function score(instructions: string, levels: readonly string[]): Question {
  if (levels.length < 2 || levels.length > 10) throw new RangeError("A score question needs between 2 and 10 levels");
  return { type: "score", instructions, criteria: [...levels] };
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function numeric(value: unknown, what: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${what} is not a number`);
  return value;
}

/** A reported token count, or null when the field is absent or not a count. */
function tokenCount(value: unknown): number | null {
  // A negative "count" would settle as negative spend and quietly raise the daily cap.
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : null;
}

/** Turn one raw answer into a Decision; throws if it does not answer `question`. */
function parseAnswer(question: Question, answer: unknown): Decision {
  if (!isObject(answer)) throw new Error("no answer was returned");
  if (answer.type !== question.type) {
    throw new Error(`expected a ${question.type} answer, got ${JSON.stringify(answer.type)}`);
  }
  if (question.type === "noul") {
    const pYes = numeric(answer.noul, "noul probability");
    if (pYes < 0 || pYes > 1) throw new Error(`noul probability out of range: ${pYes}`);
    return { value: pYes >= 0.5, confidence: Math.max(pYes, 1 - pYes), probabilities: { true: pYes, false: 1 - pYes } };
  }
  if (!isObject(answer.probabilities)) throw new Error("probabilities are missing");
  const probabilities = Object.fromEntries(
    Object.entries(answer.probabilities).map(([name, p]) => [name, numeric(p, `probability of ${JSON.stringify(name)}`)]),
  );
  const confidence = numeric(answer.confidence, "confidence");
  if (question.type === "choice") {
    const picked = answer.choice;
    // Own properties only: "toString" is not an option just because every object has one.
    if (typeof picked !== "string" || !Object.hasOwn(question.criteria, picked)) {
      throw new Error(`choice ${JSON.stringify(picked)} is not one of the offered options`);
    }
    return { value: picked, confidence, probabilities };
  }
  return { value: numeric(answer.score, "score"), confidence, probabilities };
}

/** Jev decisions with every call metered through the cost ledger. */
export class JevClient {
  private readonly config: JevConfig;
  private readonly apiKey: string | undefined;
  private readonly transport: Transport;

  constructor(
    private readonly ledger: CostLedger,
    options: { config?: JevConfig; apiKey?: string; transport?: Transport } = {},
  ) {
    this.config = options.config ?? defaultConfig().jev;
    this.apiKey = options.apiKey;
    this.transport = options.transport ?? postJson;
  }

  private cost(inputTokens: number, outputTokens: number): number {
    const cfg = this.config;
    return (inputTokens * cfg.input_usd_per_million + outputTokens * cfg.output_usd_per_million) / 1_000_000;
  }

  /**
   * Answer every question about `state` in one pass.
   *
   * `state` is the thing being judged: a string or any JSON-serialisable value.
   * Rejects with CircuitBreakerError (before any network call) when the daily cap
   * is reached.
   */
  async decide(state: unknown, questions: Record<string, Question>, taskType: string): Promise<Record<string, Decision>> {
    const names = Object.keys(questions);
    if (names.length === 0) throw new RangeError("At least one question is required");
    const cfg = this.config;
    const apiKey = this.apiKey || resolveApiKey(cfg.api_key_env);
    if (!apiKey) throw new Error(`Jev API key missing: set $${cfg.api_key_env}`);
    const payload = { state, model: cfg.model, questions: { ...questions } };
    // Worst case of one token per two bytes of request; real usage is far lower.
    const reserved = this.cost(Math.ceil(Buffer.byteLength(JSON.stringify(payload), "utf8") / 2), 0);
    const entryId = this.ledger.reserve(PROVIDER, cfg.model, taskType, reserved);
    const { response, latencyMs } = await this.ledger.execute<unknown>(entryId, reserved, () =>
      this.transport(cfg.base_url, payload, { Authorization: `Bearer ${apiKey}` }, cfg.timeout_seconds),
    );

    const body = isObject(response) ? response : {};
    const usage = isObject(body.usage) ? body.usage : {};
    const inputTokens = tokenCount(usage.input_tokens);
    const outputTokens = tokenCount(usage.output_tokens);
    if (inputTokens === null || outputTokens === null) {
      // No usage reported: keep the worst-case reservation as the recorded cost.
      this.ledger.settle(entryId, { costUsd: reserved, latencyMs, outcome: "missing_usage" });
      throw new JevResponseError("Jev response carries no token usage");
    }
    // From here on the call is billed whether or not its answers turn out to be usable.
    const billed = {
      costUsd: this.cost(inputTokens, outputTokens), latencyMs,
      promptTokens: inputTokens, completionTokens: outputTokens,
    };
    let decisions: Record<string, Decision>;
    try {
      if (!isObject(body.answers)) throw new Error("the response has no answers");
      const answers = body.answers;
      decisions = Object.fromEntries(names.map((name) => [name, parseAnswer(questions[name], answers[name])]));
    } catch (error) {
      this.ledger.settle(entryId, { ...billed, outcome: "bad_response" });
      throw new JevResponseError(`Unusable Jev answer: ${error instanceof Error ? error.message : String(error)}`);
    }
    this.ledger.settle(entryId, { ...billed, outcome: "ok" });
    return decisions;
  }

  async decideBool(state: unknown, instructions: string, taskType: string): Promise<Decision> {
    return (await this.decide(state, { q: noul(instructions) }, taskType)).q;
  }

  async decideEnum(
    state: unknown,
    instructions: string,
    options: Readonly<Record<string, string>>,
    taskType: string,
  ): Promise<Decision> {
    return (await this.decide(state, { q: choice(instructions, options) }, taskType)).q;
  }

  async decideScore(state: unknown, instructions: string, levels: readonly string[], taskType: string): Promise<Decision> {
    return (await this.decide(state, { q: score(instructions, levels) }, taskType)).q;
  }
}
