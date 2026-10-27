/**
 * Fireworks AI serverless client for text generation (Tier 2).
 *
 * Used only when prose must be written — tailored CV bullets, cold pitches, Cop Tool
 * rewrites. Every call is capped at `max_tokens` and metered through the cost ledger.
 */

import { type FireworksConfig, defaultConfig } from "@/core/config";
import type { CostLedger } from "@/core/llm/ledger";
import { type Transport, postJson } from "@/core/llm/transport";
import { resolveApiKey } from "@/core/secrets";

export const PROVIDER = "fireworks";
const MESSAGE_OVERHEAD_TOKENS = 16; // chat-template framing per message
const DEFAULT_TEMPERATURE = 0.3;

/** Fireworks returned a response without a usable completion. */
export class FireworksResponseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FireworksResponseError";
  }
}

export interface Completion {
  text: string;
  model: string;
  promptTokens: number;
  completionTokens: number;
  costUsd: number;
  latencyMs: number;
  finishReason: string;
}

export interface GenerateOptions {
  taskType: string;
  system?: string;
  /** Defaults to the configured model; it must have a pricing entry. */
  model?: string;
  /** Can only lower the configured ceiling, never raise it. */
  maxTokens?: number;
  temperature?: number;
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** A reported token count, or null when the field is absent or not a count. */
function tokenCount(value: unknown): number | null {
  // A negative "count" would settle as negative spend and quietly raise the daily cap.
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : null;
}

export class FireworksClient {
  private readonly config: FireworksConfig;
  private readonly apiKey: string | undefined;
  private readonly transport: Transport;

  constructor(
    private readonly ledger: CostLedger,
    options: { config?: FireworksConfig; apiKey?: string; transport?: Transport } = {},
  ) {
    this.config = options.config ?? defaultConfig().fireworks;
    this.apiKey = options.apiKey;
    this.transport = options.transport ?? postJson;
  }

  private cost(model: string, promptTokens: number, completionTokens: number): number {
    const pricing = this.config.pricing_usd_per_million;
    if (!Object.hasOwn(pricing, model)) {
      throw new Error(
        `No pricing configured for '${model}'. Add it to fireworks.pricing_usd_per_million ` +
          "so its cost can be metered.",
      );
    }
    const { input, output } = pricing[model];
    return (promptTokens * input + completionTokens * output) / 1_000_000;
  }

  /**
   * Generate text for `prompt`.
   *
   * `maxTokens` can only lower the configured ceiling (450 by default), never raise
   * it. Rejects with CircuitBreakerError (before any network call) when the daily
   * cap is reached.
   */
  async generate(prompt: string, options: GenerateOptions): Promise<Completion> {
    const cfg = this.config;
    const model = options.model || cfg.model;
    const limit = Math.min(options.maxTokens || cfg.max_tokens, cfg.max_tokens);
    // The limit prices the reservation, so a negative one would reserve negative spend.
    if (!Number.isInteger(limit) || limit < 1) throw new RangeError("maxTokens must be a positive integer");
    const apiKey = this.apiKey || resolveApiKey(cfg.api_key_env);
    if (!apiKey) throw new Error(`Fireworks API key missing: set $${cfg.api_key_env}`);
    const messages = [
      ...(options.system ? [{ role: "system", content: options.system }] : []),
      { role: "user", content: prompt },
    ];
    // Worst case of one token per two bytes of prompt, plus a full-length completion.
    const promptCeiling = messages.reduce(
      (total, message) => total + Math.ceil(Buffer.byteLength(message.content, "utf8") / 2) + MESSAGE_OVERHEAD_TOKENS,
      0,
    );
    const reserved = this.cost(model, promptCeiling, limit);
    const entryId = this.ledger.reserve(PROVIDER, model, options.taskType, reserved);
    const effort = cfg.reasoning_effort.trim();
    const payload = {
      model, messages, max_tokens: limit, temperature: options.temperature ?? DEFAULT_TEMPERATURE,
      ...(effort ? { reasoning_effort: effort } : {}),
    };
    const { response, latencyMs } = await this.ledger.execute<unknown>(entryId, reserved, () =>
      this.transport(cfg.base_url, payload, { Authorization: `Bearer ${apiKey}` }, cfg.timeout_seconds),
    );

    const body = isObject(response) ? response : {};
    const usage = isObject(body.usage) ? body.usage : {};
    const promptTokens = tokenCount(usage.prompt_tokens);
    const completionTokens = tokenCount(usage.completion_tokens);
    if (promptTokens === null || completionTokens === null) {
      // No usage reported: keep the worst-case reservation as the recorded cost.
      this.ledger.settle(entryId, { costUsd: reserved, latencyMs, outcome: "missing_usage" });
      throw new FireworksResponseError("Fireworks response carries no token usage");
    }
    // From here on the call is billed whether or not it carries a usable completion.
    const costUsd = this.cost(model, promptTokens, completionTokens);
    const billed = { costUsd, latencyMs, promptTokens, completionTokens };
    const first: unknown = Array.isArray(body.choices) ? body.choices[0] : undefined;
    const message = isObject(first) && isObject(first.message) ? first.message : {};
    const text = message.content;
    // A reasoning model that used its whole budget thinking answers with reasoning and no
    // text (the content is absent or empty). That is a setting to change, not a retry.
    const onlyReasoned = typeof message.reasoning_content === "string" && message.reasoning_content !== "" && !text;
    if (!isObject(first) || typeof text !== "string" || onlyReasoned) {
      this.ledger.settle(entryId, { ...billed, outcome: "bad_response" });
      throw new FireworksResponseError(
        onlyReasoned
          ? `${model} spent all ${completionTokens} tokens reasoning and wrote no text: set fireworks.reasoning_effort` +
              ' to "none", or to "low" for a model that cannot turn reasoning off'
          : "Unusable Fireworks response: choices[0] carries no text completion",
      );
    }
    this.ledger.settle(entryId, { ...billed, outcome: "ok" });
    return {
      text, model, promptTokens, completionTokens, costUsd, latencyMs,
      finishReason: typeof first.finish_reason === "string" ? first.finish_reason : "",
    };
  }
}
