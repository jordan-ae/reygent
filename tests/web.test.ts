/**
 * The web console: setup API, applications and actions, operating the pipeline, and its
 * request guard.
 *
 * Began as a port of tests/test_web.py against the layer under the Next route handlers:
 * `WebApp` (what each endpoint does), `serve` (guard, body parsing, JSON envelope) and
 * `checkRequest`. Every test works in a temporary directory with its own config, database,
 * secrets file and evidence folder; ~/.reygent and the real config.yaml are never touched,
 * and nothing reaches the network.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { type Config, CONFIG_ENV_VAR, ConfigError, DB_ENV_VAR, loadConfig } from "@/core/config";
import { toIso } from "@/core/db/repository";
import { Channel, DraftStatus, PipelineStage, createDraft, createJob, verifiedAchievements } from "@/core/models";
import { type CycleReport, HEARTBEAT_KEY, type Step, chooseJobsToDraft, runCycle } from "@/core/orchestrator/pipeline";
import { createPipelineDeps } from "@/core/orchestrator/runtime";
import { SECRETS_ENV_VAR, resolveApiKey, secretsPath } from "@/core/secrets";
import { ApiError, type ApiResult, type JsonObject, WebApp } from "@/core/web/api";
import { DEFAULT_PORT, type RequestFacts, checkRequest, serverPort } from "@/core/web/guard";
import { MAX_BODY_BYTES, serve, serveFile } from "@/core/web/http";
import { EVIDENCE_ENV_VAR, getWebApp } from "@/core/web/instance";
import { config as proxyConfig, proxy } from "@/proxy";

const EXAMPLE_CONFIG = fileURLToPath(new URL("../config.example.yaml", import.meta.url));
const NOW = new Date("2026-10-12T12:00:00Z");
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const LLAMA = "accounts/fireworks/models/llama-v3p3-70b-instruct";
const PORT = 8791;
const MANAGED_ENV = [
  SECRETS_ENV_VAR, CONFIG_ENV_VAR, DB_ENV_VAR, EVIDENCE_ENV_VAR, "TYPESAFE_API_KEY", "FIREWORKS_API_KEY", "PORT",
];

const WORLDWIDE = {
  company: "Northwind Labs", title: "Senior AI Engineer", location: "Remote (Worldwide)",
  description: "Contractors are paid through Deel.", applyUrl: "https://jobs.ashbyhq.com/northwind/1",
  channel: "contract_gigs", skills: ["Python", "LangGraph"],
};
const AMBIGUOUS = {
  company: "Fathom Systems", title: "Agent Platform Engineer", location: "Remote",
  description: "San Francisco startup with a fully remote team.",
};
/** Every discovery source switched off. */
const NO_SOURCES = {
  greenhouse_boards: [], ashby_orgs: [], lever_companies: [], workable_accounts: [], recruitee_companies: [],
  teamtailor_companies: [], breezy_companies: [], job_boards: [], hn_who_is_hiring: false, hn_freelancer: false,
};

let tmp: string;
let configPath: string;
let evidenceDir: string;
let app: WebApp;
let savedEnv: Record<string, string | undefined>;
/** Every outbound request a key test tried to make. */
let fetched: Array<{ url: string; authorization: string | null }>;
/** What the provider answers; replaced per test. */
let provider: () => Response | Promise<Response>;
/** What "Run discovery now" runs; replaced per test. Never the real one, which would fetch job boards. */
let cycle: (steps: readonly Step[]) => Promise<CycleReport>;

beforeEach(() => {
  savedEnv = Object.fromEntries(MANAGED_ENV.map((name) => [name, process.env[name]]));
  for (const name of MANAGED_ENV) delete process.env[name];
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "reygent-web-"));
  configPath = path.join(tmp, "config.yaml");
  evidenceDir = path.join(tmp, "evidence");
  fs.copyFileSync(EXAMPLE_CONFIG, configPath);
  process.env[SECRETS_ENV_VAR] = path.join(tmp, "secrets.json");

  fetched = [];
  provider = () => {
    throw new Error("no request expected");
  };
  cycle = () => {
    throw new Error("no pipeline run expected");
  };
  app = new WebApp({
    configPath,
    dbPath: path.join(tmp, "reygent.db"),
    evidenceDir,
    clock: () => NOW,
    fetch: async (input, init) => {
      fetched.push({ url: String(input), authorization: new Headers(init?.headers).get("authorization") });
      return provider();
    },
    cycle: (steps) => cycle(steps),
  });
});

afterEach(() => {
  app.close();
  for (const name of MANAGED_ENV) {
    if (savedEnv[name] === undefined) delete process.env[name];
    else process.env[name] = savedEnv[name];
  }
  fs.rmSync(tmp, { recursive: true, force: true });
});

// ---------- Helpers ----------

/** The ApiError `work` throws; anything else fails the test. */
function refused(work: () => unknown): ApiError {
  try {
    work();
  } catch (error) {
    if (error instanceof ApiError) return error;
    throw error;
  }
  throw new Error("expected the call to be refused");
}

const mode = (file: string): number => fs.statSync(file).mode & 0o777;
const ago = (ms: number): string => toIso(new Date(NOW.getTime() - ms));
const sorted = <T>(values: Iterable<T>): T[] => [...new Set(values)].sort();

/** A request as the browser (or an attacker's page) would send it to the console on PORT. */
function request(method: string, target: string, options: { body?: unknown; headers?: Record<string, string> } = {}): Request {
  const { body } = options;
  return new Request(`http://127.0.0.1:${PORT}${target}`, {
    method,
    headers: {
      host: `127.0.0.1:${PORT}`,
      ...(method === "GET" ? {} : { "content-type": "application/json" }),
      ...options.headers,
    },
    body: body === undefined || typeof body === "string" ? body : JSON.stringify(body),
  });
}

async function answer(response: Response): Promise<{ status: number; body: JsonObject }> {
  return { status: response.status, body: (await response.json()) as JsonObject };
}

const addListing = (incoming: Request) => serve(incoming, PORT, ({ body }) => app.addApplication(body));
const storeKey = (incoming: Request) => serve(incoming, PORT, ({ body }) => app.setKey("jev", body));

/** The config on disk with the profile filled in and one verified achievement. */
function filledConfig(): Config {
  const config = structuredClone(app.state().body.config);
  Object.assign(config.candidate, {
    name: "Test Candidate", email: "candidate@example.com", phone: "+237 600 000 000",
    github_url: "https://github.com/test-candidate", linkedin_url: "https://www.linkedin.com/in/test-candidate",
    portfolio_url: "https://candidate.example.com", notice_period: "2 weeks", years_experience: 8,
    employers: ["Initech"],
  });
  config.fact_bank.achievements = [{
    id: "ach_agents", category: "ai_systems", positioning: ["ai_platform_agent"],
    headline: "Built a LangGraph agent runtime", impact_metric: "Cut workflow latency by 45%",
    technologies: ["Python", "LangGraph"], employer: "Initech", evidence_url: "", context: "", verified: true,
  }];
  return config;
}

// ---------- Setup ----------

