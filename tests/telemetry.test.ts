/** Cost ledger, the $1.50/day circuit breaker, the metered LLM clients and their HTTP transport. */

import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { defaultConfig } from "@/core/config";
import { Repository, toIso } from "@/core/db/repository";
import { FireworksClient, FireworksResponseError } from "@/core/llm/fireworks";
import { JevClient, JevResponseError, choice, noul, score } from "@/core/llm/jev";
import { CircuitBreakerError, CostLedger } from "@/core/llm/ledger";
import { HttpError, type Transport, postJson } from "@/core/llm/transport";
import type { Decider, Generator } from "@/core/llm/types";
import { notifyMacos } from "@/core/notify/macos";
import { SECRETS_ENV_VAR, resolveApiKey } from "@/core/secrets";

// No test may put a real notification on the desktop: osascript is replaced for the whole file.
const execFile = vi.hoisted(() =>
  vi.fn<(file: string, args: string[], options: object, done: (error: Error | null) => void) => void>(),
);
vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  execFile,
}));

const LLAMA = "accounts/fireworks/models/llama-v3p3-70b-instruct";
/**
 * The client under test talks to one model at a flat $0.90 per 1M tokens, with no reasoning
 * setting — so the arithmetic below does not move when the shipped default model or its
 * price changes. (Fireworks retired this model; the tests only need its id as a label.)
 */
const FIREWORKS = {
  ...defaultConfig().fireworks,
  model: LLAMA,
  reasoning_effort: "",
  pricing_usd_per_million: { [LLAMA]: { input: 0.9, output: 0.9 } },
};
const NOON = new Date("2026-10-12T12:00:00Z");
const DAY_MS = 24 * 3_600_000;
const BUDGET = defaultConfig().budget;
// What one "Write a pitch." call reserves: 14 bytes / 2 + 16 framing prompt tokens, plus a
// full 450-token completion, at $0.90 per 1M.
const PITCH_RESERVATION_USD = ((7 + 16 + 450) * 0.9) / 1_000_000;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

interface Call {
  url: string;
  payload: unknown;
  headers: Record<string, string>;
  timeout: number;
}

/** Records requests and replays a canned response (or throws a canned error). */
function fakeTransport(outcome: unknown) {
  const calls: Call[] = [];
  const transport: Transport = async (url, payload, headers, timeout) => {
    calls.push({ url, payload, headers, timeout });
    if (outcome instanceof Error) throw outcome;
    return outcome;
  };
  return Object.assign(transport, { calls });
}

/** Answers after 20 ms, sampling the day's spend while its own call is still in flight. */
function slowTransport(spentToday: () => number) {
  const seen = { calls: 0, peakSpendUsd: 0 };
  const transport: Transport = async () => {
    seen.calls += 1;
    await sleep(20);
    seen.peakSpendUsd = Math.max(seen.peakSpendUsd, spentToday());
    return fireworksResponse({ promptTokens: 12, completionTokens: 200 });
  };
  return Object.assign(transport, { seen });
}

function fireworksResponse({ text = "Rewritten.", promptTokens = 1000, completionTokens = 200 } = {}) {
  return {
    choices: [{ message: { role: "assistant", content: text }, finish_reason: "stop" }],
    usage: { prompt_tokens: promptTokens, completion_tokens: completionTokens },
  };
}

/** The error `promise` rejects with; fails the test if it resolves instead. */
const rejection = (promise: Promise<unknown>): Promise<unknown> =>
  promise.then(
    () => {
      throw new Error("expected the call to be rejected");
    },
    (error: unknown) => error,
  );

/** How many of a batch of calls completed and how many the breaker refused. */
function tally(settled: PromiseSettledResult<unknown>[]) {
  const refused = settled.filter((result): result is PromiseRejectedResult => result.status === "rejected");
  for (const { reason } of refused) expect(reason).toBeInstanceOf(CircuitBreakerError);
  return { completed: settled.length - refused.length, refused: refused.length };
}

let scratch: string;
let secretsFile: string;
let repo: Repository;
let now: Date;
let alerts: string[];
let ledger: CostLedger;

const clock = () => now;
const notifier = (message: string) => void alerts.push(message);

beforeEach(() => {
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), "reygent-telemetry-"));
  // No test may see the developer's real keys: the secrets store points at an empty
  // scratch directory and the provider keys are hidden from the environment.
  secretsFile = path.join(scratch, "secrets.json");
  vi.stubEnv(SECRETS_ENV_VAR, secretsFile);
  vi.stubEnv("TYPESAFE_API_KEY", undefined);
  vi.stubEnv("FIREWORKS_API_KEY", undefined);
  repo = new Repository(":memory:");
  now = NOON;
  alerts = [];
  ledger = new CostLedger(repo, { budget: BUDGET, notifier, clock });
});

