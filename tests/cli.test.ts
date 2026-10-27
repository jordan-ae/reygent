/** The CLI verification commands: init, test-eligibility, cost-summary. */

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { type CommandContext, main } from "@/cli";
import { CONFIG_ENV_VAR, DB_ENV_VAR, loadConfig } from "@/core/config";
import { Repository } from "@/core/db/repository";
import { CircuitBreakerError, CostLedger } from "@/core/llm/ledger";
import { alreadyRunning } from "@/core/orchestrator/commands";
import { notReady } from "@/core/orchestrator/wake";
import { SECRETS_ENV_VAR } from "@/core/secrets";

const EXAMPLE_CONFIG = fileURLToPath(new URL("../config.example.yaml", import.meta.url));

describe("CLI", () => {
  let tmp: string;
  let db: string;
  let envDb: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "reygent-cli-"));
    db = path.join(tmp, "reygent.db");
    // A safety net: whatever a test does, it can never reach the real ~/.reygent or ./config.yaml.
    envDb = path.join(tmp, "from-env.db");
    vi.stubEnv(DB_ENV_VAR, envDb);
    vi.stubEnv(CONFIG_ENV_VAR, EXAMPLE_CONFIG);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  async function run(argv: string[]): Promise<{ code: number; out: string; err: string }> {
    const out: string[] = [];
    const err: string[] = [];
    const code = await main(argv, { out: (line) => out.push(line), err: (line) => err.push(line) });
    return { code, out: out.join("\n"), err: err.join("\n") };
  }

  const runCli = (args: string[], config = EXAMPLE_CONFIG) => run(["--config", config, "--db", db, ...args]);

  function writeConfig(body: string): string {
    const file = path.join(tmp, "config.yaml");
    fs.writeFileSync(file, body);
    return file;
  }

  test("init stores the profile and reports what is missing", async () => {
    const { code, out } = await runCli(["init"]);
    expect(code).toBe(0);
    expect(out).toContain("Cameroon (UTC+1)");
    expect(out).toContain("Frontend Systems Engineer");
    expect(out).toContain("0 verified of 2");
    expect(out).toContain("Not ready for real submissions");
    const repo = new Repository(db);
    try {
      expect(Object.keys(repo.getProfile()?.positioning ?? {})).toHaveLength(4);
    } finally {
      repo.close();
    }
  });

  test("init prints the same report as the Python CLI did", async () => {
    const { out } = await runCli(["init"]);
    expect(out.split("\n")).toEqual([
      `Fact bank synced to ${db}`,
      "  Candidate:     CHANGE_ME — Cameroon (UTC+1)",
      "  Work status:   Eligible for Global Independent B2B Contractor & 1099 Engagements." +
        " Invoices via direct wire / Deel / Remote / Wise.",
      "  Achievements:  0 verified of 2",
      "  Positioning:",
      "    - AI Platform / Agent Engineer  [LangGraph, MCP, Evals, Tool Calling]  (0 verified achievements)",
      "    - Senior Full-Stack Product Engineer  [TypeScript, Next.js, Python, PostgreSQL]  (0 verified achievements)",
      "    - Applied AI / LLM Engineer  [RAG, pgvector, Qdrant, Semantic Search]  (0 verified achievements)",
      "    - Frontend Systems Engineer  [React, Web Performance, Design Systems]  (0 verified achievements)",
      "",
      "Not ready for real submissions yet — edit config.yaml and re-run init:",
      "  ! Profile is missing your name, email, phone, GitHub link, LinkedIn link, portfolio link, notice period",
      '  ! 2 achievements not verified yet, so unusable: "EXAMPLE: what you built, in one line",' +
        ' "EXAMPLE: what you shipped, in one line"',
      "  ! No verified achievement yet, so no CV bullet can be written",
    ]);
  });

  test("init on a complete profile says so", async () => {
    const config = writeConfig(
      [
        "candidate:",
        "  name: Test Candidate",
        "  email: candidate@example.com",
        "  phone: '+237 600 000 000'",
        "  github_url: https://github.com/test-candidate",
        "  linkedin_url: https://www.linkedin.com/in/test-candidate",
        "  portfolio_url: https://candidate.example.com",
        "  notice_period: 2 weeks",
        "fact_bank:",
        "  achievements:",
        "    - id: ach_agents",
        "      positioning: [ai_platform_agent, fullstack_product, applied_ai_llm, frontend_systems]",
        "      headline: Built a LangGraph agent runtime",
        "      impact_metric: Cut workflow latency by 45%",
        "      verified: true",
        "",
      ].join("\n"),
    );
    const { code, out } = await runCli(["init"], config);
    expect(code).toBe(0);
    expect(out).toContain("1 verified of 1");
    expect(out).toContain("(1 verified achievements)");
    expect(out.endsWith("\n\nProfile is complete.")).toBe(true);
  });

  test("eligibility samples cover all three tiers", async () => {
    const { code, out } = await runCli(["test-eligibility"]);
    expect(code).toBe(0);
    for (const tier of ["CONFIRMED_ELIGIBLE", "POTENTIALLY_ELIGIBLE", "INELIGIBLE"]) {
      expect(out).toContain(tier);
    }
    expect(out).not.toContain("MISMATCH");
    expect(out).toContain("[ok] POTENTIALLY_ELIGIBLE  Brightline — Frontend Systems Engineer (Remote - US)");
    expect(out).toContain("       Ineligible: RATE_BELOW_FLOOR ($22/hour is below the $40/hr floor)");
    expect(out.endsWith("\n\n8/8 sample listings classified as expected.")).toBe(true);
    // The scorer is pure, so checking it must not create a database.
    expect(fs.existsSync(db)).toBe(false);
  });

  test("cost summary on an empty ledger", async () => {
    const { code, out } = await runCli(["cost-summary"]);
    expect(code).toBe(0);
    expect(out).toContain("$0.00000 of $1.50 cap");
    expect(out).toContain("No paid calls recorded yet");
    expect(out.split("\n")).toEqual([
      "Today (UTC+1): $0.00000 of $1.50 cap",
      "Remaining: $1.50000    Circuit breaker: closed (running)",
      "",
      "No paid calls recorded yet.",
    ]);
  });

  test("cost summary reports spend per model", async () => {
    const repo = new Repository(db);
    repo.recordTelemetry({
      provider: "fireworks", model: "accounts/fireworks/models/llama-v3p3-70b-instruct",
      taskType: "pitch", promptTokens: 1000, completionTokens: 200, costUsd: 0.00108, latencyMs: 840,
    });
    repo.close();
    const { code, out } = await runCli(["cost-summary"]);
    expect(code).toBe(0);
    expect(out).toContain("$0.00108 of $1.50 cap");
    expect(out).toContain("llama-v3p3-70b-instruct");
    expect(out).toContain("closed (running)");
  });

  test("cost summary lays out one row per model, costliest first", async () => {
    const repo = new Repository(db);
    repo.recordTelemetry({
      provider: "fireworks", model: "accounts/fireworks/models/llama-v3p3-70b-instruct",
      taskType: "pitch", promptTokens: 1000, completionTokens: 200, costUsd: 0.00108, latencyMs: 840,
    });
    repo.recordTelemetry({
      provider: "jev", model: "jev-latest", taskType: "fit", promptTokens: 52000, completionTokens: 310,
      costUsd: 0.002184, latencyMs: 95,
    });
    repo.recordTelemetry({
      provider: "jev", model: "jev-latest", taskType: "fit", promptTokens: 100, completionTokens: 10,
      costUsd: 0.0000042, latencyMs: 100,
    });
    repo.close();
    const { out } = await runCli(["cost-summary"]);
    expect(out.split("\n")).toEqual([
      "Today (UTC+1): $0.00327 of $1.50 cap",
      "Remaining: $1.49673    Circuit breaker: closed (running)",
      "",
      "provider   model                                                 calls    prompt   compl.  avg ms   cost USD",
      "jev        jev-latest                                                2     52100      320      97    0.00219",
      "fireworks  accounts/fireworks/models/llama-v3p3-70b-instruct         1      1000      200     840    0.00108",
      "",
      "All-time spend: $0.00327",
    ]);
  });

  test("cost summary shows a tripped circuit breaker", async () => {
    const config = writeConfig("budget:\n  daily_cap_usd: 0.5\n  day_utc_offset_hours: -5\n");
    const repo = new Repository(db);
    const ledger = new CostLedger(repo, { budget: loadConfig(config).budget, notifier: () => {} });
    expect(() => ledger.reserve("fireworks", "m", "pitch", 0.75)).toThrow(CircuitBreakerError);
    repo.close();
    const { code, out } = await runCli(["cost-summary"], config);
    expect(code).toBe(0);
    expect(out).toContain("Today (UTC-5): $0.00000 of $0.50 cap");
    expect(out).toContain("Circuit breaker: TRIPPED — paid calls paused until the next budget day");
  });

  test("invalid config is a clean error", async () => {
    const bad = writeConfig("budget:\n  daily_cap: 9\n");
    const { code, out, err } = await runCli(["cost-summary"], bad);
    expect(code).toBe(2);
    expect(err).toContain("budget.daily_cap");
    expect(err).toBe("Config error: Unknown config key 'budget.daily_cap'");
    expect(out).toBe("");
    expect(fs.existsSync(db)).toBe(false);
  });

  test("a missing config file is a clean error", async () => {
    const missing = path.join(tmp, "nowhere.yaml");
    const { code, err } = await runCli(["init"], missing);
    expect(code).toBe(2);
    expect(err).toBe(`Config error: Config file not found: ${missing}`);
  });

  test("an invalid fact bank is a config error and stores nothing", async () => {
    const config = writeConfig(
      "fact_bank:\n  achievements:\n" +
        "    - {id: twin, headline: a, impact_metric: b}\n" +
        "    - {id: twin, headline: c, impact_metric: d}\n",
    );
    const { code, err } = await runCli(["init"], config);
    expect(code).toBe(2);
    expect(err).toBe("Config error: fact_bank.achievements contains duplicate ids");
    const repo = new Repository(db);
    try {
      expect(repo.getProfile()).toBeNull();
    } finally {
      repo.close();
    }
  });

  test("the database is --db, else $REYGENT_DB, else the config's db_path", async () => {
    const flagged = await run(["cost-summary", "--db", db]);
    expect(flagged.code).toBe(0);
    expect(fs.existsSync(db)).toBe(true);
    expect(fs.existsSync(envDb)).toBe(false);

    expect((await run(["init"])).out).toContain(`Fact bank synced to ${envDb}`);
    expect(fs.existsSync(envDb)).toBe(true);

    vi.stubEnv(DB_ENV_VAR, "");
    const configured = path.join(tmp, "from-config.db");
    const config = writeConfig(`db_path: ${JSON.stringify(configured)}\n`);
    expect((await run(["init", "--config", config])).out).toContain(`Fact bank synced to ${configured}`);
    expect(fs.existsSync(configured)).toBe(true);
  });

  test("global flags may follow the command", async () => {
    const { code, out } = await run(["cost-summary", "--db", db, `--config=${EXAMPLE_CONFIG}`]);
    expect(code).toBe(0);
    expect(out).toContain("No paid calls recorded yet");
  });

  test("check names what stands between the user and a run, without calling anything when no key is set", async () => {
    // No stored key and none in the environment: the pre-flight must not reach a model API.
    vi.stubEnv(SECRETS_ENV_VAR, path.join(tmp, "secrets.json"));
    vi.stubEnv("TYPESAFE_API_KEY", "");
    vi.stubEnv("FIREWORKS_API_KEY", "");
    const realFetch = globalThis.fetch;
    globalThis.fetch = () => {
      throw new Error("the network must not be touched");
    };
    try {
      const empty = await runCli(["check"]);
      expect(empty.code).toBe(1);
      expect(empty.out).toContain("Mode: HANDS-FREE");
      expect(empty.out).toContain("[FAIL] Your profile has no name or email yet");
      expect(empty.out).toContain("[FAIL] The fact bank has no verified achievement");
      expect(empty.out).toContain("[FAIL] TypeSafe (Jev) key — not set; without it nothing past discovery runs unless you review every draft first");
      expect(empty.out).toContain("[note] No CV of your own set");
      expect(empty.out).toContain("[note] Fireworks key — not set");
      expect(empty.out).toMatch(/Not ready: \d problems above\.$/);

      // Review-first, a missing key is a note: a person approves every draft, so the free fallbacks may run.
      const config = writeConfig(
        [
          "candidate: {name: Test Candidate, email: candidate@example.com, screening_notes: Cameroonian citizen.}",
          "fact_bank:",
          "  achievements:",
          "    - {id: ach_agents, positioning: [ai_platform_agent], headline: Built a LangGraph agent runtime, impact_metric: Cut latency by 45%, verified: true}",
          "pipeline: {require_human_review: true}",
          "",
        ].join("\n"),
      );
      const reviewed = await runCli(["check"], config);
      expect(reviewed.out).toContain("Mode: REVIEW FIRST");
      expect(reviewed.out).toContain("[ ok ] 1 verified achievement(s) to write from");
      expect(reviewed.out).toContain("[note] TypeSafe (Jev) key — not set");
      expect(reviewed.out).not.toContain("No screening notes");
      expect(reviewed.out).not.toContain("[FAIL] TypeSafe");
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  test("wake judges readiness for free: profile, verified facts, and the key hands-free mode depends on", () => {
    vi.stubEnv(SECRETS_ENV_VAR, path.join(tmp, "secrets.json"));
    vi.stubEnv("TYPESAFE_API_KEY", "");
    const repo = new Repository(db);
    try {
      const empty = notReady(loadConfig(EXAMPLE_CONFIG), repo).filter((problem) => !problem.includes("Google Chrome"));
      expect(empty).toEqual([
        "Your profile has no name or email yet",
        "The fact bank has no verified achievement, so there is nothing truthful to write",
        expect.stringContaining("TypeSafe (Jev) API key is not set"),
      ]);

      const config = loadConfig(EXAMPLE_CONFIG);
      Object.assign(config.candidate, { name: "Test Candidate", email: "candidate@example.com" });
      config.fact_bank.achievements[0].verified = true;
      const problems = () => notReady(config, repo).filter((problem) => !problem.includes("Google Chrome"));
      expect(problems()).toEqual([expect.stringContaining("TypeSafe (Jev) API key is not set")]);
      // With the key in place — or a person reviewing every draft — nothing stands in the way.
      vi.stubEnv("TYPESAFE_API_KEY", "test-key");
      expect(problems()).toEqual([]);
      vi.stubEnv("TYPESAFE_API_KEY", "");
      config.pipeline.require_human_review = true;
      expect(problems()).toEqual([]);
    } finally {
      repo.close();
    }
  });

  test("--help lists every command", async () => {
    const { code, out, err } = await run(["--help"]);
    expect(code).toBe(0);
    expect(err).toBe("");
    for (const command of ["wake", "init", "check", "run", "cycle", "discover", "assist", "status", "tune", "test-eligibility", "cost-summary"]) {
      expect(out).toMatch(new RegExp(`^  ${command} +\\S`, "m"));
    }
    expect(out).toContain("npm run web");
  });

  test("a command line that cannot be understood exits 2 without running anything", async () => {
    const cases: Array<[argv: string[], message: string]> = [
      [[], "a command is required"],
      [["web"], "unknown command 'web' (choose from wake, init, check, run, cycle, discover, assist, status, tune, test-eligibility, cost-summary)"],
      [["tune"], "tune: missing <listing>"],
      [["init", "--force"], "Unknown option '--force'"],
      [["init", "extra"], "init: unexpected argument 'extra'"],
      [["cost-summary", "--config"], "Option '--config <value>' argument missing"],
    ];
    for (const [argv, message] of cases) {
      const { code, out, err } = await run(["--db", db, ...argv]);
      expect(code, argv.join(" ")).toBe(2);
      expect(err, argv.join(" ")).toContain(`reygent: error: ${message}`);
      expect(out).toBe("");
    }
    expect(fs.existsSync(db)).toBe(false);
  });

  // ---------- tune ----------

  const TUNABLE = [
    "candidate:",
    '  name: "Test Candidate"',
    '  email: "candidate@example.com"',
    '  github_url: "https://github.com/test-candidate"',
    "  skills: [Go, PostgreSQL, React]",
    '  summary: "Backend engineer who builds payment systems."',
    "  experience:",
    '    - { employer: "Initech", title: "Senior Backend Engineer", location: "Remote", start: "Jan 2023", end: "Present" }',
    "fact_bank:",
    "  achievements:",
    "    - id: ach_ledger",
    '      headline: "Built an event-driven ledger service in Go on PostgreSQL"',
    '      impact_metric: "Processed 15,000+ transactions a day"',
    "      technologies: [Go, PostgreSQL]",
    '      employer: "Initech"',
    "      verified: true",
  ].join("\n");

  test("tune needs a work history and a listing it can find", async () => {
    const listing = path.join(tmp, "listing.txt");
    fs.writeFileSync(listing, "Senior Backend Engineer\nGolang and Postgres.");
    // The example config lists no roles: there is nothing to build a CV from.
    const bare = await runCli(["tune", listing]);
    expect(bare).toMatchObject({ code: 1, out: "" });
    expect(bare.err).toContain("No work history to build a CV from");
    expect(bare.err).toContain("candidate.experience");

    const unknown = await runCli(["tune", "no-such-listing"], writeConfig(TUNABLE));
    expect(unknown).toMatchObject({ code: 2, out: "" });
    expect(unknown.err).toBe("'no-such-listing' is neither a file holding a job description nor the id of a tracked listing.");
  });

  test("tune writes the CV for a pasted listing and reports what is and is not on it", async ({ skip }) => {
    if (!fs.existsSync("/Applications/Google Chrome.app") && process.platform === "darwin") skip();
    vi.stubEnv(SECRETS_ENV_VAR, path.join(tmp, "no-secrets.json"));
    const listing = path.join(tmp, "listing.txt");
    fs.writeFileSync(listing, "Senior Backend Engineer (Golang)\n\nYou will build event-driven services in Golang on Postgres and Kafka.");
    const out = path.join(tmp, "cv");
    let result: Awaited<ReturnType<typeof run>>;
    try {
      result = await runCli(["tune", listing, "--company", "Acme Pay", "--no-model", "--out", out], writeConfig(TUNABLE));
    } catch (error) {
      // No browser to print with on this machine: nothing to check here.
      if (/chrome|browser|executable/i.test(String(error))) skip();
      throw error;
    }
    const file = path.join(out, "Test-Candidate-Resume.pdf");
    expect(result.err).toBe("");
    expect(result.code).toBe(0);
    const lines = result.out.split("\n");
    expect(lines.slice(0, 3)).toEqual([
      "Senior Backend Engineer (Golang) at Acme Pay", `  CV:        ${file} (1 page)`, "  Headline:  Senior Backend Engineer",
    ]);
    // Without the model only the candidate's own skills are looked for, so Kafka is not even asked about.
    expect(result.out).toContain("The listing asks for 2 terms. Your CV backs 2, each now on the page as the listing spells it:");
    expect(result.out).toContain("    Golang, Postgres");
    // And nothing is reworded: the summary is the candidate's own.
    expect(result.out).toContain("  Summary: your own, as written.");
    expect(result.out).toContain("Nothing a model wrote is on this CV (--no-model)");
    expect(result.out).toContain("The listing was not read by the writing model either");
    expect(lines.filter((line) => line.includes("[ ok ]"))).toHaveLength(7);
    expect(result.out).not.toContain("FAIL");
    expect(fs.statSync(file).size).toBeGreaterThan(10_000);
  }, 60_000);
});

describe("one pipeline loop per database", () => {
  test("a second loop refuses to start while the first one runs, and starts once it has gone", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "reygent-lock-"));
    const context = { dbPath: path.join(dir, "reygent.db") } as CommandContext;
    const lock = path.join(dir, "pipeline.pid");
    // Stands in for a loop started from the CLI: what `ps` shows for it names cli.ts.
    const loop = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)", "cli.ts"], { stdio: "ignore" });
    try {
      expect(alreadyRunning(context)).toBeNull();
      fs.writeFileSync(lock, JSON.stringify({ pid: loop.pid, startedAt: "2026-10-14T13:09:30.000Z" }));
      expect(alreadyRunning(context)).toContain(`process ${loop.pid}`);
      // This process's own lock, and a pid that is not a Reygent loop, stop nothing.
      fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, startedAt: "2026-10-14T13:09:30.000Z" }));
      expect(alreadyRunning(context)).toBeNull();
    } finally {
      loop.kill();
      await new Promise((resolve) => loop.once("exit", resolve));
    }
    fs.writeFileSync(lock, JSON.stringify({ pid: loop.pid, startedAt: "2026-10-14T13:09:30.000Z" }));
    expect(alreadyRunning(context)).toBeNull();
    expect(alreadyRunning({ dbPath: ":memory:" } as CommandContext)).toBeNull();
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