describe("setup", () => {
  test("state lists everything still to set up", () => {
    const { status, body: state } = app.state();
    expect(status).toBe(200);
    expect(state.configError).toBe("");
    expect(sorted(state.readiness.map((issue) => issue.area))).toEqual(["fact_bank", "profile", "settings"]);
    expect(state.keys.map((key) => key.source)).toEqual([null, null, null]);
    expect(state.keys.map((key) => [key.id, key.env])).toEqual([
      ["jev", "TYPESAFE_API_KEY"], ["fireworks", "FIREWORKS_API_KEY"], ["email", "REYGENT_SMTP_PASSWORD"],
    ]);
    // Without the mailbox's password nothing is emailed, and the console says so.
    expect(state.readiness.map((issue) => issue.message)).toContain(
      "The email app password is not set: nothing is sent by email, and you are not emailed what needs you",
    );
    expect(state.positioning).toHaveLength(4);
    expect(state.positioning[0]).toMatchObject({ id: "ai_platform_agent", verifiedAchievements: 0 });
    expect(state.placeholder).toBe("CHANGE_ME");
    expect(state.configPath).toBe(configPath);
    expect(state.dbPath).toBe(path.join(tmp, "reygent.db"));
    expect(state.secretsPath).toBe(path.join(tmp, "secrets.json"));

    const statuses = Object.fromEntries(state.system.map((part) => [part.name, part.status]));
    expect(statuses["3-tier eligibility scorer"]).toBe("ready");
    expect(statuses["Profile & fact bank"]).toBe("needs_setup");
    expect(statuses["Jev decisions"]).toBe("needs_setup");
    expect(statuses["Job discovery"]).toBe("ready");
    expect(statuses["Browser operator"]).toBe("ready");
    expect(statuses["Pipeline"]).toBe("idle");
    expect(Object.values(statuses)).not.toContain("not_built"); // everything listed exists now
    expect(state.system.find((part) => part.name === "Web console")).toMatchObject({
      status: "ready", detail: expect.stringContaining("Next.js"),
    });
  });

  test("the component list says what each part still needs", () => {
    const part = (name: string) => app.state().body.system.find((candidate) => candidate.name === name);
    // The example config has no name, no email and no verified achievement: nothing truthful to write.
    expect(part("Tailoring & drafting")).toMatchObject({ status: "needs_setup", detail: expect.stringContaining("Blocked") });
    // Hands-free with no Jev key: the keyword score is never a stand-in, so scoring waits.
    expect(part("Fit scoring")).toMatchObject({ status: "needs_setup", detail: expect.stringContaining("Waiting for the Jev key") });
    // As shipped: the company boards, the remote-job sites and both Hacker News threads.
    expect(part("Job discovery")?.detail).toBe("Reads 42 job boards, 9 remote-job sites and the Hacker News hiring threads. Free.");

    const config = filledConfig();
    Object.assign(config.discovery, NO_SOURCES);
    app.saveConfig({ config });
    app.setKey("jev", { key: "ts-secret" });
    expect(part("Tailoring & drafting")).toMatchObject({ status: "ready", detail: expect.stringContaining("verified text only") });
    expect(part("Fit scoring")?.detail).toContain("Jev scores");
    expect(part("Job discovery")).toMatchObject({ status: "needs_setup", detail: expect.stringContaining("Settings") });

    config.discovery.lever_companies = ["metabase"];
    app.saveConfig({ config });
    expect(part("Job discovery")).toMatchObject({ status: "ready", detail: expect.stringContaining("1 job board.") });
    // A job site or the freelancer thread alone is a source too.
    Object.assign(config.discovery, { lever_companies: [], job_boards: ["remotive"], hn_freelancer: true });
    app.saveConfig({ config });
    expect(part("Job discovery")).toMatchObject({
      status: "ready", detail: "Reads 0 job boards, 1 remote-job site and the Hacker News freelancer thread. Free.",
    });
  });

  test("the config is passed through exactly as config.yaml spells it", () => {
    const { config } = app.state().body;
    expect(config).toEqual(loadConfig(configPath));
    expect(config.candidate.location).toBe("Cameroon (UTC+1)");
    expect(config.candidate.name).toBe("CHANGE_ME");
    expect(config.budget.daily_cap_usd).toBe(1.5);
    expect(config.fact_bank.achievements[0]).toMatchObject({ id: "ach_example_agents", verified: false });
    expect(config.fact_bank.achievements[0].impact_metric).toContain("EXAMPLE");
  });

  test("saving writes config.yaml and syncs the fact bank", () => {
    const config = filledConfig();
    config.budget.daily_cap_usd = 1.25;
    const { status, body: state } = app.saveConfig({ config });
    expect(status).toBe(200);
    expect(sorted(state.readiness.map((issue) => issue.area))).toEqual(["fact_bank", "settings"]);
    expect(state.config.candidate.name).toBe("Test Candidate");
    expect(state.positioning.find((p) => p.id === "ai_platform_agent")?.verifiedAchievements).toBe(1);

    const onDisk = loadConfig(configPath);
    expect(onDisk.candidate.name).toBe("Test Candidate");
    expect(onDisk.budget.daily_cap_usd).toBe(1.25);
    expect(mode(configPath)).toBe(0o600);
    expect(fs.existsSync(`${configPath}.bak`)).toBe(true); // the previous file is kept

    const profile = app.repo.getProfile();
    expect(profile).not.toBeNull();
    expect(verifiedAchievements(profile!).map((achievement) => achievement.id)).toEqual(["ach_agents"]);
    expect(profile!.positioning.ai_platform_agent.highlightedAchievements).toEqual(["ach_agents"]);
  });

  test("the pipeline, source and screening settings the console edits are saved as given", () => {
    const config = filledConfig();
    // The defaults are hands-free; flip everything the Settings and Profile pages can change.
    expect(config.pipeline).toMatchObject({ require_human_review: false, auto_submit: true, stop_at_invisible_captcha: false });
    Object.assign(config.pipeline, {
      require_human_review: true, auto_submit: false, stop_at_invisible_captcha: true, pitch_unconfirmed_tier2: false,
      answer_confidence: 0.9, fit_threshold: 70, max_drafts_per_cycle: 4, max_submissions_per_day: 3,
      loop_interval_minutes: 30, investigation_confidence: 0.75,
    });
    Object.assign(config.discovery, {
      greenhouse_boards: ["gitlab"], ashby_orgs: [], lever_companies: ["metabase", "superside"], hn_who_is_hiring: false,
      title_keywords: ["engineer", "agent"], max_new_jobs_per_cycle: 25,
      workable_accounts: ["zyte"], recruitee_companies: [], teamtailor_companies: ["axmed"], breezy_companies: [],
      job_boards: ["remotive", "weworkremotely"], hn_freelancer: false, follow_board_links: false, found_boards_per_cycle: 5,
    });
    config.candidate.screening_notes = "Cameroonian citizen. I do not need sponsorship: I invoice as a contractor.";

    const saved = app.saveConfig({ config }).body.config;
    expect(saved).toEqual(config);
    const onDisk = loadConfig(configPath);
    expect(onDisk.pipeline).toEqual(config.pipeline);
    expect(onDisk.discovery).toEqual(config.discovery);
    expect(onDisk.candidate.screening_notes).toBe(config.candidate.screening_notes);

    for (const [key, value] of [["answer_confidence", 0.2], ["fit_threshold", 140], ["loop_interval_minutes", 0]] as const) {
      const invalid = structuredClone(config);
      invalid.pipeline[key] = value;
      expect(refused(() => app.saveConfig({ config: invalid })).message).toContain(key);
    }
    expect(refused(() => app.saveConfig({ config: { ...config, discovery: { ...config.discovery, max_new_jobs_per_cycle: 0 } } })).status).toBe(400);
    // Only the job sites Reygent has a reader for can be switched on.
    expect(refused(() => app.saveConfig({ config: { ...config, discovery: { ...config.discovery, job_boards: ["linkedin"] } } })).message).toContain("job_boards");
    expect(loadConfig(configPath).pipeline.fit_threshold).toBe(70);
  });

  test("invalid settings are rejected and nothing is written", () => {
    const before = fs.readFileSync(configPath);
    const cases: Array<[fragment: string, change: (config: Config) => void]> = [
      ["daily_cap_usd", (config) => { config.budget.daily_cap_usd = -1; }],
      ["budget.daily_cap", (config) => { Object.assign(config.budget, { daily_cap: 5 }); }],
      ["duplicate", (config) => { config.fact_bank.achievements.push(config.fact_bank.achievements[0]); }],
      ["email", (config) => { config.candidate.email = "not-an-email"; }],
      ["max_tokens", (config) => { config.fireworks.max_tokens = 4000; }],
      ["pricing", (config) => { config.fireworks.model = "accounts/fireworks/models/unpriced"; }],
      ["quoted_hourly_rate_usd", (config) => { config.compensation.hourly_floor_usd = 500; }],
    ];
    for (const [fragment, change] of cases) {
      const config = filledConfig();
      change(config);
      const error = refused(() => app.saveConfig({ config }));
      expect(error.status, fragment).toBe(400);
      expect(error.message).toContain(fragment);
    }
    for (const body of [{}, { config: "nope" }, { config: [] }, { config: null }]) {
      expect(refused(() => app.saveConfig(body)).status).toBe(400);
    }
    expect(fs.readFileSync(configPath).equals(before)).toBe(true);
    expect(fs.existsSync(`${configPath}.bak`)).toBe(false);
    expect(app.repo.getProfile()).toBeNull();
  });

  test("an unreadable config file is reported instead of crashing", () => {
    fs.writeFileSync(configPath, "candidate: [unclosed\n");
    const state = app.state().body;
    expect(state.configError).toContain("not valid YAML");
    expect(state.config.budget.daily_cap_usd).toBe(1.5); // defaults are shown
    expect(state.positioning).toEqual([]);
    expect(app.overview().status).toBe(200); // the other pages keep working
  });

  test("a fact bank the profile cannot be built from is reported the same way", () => {
    const text = fs.readFileSync(configPath, "utf8").replace("[ai_platform_agent]", "[no_such_profile]");
    fs.writeFileSync(configPath, text);
    const state = app.state().body;
    expect(state.configError).toContain("no_such_profile");
    expect(state.config.fact_bank.achievements).toHaveLength(2); // the file itself is still shown
  });

  test("a missing config file is created on first save", () => {
    fs.rmSync(configPath);
    expect(app.state().body.configError).toBe("");
    expect(app.saveConfig({ config: filledConfig() }).status).toBe(200);
    expect(loadConfig(configPath).candidate.name).toBe("Test Candidate");
  });
});

// ---------- API keys ----------

describe("API keys", () => {
  const SECRET = "fw-secret-0123456789";

  test("a key is stored owner-only and never sent back", () => {
    const saved = app.setKey("fireworks", { key: `  ${SECRET}\n` });
    expect(saved.status).toBe(200);
    expect(JSON.stringify(saved.body)).not.toContain(SECRET);

    const state = app.state().body;
    expect(JSON.stringify(state)).not.toContain(SECRET);
    expect(Object.fromEntries(state.keys.map((key) => [key.id, key.source]))).toEqual({ jev: null, fireworks: "stored", email: null });
    expect(state.readiness.map((issue) => issue.message)).not.toContain("Fireworks AI API key is not set");

    // Google shows an app password in four groups; it is stored without the spaces.
    app.setKey("email", { key: "abcd efgh ijkl mnop" });
    expect(resolveApiKey("REYGENT_SMTP_PASSWORD")).toBe("abcdefghijklmnop");
    expect(JSON.stringify(app.state().body)).not.toContain("abcdefghijklmnop");

    expect(resolveApiKey("FIREWORKS_API_KEY")).toBe(SECRET);
    expect(mode(secretsPath())).toBe(0o600);
    expect(fs.readFileSync(configPath, "utf8")).not.toContain(SECRET);
  });

  test("no endpoint ever includes a key", async () => {
    app.setKey("jev", { key: "ts-secret-abcdef" });
    app.setKey("fireworks", { key: SECRET });
    app.saveConfig({ config: filledConfig() });
    provider = () => new Response("{}", { status: 200 });
    const responses: ApiResult[] = [
      app.state(), app.overview(), app.applications({}), app.activity({}), app.quarantine({}), app.costs(),
      await app.testKey("jev"), await app.testKey("fireworks"), app.deleteKey("jev"),
    ];
    for (const response of responses) {
      const sent = JSON.stringify(response.body);
      expect(sent).not.toContain(SECRET);
      expect(sent).not.toContain("ts-secret-abcdef");
    }
  });

  test("a key can be removed", () => {
    app.setKey("jev", { key: "ts-secret" });
    const { status, body: state } = app.deleteKey("jev");
    expect(status).toBe(200);
    expect(state.keys[0].source).toBeNull();
    expect(resolveApiKey("TYPESAFE_API_KEY")).toBeNull();
  });

  test("an environment variable takes precedence over a stored key", () => {
    app.setKey("jev", { key: "stored-key" });
    process.env.TYPESAFE_API_KEY = "env-key";
    expect(app.state().body.keys[0].source).toBe("environment");
    expect(resolveApiKey("TYPESAFE_API_KEY")).toBe("env-key");
    expect(JSON.stringify(app.state().body)).not.toContain("env-key");
    delete process.env.TYPESAFE_API_KEY;
    expect(app.state().body.keys[0].source).toBe("stored");
  });

  test("bad key requests are rejected", () => {
    expect(refused(() => app.setKey("fireworks", { key: "   " })).status).toBe(400);
    expect(refused(() => app.setKey("fireworks", { key: "two words" })).status).toBe(400);
    expect(refused(() => app.setKey("fireworks", {})).status).toBe(400);
    expect(refused(() => app.setKey("fireworks", { key: 12345 })).status).toBe(400);
    expect(refused(() => app.setKey("openai", { key: "x" })).status).toBe(404);
    expect(refused(() => app.deleteKey("openai")).status).toBe(404);
    expect(fs.existsSync(secretsPath())).toBe(false);
  });

  test("testing without a key makes no network call", async () => {
    const { status, body } = await app.testKey("jev");
    expect(status).toBe(200);
    expect(body.ok).toBe(false);
    expect(body.message).toContain("No key");
    expect(fetched).toEqual([]);
    await expect(app.testKey("openai")).rejects.toMatchObject({ status: 404 });
  });

  test("testing a key asks the provider's model list and reports the answer without the key", async () => {
    app.setKey("fireworks", { key: SECRET });
    const outcomes: Array<[() => Response, boolean, string]> = [
      [() => new Response("{}", { status: 200 }), true, "accepted the key"],
      [() => new Response("{}", { status: 401 }), false, "rejected the key (HTTP 401)"],
      [() => new Response("{}", { status: 403 }), false, "rejected the key (HTTP 403)"],
      [() => new Response("{}", { status: 503 }), false, "Could not verify: Fireworks AI answered HTTP 503"],
      [() => { throw new TypeError("fetch failed", { cause: new Error("getaddrinfo ENOTFOUND") }); }, false, "Could not reach Fireworks AI: fetch failed (getaddrinfo ENOTFOUND)"],
    ];
    for (const [respond, ok, message] of outcomes) {
      provider = respond;
      const { status, body } = await app.testKey("fireworks");
      expect(status).toBe(200);
      expect(body.ok, message).toBe(ok);
      expect(body.message).toContain(message);
      expect(body.message).not.toContain(SECRET);
    }
    expect(fetched).toHaveLength(outcomes.length);
    expect(fetched[0]).toEqual({ url: "https://api.fireworks.ai/inference/v1/models", authorization: `Bearer ${SECRET}` });

    app.setKey("jev", { key: "ts-secret" });
    provider = () => new Response("{}", { status: 200 });
    await app.testKey("jev");
    expect(fetched.at(-1)).toEqual({ url: "https://api.typesafe.ai/v1/models", authorization: "Bearer ts-secret" });
  });
});

// ---------- Applications ----------