afterEach(() => {
  repo.close();
  vi.unstubAllEnvs();
  fs.rmSync(scratch, { recursive: true, force: true });
});

function spend(amount: number, when: Date = now): void {
  repo.recordTelemetry({
    provider: "fireworks", model: LLAMA, taskType: "seed", costUsd: amount, timestamp: toIso(when),
  });
}

const rows = () => repo.listTelemetry();

const fireworks = (transport: Transport, target: CostLedger = ledger) =>
  new FireworksClient(target, { config: FIREWORKS, apiKey: "test-key", transport });

const jev = (transport: Transport) =>
  new JevClient(ledger, { config: defaultConfig().jev, apiKey: "test-key", transport });

test("the suite cannot see real provider keys", () => {
  // Compared as booleans so that a failure can never print a key.
  for (const name of [defaultConfig().jev.api_key_env, defaultConfig().fireworks.api_key_env]) {
    expect(resolveApiKey(name) === null).toBe(true);
  }
});

test("the clients fit the interfaces the pipeline takes them through", () => {
  // The assignments are the test: `tsc --noEmit` rejects them if a signature drifts.
  const decider: Decider = jev(fakeTransport({}));
  const generator: Generator = fireworks(fakeTransport({}));
  expect([typeof decider.decideBool, typeof generator.generate]).toEqual(["function", "function"]);
});