describe("applications", () => {
  test("an added listing is classified, routed and listed", () => {
    const { status, body: added } = app.addApplication(WORLDWIDE);
    expect(status).toBe(201);
    if (added.duplicate) throw new Error("expected a new listing");
    expect(added.report.tier).toBe("confirmed");
    expect(Object.keys(added.report).sort()).toEqual([
      "disqualifiers", "needsB2bInvestigation", "positiveSignals", "reasonCodes", "summary", "tier",
    ]);

    const listing = app.applications({}).body;
    expect(listing.applications).toHaveLength(1);
    expect(listing.applications[0]).toMatchObject({
      id: added.jobId, company: "Northwind Labs", tier: "confirmed", stage: "qualified", channel: "contract_gigs",
      source: "manual", compMin: null, compCurrency: "USD", held: 0,
    });
    expect(listing.stages.qualified).toBe(1);
    expect(listing.stages.investigating).toBe(0); // zero-filled

    const detail = app.application(added.jobId).body;
    expect(detail.job.skills).toEqual(["Python", "LangGraph"]);
    expect(detail.job).toMatchObject({ applyUrl: "https://jobs.ashbyhq.com/northwind/1", isRemote: null });
    expect(detail.evaluation?.reasonCodes).toContain("CONTRACTOR_RAILS");
    expect(sorted(detail.activity.map((event) => event.kind))).toEqual(["discovered", "evaluated"]);
    expect(detail.quarantine).toEqual([]);
  });

  test("an ambiguous listing joins the investigation queue", () => {
    const added = app.addApplication(AMBIGUOUS).body;
    if (added.duplicate) throw new Error("expected a new listing");
    expect(added.report.tier).toBe("potentially_eligible");
    expect(added.report.needsB2bInvestigation).toBe(true);
    const overview = app.overview().body;
    expect(overview.stages.investigating).toBe(1);
    expect(overview.pending).toEqual({
      quarantine: 0, investigation: 1, needsDecision: 0, needsAttention: 0, needsCode: 0, awaitingReview: 0, toSend: 0,
    });
    expect(overview.goal).toEqual({ monthlyIncomeGoalUsd: 10000, maxConcurrentEngagements: 3, securedMonthlyUsd: 0 });
    const queued = app.activity({}).body.events.find((event) => event.kind === "queued");
    expect(queued).toMatchObject({ jobId: added.jobId, detail: { taskType: "b2b_investigation", status: "pending" } });
    expect(overview.recentActivity.map((event) => event.kind)).toContain("queued");
  });

  test("the same listing twice is reported as already tracked", () => {
    const first = app.addApplication(WORLDWIDE).body;
    const second = app.addApplication({ ...WORLDWIDE, company: "NORTHWIND LABS " });
    expect(second).toEqual({ status: 200, body: { duplicate: true, jobId: first.jobId } });
    expect(app.applications({}).body.applications).toHaveLength(1);
  });

  test("filters and search", () => {
    app.addApplication(WORLDWIDE);
    app.addApplication(AMBIGUOUS);
    const companies = (query: Record<string, string>): string[] =>
      app.applications(query).body.applications.map((row) => row.company);

    expect(companies({ stage: "investigating" })).toEqual(["Fathom Systems"]);
    expect(companies({ tier: "confirmed" })).toEqual(["Northwind Labs"]);
    expect(companies({ q: "northwind" })).toEqual(["Northwind Labs"]);
    expect(companies({ q: "  platform engineer " })).toEqual(["Fathom Systems"]); // matches the title, trimmed
    expect(companies({ q: "worldwide", stage: "qualified" })).toEqual(["Northwind Labs"]); // and the location
    // LIKE wildcards in the search are literal text.
    expect(companies({ q: "100%" })).toEqual([]);
    expect(companies({ q: "%" })).toEqual([]);
    expect(companies({ q: "North_ind" })).toEqual([]);
    expect(companies({ q: "\\" })).toEqual([]);
    expect(sorted(companies({}))).toEqual(["Fathom Systems", "Northwind Labs"]);
  });

  test("an eligibility check does not save anything", () => {
    const { status, body } = app.checkEligibility({ ...AMBIGUOUS, description: "US citizenship required." });
    expect(status).toBe(200);
    expect(body.report.tier).toBe("ineligible");
    expect(app.applications({}).body.applications).toEqual([]);
    expect(app.activity({}).body.events).toEqual([]);
  });

  test("invalid listings are rejected", () => {
    const cases: Array<[change: JsonObject, fragment: string]> = [
      [{ company: "" }, "company"],
      [{ title: "   " }, "title"],
      [{ company: 7 }, "company"],
      [{ applyUrl: "javascript:alert(1)" }, "applyUrl"],
      [{ applyUrl: "https://example.com/a b" }, "applyUrl"],
      [{ compMax: -5 }, "compMax"],
      [{ compMin: "40" }, "compMin"],
      [{ compPeriod: "fortnight" }, "compPeriod"],
      [{ employmentType: "internship" }, "employmentType"],
      [{ channel: "carrier_pigeon" }, "channel"],
      [{ isRemote: "yes" }, "isRemote"],
      [{ skills: "Python" }, "skills"],
      [{ skills: [1, 2] }, "skills"],
      [{ description: "x".repeat(100_001) }, "description"],
    ];
    for (const [change, fragment] of cases) {
      for (const call of [() => app.addApplication({ ...WORLDWIDE, ...change }), () => app.checkEligibility({ ...WORLDWIDE, ...change })]) {
        const error = refused(call);
        expect(error.status, fragment).toBe(400);
        expect(error.message).toContain(`'${fragment}'`);
      }
    }
    expect(app.applications({}).body.applications).toEqual([]);
  });

  test("a listing's optional fields are normalised", () => {
    const added = app.addApplication({
      ...WORLDWIDE, companyDomain: " Northwind.IO ", compCurrency: "eur", compMin: 60, compMax: 90, compPeriod: "hour",
      employmentType: "contract", isRemote: true, skills: [" Python ", "", "LangGraph"],
    }).body;
    expect(app.application(added.jobId).body.job).toMatchObject({
      companyDomain: "northwind.io", compCurrency: "EUR", compMin: 60, compMax: 90, compPeriod: "hour",
      employmentType: "contract", isRemote: true, skills: ["Python", "LangGraph"],
    });
  });

  test("markup in a listing never reaches the page as markup", async () => {
    const hostile = {
      ...WORLDWIDE,
      description: 'Remote worldwide. <script>alert("x")</script><img src=x onerror=alert(1)>',
    };
    const { jobId } = app.addApplication(hostile).body;
    const response = await serve(request("GET", `/api/applications/${jobId}`), PORT, () => app.application(jobId));
    // The body is JSON and says so, and the browser is told not to second-guess that.
    expect(response.headers.get("content-type")).toBe("application/json; charset=utf-8");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("cache-control")).toBe("no-store");
    const { description } = ((await response.json()) as { job: { description: string } }).job;
    expect(description).toContain("Remote worldwide.");
    expect(description).not.toContain("<script");
    expect(description).not.toContain("<img");
  });

  test("an unknown application is a 404", () => {
    expect(refused(() => app.application("deadbeef")).status).toBe(404);
    expect(refused(() => app.application("../../etc/passwd")).status).toBe(404);
    expect(refused(() => app.application("")).status).toBe(404);
  });
});

// ---------- Actions ----------

describe("actions", () => {
  let held: number[];

  /** One tracked job with a held draft, a dispatch, two paid calls and an old breaker trip. */
  function seed(): string {
    const { jobId } = app.addApplication(WORLDWIDE).body;
    const { repo } = app;
    const draft = JSON.stringify({ pitch: "I hope this email finds you well.", cvBullets: [], screeningAnswers: [] });
    // One inspection that tripped two rules: the Cop Tool writes a row per rule.
    held = repo.quarantine([
      {
        jobId, violationRule: "9_tone", originalContent: draft, retryCount: 2, createdAt: ago(3 * HOUR),
        critique: "[pitch] filler or cliché: 'i hope this email finds you'; [pitch] contains emoji",
      },
      {
        jobId, violationRule: "8_deduplication", originalContent: draft, retryCount: 2, createdAt: ago(3 * HOUR),
        critique: "[job] Northwind Labs was already contacted on 2026-10-07 (job abc); next contact allowed from 2026-11-06",
      },
    ]);
    repo.recordDispatch({
      jobId, channel: Channel.CONTRACT_GIGS, companyKey: "northwind labs", domain: "",
      contact: "founder@northwind.io", dispatchedAt: ago(2 * HOUR),
    });
    for (const [age, costUsd] of [[HOUR, 0.00108], [2 * DAY, 0.25]]) {
      repo.recordTelemetry({
        provider: "fireworks", model: LLAMA, taskType: "pitch", promptTokens: 1000, completionTokens: 200,
        costUsd, latencyMs: 800, timestamp: ago(age),
      });
    }
    repo.setState("circuit_breaker", { day: "2026-10-01", tripped_at: ago(11 * DAY), spent_usd: 1.4999 });
    return jobId;
  }

  test("the activity feed merges every kind of action, newest first", () => {
    const jobId = seed();
    const { events } = app.activity({}).body;
    expect(sorted(events.map((event) => event.kind))).toEqual([
      "breaker", "discovered", "dispatched", "evaluated", "llm_call", "quarantined",
    ]);
    const times = events.map((event) => event.at);
    expect(times).toEqual([...times].sort().reverse());

    expect(events.find((event) => event.kind === "dispatched")).toMatchObject({
      jobId, company: "Northwind Labs", detail: { channel: "contract_gigs", contact: "founder@northwind.io" },
    });
    expect(events.find((event) => event.kind === "breaker")).toMatchObject({
      jobId: null, detail: { spentUsd: 1.4999, day: "2026-10-01" },
    });

    const calls = app.activity({ kind: "llm_call" }).body.events;
    expect(calls.map((event) => event.kind)).toEqual(["llm_call", "llm_call"]);
    expect(calls[0].detail).toMatchObject({ taskType: "pitch", promptTokens: 1000, costUsd: 0.00108, outcome: "ok" });
    expect(app.activity({ limit: "3" }).body.events).toHaveLength(3);
    expect(app.activity({ limit: "0" }).body.events).toHaveLength(1); // clamped to at least one
    expect(app.activity({ kind: "no_such_kind" }).body.events).toEqual([]);
    for (const limit of ["abc", "", "1.5", "1e3"]) {
      expect(refused(() => app.activity({ limit })).status).toBe(400);
    }

    // A job's own history leaves out what belongs to no job.
    const history = app.application(jobId).body.activity;
    expect(sorted(history.map((event) => event.kind))).toEqual(["discovered", "dispatched", "evaluated", "quarantined"]);
  });

  test("rules from one inspection are shown as a single hold", () => {
    const jobId = seed();
    const pending = app.quarantine({}).body;
    expect(pending.pending).toBe(1);
    expect(pending.holds).toHaveLength(1);
    const [hold] = pending.holds;
    expect(hold).toMatchObject({ jobId, company: "Northwind Labs", retryCount: 2, status: "pending", ids: held });
    expect(hold.draft?.pitch).toBe("I hope this email finds you well.");
    const [tone, dedup] = hold.findings;
    expect(tone.rule).toBe("9_tone");
    expect(tone.critiques).toEqual(["[pitch] filler or cliché: 'i hope this email finds you'", "[pitch] contains emoji"]);
    // A critique that itself contains "; " is not split in two.
    expect(dedup.rule).toBe("8_deduplication");
    expect(dedup.critiques).toHaveLength(1);

    const overview = app.overview().body;
    expect(overview.stages.quarantined).toBe(1);
    expect(overview.pending.quarantine).toBe(1);
    expect(app.applications({}).body.applications[0].held).toBe(1);
    const quarantined = app.activity({ kind: "quarantined" }).body.events;
    expect(quarantined).toHaveLength(1);
    expect(quarantined[0].detail).toEqual({ rules: ["9_tone", "8_deduplication"], retryCount: 2, status: "pending" });
    expect(app.application(jobId).body.quarantine).toEqual(pending.holds);
  });

  test("holds written by either implementation are read", () => {
    const { jobId } = app.addApplication(WORLDWIDE).body;
    const base = { jobId, violationRule: "1_fact_grounding", retryCount: 0 };
    app.repo.quarantine([
      {
        ...base, createdAt: ago(2 * HOUR),
        critique: "[cvBullets[0]] cites 45%; which is not in the achievement; [screeningAnswers[2]] names an unknown employer",
        originalContent: JSON.stringify({
          jobId, channel: "contract_gigs", positioningProfileId: "ai_platform_agent",
          pitch: "Hello", cvBullets: [{ text: "Cut latency by 45%", achievementId: "ach_agents" }],
          screeningAnswers: [{ question: "Notice?", answer: "2 weeks", options: [], factKey: "notice_period" }],
          resumePdfPath: "/tmp/resume.pdf", quotedRateUsd: 50, quotedRatePeriod: "hour", contact: "cto@northwind.io",
        }),
      },
      {
        // As the original Python console stored it: snake_case fields and draft.
        ...base, createdAt: ago(HOUR),
        critique: "[cv_bullets[0]] cites 45%; [resume_pdf] has 3 pages",
        originalContent: JSON.stringify({
          job_id: jobId, channel: "contract_gigs", positioning_profile_id: "ai_platform_agent",
          pitch: "Hello", cv_bullets: [{ text: "Cut latency by 45%", achievement_id: "ach_agents" }],
          screening_answers: [{ question: "Notice?", answer: "2 weeks", options: ["Now", "2 weeks"] }],
          resume_pdf_path: "/tmp/resume.pdf", quoted_rate_usd: 50, quoted_rate_period: "hour", contact: "cto@northwind.io",
        }),
      },
      { ...base, createdAt: ago(3 * HOUR), critique: "[draft] draft has no content", originalContent: "not json" },
    ]);
    const [python, current, unreadable] = app.quarantine({}).body.holds; // newest first
    expect(current.findings[0].critiques).toEqual([
      "[cvBullets[0]] cites 45%; which is not in the achievement", "[screeningAnswers[2]] names an unknown employer",
    ]);
    expect(python.findings[0].critiques).toEqual(["[cv_bullets[0]] cites 45%", "[resume_pdf] has 3 pages"]);
    expect(current.draft).toEqual({
      channel: "contract_gigs", positioningProfileId: "ai_platform_agent",
      pitch: "Hello", cvBullets: [{ text: "Cut latency by 45%", achievementId: "ach_agents" }],
      screeningAnswers: [{ question: "Notice?", answer: "2 weeks", options: [] }],
      resumePdfPath: "/tmp/resume.pdf", quotedRateUsd: 50, quotedRatePeriod: "hour", contact: "cto@northwind.io",
      cvMatch: null, cvSummary: "",
    });
    expect(python.draft).toEqual({
      ...current.draft, screeningAnswers: [{ question: "Notice?", answer: "2 weeks", options: ["Now", "2 weeks"] }],
    });
    expect(unreadable.draft).toBeNull();
    // None of these critiques is about a question only the candidate can answer.
    expect([python, current, unreadable].map((hold) => hold.questions)).toEqual([[], [], []]);
    expect(app.quarantine({}).body.pending).toBe(3);
  });

  test("the quarantine review flow", () => {
    seed();
    const [hold] = app.quarantine({}).body.holds;
    expect(app.reviewQuarantine({ ids: hold.ids })).toEqual({ status: 200, body: { ok: true } });
    expect(app.quarantine({}).body).toEqual({ holds: [], pending: 0 });
    const reviewed = app.quarantine({ status: "reviewed" }).body.holds;
    expect(reviewed).toHaveLength(1);
    expect(reviewed[0].status).toBe("reviewed");
    expect(app.quarantine({ status: "all" }).body.holds).toHaveLength(1);
    expect(app.applications({}).body.applications[0].held).toBe(0);

    expect(refused(() => app.reviewQuarantine({ ids: hold.ids })).status).toBe(404); // already done
    expect(refused(() => app.reviewQuarantine({ ids: [9999] })).status).toBe(404);
    const tooMany = Array.from({ length: 51 }, (_, index) => index);
    for (const bad of [{}, { ids: [] }, { ids: ["1"] }, { ids: [true] }, { ids: [1.5] }, { ids: 1 }, { ids: tooMany }]) {
      expect(refused(() => app.reviewQuarantine(bad)).status).toBe(400);
    }
    expect(refused(() => app.quarantine({ status: "bogus" })).status).toBe(400);
  });

  test("a hold stays pending until every one of its findings is reviewed", () => {
    seed();
    app.reviewQuarantine({ ids: [held[0]] });
    const pending = app.quarantine({}).body;
    expect(pending.pending).toBe(1);
    expect(pending.holds[0]).toMatchObject({ status: "pending", ids: held });
    expect(app.quarantine({ status: "reviewed" }).body.holds).toEqual([]);
  });

  test("costs report the budget, history and breakdown", () => {
    seed();
    const costs = app.costs().body;
    expect(costs.budget.spentUsd).toBeCloseTo(0.00108, 8);
    expect(costs.budget.remainingUsd).toBeCloseTo(1.49892, 8);
    expect(costs.budget).toMatchObject({ capUsd: 1.5, utcOffsetHours: 1, tripped: false }); // the trip was on an earlier day
    expect(costs.daily).toHaveLength(14);
    expect(costs.daily[0].day).toBe("2026-09-29");
    expect(costs.daily.at(-1)).toEqual({ day: "2026-10-12", costUsd: 0.00108, calls: 1 });
    expect(costs.daily.at(-3)).toEqual({ day: "2026-10-10", costUsd: 0.25, calls: 1 });
    expect(costs.daily.at(-2)).toEqual({ day: "2026-10-11", costUsd: 0, calls: 0 });
    expect(costs.daily.reduce((sum, day) => sum + day.calls, 0)).toBe(2);
    expect(costs.byModel).toHaveLength(1);
    expect(costs.byModel[0]).toMatchObject({
      provider: "fireworks", model: LLAMA, calls: 2, promptTokens: 2000, completionTokens: 400, avgLatencyMs: 800,
    });
    expect(costs.allTimeUsd).toBeCloseTo(0.25108, 8);
    expect(costs.recent.map((call) => call.costUsd)).toEqual([0.00108, 0.25]); // newest first
  });

  test("the 14-day history follows the budget day, not the UTC day", () => {
    // 23:30 UTC on the 11th is already 00:30 on the 12th in Cameroon (UTC+1).
    app.repo.recordTelemetry({ provider: "jev", model: "jev-latest", taskType: "fit", costUsd: 0.5, timestamp: "2026-10-11T23:30:00.000000+00:00" });
    // 22:30 UTC on the 28th of September is 23:30 local: the day before the window opens.
    app.repo.recordTelemetry({ provider: "jev", model: "jev-latest", taskType: "fit", costUsd: 0.75, timestamp: "2026-09-28T22:30:00.000000+00:00" });
    // 23:30 UTC that day is 00:30 on the 29th: the first day shown.
    app.repo.recordTelemetry({ provider: "jev", model: "jev-latest", taskType: "fit", costUsd: 0.125, timestamp: "2026-09-28T23:30:00.000000+00:00" });
    const costs = app.costs().body;
    expect(costs.daily.at(-1)).toEqual({ day: "2026-10-12", costUsd: 0.5, calls: 1 });
    expect(costs.daily.at(-2)).toEqual({ day: "2026-10-11", costUsd: 0, calls: 0 });
    expect(costs.daily[0]).toEqual({ day: "2026-09-29", costUsd: 0.125, calls: 1 });
    expect(costs.daily.reduce((sum, day) => sum + day.calls, 0)).toBe(2);
    expect(costs.budget.spentUsd).toBe(0.5);
    expect(costs.allTimeUsd).toBe(1.375);

    // With the budget day on UTC the same call belongs to the 11th.
    const config = filledConfig();
    config.budget.day_utc_offset_hours = 0;
    app.saveConfig({ config });
    const utc = app.costs().body;
    expect(utc.daily.at(-2)).toEqual({ day: "2026-10-11", costUsd: 0.5, calls: 1 });
    expect(utc.daily.at(-1)).toEqual({ day: "2026-10-12", costUsd: 0, calls: 0 });
    expect(utc.budget).toMatchObject({ spentUsd: 0, utcOffsetHours: 0 });
  });

  test("a tripped breaker is shown as paused", () => {
    app.repo.setState("circuit_breaker", { day: "2026-10-12", tripped_at: toIso(NOW), spent_usd: 1.5 });
    expect(app.overview().body.budget.tripped).toBe(true);
    expect(app.costs().body.budget.tripped).toBe(true);
    const breaker = app.state().body.system.find((part) => part.name === "Cost ledger & circuit breaker");
    expect(breaker).toMatchObject({ status: "paused", detail: expect.stringContaining("Tripped") });
  });
});

// ---------- Operating the pipeline ----------

/** A finished cycle, as the terminal run leaves it in the database. */
const finishedCycle = (finishedAt: string): CycleReport => ({
  startedAt: finishedAt, finishedAt, steps: ["discover", "investigate", "score", "draft", "apply"],
  fetched: 40, added: 6, tiers: { confirmed: 2, potentially_eligible: 3, ineligible: 1 },
  investigated: { qualified: 1, disqualified: 1, needs_human: 1 }, pitchedUnconfirmed: 1, scored: 3, lowFit: 1,
  drafts: { awaitingReview: 0, approved: 2, quarantined: 1, skipped: 0 }, leadsDrafted: 1,
  leadsMoved: 0, boardsLearned: 0, emailed: 0, notified: 0, holdsRetried: 0,
  inbox: { opened: 0, confirmed: 0, rejected: 0, replies: 0 }, waiting: { toSend: 0, held: 0, needsAttention: 0 }, unattended: false,
  applications: { submitted: 1, handedOff: 1, failed: 0 }, paused: false, blocked: [], errors: ["lever:acme: HTTP 404"],
});

/** A distinct listing that classifies as confirmed eligible, so it starts out qualified. */
const listing = (n: number, extra: JsonObject = {}): JsonObject => ({
  ...WORLDWIDE, company: `Company ${n}`, applyUrl: `https://jobs.example.com/apply/${n}`, ...extra,
});
const FOUNDER = listing(90, {
  company: "Lumen Robotics", title: "Founding AI Engineer", channel: "founder_direct", applyUrl: "mailto:dana@lumen.example",
});

/** Track a listing and give it a draft in `status`, as the drafting step would. */
function drafted(body: JsonObject, status: DraftStatus, note = ""): { jobId: string; draftId: number } {
  const { jobId } = app.addApplication(body).body;
  const draftId = app.repo.saveDraft(
    createDraft({
      jobId, channel: (body.channel as Channel | undefined) ?? Channel.CONTRACT_GIGS,
      positioningProfileId: "ai_platform_agent", pitch: "Hello Dana — I build agent runtimes.",
      cvBullets: [{ text: "Cut workflow latency by 45%", achievementId: "ach_agents" }],
      screeningAnswers: [{ question: "Email", answer: "candidate@example.com", options: [], factKey: "email" }],
      resumePdfPath: "/tmp/resumes/lumen.pdf", quotedRateUsd: 55, quotedRatePeriod: "hour", contact: "dana@lumen.example",
    }),
    DraftStatus.AWAITING_REVIEW,
  );
  // The drafting step stores a draft once; every later move goes through setDraftStatus, as here.
  if (status !== DraftStatus.AWAITING_REVIEW) app.repo.setDraftStatus(draftId, status, note);
  return { jobId, draftId };
}

const stageOf = (jobId: string): string | undefined => app.repo.getJob(jobId)?.stage;