describe("circuit breaker", () => {
  test("a call is refused before any request once the cap would be exceeded", async () => {
    spend(1.4999);
    const transport = fakeTransport(fireworksResponse());
    const error = await rejection(fireworks(transport).generate("Write a pitch.", { taskType: "pitch" }));
    expect(error).toBeInstanceOf(CircuitBreakerError);
    expect(error).toMatchObject({ spentUsd: expect.closeTo(1.4999, 7), capUsd: 1.5 });
    expect(transport.calls).toEqual([]);
    expect(ledger.isTripped()).toBe(true);
    expect(ledger.spentToday()).toBeCloseTo(1.4999, 7); // nothing was added
  });

  test("the user is alerted once and every later call is refused", async () => {
    spend(1.5);
    const transport = fakeTransport(fireworksResponse());
    const client = fireworks(transport);
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await expect(client.generate("Write a pitch.", { taskType: "pitch" })).rejects.toThrow(CircuitBreakerError);
    }
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toContain("$1.50");
    expect(transport.calls).toEqual([]);
  });

  test("a tripped breaker blocks cheap decisions too", async () => {
    spend(1.4999);
    await expect(
      fireworks(fakeTransport(fireworksResponse())).generate("Write a pitch.", { taskType: "pitch" }),
    ).rejects.toThrow(CircuitBreakerError);
    // A Jev decision costs a few millionths of a dollar and would still fit under the cap.
    const transport = fakeTransport({});
    await expect(
      jev(transport).decideBool("Remote, worldwide.", "Is this role open worldwide?", "eligibility"),
    ).rejects.toThrow(CircuitBreakerError);
    expect(transport.calls).toEqual([]);
  });

  test("spend under the cap proceeds", async () => {
    spend(1.4);
    const transport = fakeTransport(fireworksResponse());
    const completion = await fireworks(transport).generate("Write a pitch.", { taskType: "pitch" });
    expect(completion.text).toBe("Rewritten.");
    expect(transport.calls).toHaveLength(1);
    expect(ledger.isTripped()).toBe(false);
    expect(alerts).toEqual([]);
  });

  test("the breaker resets on the next budget day", async () => {
    spend(1.5);
    const client = fireworks(fakeTransport(fireworksResponse()));
    await expect(client.generate("Write a pitch.", { taskType: "pitch" })).rejects.toThrow(CircuitBreakerError);
    now = new Date(now.getTime() + DAY_MS);
    expect(ledger.isTripped()).toBe(false);
    expect(ledger.spentToday()).toBe(0);
    expect((await client.generate("Write a pitch.", { taskType: "pitch" })).text).toBe("Rewritten.");
  });

  test("the budget day follows Cameroon local time", () => {
    // 23:30 UTC on the 12th is already 00:30 on the 13th in Cameroon (UTC+1).
    spend(1.5, new Date("2026-10-12T22:00:00Z"));
    now = new Date("2026-10-12T23:30:00Z");
    expect(ledger.spentToday()).toBe(0);
    expect(ledger.remainingToday()).toBe(1.5);
  });

  test("concurrent calls cannot jointly exceed the cap", async () => {
    // $0.005 has room for 11 reservations of $0.0004257, not 12.
    const tight = new CostLedger(repo, { budget: { ...BUDGET, daily_cap_usd: 0.005 }, notifier, clock });
    const transport = slowTransport(() => tight.spentToday());
    const client = fireworks(transport, tight);

    const settled = await Promise.allSettled(
      Array.from({ length: 24 }, () => client.generate("Write a pitch.", { taskType: "pitch" })),
    );

    expect(tally(settled)).toEqual({ completed: 11, refused: 13 });
    expect(transport.seen.calls).toBe(11); // a refused call never reaches the provider
    // While the 11 were in flight, all of their worst-case reservations counted as spend
    // (spentToday rounds to a millionth of a dollar).
    expect(transport.seen.peakSpendUsd).toBeCloseTo(11 * PITCH_RESERVATION_USD, 6);
    expect(transport.seen.peakSpendUsd).toBeLessThanOrEqual(tight.capUsd);
    expect(tight.spentToday()).toBeLessThanOrEqual(tight.capUsd);
    expect(rows().map((entry) => entry.outcome)).toEqual(Array(11).fill("ok"));
    expect(alerts).toHaveLength(1);
  });

  describe("across two connections to one database file", () => {
    let repos: Repository[];

    beforeEach(() => {
      const file = path.join(scratch, "reygent.db");
      repos = [new Repository(file), new Repository(file)];
    });

    afterEach(() => {
      for (const connection of repos) connection.close();
    });

    test("concurrent calls share the cap", async () => {
      const ledgers = repos.map(
        (connection) => new CostLedger(connection, { budget: { ...BUDGET, daily_cap_usd: 0.005 }, notifier, clock }),
      );
      // Spend is sampled through the first connection, whichever one made the call.
      const transport = slowTransport(() => ledgers[0].spentToday());
      const clients = ledgers.map((shared) => fireworks(transport, shared));

      const settled = await Promise.allSettled(
        Array.from({ length: 24 }, (_, index) => clients[index % 2].generate("Write a pitch.", { taskType: "pitch" })),
      );

      expect(tally(settled)).toEqual({ completed: 11, refused: 13 });
      expect(transport.seen.calls).toBe(11);
      expect(transport.seen.peakSpendUsd).toBeCloseTo(11 * PITCH_RESERVATION_USD, 6);
      expect(transport.seen.peakSpendUsd).toBeLessThanOrEqual(0.005);
      for (const shared of ledgers) {
        expect(shared.spentToday()).toBeLessThanOrEqual(0.005);
        expect(shared.isTripped()).toBe(true);
      }
      expect(ledgers[1].spentToday()).toBe(ledgers[0].spentToday());
      expect(alerts).toHaveLength(1); // the second connection sees the breaker already tripped
    });

    test("24 reservations of $0.10 fit the $1.50 cap exactly 15 times", () => {
      const ledgers = repos.map((connection) => new CostLedger(connection, { budget: BUDGET, notifier, clock }));
      const outcomes = Array.from({ length: 24 }, (_, index) => {
        try {
          ledgers[index % 2].reserve("fireworks", LLAMA, "pitch", 0.1);
          return "reserved";
        } catch (error) {
          expect(error).toBeInstanceOf(CircuitBreakerError);
          return "refused";
        }
      });
      expect(outcomes.filter((outcome) => outcome === "reserved")).toHaveLength(15);
      expect(outcomes.filter((outcome) => outcome === "refused")).toHaveLength(9);
      for (const shared of ledgers) expect(shared.spentToday()).toBeLessThanOrEqual(1.5);
      expect(alerts).toHaveLength(1);
    });
  });

  test("the cap is configurable", () => {
    const tight = new CostLedger(repo, { budget: { ...BUDGET, daily_cap_usd: 0.01 }, notifier, clock });
    tight.reserve("fireworks", LLAMA, "pitch", 0.01);
    expect(() => tight.reserve("fireworks", LLAMA, "pitch", 0.001)).toThrow(CircuitBreakerError);
  });
});