describe("the pipeline", () => {
  const pipelinePart = () => app.overview().body.system.find((part) => part.name === "Pipeline");

  test("the overview says how it runs and whether a cycle finished recently", () => {
    const fresh = app.overview().body;
    expect(fresh.mode).toEqual({ description: expect.stringContaining("HANDS-FREE"), reviewFirst: false, pitchUnconfirmed: true });
    expect(fresh.lastCycle).toBeNull();
    expect(fresh.cycleIsRecent).toBe(false);
    expect(pipelinePart()).toMatchObject({ status: "idle", detail: expect.stringContaining("No cycle has run yet") });
    expect(pipelinePart()?.detail).toContain("npm run wake");

    const recent = finishedCycle(ago(30 * 60_000));
    app.repo.setState(HEARTBEAT_KEY, recent);
    expect(app.overview().body).toMatchObject({ lastCycle: recent, cycleIsRecent: true });
    expect(pipelinePart()).toMatchObject({ status: "running", detail: expect.stringContaining("finished recently") });
    expect(app.state().body.system.find((part) => part.name === "Pipeline")?.status).toBe("running");

    // The loop runs hourly by default: five hours of silence means nothing is running.
    app.repo.setState(HEARTBEAT_KEY, finishedCycle(ago(5 * HOUR)));
    expect(app.overview().body.cycleIsRecent).toBe(false);
    expect(pipelinePart()).toMatchObject({ status: "idle", detail: expect.stringContaining("No cycle has finished recently") });

    // A slower loop is given proportionally longer before it counts as stopped.
    const config = filledConfig();
    config.pipeline.loop_interval_minutes = 240;
    app.saveConfig({ config });
    expect(app.overview().body.cycleIsRecent).toBe(true);

    app.repo.setState(HEARTBEAT_KEY, "not a report");
    expect(app.overview().body).toMatchObject({ lastCycle: null, cycleIsRecent: false });
  });

  test("the mode line follows the saved settings", () => {
    const config = filledConfig();
    config.pipeline.auto_submit = false;
    app.saveConfig({ config });
    expect(app.overview().body.mode.description).toContain("ASSISTED");

    config.pipeline.require_human_review = true;
    config.pipeline.pitch_unconfirmed_tier2 = false;
    app.saveConfig({ config });
    expect(app.overview().body.mode).toEqual({
      description: expect.stringContaining("REVIEW FIRST"), reviewFirst: true, pitchUnconfirmed: false,
    });
  });

  test("everything waiting on the user is counted", () => {
    const tier2 = app.addApplication(AMBIGUOUS).body.jobId;
    expect(app.overview().body.pending).toMatchObject({ investigation: 1, needsDecision: 0 });
    // The investigation could not settle it: it now waits for the user, not for the pipeline.
    app.repo.setTaskStatus("b2b_investigation", tier2, "needs_human");
    drafted(listing(1), DraftStatus.AWAITING_REVIEW);
    drafted(listing(2), DraftStatus.NEEDS_ATTENTION, "CAPTCHA on the form.");
    drafted(listing(3), DraftStatus.NEEDS_ATTENTION, "Login required.");
    drafted(listing(4), DraftStatus.APPROVED); // has a form: the pipeline will submit it
    drafted(FOUNDER, DraftStatus.APPROVED); // no form: only the user can send it
    drafted(listing(5, { applyUrl: "" }), DraftStatus.APPROVED); // no link at all: likewise
    expect(app.overview().body.pending).toEqual({
      quarantine: 0, investigation: 0, needsDecision: 1, needsAttention: 2, needsCode: 0, awaitingReview: 1, toSend: 2,
    });
    expect(app.overview().body.stages).toMatchObject({ approved: 3, needs_attention: 2, awaiting_review: 1, investigating: 1 });
  });

  test("income secured is what accepted engagements add up to", () => {
    const { jobId } = drafted(listing(1), DraftStatus.SUBMITTED);
    app.recordOutcome(jobId, { kind: "interview" });
    expect(app.overview().body.goal.securedMonthlyUsd).toBe(0);
    app.recordOutcome(jobId, { kind: "accepted", monthlyValueUsd: 4200, note: "20 h/week" });
    expect(app.overview().body.goal).toEqual({ monthlyIncomeGoalUsd: 10000, maxConcurrentEngagements: 3, securedMonthlyUsd: 4200 });
  });

  const LISTINGS = () => [
    createJob({
      source: "greenhouse", sourceId: "1", company: "Northwind Labs", title: "Senior AI Agent Engineer",
      location: "Remote (Worldwide)", description: "Build LangGraph agents in Python. Contractors are paid through Deel.",
      applyUrl: "https://boards.greenhouse.io/northwind/jobs/1", skills: ["Python", "LangGraph"],
    }),
    createJob({
      source: "ashby", sourceId: "2", company: "Fathom Systems", title: "Agent Platform Engineer", location: "Remote",
      description: "San Francisco startup with a fully remote team. Python and LangGraph.",
      applyUrl: "https://jobs.ashbyhq.com/fathom/2",
    }),
    createJob({
      source: "lever", sourceId: "3", company: "Aegis Federal", title: "Senior Software Engineer", location: "Remote",
      description: "US citizenship required. Must hold an active security clearance.", applyUrl: "https://jobs.lever.co/aegis/3",
    }),
  ];

  test("Run discovery now fetches, investigates and scores in this process", async () => {
    const asked: Step[][] = [];
    cycle = (steps) => {
      asked.push([...steps]);
      // The real pipeline over the console's own database; only the job boards are replaced.
      return runCycle(
        {
          ...createPipelineDeps(loadConfig(configPath), app.repo, null),
          discover: async () => ({ jobs: LISTINGS(), errors: [{ source: "lever:acme", message: "HTTP 404" }] }),
          clock: () => NOW,
        },
        steps,
      );
    };
    const { status, body } = await app.runDiscovery();
    expect(status).toBe(200);
    // Never draft or apply: those read and fill forms, which is the terminal run's job.
    expect(asked).toEqual([["discover", "investigate", "score"]]);
    expect(body.report).toMatchObject({
      steps: ["discover", "investigate", "score"], fetched: 3, added: 3,
      tiers: { confirmed: 1, potentially_eligible: 1, ineligible: 1 },
      // No Jev key, hands-free: nothing is judged, so the Tier 2 job stays queued and nothing is scored.
      investigated: { qualified: 0, disqualified: 0, needs_human: 0 }, pitchedUnconfirmed: 0, scored: 0,
      blocked: [expect.stringContaining("TypeSafe (Jev) key")],
      drafts: { awaitingReview: 0, approved: 0, quarantined: 0, skipped: 0 },
      applications: { submitted: 0, handedOff: 0, failed: 0 }, errors: ["lever:acme: HTTP 404"],
    });
    expect(app.repo.listDrafts()).toEqual([]);
    expect(sorted(app.applications({}).body.applications.map((row) => row.company))).toEqual([
      "Aegis Federal", "Fathom Systems", "Northwind Labs",
    ]);
    expect(app.applications({ stage: "investigating" }).body.applications.map((row) => row.company)).toEqual(["Fathom Systems"]);
    // The run is the last cycle on record, so the overview shows it at once.
    expect(app.overview().body).toMatchObject({ lastCycle: body.report, cycleIsRecent: true });
    expect(fetched).toEqual([]);
  });

  test("a second run is refused while one is in progress, and a broken config is the user's to fix", async () => {
    let finish: (report: CycleReport) => void = () => {};
    cycle = () => new Promise((resolve) => {
      finish = resolve;
    });
    const first = app.runDiscovery();
    await expect(app.runDiscovery()).rejects.toMatchObject({ status: 409 });
    finish(finishedCycle(toIso(NOW)));
    expect((await first).status).toBe(200);

    cycle = async () => {
      throw new ConfigError("fact_bank.achievements contains duplicate ids");
    };
    await expect(app.runDiscovery()).rejects.toMatchObject({ status: 400, message: "fact_bank.achievements contains duplicate ids" });
    // Anything else is a fault — and must not leave the console believing a run is still going.
    cycle = async () => {
      throw new Error("database is locked");
    };
    await expect(app.runDiscovery()).rejects.toThrow("database is locked");
    cycle = async () => finishedCycle(toIso(NOW));
    expect((await app.runDiscovery()).status).toBe(200);
  });

  test("left to itself the console runs the real pipeline, with no browser and no draft or apply step", async () => {
    const config = filledConfig();
    // With nothing to fetch, the real discovery makes no request at all.
    Object.assign(config.discovery, NO_SOURCES);
    // Review-first: with a person approving every draft, the free fallbacks may keep jobs moving without a key.
    config.pipeline.require_human_review = true;
    app.saveConfig({ config });
    const { jobId } = app.addApplication(AMBIGUOUS).body;
    const own = new WebApp({ configPath, dbPath: path.join(tmp, "reygent.db"), clock: () => NOW });
    const realFetch = globalThis.fetch;
    globalThis.fetch = () => {
      throw new Error("the network must not be touched");
    };
    try {
      const { body } = await own.runDiscovery();
      expect(body.report).toMatchObject({
        steps: ["discover", "investigate", "score"], fetched: 0, added: 0, errors: [],
        investigated: { needs_human: 1 }, pitchedUnconfirmed: 1, scored: 1,
      });
    } finally {
      globalThis.fetch = realFetch;
      own.close();
    }
    expect(app.application(jobId).body.fit).not.toBeNull();
    expect(app.repo.listDrafts()).toEqual([]);
    expect(app.overview().body.lastCycle?.scored).toBe(1);
  });

  test("a cross-site page cannot start a run", async () => {
    const attempt = request("POST", "/api/pipeline/run", { headers: { origin: "https://evil.example" } });
    // Had the guard let it through, the stand-in cycle would throw and this would be a 500.
    expect((await serve(attempt, PORT, () => app.runDiscovery())).status).toBe(403);
    cycle = async () => finishedCycle(toIso(NOW));
    const allowed = await answer(await serve(request("POST", "/api/pipeline/run"), PORT, () => app.runDiscovery()));
    expect(allowed.status).toBe(200);
    expect(allowed.body.report).toMatchObject({ fetched: 40, added: 6 });
  });
});

// ---------- Acting on applications ----------

describe("acting on an application", () => {
  test("an open investigation is settled by the user's own call", () => {
    const { jobId } = app.addApplication(AMBIGUOUS).body;
    expect(app.application(jobId).body.actions).toEqual(["qualify", "disqualify"]);

    const qualified = app.resolveInvestigation(jobId, { decision: "qualify" });
    expect(qualified.status).toBe(200);
    expect(qualified.body.job.stage).toBe("qualified");
    expect(qualified.body.evaluation).toMatchObject({ tier: "confirmed", needsB2bInvestigation: false });
    expect(qualified.body.evaluation?.reasonCodes).toContain("B2B_CONFIRMED_BY_USER");
    expect(qualified.body.actions).toEqual([]);
    expect(app.overview().body.pending.investigation).toBe(0);
    // It is no longer open, so the same call again changes nothing.
    expect(refused(() => app.resolveInvestigation(jobId, { decision: "disqualify" })).status).toBe(409);
    expect(stageOf(jobId)).toBe("qualified");

    const other = app.addApplication({ ...AMBIGUOUS, company: "Harbor Analytics" }).body.jobId;
    expect(app.resolveInvestigation(other, { decision: "disqualify" }).body.job).toMatchObject({
      stage: "disqualified", tier: "ineligible",
    });
  });

  test("an investigation call needs a job that is being investigated and a decision that exists", () => {
    const { jobId } = app.addApplication(AMBIGUOUS).body;
    const settled = app.addApplication(WORLDWIDE).body.jobId;
    for (const body of [{}, { decision: "maybe" }, { decision: true }, { decision: ["qualify"] }]) {
      expect(refused(() => app.resolveInvestigation(jobId, body)).status).toBe(400);
    }
    expect(refused(() => app.resolveInvestigation(settled, { decision: "qualify" })).status).toBe(409);
    expect(refused(() => app.resolveInvestigation("deadbeef", { decision: "qualify" })).status).toBe(404);
    expect(refused(() => app.resolveInvestigation("../x", { decision: "qualify" })).status).toBe(404);
    expect([stageOf(jobId), stageOf(settled)]).toEqual(["investigating", "qualified"]);
  });

  test("the detail page has the fit, the draft and what can be done next", () => {
    const { jobId, draftId } = drafted(listing(1), DraftStatus.AWAITING_REVIEW);
    app.repo.saveFit({
      jobId, fitScore: 82, bestPositioningProfile: "ai_platform_agent", matchedSkills: ["Python", "LangGraph"],
      missingSkills: ["Rust"],
    });
    const detail = app.application(jobId).body;
    expect(detail.fit).toEqual({
      fitScore: 82, bestPositioningProfile: "ai_platform_agent", matchedSkills: ["Python", "LangGraph"], missingSkills: ["Rust"],
    });
    expect(detail.draft).toMatchObject({ id: draftId, status: "awaiting_review", note: "", copRetries: 0 });
    expect(detail.draft?.content).toEqual({
      channel: "contract_gigs", positioningProfileId: "ai_platform_agent", pitch: "Hello Dana — I build agent runtimes.",
      cvBullets: [{ text: "Cut workflow latency by 45%", achievementId: "ach_agents" }],
      screeningAnswers: [{ question: "Email", answer: "candidate@example.com", options: [] }],
      resumePdfPath: "/tmp/resumes/lumen.pdf", quotedRateUsd: 55, quotedRatePeriod: "hour", contact: "dana@lumen.example",
      cvMatch: null, cvSummary: "",
    });
    expect(detail).toMatchObject({
      actions: ["approve", "decline"], sentByHand: false, dispatches: [], outcomes: [], hasEvidence: false,
    });
    expect(sorted(detail.activity.map((event) => event.kind))).toEqual(["discovered", "drafted", "evaluated"]);
    expect(detail.activity.find((event) => event.kind === "drafted")?.detail).toEqual({
      status: "awaiting_review", note: "", copRetries: 0,
    });

    // A job that has only been classified has none of it.
    const bare = app.application(app.addApplication(listing(2)).body.jobId).body;
    expect(bare).toMatchObject({ fit: null, draft: null, actions: [], dispatches: [], outcomes: [] });
  });

  test("a draft awaiting review is approved or declined", () => {
    const { jobId, draftId } = drafted(listing(1), DraftStatus.AWAITING_REVIEW);
    const approved = app.draftAction(jobId, { action: "approve" }).body;
    expect(approved.job.stage).toBe("approved");
    expect(approved.draft?.status).toBe("approved");
    // It has a form, so the pipeline submits it; the user can only call it off.
    expect(approved.actions).toEqual(["decline"]);
    expect(refused(() => app.draftAction(jobId, { action: "approve" })).status).toBe(409);
    expect(refused(() => app.draftAction(jobId, { action: "submitted" })).status).toBe(409);
    expect(refused(() => app.draftAction(jobId, { action: "retry" })).status).toBe(409);
    expect(app.repo.listDispatches(jobId)).toEqual([]);

    const declined = app.draftAction(jobId, { action: "decline" }).body;
    expect(declined).toMatchObject({ job: { stage: "declined" }, draft: { status: "declined" }, actions: [] });
    expect(app.repo.getDraft(draftId)?.status).toBe(DraftStatus.DECLINED);
    for (const action of ["approve", "decline", "submitted", "retry"]) {
      expect(refused(() => app.draftAction(jobId, { action })).status).toBe(409);
    }

    const other = drafted(listing(2), DraftStatus.AWAITING_REVIEW).jobId;
    expect(app.draftAction(other, { action: "decline" }).body.job.stage).toBe("declined");
  });

  test("an approved pitch with no form is sent by the user and marked as sent", () => {
    const { jobId, draftId } = drafted(FOUNDER, DraftStatus.APPROVED);
    const waiting = app.application(jobId).body;
    expect(waiting).toMatchObject({ sentByHand: true, actions: ["submitted", "decline"] });
    expect(waiting.draft?.content).toMatchObject({ contact: "dana@lumen.example", channel: "founder_direct" });

    const sent = app.draftAction(jobId, { action: "submitted" }).body;
    expect(sent).toMatchObject({ job: { stage: "submitted" }, draft: { status: "submitted" }, actions: ["outcome"] });
    // The dispatch is logged, so the 30-day rule knows this company has been contacted.
    expect(sent.dispatches).toEqual([
      { channel: "founder_direct", domain: "lumen.example", contact: "dana@lumen.example", dispatchedAt: toIso(NOW) },
    ]);
    expect(app.repo.getDraft(draftId)?.status).toBe(DraftStatus.SUBMITTED);
    expect(app.activity({ kind: "dispatched" }).body.events).toHaveLength(1);
    expect(refused(() => app.draftAction(jobId, { action: "submitted" })).status).toBe(409); // not twice
    expect(app.repo.listDispatches(jobId)).toHaveLength(1);
  });

  test("an application the operator handed off is finished by hand, retried or declined", () => {
    const first = drafted(listing(1), DraftStatus.NEEDS_ATTENTION, "CAPTCHA on the form. Left for you: Cover letter.");
    const detail = app.application(first.jobId).body;
    expect(detail.draft).toMatchObject({ status: "needs_attention", note: "CAPTCHA on the form. Left for you: Cover letter." });
    expect(detail.actions).toEqual(["submitted", "retry", "decline"]);

    // Retry hands it back to the operator and clears the note that explained the hand-off.
    const retried = app.draftAction(first.jobId, { action: "retry" }).body;
    expect(retried).toMatchObject({ job: { stage: "approved" }, draft: { status: "approved", note: "" }, actions: ["decline"] });
    expect(app.repo.listDispatches(first.jobId)).toEqual([]);

    const second = drafted(listing(2), DraftStatus.NEEDS_ATTENTION, "Login required.");
    const submitted = app.draftAction(second.jobId, { action: "submitted" }).body;
    expect(submitted).toMatchObject({ job: { stage: "submitted" }, actions: ["outcome"] });
    expect(submitted.dispatches).toHaveLength(1);

    const third = drafted(listing(3), DraftStatus.NEEDS_ATTENTION, "Unknown form.");
    expect(app.draftAction(third.jobId, { action: "decline" }).body.job.stage).toBe("declined");
  });

  test("a draft action needs a draft, a known job and a known action", () => {
    const qualified = app.addApplication(listing(1)).body.jobId;
    const { jobId } = drafted(listing(2), DraftStatus.AWAITING_REVIEW);
    for (const action of ["approve", "decline", "submitted", "retry"]) {
      expect(refused(() => app.draftAction(qualified, { action })).status).toBe(409); // nothing drafted yet
      expect(refused(() => app.draftAction("deadbeef", { action })).status).toBe(404);
    }
    for (const body of [{}, { action: "send" }, { action: 1 }, { action: null }, { action: ["approve"] }]) {
      expect(refused(() => app.draftAction(jobId, body)).status).toBe(400);
    }
    expect(refused(() => app.draftAction("../../x", { action: "approve" })).status).toBe(404);
    expect([stageOf(qualified), stageOf(jobId)]).toEqual(["qualified", "awaiting_review"]);

    // A draft whose job has moved on without it is left alone.
    app.repo.setJobStage(jobId, PipelineStage.QUARANTINED);
    expect(app.application(jobId).body.actions).toEqual([]);
    expect(refused(() => app.draftAction(jobId, { action: "approve" })).status).toBe(409);
  });

  test("what came of a submitted application is recorded", () => {
    const { jobId } = drafted(FOUNDER, DraftStatus.APPROVED);
    expect(refused(() => app.recordOutcome(jobId, { kind: "response" })).status).toBe(409); // not sent yet
    app.draftAction(jobId, { action: "submitted" });

    const replied = app.recordOutcome(jobId, { kind: "response", note: "  Asked for a call next week.  " });
    expect(replied.status).toBe(201);
    expect(replied.body.outcomes).toEqual([{
      kind: "response", note: "Asked for a call next week.", monthlyValueUsd: null,
      // Credited to the channel it actually went out on.
      channel: "founder_direct", recordedAt: toIso(NOW),
    }]);
    app.recordOutcome(jobId, { kind: "interview" });
    app.recordOutcome(jobId, { kind: "offer", monthlyValueUsd: null });
    const accepted = app.recordOutcome(jobId, { kind: "accepted", monthlyValueUsd: 6000 }).body;
    expect(sorted(accepted.outcomes.map((outcome) => outcome.kind))).toEqual(["accepted", "interview", "offer", "response"]);
    expect(accepted.outcomes.find((outcome) => outcome.kind === "accepted")?.monthlyValueUsd).toBe(6000);
    expect(accepted.actions).toEqual(["outcome"]); // more can follow
    expect(app.overview().body.goal.securedMonthlyUsd).toBe(6000);

    const feed = app.activity({ kind: "outcome" }).body.events;
    expect(feed).toHaveLength(4);
    expect(feed[0]).toMatchObject({ jobId, company: "Lumen Robotics", kind: "outcome" });
    expect(feed.map((event) => event.detail)).toContainEqual({
      outcome: "accepted", note: "", monthlyValueUsd: 6000, channel: "founder_direct",
    });
    expect(sorted(app.application(jobId).body.activity.map((event) => event.kind))).toEqual([
      "discovered", "dispatched", "drafted", "evaluated", "outcome",
    ]);
    expect(sorted(app.activity({}).body.events.map((event) => event.kind))).toContain("drafted");
  });

  test("an outcome needs a kind that exists, and a monthly value exactly when it was accepted", () => {
    const { jobId } = drafted(listing(1), DraftStatus.SUBMITTED);
    const bad: JsonObject[] = [
      {}, { kind: "ghosted" }, { kind: 3 },
      { kind: "accepted" }, { kind: "accepted", monthlyValueUsd: 0 }, { kind: "accepted", monthlyValueUsd: -100 },
      { kind: "accepted", monthlyValueUsd: "6000" },
      { kind: "interview", monthlyValueUsd: 6000 }, // a value only means something once accepted
      { kind: "response", note: "x".repeat(1001) }, { kind: "response", note: 7 },
    ];
    for (const body of bad) expect(refused(() => app.recordOutcome(jobId, body)).status, JSON.stringify(body)).toBe(400);
    expect(refused(() => app.recordOutcome("deadbeef", { kind: "response" })).status).toBe(404);
    expect(refused(() => app.recordOutcome(app.addApplication(listing(2)).body.jobId, { kind: "response" })).status).toBe(409);
    expect(app.repo.listOutcomes()).toEqual([]);
  });
});

// ---------- Confirmation screenshots ----------

describe("the confirmation screenshot", () => {
  const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from("not really an image")]);
  const shot = (name: string): string => path.join(evidenceDir, name);
  const fetchShot = (id: string, headers: Record<string, string> = {}) =>
    serveFile(request("GET", `/api/applications/${id}/evidence`, { headers }), PORT, "image/png", () => app.evidenceFile(id));

  test("is served for a job that has one, as an image and nothing else", async () => {
    const { jobId } = drafted(listing(1), DraftStatus.SUBMITTED);
    expect(app.application(jobId).body.hasEvidence).toBe(false);
    expect(refused(() => app.evidenceFile(jobId)).status).toBe(404); // not even the folder exists yet

    fs.mkdirSync(evidenceDir);
    fs.writeFileSync(shot(`${jobId}.png`), PNG);
    expect(app.application(jobId).body.hasEvidence).toBe(true);
    expect(app.evidenceFile(jobId)).toBe(path.join(fs.realpathSync(evidenceDir), `${jobId}.png`));

    const response = await fetchShot(jobId);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/png");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(Buffer.from(await response.arrayBuffer()).equals(PNG)).toBe(true);

    // The same guard as every other endpoint.
    expect((await fetchShot(jobId, { host: `evil.example:${PORT}` })).status).toBe(403);
  });

  test("only ever reads <evidence dir>/<job id>.png", async () => {
    const { jobId } = drafted(listing(1), DraftStatus.SUBMITTED);
    fs.mkdirSync(evidenceDir);
    fs.writeFileSync(shot(`${jobId}.png`), PNG);
    fs.writeFileSync(shot("deadbeef.png"), PNG); // a screenshot with no job behind it
    fs.writeFileSync(path.join(tmp, "outside.png"), PNG);
    fs.writeFileSync(path.join(tmp, "secrets.json"), JSON.stringify({ FIREWORKS_API_KEY: "fw-secret" }));

    const notIds = [
      "", ".", "..", "../outside", "..%2Foutside", `../evidence/${jobId}`, `${jobId}.png`, `${jobId}/`, `${jobId}\u0000`,
      `./${jobId}`, jobId.toUpperCase(), "../secrets.json", "/etc/passwd", "outside", "deadbeef", "g".repeat(16), "a".repeat(65),
    ];
    for (const id of notIds) {
      expect(refused(() => app.evidenceFile(id)).status, JSON.stringify(id)).toBe(404);
      const response = await answer(await fetchShot(encodeURIComponent(id)));
      expect(response.status, JSON.stringify(id)).toBe(404);
      expect(JSON.stringify(response.body)).not.toContain("fw-secret");
    }
    expect(app.evidenceFile(jobId)).toContain(`${jobId}.png`); // the real one is still served
  });

  test("a link or a non-image planted under the right name is not followed", () => {
    const linked = drafted(listing(1), DraftStatus.SUBMITTED).jobId;
    const textual = drafted(listing(2), DraftStatus.SUBMITTED).jobId;
    const folder = drafted(listing(3), DraftStatus.SUBMITTED).jobId;
    fs.mkdirSync(evidenceDir);
    fs.writeFileSync(path.join(tmp, "outside.png"), PNG);
    fs.symlinkSync(path.join(tmp, "outside.png"), shot(`${linked}.png`)); // a valid PNG, but outside the folder
    fs.writeFileSync(shot(`${textual}.png`), "<script>alert(1)</script>");
    fs.mkdirSync(shot(`${folder}.png`));
    for (const jobId of [linked, textual, folder]) {
      expect(refused(() => app.evidenceFile(jobId)).status).toBe(404);
      expect(app.application(jobId).body.hasEvidence).toBe(false);
    }
  });
});

// ---------- Answering a held draft ----------