describe("Fireworks client", () => {
  test("cost is computed from the reported tokens and logged", async () => {
    const transport = fakeTransport(fireworksResponse({ promptTokens: 1000, completionTokens: 200 }));
    const completion = await fireworks(transport).generate("Write a pitch.", { system: "Be brief.", taskType: "pitch" });
    expect(completion).toMatchObject({
      text: "Rewritten.", model: LLAMA, promptTokens: 1000, completionTokens: 200, finishReason: "stop",
    });
    expect(completion.costUsd).toBeCloseTo(0.00108, 7); // 1,200 tokens at $0.90 per 1M
    const entries = rows();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      provider: "fireworks", model: LLAMA, taskType: "pitch", outcome: "ok", promptTokens: 1000, completionTokens: 200,
    });
    expect(entries[0].costUsd).toBeCloseTo(0.00108, 7);
    expect(entries[0].latencyMs).toBeGreaterThanOrEqual(0);
    expect(ledger.spentToday()).toBeCloseTo(0.00108, 7);
  });

  test("request shape and the max_tokens ceiling", async () => {
    const transport = fakeTransport(fireworksResponse());
    await fireworks(transport).generate("Write a pitch.", { system: "Be brief.", taskType: "pitch", maxTokens: 4000 });
    expect(transport.calls).toEqual([
      {
        url: "https://api.fireworks.ai/inference/v1/chat/completions",
        headers: { Authorization: "Bearer test-key" },
        timeout: 60,
        payload: {
          model: LLAMA,
          max_tokens: 450,
          temperature: 0.3,
          messages: [
            { role: "system", content: "Be brief." },
            { role: "user", content: "Write a pitch." },
          ],
        },
      },
    ]);
  });

  test("the reasoning setting is sent when there is one, and the shipped default turns reasoning off", async () => {
    const transport = fakeTransport(fireworksResponse());
    const shipped = defaultConfig().fireworks;
    await new FireworksClient(ledger, { config: shipped, apiKey: "test-key", transport }).generate("Hi", { taskType: "pitch" });
    expect(transport.calls[0].payload).toMatchObject({ model: shipped.model, reasoning_effort: "none" });
    // The shipped model has a price, or the call above would have been refused.
    expect(Object.keys(shipped.pricing_usd_per_million)).toContain(shipped.model);

    await new FireworksClient(ledger, { config: { ...FIREWORKS, reasoning_effort: " low " }, apiKey: "test-key", transport })
      .generate("Hi", { taskType: "pitch" });
    expect(transport.calls[1].payload).toMatchObject({ reasoning_effort: "low" });
    // An empty setting sends nothing at all, for a model that would reject the field.
    await fireworks(transport).generate("Hi", { taskType: "pitch" });
    expect(transport.calls[2].payload).not.toHaveProperty("reasoning_effort");
  });

  test("a model that spent its whole budget reasoning is an error that names the setting to change, billed as used", async () => {
    for (const message of [
      { role: "assistant", reasoning_content: "The user wants a pitch. Let me think about" },
      { role: "assistant", content: "", reasoning_content: "The user wants a pitch. Let me think about" },
    ]) {
      const transport = fakeTransport({
        choices: [{ message, finish_reason: "length" }],
        usage: { prompt_tokens: 200, completion_tokens: 450 },
      });
      const error = await rejection(fireworks(transport).generate("Write a pitch.", { taskType: "pitch" }));
      expect(error).toBeInstanceOf(FireworksResponseError);
      expect((error as Error).message).toBe(
        `${LLAMA} spent all 450 tokens reasoning and wrote no text: set fireworks.reasoning_effort` +
          ' to "none", or to "low" for a model that cannot turn reasoning off',
      );
    }
    const entries = rows();
    expect(entries.map((entry) => entry.outcome)).toEqual(["bad_response", "bad_response"]);
    expect(entries[0].costUsd).toBeCloseTo((650 * 0.9) / 1_000_000, 9);
    // Text alongside reasoning is an ordinary answer.
    const fine = fakeTransport({
      choices: [{ message: { role: "assistant", content: "A pitch.", reasoning_content: "Briefly." }, finish_reason: "stop" }],
      usage: { prompt_tokens: 200, completion_tokens: 30 },
    });
    expect((await fireworks(fine).generate("Write a pitch.", { taskType: "pitch" })).text).toBe("A pitch.");
  });

  test("max_tokens can be lowered", async () => {
    const transport = fakeTransport(fireworksResponse());
    await fireworks(transport).generate("Write a pitch.", { taskType: "pitch", maxTokens: 120 });
    expect(transport.calls[0].payload).toMatchObject({ max_tokens: 120 });
  });

  test("a max_tokens that is not a positive integer is refused before any request", async () => {
    const transport = fakeTransport(fireworksResponse());
    for (const maxTokens of [-5, 120.5]) {
      await expect(fireworks(transport).generate("Hi", { taskType: "pitch", maxTokens })).rejects.toThrow(RangeError);
    }
    expect(transport.calls).toEqual([]);
    expect(rows()).toEqual([]);
  });

  test("a model without pricing is refused before any request", async () => {
    const transport = fakeTransport(fireworksResponse());
    await expect(
      fireworks(transport).generate("Hi", { taskType: "pitch", model: "accounts/fireworks/models/unpriced" }),
    ).rejects.toThrow("No pricing configured for 'accounts/fireworks/models/unpriced'");
    expect(transport.calls).toEqual([]);
    expect(rows()).toEqual([]);
  });

  test("a missing API key is refused before any request", async () => {
    const transport = fakeTransport(fireworksResponse());
    const config = { ...FIREWORKS, api_key_env: "REYGENT_TEST_UNSET_KEY" };
    const client = new FireworksClient(ledger, { config, transport });
    await expect(client.generate("Hi", { taskType: "pitch" })).rejects.toThrow(
      "Fireworks API key missing: set $REYGENT_TEST_UNSET_KEY",
    );
    expect(transport.calls).toEqual([]);
    expect(rows()).toEqual([]);
  });

  test("the key comes from the stored secrets, and the environment wins over them", async () => {
    fs.writeFileSync(secretsFile, JSON.stringify({ REYGENT_TEST_KEY: "stored-key" }));
    const transport = fakeTransport(fireworksResponse());
    const config = { ...FIREWORKS, api_key_env: "REYGENT_TEST_KEY" };
    const client = new FireworksClient(ledger, { config, transport });
    await client.generate("Hi", { taskType: "pitch" });
    vi.stubEnv("REYGENT_TEST_KEY", "environment-key");
    await client.generate("Hi", { taskType: "pitch" });
    expect(transport.calls.map((call) => call.headers.Authorization)).toEqual([
      "Bearer stored-key",
      "Bearer environment-key",
    ]);
  });

  test("a provider error releases the reservation", async () => {
    const failure = new HttpError(500, "upstream failure");
    const client = fireworks(fakeTransport(failure));
    await expect(client.generate("Write a pitch.", { taskType: "pitch" })).rejects.toBe(failure);
    const entries = rows();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ outcome: "http_500", costUsd: 0 });
    expect(ledger.spentToday()).toBe(0);
  });

  test("a timeout keeps the worst-case cost on the books", async () => {
    const timeout = new DOMException("The operation was aborted due to timeout", "TimeoutError");
    const client = fireworks(fakeTransport(timeout));
    await expect(client.generate("Write a pitch.", { taskType: "pitch" })).rejects.toBe(timeout);
    const entries = rows();
    expect(entries).toHaveLength(1);
    expect(entries[0].outcome).toBe("transport_error");
    expect(entries[0].costUsd).toBeGreaterThan((450 * 0.9) / 1_000_000); // at least a full-length completion
    expect(entries[0].costUsd).toBeCloseTo(PITCH_RESERVATION_USD, 8);
  });

  test("the reservation counts UTF-8 bytes, not characters", async () => {
    // 100 two-byte characters: 200 bytes / 2 + 16 framing prompt tokens, plus 450.
    const client = fireworks(fakeTransport(new Error("socket hang up")));
    await expect(client.generate("é".repeat(100), { taskType: "pitch" })).rejects.toThrow("socket hang up");
    expect(rows()[0].costUsd).toBeCloseTo(((100 + 16 + 450) * 0.9) / 1_000_000, 8);
  });

  test("a response without usage is an error and stays charged", async () => {
    const transport = fakeTransport({ choices: [{ message: { content: "hi" } }] });
    await expect(fireworks(transport).generate("Write a pitch.", { taskType: "pitch" })).rejects.toThrow(
      FireworksResponseError,
    );
    const entries = rows();
    expect(entries).toHaveLength(1);
    expect(entries[0].outcome).toBe("missing_usage");
    expect(entries[0].costUsd).toBeCloseTo(PITCH_RESERVATION_USD, 8); // the full reservation
  });

  test.each([
    ["no choices", { choices: [] }],
    ["no message", { choices: [{ finish_reason: "stop" }] }],
    ["a completion that is not text", { choices: [{ message: { content: null } }] }],
  ])("a response with %s is an error billed at the reported usage", async (_why, body) => {
    const transport = fakeTransport({ ...body, usage: { prompt_tokens: 30, completion_tokens: 0 } });
    await expect(fireworks(transport).generate("Write a pitch.", { taskType: "pitch" })).rejects.toThrow(
      FireworksResponseError,
    );
    const entries = rows();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ outcome: "bad_response", promptTokens: 30, completionTokens: 0 });
    expect(entries[0].costUsd).toBeCloseTo((30 * 0.9) / 1_000_000, 8);
  });
});

describe("Jev client", () => {
  const RESPONSE = {
    model: "jev-1.13.0",
    answers: {
      worldwide: { type: "noul", noul: 0.93 },
      tier: {
        type: "choice", choice: "potentially_eligible", confidence: 0.82,
        probabilities: { confirmed: 0.1, potentially_eligible: 0.85, ineligible: 0.05 },
      },
      fit: {
        type: "score", score: 2.4, confidence: 0.7,
        legend: { "0": "weak", "1": "partial", "2": "strong", "3": "exact" },
        probabilities: { "0": 0.05, "1": 0.15, "2": 0.5, "3": 0.3 },
      },
    },
    usage: { input_tokens: 500, output_tokens: 48 },
  };
  const QUESTIONS = {
    worldwide: noul("Is the role open to candidates worldwide?"),
    tier: choice("Which eligibility tier applies?", {
      confirmed: "Explicitly global",
      potentially_eligible: "Remote, scope unstated",
      ineligible: "Restricted to a country or on-site",
    }),
    fit: score("How well does the candidate fit?", ["weak", "partial", "strong", "exact"]),
  };
  const USAGE = { input_tokens: 90, output_tokens: 4 };

  test("typed decisions from one pass", async () => {
    const transport = fakeTransport(RESPONSE);
    const decisions = await jev(transport).decide("Remote. We hire worldwide.", QUESTIONS, "eligibility");
    expect(transport.calls).toHaveLength(1);

    expect(decisions.worldwide.value).toBe(true);
    expect(decisions.worldwide.confidence).toBeCloseTo(0.93, 7);
    expect(decisions.worldwide.probabilities).toEqual({ true: expect.closeTo(0.93, 7), false: expect.closeTo(0.07, 7) });
    expect(decisions.tier.value).toBe("potentially_eligible");
    expect(decisions.tier.confidence).toBeCloseTo(0.82, 7);
    expect(decisions.tier.probabilities.potentially_eligible).toBeCloseTo(0.85, 7);
    expect(decisions.fit.value).toBeCloseTo(2.4, 7);
    expect(decisions.fit.value).toBeTypeOf("number");
  });

  test("request shape", async () => {
    const transport = fakeTransport(RESPONSE);
    await jev(transport).decide({ title: "Engineer" }, QUESTIONS, "eligibility");
    expect(transport.calls).toHaveLength(1);
    const [call] = transport.calls;
    expect(call.url).toBe("https://api.typesafe.ai/v1/systemone");
    expect(call.headers).toEqual({ Authorization: "Bearer test-key" });
    expect(call.timeout).toBe(15);
    expect(call.payload).toEqual({ state: { title: "Engineer" }, model: "jev-latest", questions: QUESTIONS });
    expect(QUESTIONS.worldwide).toEqual({ type: "noul", instructions: "Is the role open to candidates worldwide?" });
    expect(QUESTIONS.fit).toMatchObject({ type: "score", criteria: ["weak", "partial", "strong", "exact"] });
  });

  test("micro-cost and latency are logged", async () => {
    await jev(fakeTransport(RESPONSE)).decide("state", QUESTIONS, "eligibility");
    const entries = rows();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      provider: "typesafe", model: "jev-latest", taskType: "eligibility", outcome: "ok",
      promptTokens: 500, completionTokens: 48,
    });
    expect(entries[0].costUsd).toBeCloseTo((500 * 0.042) / 1_000_000, 10); // output tokens are free
    expect(entries[0].latencyMs).toBeGreaterThanOrEqual(0);
  });

  test("a no answer reports confidence in the no", async () => {
    const response = { answers: { q: { type: "noul", noul: 0.1 } }, usage: USAGE };
    const decision = await jev(fakeTransport(response)).decideBool("state", "Is it remote?", "eligibility");
    expect(decision.value).toBe(false);
    expect(decision.confidence).toBeCloseTo(0.9, 7);
  });

  test("typed helpers", async () => {
    const picked = {
      answers: { q: { type: "choice", choice: "b", confidence: 0.6, probabilities: { a: 0.4, b: 0.6 } } },
      usage: USAGE,
    };
    const enumTransport = fakeTransport(picked);
    const options = { a: "first", b: "second" };
    expect((await jev(enumTransport).decideEnum("state", "Pick one.", options, "routing")).value).toBe("b");
    expect(enumTransport.calls[0].payload).toMatchObject({
      questions: { q: { type: "choice", instructions: "Pick one.", criteria: options } },
    });

    const rated = {
      answers: { q: { type: "score", score: 1.0, confidence: 0.9, probabilities: { "0": 0.1, "1": 0.9 } } },
      usage: USAGE,
    };
    expect((await jev(fakeTransport(rated)).decideScore("state", "Rate it.", ["low", "high"], "fit")).value).toBe(1);
  });

  test.each<[string, unknown]>([
    ["the question is not answered", { answers: {}, usage: USAGE }],
    ["there are no answers at all", { usage: USAGE }],
    ["the answer is of another type", { answers: { q: { type: "choice", choice: "x" } }, usage: USAGE }],
    ["the probability is out of range", { answers: { q: { type: "noul", noul: 1.7 } }, usage: USAGE }],
    ["the probability is not a number", { answers: { q: { type: "noul", noul: "0.9" } }, usage: USAGE }],
    ["the answer is null", { answers: { q: null }, usage: USAGE }],
  ])("a malformed answer is rejected but still billed: %s", async (_why, response) => {
    await expect(jev(fakeTransport(response)).decideBool("state", "Is it remote?", "eligibility")).rejects.toThrow(
      JevResponseError,
    );
    const entries = rows();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ outcome: "bad_response", promptTokens: 90, completionTokens: 4 });
    expect(entries[0].costUsd).toBeCloseTo((90 * 0.042) / 1_000_000, 10);
  });

  test.each(["c", "toString"])("the choice %j, outside the offered options, is rejected", async (picked) => {
    const response = {
      answers: { q: { type: "choice", choice: picked, confidence: 0.9, probabilities: { [picked]: 1.0 } } },
      usage: USAGE,
    };
    await expect(
      jev(fakeTransport(response)).decideEnum("s", "Pick.", { a: "first", b: "second" }, "routing"),
    ).rejects.toThrow(JevResponseError);
    expect(rows()[0].outcome).toBe("bad_response");
  });

  test("a response without usage is an error and stays charged at the reservation", async () => {
    const transport = fakeTransport({ answers: { q: { type: "noul", noul: 0.9 } } });
    await expect(jev(transport).decideBool("state", "Is it remote?", "eligibility")).rejects.toThrow(
      "Jev response carries no token usage",
    );
    const entries = rows();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ outcome: "missing_usage", promptTokens: 0, completionTokens: 0 });
    // One token per two bytes of the request that was sent, at $0.042 per 1M.
    const requestBytes = Buffer.byteLength(JSON.stringify(transport.calls[0].payload), "utf8");
    expect(requestBytes).toBeGreaterThan(0);
    expect(entries[0].costUsd).toBeCloseTo((Math.ceil(requestBytes / 2) * 0.042) / 1_000_000, 8);
  });

  test("a provider error releases the reservation", async () => {
    const failure = new HttpError(503, "overloaded");
    await expect(jev(fakeTransport(failure)).decideBool("state", "Is it remote?", "eligibility")).rejects.toBe(failure);
    expect(rows()).toHaveLength(1);
    expect(rows()[0]).toMatchObject({ outcome: "http_503", costUsd: 0 });
  });

  test("a missing API key is refused before any reservation", async () => {
    const transport = fakeTransport(RESPONSE);
    const config = { ...defaultConfig().jev, api_key_env: "REYGENT_TEST_UNSET_KEY" };
    const client = new JevClient(ledger, { config, transport });
    await expect(client.decideBool("state", "Is it remote?", "eligibility")).rejects.toThrow(
      "Jev API key missing: set $REYGENT_TEST_UNSET_KEY",
    );
    expect(transport.calls).toEqual([]);
    expect(rows()).toEqual([]);
  });

  test("question limits match the API", async () => {
    const numbered = (count: number) => Array.from({ length: count }, (_, index) => String(index));
    const options = (count: number) => Object.fromEntries(numbered(count).map((name) => [name, `option ${name}`]));

    expect(() => score("Rate it.", ["only one level"])).toThrow(RangeError);
    expect(() => score("Rate it.", numbered(11))).toThrow(RangeError);
    expect(score("Rate it.", numbered(2))).toMatchObject({ criteria: ["0", "1"] });
    expect(score("Rate it.", numbered(10))).toMatchObject({ type: "score" });

    expect(() => choice("Pick.", { only: "one option" })).toThrow(RangeError);
    expect(() => choice("Pick.", options(256))).toThrow(RangeError);
    expect(choice("Pick.", options(2))).toMatchObject({ criteria: { "0": "option 0", "1": "option 1" } });
    expect(choice("Pick.", options(255))).toMatchObject({ type: "choice" });

    const transport = fakeTransport({});
    await expect(jev(transport).decide("state", {}, "eligibility")).rejects.toThrow(RangeError);
    await expect(jev(transport).decideScore("state", "Rate it.", ["only one level"], "fit")).rejects.toThrow(RangeError);
    expect(transport.calls).toEqual([]);
    expect(rows()).toEqual([]);
  });
});