describe("answering a held draft", () => {
  const SPONSORSHIP = "Will you now or in the future require visa sponsorship?";
  const AUTHORIZED = "Are you legally authorized to work in the United States?";
  const REMEMBER = "answer it once and Reygent will remember it";
  let jobId: string;
  let ids: number[];

  /** A draft the Cop Tool held because of two form questions, plus an unrelated tone problem. */
  function hold(createdAt = ago(HOUR)): number[] {
    const originalContent = JSON.stringify(createDraft({
      jobId, channel: Channel.CONTRACT_GIGS, pitch: "I hope this email finds you well.",
      screeningAnswers: [
        { question: "Email", answer: "candidate@example.com", options: [], factKey: "email" },
        { question: SPONSORSHIP, answer: "", options: ["Yes", "No"], factKey: "" },
        { question: AUTHORIZED, answer: "Yes", options: [], factKey: "" },
      ],
    }));
    return app.repo.quarantine([
      {
        jobId, violationRule: "2_screening_sanity", originalContent, retryCount: 0, createdAt,
        critique:
          `[screeningAnswers[1]] '${SPONSORSHIP}' could not be answered from your data — ${REMEMBER}; ` +
          `[screeningAnswers[2]] answer to '${AUTHORIZED}' ("Yes") is not supported by your data — ${REMEMBER}`,
      },
      { jobId, violationRule: "9_tone", originalContent, retryCount: 0, createdAt, critique: "[pitch] filler or cliché" },
    ]);
  }

  const drafting = (): string[] => chooseJobsToDraft(app.repo, 10, 0).map(({ job }) => job.id);

  beforeEach(() => {
    jobId = app.addApplication(WORLDWIDE).body.jobId;
    app.repo.saveFit({ jobId, fitScore: 80, bestPositioningProfile: "ai_platform_agent", matchedSkills: [], missingSkills: [] });
    ids = hold();
  });

  test("a hold lists the questions it is waiting on", () => {
    const [held] = app.quarantine({}).body.holds;
    expect(held.questions).toEqual([
      { question: SPONSORSHIP, options: ["Yes", "No"], answer: "", reason: "unanswered" },
      // The AI did answer this one; its answer is offered back for the user to confirm or correct.
      { question: AUTHORIZED, options: [], answer: "Yes", reason: "unverified" },
    ]);
    expect(held).toMatchObject({ canRetry: true, status: "pending", ids });
    expect(app.application(jobId).body.quarantine[0].questions).toHaveLength(2);
  });

  test("every way the Cop Tool asks for the user's own answer is recognised", () => {
    app.reviewQuarantine({ ids });
    const originalContent = JSON.stringify(createDraft({
      jobId,
      screeningAnswers: [
        { question: "Do you hold a security clearance?", answer: "No", options: ["Yes", "No"], factKey: "" },
        { question: "Preferred pronouns?", answer: "Maybe", options: ["She", "He", "They"], factKey: "" },
        { question: "Notice period?", answer: "1 month", options: [], factKey: "" },
        { question: "", answer: "", options: [], factKey: "" },
      ],
    }));
    app.repo.quarantine([{
      jobId, violationRule: "2_screening_sanity", originalContent, retryCount: 1,
      critique: [
        "[screeningAnswers[0]] 'Do you hold a security clearance?' needs an answer from you: no decision model is configured to verify one",
        "[screeningAnswers[1]] answer to 'Preferred pronouns?' is not one of the offered options",
        // Fixed by the redraft itself, which uses the remembered answer: nothing to ask the user.
        "[screeningAnswers[2]] answer to 'Notice period?' differs from your remembered answer",
        `[screeningAnswers[3]] '' could not be answered from your data — ${REMEMBER}`,
        `[screeningAnswers[9]] 'A question the draft does not have' could not be answered from your data — ${REMEMBER}`,
      ].join("; "),
    }]);
    expect(app.quarantine({}).body.holds[0].questions).toEqual([
      { question: "Do you hold a security clearance?", options: ["Yes", "No"], answer: "No", reason: "unverified" },
      // "Maybe" is not something this form accepts, so it is not offered back.
      { question: "Preferred pronouns?", options: ["She", "He", "They"], answer: "", reason: "unverified" },
    ]);
  });

  test("saving answers remembers them and sends the job back to be drafted again", () => {
    // What the AI had on file for one of them; the user's answer replaces it.
    app.repo.saveStandingAnswer({ question: AUTHORIZED, answer: "Yes", options: [], source: "ai" });
    expect(stageOf(jobId)).toBe("quarantined");
    expect(drafting()).toEqual([]);

    const result = app.retryQuarantine({
      ids,
      answers: [
        { question: SPONSORSHIP, answer: " no " },
        { question: AUTHORIZED, answer: "No — I work as an independent contractor from Cameroon." },
      ],
    });
    expect(result).toEqual({ status: 200, body: { ok: true, jobId, saved: 2 } });

    // Stored as the user's own, the multiple-choice one spelled as the form spells it.
    expect(app.repo.getStandingAnswer(SPONSORSHIP)).toMatchObject({ answer: "No", options: ["Yes", "No"], source: "user" });
    expect(app.repo.getStandingAnswer(AUTHORIZED)).toMatchObject({
      answer: "No — I work as an independent contractor from Cameroon.", options: [], source: "user",
    });
    expect(sorted(app.answers().body.answers.map((item) => item.question))).toEqual([AUTHORIZED, SPONSORSHIP]);

    // The hold is done with and the job is where the next cycle will pick it up.
    expect(app.quarantine({}).body).toEqual({ holds: [], pending: 0 });
    expect(app.quarantine({ status: "reviewed" }).body.holds[0]).toMatchObject({ status: "reviewed", canRetry: false });
    expect(stageOf(jobId)).toBe("qualified");
    expect(drafting()).toEqual([jobId]);
    expect(app.overview().body.pending.quarantine).toBe(0);
    expect(refused(() => app.retryQuarantine({ ids })).status).toBe(404); // nothing left to retry
  });

  test("a plain retry requeues the job without storing anything, and clears older holds on it", () => {
    const older = hold(ago(5 * HOUR));
    expect(app.quarantine({}).body.pending).toBe(2);
    expect(app.retryQuarantine({ ids })).toEqual({ status: 200, body: { ok: true, jobId, saved: 0 } });
    expect(app.answers().body.answers).toEqual([]);
    expect(stageOf(jobId)).toBe("qualified");
    // The job is being redrafted, so its other held draft is out of date too.
    expect(app.quarantine({}).body.pending).toBe(0);
    expect(app.repo.listQuarantined("reviewed").map((item) => item.id).sort()).toEqual([...ids, ...older].sort());
  });

  test("an answer that cannot be used changes nothing", () => {
    const unchanged = () => {
      expect(app.answers().body.answers).toEqual([]);
      expect(app.quarantine({}).body.pending).toBe(1);
      expect(stageOf(jobId)).toBe("quarantined");
    };
    const bad: Array<[answers: unknown, fragment: string]> = [
      [[{ question: SPONSORSHIP, answer: "Perhaps" }], "must be one of: Yes / No"],
      [[{ question: "What is your favourite colour?", answer: "Blue" }], "not a question on this draft"],
      [[{ question: SPONSORSHIP, answer: "   " }], "'answer' is required"],
      [[{ question: "", answer: "No" }], "'question' is required"],
      [[{ question: SPONSORSHIP, answer: 5 }], "'answer' must be text"],
      [[{ question: AUTHORIZED, answer: "x".repeat(5001) }], "'answer' must be text"],
      [[{ question: SPONSORSHIP }], "'answer' is required"],
      [["No"], "'answers' must be a list"],
      [{ [SPONSORSHIP]: "No" }, "'answers' must be a list"],
      ["No", "'answers' must be a list"],
      // One good answer does not carry a bad one through.
      [[{ question: AUTHORIZED, answer: "No" }, { question: SPONSORSHIP, answer: "Perhaps" }], "must be one of"],
    ];
    for (const [answers, fragment] of bad) {
      const error = refused(() => app.retryQuarantine({ ids, answers }));
      expect(error.status, fragment).toBe(400);
      expect(error.message).toContain(fragment);
      unchanged();
    }
    for (const body of [{}, { ids: [] }, { ids: ["1"] }, { ids: [1.5] }, { answers: [] }]) {
      expect(refused(() => app.retryQuarantine(body)).status).toBe(400);
    }
    unchanged();
  });

  test("only a pending hold on a job that is still held can be retried", () => {
    const elsewhere = app.addApplication(listing(7)).body.jobId;
    const [foreign] = app.repo.quarantine([{
      jobId: elsewhere, violationRule: "9_tone", originalContent: "{}", critique: "[pitch] filler", retryCount: 0,
    }]);
    expect(refused(() => app.retryQuarantine({ ids: [9999] })).status).toBe(404);
    // Ids from two different drafts are not one hold.
    expect(refused(() => app.retryQuarantine({ ids: [ids[0], foreign] })).status).toBe(404);

    // The job moved on some other way (say the user ruled it out): the hold has nothing to requeue.
    app.repo.setJobStage(jobId, PipelineStage.DISQUALIFIED);
    expect(app.quarantine({}).body.holds.find((held) => held.jobId === jobId)?.canRetry).toBe(false);
    expect(refused(() => app.retryQuarantine({ ids })).status).toBe(409);
    expect(stageOf(jobId)).toBe("disqualified");

    app.reviewQuarantine({ ids: [foreign] });
    expect(refused(() => app.retryQuarantine({ ids: [foreign] })).status).toBe(404); // already reviewed
  });
});

// ---------- Standing answers ----------

describe("standing answers", () => {
  const SALARY = "What are your salary expectations?";
  const RELOCATE = "Are you willing to relocate?";

  test("answers are added, listed, corrected and deleted", () => {
    expect(app.answers()).toEqual({ status: 200, body: { answers: [] } });

    const added = app.saveAnswer({ question: `  ${SALARY} `, answer: " USD 55 an hour, invoiced monthly. " });
    expect(added.status).toBe(200);
    expect(added.body.answers).toEqual([
      { question: SALARY, answer: "USD 55 an hour, invoiced monthly.", options: [], source: "user", updatedAt: expect.any(String) },
    ]);

    // Saving the same question again replaces its answer; spacing, case and a trailing colon do not make it a new one.
    app.saveAnswer({ question: "what are your salary expectations?:", answer: "USD 60 an hour." });
    expect(app.answers().body.answers).toMatchObject([{ question: SALARY, answer: "USD 60 an hour." }]);

    app.saveAnswer({ question: "Notice period?", answer: "2 weeks" });
    expect(sorted(app.answers().body.answers.map((item) => item.question))).toEqual(["Notice period?", SALARY]);

    const left = app.deleteAnswer({ question: SALARY }).body.answers;
    expect(left.map((item) => item.question)).toEqual(["Notice period?"]);
    expect(app.repo.getStandingAnswer(SALARY)).toBeNull();
  });

  test("an AI answer the user edits becomes the user's, and stays one of the form's options", () => {
    app.repo.saveStandingAnswer({ question: RELOCATE, answer: "Yes", options: ["Yes", "No"], source: "ai" });
    expect(app.answers().body.answers).toMatchObject([{ question: RELOCATE, answer: "Yes", source: "ai" }]);

    const error = refused(() => app.saveAnswer({ question: RELOCATE, answer: "Only within Africa" }));
    expect(error.status).toBe(400);
    expect(error.message).toContain("must be one of: Yes / No");
    expect(app.repo.getStandingAnswer(RELOCATE)).toMatchObject({ answer: "Yes", source: "ai" });

    app.saveAnswer({ question: RELOCATE.toUpperCase(), answer: "no" });
    expect(app.answers().body.answers).toMatchObject([
      // The form's own wording and choices are kept; only the answer and its owner change.
      { question: RELOCATE, answer: "No", options: ["Yes", "No"], source: "user" },
    ]);
    // And from then on the pipeline cannot overwrite it.
    expect(app.repo.saveStandingAnswer({ question: RELOCATE, answer: "Yes", options: ["Yes", "No"], source: "ai" })).toBe(false);
    expect(app.repo.getStandingAnswer(RELOCATE)?.answer).toBe("No");
  });

  test("bad answer requests are rejected", () => {
    app.saveAnswer({ question: SALARY, answer: "USD 55 an hour." });
    const bad: JsonObject[] = [
      {}, { question: SALARY }, { answer: "x" }, { question: "  ", answer: "x" }, { question: SALARY, answer: "" },
      { question: 5, answer: "x" }, { question: SALARY, answer: ["x"] },
      { question: "q".repeat(1001), answer: "x" }, { question: SALARY, answer: "x".repeat(5001) },
    ];
    for (const body of bad) expect(refused(() => app.saveAnswer(body)).status, JSON.stringify(body).slice(0, 60)).toBe(400);
    for (const body of [{}, { question: "" }, { question: 5 }]) {
      expect(refused(() => app.deleteAnswer(body)).status).toBe(400);
    }
    expect(refused(() => app.deleteAnswer({ question: "Never asked?" })).status).toBe(404);
    expect(app.answers().body.answers).toMatchObject([{ question: SALARY, answer: "USD 55 an hour." }]);
  });

  test("over HTTP the question travels in the body, and a cross-site page can change nothing", async () => {
    const put = (body: JsonObject, headers: Record<string, string> = {}) =>
      serve(request("PUT", "/api/answers", { body, headers }), PORT, (input) => app.saveAnswer(input.body));
    const remove = (body: JsonObject, headers: Record<string, string> = {}) =>
      serve(request("DELETE", "/api/answers", { body, headers }), PORT, (input) => app.deleteAnswer(input.body));

    expect((await put({ question: SALARY, answer: "USD 55 an hour." }, { origin: "https://evil.example" })).status).toBe(403);
    expect(app.answers().body.answers).toEqual([]);
    expect((await put({ question: SALARY, answer: "USD 55 an hour." })).status).toBe(200);

    expect((await remove({ question: SALARY }, { "sec-fetch-site": "cross-site" })).status).toBe(403);
    expect(app.answers().body.answers).toHaveLength(1);
    expect(await answer(await remove({ question: SALARY }))).toEqual({ status: 200, body: { answers: [] } });
    expect((await remove({ question: SALARY })).status).toBe(404);
  });
});