describe("desktop notifications", () => {
  beforeEach(() => {
    execFile.mockReset();
  });

  test("the message is passed as an argument, never interpolated into the script", async () => {
    execFile.mockImplementation((_file, _args, _options, done) => done(null));
    const hostile = 'Acme" & (do shell script "rm -rf ~") & "';
    await expect(notifyMacos(hostile)).resolves.toBe(true);
    expect(execFile).toHaveBeenCalledOnce();
    const [file, args] = execFile.mock.calls[0];
    expect(file).toBe("osascript");
    expect(args[0]).toBe("-e");
    expect(args[1]).not.toContain(hostile);
    expect(args.slice(2)).toEqual([hostile, "Reygent", "Glass"]);
  });

  test("a delivery failure is reported, not thrown", async () => {
    execFile.mockImplementation((_file, _args, _options, done) => done(new Error("osascript exited with code 1")));
    await expect(notifyMacos("hello")).resolves.toBe(false);
    execFile.mockImplementation(() => {
      throw new Error("spawn osascript ENOENT");
    });
    await expect(notifyMacos("hello")).resolves.toBe(false);
  });
});

describe("postJson", () => {
  interface Received {
    method: string | undefined;
    headers: http.IncomingHttpHeaders;
    body: string;
  }
  type Responder = (response: http.ServerResponse, request: http.IncomingMessage, attempt: number) => void;

  let server: http.Server;
  let url: string;
  let received: Received[];
  let respond: Responder;

  const reply = (response: http.ServerResponse, status: number, body: string) =>
    response.writeHead(status, { "Content-Type": "application/json" }).end(body);

  beforeEach(async () => {
    received = [];
    server = http.createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        received.push({ method: request.method, headers: request.headers, body: Buffer.concat(chunks).toString("utf8") });
        respond(response, request, received.length);
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/test`;
  });

  afterEach(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });

  test("posts the payload as JSON and decodes the response", async () => {
    respond = (response) => reply(response, 200, JSON.stringify({ answer: 42, text: "naïve" }));
    const payload = { state: "Zürich, remote", questions: { q: { type: "noul" } } };
    await expect(postJson(url, payload, { Authorization: "Bearer test-key" }, 5)).resolves.toEqual({
      answer: 42, text: "naïve",
    });
    expect(received).toHaveLength(1);
    expect(received[0].method).toBe("POST");
    expect(received[0].headers).toMatchObject({
      "content-type": "application/json", accept: "application/json", authorization: "Bearer test-key",
      "user-agent": "reygent/0.2",
    });
    expect(JSON.parse(received[0].body)).toEqual(payload);
  });

  test("never sends half an emoji: text cut at a fixed length is made valid Unicode first", async () => {
    respond = (response) => reply(response, 200, JSON.stringify({ ok: true }));
    const cut = "Join us at Monzo! \u{1F642}".slice(0, -1);
    await postJson(url, { state: { description: cut, whole: "ok \u{1F642}" } }, {}, 5);
    // A lone surrogate would arrive as the escape "\ud83d", which strict APIs refuse.
    expect(received[0].body).not.toMatch(/\\ud83d/i);
    expect(JSON.parse(received[0].body)).toEqual({ state: { description: "Join us at Monzo! \uFFFD", whole: "ok \u{1F642}" } });
  });

  test("retries a rate-limited request, then succeeds", async () => {
    respond = (response, _request, attempt) =>
      attempt === 1 ? reply(response, 429, "slow down") : reply(response, 200, JSON.stringify({ ok: true }));
    await expect(postJson(url, { n: 1 }, {}, 5, 2, 0.001)).resolves.toEqual({ ok: true });
    expect(received).toHaveLength(2);
    expect(received[1].body).toBe(received[0].body);
  });

  test("gives up with the last status once the retries are spent", async () => {
    respond = (response) => reply(response, 503, "overloaded");
    const error = await rejection(postJson(url, {}, {}, 5, 2, 0.001));
    expect(error).toBeInstanceOf(HttpError);
    expect(error).toMatchObject({ status: 503, body: "overloaded" });
    expect(received).toHaveLength(3);
  });

  test("an error status is an HttpError with the status and body, and is not retried", async () => {
    const detail = `{"error":"bad request"}${"x".repeat(600)}`;
    respond = (response) => reply(response, 400, detail);
    const error = await rejection(postJson(url, {}, {}, 5, 2, 0.001));
    expect(error).toBeInstanceOf(HttpError);
    expect(error).toMatchObject({ status: 400, body: detail.slice(0, 500) }); // long bodies are cut to 500 characters
    expect(received).toHaveLength(1);
  });

  test("a dropped connection is not retried", async () => {
    respond = (_response, request) => request.socket.destroy();
    const error = await rejection(postJson(url, {}, {}, 5, 2, 0.001));
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(HttpError);
    expect(received).toHaveLength(1);
  });

  test("a timeout is not retried", async () => {
    respond = () => {}; // never answers
    const error = await rejection(postJson(url, {}, {}, 0.2, 2, 0.001));
    expect(error).toMatchObject({ name: "TimeoutError" });
    expect(error).not.toBeInstanceOf(HttpError);
    expect(received).toHaveLength(1);
  });

  test("a success that is not JSON is an error, but not an HttpError", async () => {
    // Not an HttpError, so the ledger keeps the worst-case cost: the provider did answer 200.
    respond = (response) => reply(response, 200, "<html>gateway</html>");
    const error = await rejection(postJson(url, {}, {}, 5));
    expect(error).toBeInstanceOf(SyntaxError);
    expect(received).toHaveLength(1);
  });

  test("a timeout that is not a whole number of milliseconds is accepted", async () => {
    respond = (response) => reply(response, 200, JSON.stringify({ ok: true }));
    expect(Number.isInteger(16.1 * 1000)).toBe(false);
    await expect(postJson(url, {}, {}, 16.1)).resolves.toEqual({ ok: true });
  });
});