// ---------- Request guard ----------

describe("request guard", () => {
  const SAME_ORIGIN: RequestFacts = {
    method: "POST", host: `127.0.0.1:${PORT}`, origin: `http://127.0.0.1:${PORT}`, secFetchSite: "same-origin",
    contentType: "application/json",
  };
  const BARE_GET: RequestFacts = { method: "GET", host: `127.0.0.1:${PORT}`, origin: null, secFetchSite: null, contentType: null };

  test("same-origin requests to the console's own address pass", () => {
    const allowed: RequestFacts[] = [
      BARE_GET,
      { ...BARE_GET, host: `localhost:${PORT}` },
      // A GET changes nothing, so only its Host matters.
      { ...BARE_GET, origin: "https://evil.example", secFetchSite: "cross-site" },
      SAME_ORIGIN,
      { ...SAME_ORIGIN, host: `localhost:${PORT}`, origin: `http://localhost:${PORT}` },
      { ...SAME_ORIGIN, method: "PUT", contentType: "application/json; charset=utf-8" },
      { ...SAME_ORIGIN, method: "DELETE", secFetchSite: "none" },
      // Not a browser at all (curl, a script): no Origin and no Sec-Fetch-Site.
      { ...SAME_ORIGIN, origin: null, secFetchSite: null },
    ];
    for (const facts of allowed) expect(checkRequest(facts, PORT), JSON.stringify(facts)).toBeNull();
  });

  test("requests for another host are refused", () => {
    // A DNS-rebinding page reaches 127.0.0.1 but still sends its own Host header.
    const hosts = [
      `evil.example:${PORT}`, "127.0.0.1", `127.0.0.1:${PORT + 1}`, "localhost", `LOCALHOST:${PORT}`, `[::1]:${PORT}`,
      `127.0.0.1:${PORT}.evil.example`, "", null,
    ];
    for (const host of hosts) {
      expect(checkRequest({ ...BARE_GET, host }, PORT), String(host)).toContain("own localhost address");
      expect(checkRequest({ ...SAME_ORIGIN, host }, PORT), String(host)).toContain("own localhost address");
    }
  });

  test("cross-site writes are refused", () => {
    const refusals: Array<[Partial<RequestFacts>, string]> = [
      [{ origin: "https://evil.example" }, "Cross-origin"],
      [{ origin: `https://127.0.0.1:${PORT}` }, "Cross-origin"],
      [{ origin: `http://127.0.0.1:${PORT + 1}` }, "Cross-origin"],
      [{ origin: "null" }, "Cross-origin"], // a sandboxed frame or a file:// page
      [{ origin: null, secFetchSite: "cross-site" }, "Cross-site"],
      [{ secFetchSite: "same-site" }, "Cross-site"],
      [{ contentType: "text/plain" }, "must be JSON"],
      [{ contentType: "application/x-www-form-urlencoded" }, "must be JSON"],
      [{ contentType: "multipart/form-data; boundary=x" }, "must be JSON"],
      [{ contentType: null }, "must be JSON"],
    ];
    for (const method of ["POST", "PUT", "DELETE", "PATCH", "post"]) {
      for (const [change, fragment] of refusals) {
        expect(checkRequest({ ...SAME_ORIGIN, method, ...change }, PORT), JSON.stringify(change)).toContain(fragment);
      }
    }
  });

  test("a refused request never reaches the console", async () => {
    const stolen = await answer(
      await serve(request("GET", "/api/state", { headers: { host: `evil.example:${PORT}` } }), PORT, () => app.state()),
    );
    expect(stolen.status).toBe(403);
    expect(stolen.body).toEqual({ error: "This console only answers on its own localhost address." });
    const local = request("GET", "/api/state", { headers: { host: `localhost:${PORT}` } });
    expect((await serve(local, PORT, () => app.state())).status).toBe(200);

    const crossSite: Array<Record<string, string>> = [
      { origin: "https://evil.example" },
      { "sec-fetch-site": "cross-site" },
      { "content-type": "text/plain" },
      { "content-type": "application/x-www-form-urlencoded" },
    ];
    for (const headers of crossSite) {
      expect((await addListing(request("POST", "/api/applications", { body: WORLDWIDE, headers }))).status).toBe(403);
      expect((await storeKey(request("PUT", "/api/keys/jev", { body: { key: "x" }, headers }))).status).toBe(403);
    }
    expect(app.applications({}).body.applications).toEqual([]);
    expect(resolveApiKey("TYPESAFE_API_KEY")).toBeNull();

    const sameOrigin = { origin: `http://127.0.0.1:${PORT}`, "sec-fetch-site": "same-origin" };
    const added = await answer(await addListing(request("POST", "/api/applications", { body: WORLDWIDE, headers: sameOrigin })));
    expect(added.status).toBe(201);
    expect(added.body.duplicate).toBe(false);
  });

  test("the guard is bound to the port the server is listening on", () => {
    expect(serverPort()).toBe(DEFAULT_PORT);
    process.env.PORT = String(PORT);
    expect(serverPort()).toBe(PORT);
    for (const invalid of ["", "not-a-port", "-1", "80.5"]) {
      process.env.PORT = invalid;
      expect(serverPort()).toBe(DEFAULT_PORT);
    }
  });

  test("the proxy applies the guard to every API path before it is routed", async () => {
    process.env.PORT = String(PORT);
    expect(proxyConfig.matcher).toBe("/api/:path*");
    const pass = (incoming: Request) => proxy(incoming as NextRequest);

    expect(pass(request("GET", "/api/state"))).toBeUndefined();
    expect(pass(request("POST", "/api/applications", { body: WORLDWIDE }))).toBeUndefined();

    const rebound = pass(request("GET", "/api/no-such-route", { headers: { host: `evil.example:${PORT}` } }));
    expect(rebound?.status).toBe(403);
    expect(await rebound?.json()).toEqual({ error: "This console only answers on its own localhost address." });
    const crossSite = pass(request("POST", "/api/applications", { body: WORLDWIDE, headers: { origin: "https://evil.example" } }));
    expect(crossSite?.status).toBe(403);
    // Answering on another port means a different allowed Host.
    process.env.PORT = String(PORT + 1);
    expect(pass(request("GET", "/api/state"))?.status).toBe(403);
  });

  test("malformed and oversized bodies are rejected", async () => {
    const post = (body: string, headers: Record<string, string> = {}) =>
      addListing(request("POST", "/api/applications", { body, headers }));

    expect(await answer(await post("{not json"))).toEqual({ status: 400, body: { error: "Request body is not valid JSON" } });
    for (const notAnObject of ["[1, 2]", '"text"', "42", "null"]) {
      expect(await answer(await post(notAnObject))).toEqual({
        status: 400, body: { error: "Request body must be a JSON object" },
      });
    }
    expect((await post(JSON.stringify(WORLDWIDE), { "content-length": "abc" })).status).toBe(400);

    // Too large by its declared length: refused before the body is read.
    expect((await post("{}", { "content-length": String(MAX_BODY_BYTES + 1) })).status).toBe(413);
    // Too large with no declared length (a chunked upload): refused while reading.
    const oversized = JSON.stringify({ ...WORLDWIDE, description: "x".repeat(1_100_000) });
    expect(await answer(await post(oversized))).toEqual({ status: 413, body: { error: "Request is too large" } });
    expect(app.applications({}).body.applications).toEqual([]);

    // An empty body is an empty object, which the handler then judges.
    const empty = await answer(await addListing(request("POST", "/api/applications")));
    expect(empty).toEqual({ status: 400, body: { error: "'company' is required" } });
    // Exactly at the limit is still read.
    const padding = "x".repeat(MAX_BODY_BYTES - JSON.stringify({ ...WORLDWIDE, pad: "" }).length);
    expect((await post(JSON.stringify({ ...WORLDWIDE, pad: padding }))).status).toBe(201);
  });

  test("query parameters reach the handler, the last value winning", async () => {
    app.addApplication(WORLDWIDE);
    app.addApplication(AMBIGUOUS);
    const list = await serve(
      request("GET", "/api/applications?stage=qualified&stage=investigating&q=fathom"), PORT,
      ({ query }) => app.applications(query),
    );
    const { applications } = (await list.json()) as { applications: Array<{ company: string }> };
    expect(applications.map((row) => row.company)).toEqual(["Fathom Systems"]);
  });

  test("an unexpected failure is a 500 that says nothing about the internals", async () => {
    const logged: unknown[] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => void logged.push(...args);
    try {
      const failed = await answer(
        await serve(request("GET", "/api/state"), PORT, () => {
          throw new Error(`cannot open ${tmp}/reygent.db`);
        }),
      );
      expect(failed.status).toBe(500);
      expect(JSON.stringify(failed.body)).not.toContain(tmp);
      expect(failed.body.error).toContain("Internal error");
      expect(String(logged[0])).toContain("cannot open"); // but the terminal has the detail
    } finally {
      console.error = original;
    }
    const missing = await answer(await serve(request("GET", "/api/nope"), PORT, () => {
      throw new ApiError(404, "Not found");
    }));
    expect(missing).toEqual({ status: 404, body: { error: "Not found" } });
  });
});

// ---------- The process-wide instance ----------

describe("the server's own console", () => {
  test("is opened once, from $REYGENT_CONFIG, $REYGENT_DB and $REYGENT_EVIDENCE_DIR", () => {
    process.env[CONFIG_ENV_VAR] = configPath;
    process.env[DB_ENV_VAR] = path.join(tmp, "server.db");
    process.env[EVIDENCE_ENV_VAR] = evidenceDir;
    const holder = globalThis as unknown as Record<symbol, unknown>;
    const key = Symbol.for("reygent.web.app");
    expect(holder[key]).toBeUndefined();
    const server = getWebApp();
    try {
      expect(getWebApp()).toBe(server);
      expect(server.dbPath).toBe(path.join(tmp, "server.db"));
      expect(server.state().body.configPath).toBe(configPath);

      const { jobId } = server.addApplication(WORLDWIDE).body;
      fs.mkdirSync(evidenceDir);
      fs.writeFileSync(path.join(evidenceDir, `${jobId}.png`), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
      expect(server.application(jobId).body.hasEvidence).toBe(true);
    } finally {
      server.close();
      delete holder[key];
    }
  });
});
