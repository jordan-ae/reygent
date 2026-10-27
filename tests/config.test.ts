/**
 * Configuration: defaults, loading, validation and saving.
 *
 * Ports ConfigTests from tests/test_profile.py and the settings cases of
 * tests/test_web.py::SetupTests, and covers what config.ts adds to the Python original
 * (the `discovery` and `pipeline` sections, `compensation.quoted_hourly_rate_usd`).
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import {
  CONFIG_ENV_VAR,
  type Config,
  ConfigError,
  DB_ENV_VAR,
  configFromObject,
  defaultConfig,
  expandHome,
  loadConfig,
  resolveConfigPath,
  resolveDbPath,
  saveConfig,
  validateConfig,
} from "@/core/config";
import { PLACEHOLDER } from "@/core/models";

const EXAMPLE_CONFIG = fileURLToPath(new URL("../config.example.yaml", import.meta.url));
const DEEPSEEK = "accounts/fireworks/models/deepseek-v4p1-flash";
const GLM = "accounts/fireworks/models/glm-5p3-flash";
const GPT_OSS = "accounts/fireworks/models/gpt-oss-120b";
const MANAGED_ENV = [CONFIG_ENV_VAR, DB_ENV_VAR];

let dir: string;
let savedEnv: Record<string, string | undefined>;

const mode = (target: string): number => fs.statSync(target).mode & 0o777;

/** Write `body` as a config file in the test's own directory and return its path. */
function write(body: string, name = "config.yaml"): string {
  const file = path.join(dir, name);
  fs.writeFileSync(file, body);
  return file;
}

/** The message of the ConfigError that `action` throws. */
function configError(action: () => unknown): string {
  try {
    action();
  } catch (error) {
    expect(error).toBeInstanceOf(ConfigError);
    return (error as Error).message;
  }
  throw new Error("expected a ConfigError, but nothing was thrown");
}

/** A config as the setup form would submit it once every CHANGE_ME is filled in. */
function filledConfig(): Config {
  const config = defaultConfig();
  Object.assign(config.candidate, {
    name: "Test Candidate", email: "candidate@example.com", phone: "+237 600 000 000",
    github_url: "https://github.com/test-candidate",
    linkedin_url: "https://www.linkedin.com/in/test-candidate",
    portfolio_url: "https://candidate.example.com", notice_period: "2 weeks",
    years_experience: 8, employers: ["Initech"], skills: ["Python", "TypeScript"],
  });
  config.fact_bank.achievements = [{
    id: "ach_agents", category: "ai_systems", positioning: ["ai_platform_agent"],
    headline: "Built a LangGraph agent runtime", impact_metric: "Cut workflow latency by 45%",
    technologies: ["Python", "LangGraph"], employer: "Initech", evidence_url: "", context: "",
    verified: true,
  }];
  return config;
}

beforeEach(() => {
  savedEnv = Object.fromEntries(MANAGED_ENV.map((name) => [name, process.env[name]]));
  for (const name of MANAGED_ENV) delete process.env[name];
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "reygent-config-"));
});

afterEach(() => {
  vi.restoreAllMocks();
  for (const name of MANAGED_ENV) {
    if (savedEnv[name] === undefined) delete process.env[name];
    else process.env[name] = savedEnv[name];
  }
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("defaults", () => {
  test("defaults encode the spec", () => {
    const config = defaultConfig();
    expect(config.budget.daily_cap_usd).toBe(1.5);
    expect(config.compensation.hourly_floor_usd).toBe(40);
    expect(config.compensation.monthly_floor_usd).toBe(2500);
    expect(config.compensation.monthly_income_goal_usd).toBe(10000);
    expect(config.fireworks.max_tokens).toBe(450);
    expect(config.cop.max_autofix_retries).toBe(2);
    expect(config.cop.dedup_window_days).toBe(30);
    expect(config.candidate.location).toBe("Cameroon (UTC+1)");
  });

  test("every remaining default matches the Python Config()", () => {
    const config = defaultConfig();
    // Added since the Python original: the candidate's own summary, their own CV and the work history a
    // tuned CV is built from, all empty until supplied.
    expect(config.candidate).toMatchObject({ summary: "", resume_path: "", experience: [], projects: [], education: [] });
    const {
      summary: _summary, resume_path: _resumePath, experience: _experience, projects: _projects, education: _education,
      ...candidate
    } = config.candidate;
    expect(candidate).toEqual({
      name: PLACEHOLDER, email: PLACEHOLDER, phone: PLACEHOLDER, github_url: PLACEHOLDER,
      linkedin_url: PLACEHOLDER, portfolio_url: PLACEHOLDER, location: "Cameroon (UTC+1)",
      timezone: "Africa/Douala (WAT, UTC+1)",
      work_authorization:
        "Eligible for Global Independent B2B Contractor & 1099 Engagements. " +
        "Invoices via direct wire / Deel / Remote / Wise.",
      notice_period: PLACEHOLDER, years_experience: null, employers: [], skills: [], screening_notes: "",
    });
    expect(config.fact_bank).toEqual({ achievements: [] });
    expect(config.compensation.max_concurrent_engagements).toBe(3);
    expect(config.budget).toEqual({ daily_cap_usd: 1.5, day_utc_offset_hours: 1 });
    expect(config.jev).toEqual({
      base_url: "https://api.typesafe.ai/v1/systemone", api_key_env: "TYPESAFE_API_KEY", model: "jev-latest",
      input_usd_per_million: 0.042, output_usd_per_million: 0, timeout_seconds: 15,
    });
    expect(config.fireworks).toEqual({
      base_url: "https://api.fireworks.ai/inference/v1/chat/completions", api_key_env: "FIREWORKS_API_KEY",
      // Fireworks' current models reason before answering; "none" keeps the 450 tokens for the text.
      model: DEEPSEEK, max_tokens: 450, reasoning_effort: "none", timeout_seconds: 60,
      // Fireworks' published serverless prices on 2026-10-12.
      pricing_usd_per_million: {
        [DEEPSEEK]: { input: 0.3, output: 1.2 }, [GLM]: { input: 0.15, output: 0.5 }, [GPT_OSS]: { input: 0.15, output: 0.6 },
      },
    });
    expect(config.cop).toEqual({
      max_autofix_retries: 2, dedup_window_days: 30, max_pitch_words: 200, min_pdf_bytes: 10240, max_pdf_pages: 2,
    });
    expect(config.db_path).toBe("~/.reygent/reygent.db");
    expect(config.browser_profile_dir).toBe("~/.reygent/browser_profile/default");
  });

  test("the sections added in the TypeScript port default to hands-free operation", () => {
    const config = defaultConfig();
    expect(config.compensation.quoted_hourly_rate_usd).toBe(50);
    expect(config.compensation.quoted_hourly_rate_usd).toBeGreaterThanOrEqual(config.compensation.hourly_floor_usd);
    expect(config.discovery).toEqual({
      greenhouse_boards: [
        "canonical", "gitlab", "grafanalabs", "automatticcareers", "sourcegraph91", "mozilla", "planetscale",
        "consensys", "fivetran", "wikimedia", "jetbrains", "nearform", "mattermost", "tailscale",
      ],
      ashby_orgs: [
        "supabase", "n8n", "linear", "elevenlabs", "cohere", "railway", "livekit", "clickhouse", "oyster",
        "resend", "sanity", "mastra", "triggerdev", "docker",
      ],
      lever_companies: ["metabase", "gohighlevel", "superside", "anchorage", "toptal", "jumpcloud", "swissborg", "1inch"],
      workable_accounts: ["zyte", "modash", "huggingface"],
      recruitee_companies: ["tether"],
      teamtailor_companies: ["axmed"],
      breezy_companies: ["abstractgroup"],
      // Every job board Reygent can read is on until the user takes it off the list.
      job_boards: [
        "remotive", "remoteok", "jobicy", "himalayas", "workingnomads", "weworkremotely", "realworkfromanywhere",
        "golangprojects", "python_org",
      ],
      hn_who_is_hiring: true,
      hn_freelancer: true,
      follow_board_links: true,
      found_boards_per_cycle: 20,
      title_keywords: [
        "engineer", "developer", "full-stack", "full stack", "fullstack", "frontend", "front-end",
        "backend", "ai", "llm", "machine learning", "agent",
      ],
      // Roles below a senior engineer's level are not tracked.
      title_exclude_keywords: [
        "junior", "intern", "internship", "graduate", "trainee", "apprentice", "entry level", "entry-level",
        "working student",
      ],
      max_new_jobs_per_cycle: 3000,
    });
    // The Ashby board that stopped resolving stays out of the defaults.
    expect(config.discovery.ashby_orgs).not.toContain("posthog");
    expect(config.pipeline).toEqual({
      // The owner's call: no approval step, and the operator presses Submit itself.
      require_human_review: false, auto_submit: true, stop_at_invisible_captcha: false,
      pitch_unconfirmed_tier2: true, apply_single_country: false, answer_confidence: 0.85,
      // On, and without effect until the candidate lists their work history.
      tune_cv: true,
      fit_threshold: 60, max_drafts_per_cycle: 10, max_submissions_per_day: 10,
      loop_interval_minutes: 60, investigation_confidence: 0.8,
    });
  });

  test("the top-level keys are exactly the sections of config.yaml", () => {
    expect(Object.keys(defaultConfig()).sort()).toEqual([
      "agent", "apply", "browser_profile_dir", "budget", "candidate", "compensation", "cop", "db_path", "discovery", "email",
      "fact_bank", "fireworks", "inbox", "jev", "pipeline",
    ]);
  });

  test("the defaults are themselves a valid config", () => {
    expect(() => validateConfig(defaultConfig())).not.toThrow();
    expect(configFromObject(defaultConfig())).toEqual(defaultConfig());
  });

  test("each default config is independent of every other", () => {
    const first = defaultConfig();
    first.candidate.name = "Changed";
    first.candidate.skills.push("Rust");
    first.candidate.employers.push("Initech");
    first.fact_bank.achievements.push({ id: "ach_x" });
    first.discovery.title_keywords.push("wizard");
    first.discovery.greenhouse_boards.push("not-a-default-board");
    first.fireworks.pricing_usd_per_million[DEEPSEEK].input = 99;
    first.fireworks.pricing_usd_per_million["accounts/fireworks/models/other"] = { input: 1, output: 1 };

    const second = defaultConfig();
    expect(second.candidate.name).toBe(PLACEHOLDER);
    expect(second.candidate.skills).toEqual([]);
    expect(second.candidate.employers).toEqual([]);
    expect(second.fact_bank.achievements).toEqual([]);
    expect(second.discovery.title_keywords).not.toContain("wizard");
    expect(second.discovery.greenhouse_boards).not.toContain("not-a-default-board");
    expect(second.fireworks.pricing_usd_per_million).toEqual({
      [DEEPSEEK]: { input: 0.3, output: 1.2 }, [GLM]: { input: 0.15, output: 0.5 }, [GPT_OSS]: { input: 0.15, output: 0.6 },
    });
    // The same holds for configs built from a partial object or a file.
    expect(configFromObject({ budget: { daily_cap_usd: 2 } }).fireworks.pricing_usd_per_million[DEEPSEEK].input).toBe(0.3);
  });
});

describe("configFromObject", () => {
  test("values given replace defaults; everything else keeps its default", () => {
    const config = configFromObject({
      candidate: { name: "Test Candidate", years_experience: 8 },
      budget: { daily_cap_usd: 3 },
      pipeline: { fit_threshold: 75 },
      db_path: "/data/reygent.db",
    });
    expect(config.candidate.name).toBe("Test Candidate");
    expect(config.candidate.years_experience).toBe(8);
    expect(config.candidate.email).toBe(PLACEHOLDER);
    expect(config.budget).toEqual({ daily_cap_usd: 3, day_utc_offset_hours: 1 });
    expect(config.pipeline.fit_threshold).toBe(75);
    expect(config.pipeline.require_human_review).toBe(false);
    expect(config.db_path).toBe("/data/reygent.db");
    expect(config.cop).toEqual(defaultConfig().cop);
  });

  test("nothing at all means the defaults", () => {
    expect(configFromObject({})).toEqual(defaultConfig());
    expect(configFromObject(null)).toEqual(defaultConfig());
    expect(configFromObject(undefined)).toEqual(defaultConfig());
  });

  test("the object passed in is not modified", () => {
    const raw = { candidate: { name: "Test Candidate" }, cop: null };
    const snapshot = structuredClone(raw);
    configFromObject(raw);
    expect(raw).toEqual(snapshot);
  });

  test("whole numbers are accepted where a decimal is expected, and the reverse is refused", () => {
    expect(configFromObject({ budget: { daily_cap_usd: 2 } }).budget.daily_cap_usd).toBe(2);
    expect(configError(() => configFromObject({ fireworks: { max_tokens: 1.5 } }))).toContain("fireworks.max_tokens");
    expect(configError(() => configFromObject({ budget: { day_utc_offset_hours: 0.5 } }))).toContain(
      "budget.day_utc_offset_hours",
    );
  });

  test("unknown keys are rejected rather than ignored", () => {
    expect(configError(() => configFromObject({ budget: { daily_cap: 5 } }))).toBe("Unknown config key 'budget.daily_cap'");
    expect(configError(() => configFromObject({ bugdet: { daily_cap_usd: 5 } }))).toBe("Unknown config key 'bugdet'");
    expect(configError(() => configFromObject({ candidate: { nmae: "x" } }))).toBe("Unknown config key 'candidate.nmae'");
    expect(configError(() => configFromObject({ pipeline: { auto_send: true } }))).toBe(
      "Unknown config key 'pipeline.auto_send'",
    );
    expect(
      configError(() => configFromObject({ fireworks: { pricing_usd_per_million: { [DEEPSEEK]: { input: 1, output: 1, cached: 0.5 } } } })),
    ).toContain("cached");
  });

  test.each<[string, unknown]>([
    ["budget.daily_cap_usd", { budget: { daily_cap_usd: "lots" } }],
    ["budget.daily_cap_usd", { budget: { daily_cap_usd: true } }],
    ["budget.daily_cap_usd", { budget: { daily_cap_usd: null } }],
    ["budget.daily_cap_usd", { budget: { daily_cap_usd: Number.NaN } }],
    ["budget.daily_cap_usd", { budget: { daily_cap_usd: Number.POSITIVE_INFINITY } }],
    ["budget", { budget: [1, 2] }],
    ["budget", { budget: "lots" }],
    ["candidate.name", { candidate: { name: 42 } }],
    ["candidate.name", { candidate: { name: null } }],
    ["candidate.employers", { candidate: { employers: "Initech" } }],
    ["candidate.employers", { candidate: { employers: ["Initech", 7] } }],
    ["candidate.years_experience", { candidate: { years_experience: "8" } }],
    ["candidate.years_experience", { candidate: { years_experience: true } }],
    ["compensation.max_concurrent_engagements", { compensation: { max_concurrent_engagements: "3" } }],
    ["compensation.quoted_hourly_rate_usd", { compensation: { quoted_hourly_rate_usd: "50" } }],
    ["fact_bank.achievements", { fact_bank: { achievements: { id: "ach_x" } } }],
    ["fact_bank.achievements", { fact_bank: { achievements: ["just a headline"] } }],
    ["fireworks.pricing_usd_per_million", { fireworks: { pricing_usd_per_million: [DEEPSEEK] } }],
    ["fireworks.pricing_usd_per_million", { fireworks: { pricing_usd_per_million: { [DEEPSEEK]: 0.9 } } }],
    ["fireworks.pricing_usd_per_million", { fireworks: { pricing_usd_per_million: { [DEEPSEEK]: { input: "cheap", output: 1 } } } }],
    ["fireworks.pricing_usd_per_million", { fireworks: { pricing_usd_per_million: { [DEEPSEEK]: { input: 1 } } } }],
    ["discovery.greenhouse_boards", { discovery: { greenhouse_boards: "gitlab" } }],
    ["discovery.hn_who_is_hiring", { discovery: { hn_who_is_hiring: 1 } }],
    ["discovery.title_keywords", { discovery: { title_keywords: [1] } }],
    ["discovery.max_new_jobs_per_cycle", { discovery: { max_new_jobs_per_cycle: 2.5 } }],
    ["discovery.workable_accounts", { discovery: { workable_accounts: "zyte" } }],
    // A job board Reygent has no reader for is a typo, not a source.
    ["discovery.job_boards.0", { discovery: { job_boards: ["linkedin"] } }],
    ["discovery.hn_freelancer", { discovery: { hn_freelancer: "yes" } }],
    ["discovery.follow_board_links", { discovery: { follow_board_links: 1 } }],
    ["discovery.found_boards_per_cycle", { discovery: { found_boards_per_cycle: 2.5 } }],
    ["pipeline.require_human_review", { pipeline: { require_human_review: "yes" } }],
    ["pipeline.require_human_review", { pipeline: { require_human_review: 0 } }],
    ["pipeline.fit_threshold", { pipeline: { fit_threshold: "60" } }],
    ["pipeline.loop_interval_minutes", { pipeline: { loop_interval_minutes: 0.5 } }],
    ["db_path", { db_path: 5 }],
    ["db_path", { db_path: null }],
    ["browser_profile_dir", { browser_profile_dir: ["~/x"] }],
  ])("a wrong type for %s is rejected and the message names the key", (key, raw) => {
    expect(configError(() => configFromObject(raw))).toContain(key);
  });

  test("a config that is not a mapping is rejected", () => {
    for (const raw of [["budget"], "budget", 5, true]) {
      expect(() => configFromObject(raw)).toThrow(ConfigError);
    }
  });
});

describe("validateConfig", () => {
  /** [what is wrong, how to break a valid config, a fragment of the message] */
  const INVALID: ReadonlyArray<[string, (config: Config) => void, string]> = [
    ["an email without @", (c) => { c.candidate.email = "not-an-email"; }, "candidate.email is not a valid email address"],
    ["an email without a domain dot", (c) => { c.candidate.email = "me@localhost"; }, "candidate.email"],
    ["an email with a space", (c) => { c.candidate.email = "me and@example.com"; }, "candidate.email"],
    ["an email with two @", (c) => { c.candidate.email = "me@@example.com"; }, "candidate.email"],
    ["an email followed by a line break", (c) => { c.candidate.email = "me@example.com\n"; }, "candidate.email"],
    ["a GitHub URL without a scheme", (c) => { c.candidate.github_url = "github.com/me"; }, "candidate.github_url must be an http(s) URL"],
    ["a LinkedIn URL with another scheme", (c) => { c.candidate.linkedin_url = "ftp://linkedin.com/in/me"; }, "candidate.linkedin_url must be an http(s) URL"],
    ["a script portfolio URL", (c) => { c.candidate.portfolio_url = "javascript:alert(1)"; }, "candidate.portfolio_url must be an http(s) URL"],
    ["a URL containing a space", (c) => { c.candidate.portfolio_url = "https://me.example.com/my site"; }, "candidate.portfolio_url"],
    ["a URL followed by a line break", (c) => { c.candidate.github_url = "https://github.com/me\n"; }, "candidate.github_url"],
    ["a scheme with nothing after it", (c) => { c.candidate.github_url = "https://"; }, "candidate.github_url"],
    ["negative experience", (c) => { c.candidate.years_experience = -1; }, "candidate.years_experience must be between 0 and 60"],
    ["implausible experience", (c) => { c.candidate.years_experience = 61; }, "candidate.years_experience must be between 0 and 60"],
    ["a negative hourly floor", (c) => { c.compensation.hourly_floor_usd = -1; }, "compensation floors cannot be negative"],
    ["a negative monthly floor", (c) => { c.compensation.monthly_floor_usd = -1; }, "compensation floors cannot be negative"],
    ["a zero income goal", (c) => { c.compensation.monthly_income_goal_usd = 0; }, "compensation.monthly_income_goal_usd must be positive"],
    ["a negative income goal", (c) => { c.compensation.monthly_income_goal_usd = -10000; }, "compensation.monthly_income_goal_usd must be positive"],
    ["no engagements allowed", (c) => { c.compensation.max_concurrent_engagements = 0; }, "compensation.max_concurrent_engagements must be at least 1"],
    ["a quoted rate below the floor", (c) => { c.compensation.quoted_hourly_rate_usd = 39.99; }, "compensation.quoted_hourly_rate_usd cannot be below the hourly floor"],
    ["a floor raised above the quoted rate", (c) => { c.compensation.hourly_floor_usd = 60; }, "compensation.quoted_hourly_rate_usd cannot be below the hourly floor"],
    ["a negative daily cap", (c) => { c.budget.daily_cap_usd = -1; }, "budget.daily_cap_usd cannot be negative"],
    ["a UTC offset below -12", (c) => { c.budget.day_utc_offset_hours = -13; }, "budget.day_utc_offset_hours must be between -12 and 14"],
    ["a UTC offset above 14", (c) => { c.budget.day_utc_offset_hours = 15; }, "budget.day_utc_offset_hours must be between -12 and 14"],
    ["negative auto-fix retries", (c) => { c.cop.max_autofix_retries = -1; }, "cop.max_autofix_retries must be between 0 and 5"],
    ["too many auto-fix retries", (c) => { c.cop.max_autofix_retries = 6; }, "cop.max_autofix_retries must be between 0 and 5"],
    ["a negative de-duplication window", (c) => { c.cop.dedup_window_days = -1; }, "cop.dedup_window_days cannot be negative"],
    ["a pitch limit below 20 words", (c) => { c.cop.max_pitch_words = 19; }, "cop.max_pitch_words must be at least 20"],
    ["a zero-page PDF limit", (c) => { c.cop.max_pdf_pages = 0; }, "cop PDF limits must be positive"],
    ["a negative PDF size", (c) => { c.cop.min_pdf_bytes = -1; }, "cop PDF limits must be positive"],
    ["a negative Jev input price", (c) => { c.jev.input_usd_per_million = -0.01; }, "jev prices cannot be negative"],
    ["a negative Jev output price", (c) => { c.jev.output_usd_per_million = -0.01; }, "jev prices cannot be negative"],
    ["zero max_tokens", (c) => { c.fireworks.max_tokens = 0; }, "fireworks.max_tokens must be between 1 and 450"],
    ["max_tokens above the 450 ceiling", (c) => { c.fireworks.max_tokens = 4000; }, "fireworks.max_tokens must be between 1 and 450"],
    ["max_tokens just above the ceiling", (c) => { c.fireworks.max_tokens = 451; }, "fireworks.max_tokens must be between 1 and 450"],
    ["a negative input price", (c) => { c.fireworks.pricing_usd_per_million[DEEPSEEK].input = -0.9; }, `fireworks.pricing_usd_per_million['${DEEPSEEK}'] needs non-negative input and output prices`],
    ["a negative output price", (c) => { c.fireworks.pricing_usd_per_million[GLM].output = -0.9; }, `fireworks.pricing_usd_per_million['${GLM}'] needs non-negative input and output prices`],
    ["a model with no price", (c) => { c.fireworks.model = "accounts/fireworks/models/unpriced"; }, "fireworks.model 'accounts/fireworks/models/unpriced' has no entry in fireworks.pricing_usd_per_million"],
    ["an empty model name", (c) => { c.fireworks.model = ""; }, "has no entry in fireworks.pricing_usd_per_million"],
    ["an empty price table", (c) => { c.fireworks.pricing_usd_per_million = {}; }, "has no entry in fireworks.pricing_usd_per_million"],
    ["a negative fit threshold", (c) => { c.pipeline.fit_threshold = -1; }, "pipeline.fit_threshold must be between 0 and 100"],
    ["a fit threshold above 100", (c) => { c.pipeline.fit_threshold = 101; }, "pipeline.fit_threshold must be between 0 and 100"],
    ["negative drafts per cycle", (c) => { c.pipeline.max_drafts_per_cycle = -1; }, "pipeline.max_drafts_per_cycle cannot be negative"],
    ["negative submissions per day", (c) => { c.pipeline.max_submissions_per_day = -1; }, "pipeline.max_submissions_per_day cannot be negative"],
    ["a zero loop interval", (c) => { c.pipeline.loop_interval_minutes = 0; }, "pipeline.loop_interval_minutes must be at least 1"],
    ["investigation confidence below a coin flip", (c) => { c.pipeline.investigation_confidence = 0.49; }, "pipeline.investigation_confidence must be between 0.5 and 1"],
    ["investigation confidence above certainty", (c) => { c.pipeline.investigation_confidence = 1.01; }, "pipeline.investigation_confidence must be between 0.5 and 1"],
    ["no new jobs per cycle", (c) => { c.discovery.max_new_jobs_per_cycle = 0; }, "discovery.max_new_jobs_per_cycle must be at least 1"],
    ["a negative found-board budget", (c) => { c.discovery.found_boards_per_cycle = -1; }, "discovery.found_boards_per_cycle cannot be negative"],
    ["an agent model with no price", (c) => { c.agent.model = "accounts/fireworks/models/unpriced"; }, "agent.model 'accounts/fireworks/models/unpriced' has no entry in fireworks.pricing_usd_per_million"],
    ["a never-click pattern that is not one", (c) => { c.agent.never_click = ["(sign in"]; }, "agent.never_click: '(sign in' is not a valid pattern"],
  ];

  test.each(INVALID)("%s is rejected", (_label, breakIt, fragment) => {
    const config = filledConfig();
    breakIt(config);
    expect(configError(() => validateConfig(config))).toContain(fragment);
    // The same rule guards both ways in: a parsed file and a submitted form.
    expect(configError(() => configFromObject(config))).toContain(fragment);
  });

  /** [what is allowed, how to push a valid config to the edge of a rule] */
  const VALID: ReadonlyArray<[string, (config: Config) => void]> = [
    ["an unfilled email", (c) => { c.candidate.email = PLACEHOLDER; }],
    ["an empty email", (c) => { c.candidate.email = ""; }],
    ["a plus-addressed email", (c) => { c.candidate.email = "first.last+jobs@mail.example.co.uk"; }],
    ["unfilled profile links", (c) => { c.candidate.github_url = PLACEHOLDER; c.candidate.linkedin_url = ""; }],
    ["an http link", (c) => { c.candidate.portfolio_url = "http://me.example.com/work?id=1#top"; }],
    ["unknown experience", (c) => { c.candidate.years_experience = null; }],
    ["no experience", (c) => { c.candidate.years_experience = 0; }],
    ["sixty years of experience", (c) => { c.candidate.years_experience = 60; }],
    ["half years of experience", (c) => { c.candidate.years_experience = 7.5; }],
    ["zero floors", (c) => { c.compensation.hourly_floor_usd = 0; c.compensation.monthly_floor_usd = 0; }],
    ["a single engagement", (c) => { c.compensation.max_concurrent_engagements = 1; }],
    ["a quoted rate equal to the floor", (c) => { c.compensation.quoted_hourly_rate_usd = 40; }],
    ["a zero daily cap (never spend)", (c) => { c.budget.daily_cap_usd = 0; }],
    ["UTC-12", (c) => { c.budget.day_utc_offset_hours = -12; }],
    ["UTC+14", (c) => { c.budget.day_utc_offset_hours = 14; }],
    ["no auto-fix retries", (c) => { c.cop.max_autofix_retries = 0; }],
    ["five auto-fix retries", (c) => { c.cop.max_autofix_retries = 5; }],
    ["no de-duplication window", (c) => { c.cop.dedup_window_days = 0; }],
    ["a 20-word pitch limit", (c) => { c.cop.max_pitch_words = 20; }],
    ["a one-page, any-size PDF", (c) => { c.cop.max_pdf_pages = 1; c.cop.min_pdf_bytes = 0; }],
    ["free Jev tokens", (c) => { c.jev.input_usd_per_million = 0; c.jev.output_usd_per_million = 0; }],
    ["a single output token", (c) => { c.fireworks.max_tokens = 1; }],
    ["free Fireworks tokens", (c) => { c.fireworks.pricing_usd_per_million[DEEPSEEK] = { input: 0, output: 0 }; }],
    ["the other priced model", (c) => { c.fireworks.model = GLM; }],
    ["a newly priced model", (c) => {
      c.fireworks.pricing_usd_per_million["accounts/fireworks/models/new"] = { input: 0.2, output: 0.2 };
      c.fireworks.model = "accounts/fireworks/models/new";
    }],
    ["a fit threshold of 0", (c) => { c.pipeline.fit_threshold = 0; }],
    ["a fit threshold of 100", (c) => { c.pipeline.fit_threshold = 100; }],
    ["drafting and submitting switched off", (c) => { c.pipeline.max_drafts_per_cycle = 0; c.pipeline.max_submissions_per_day = 0; }],
    ["a one-minute loop", (c) => { c.pipeline.loop_interval_minutes = 1; }],
    ["investigation confidence of 0.5", (c) => { c.pipeline.investigation_confidence = 0.5; }],
    ["investigation confidence of 1", (c) => { c.pipeline.investigation_confidence = 1; }],
    ["one new job per cycle", (c) => { c.discovery.max_new_jobs_per_cycle = 1; }],
    ["no found boards read per cycle", (c) => { c.discovery.found_boards_per_cycle = 0; }],
    ["no job boards at all", (c) => { c.discovery.job_boards = []; }],
    ["review switched off", (c) => { c.pipeline.require_human_review = false; }],
  ];

  test.each(VALID)("%s is accepted", (_label, adjust) => {
    const config = filledConfig();
    adjust(config);
    expect(() => validateConfig(config)).not.toThrow();
    expect(configFromObject(config)).toEqual(config);
  });

  test.each(["constructor", "toString", "hasOwnProperty", "valueOf", "__proto__"])(
    "a model named %s is not mistaken for a priced one",
    (model) => {
      const config = filledConfig();
      config.fireworks.model = model;
      expect(configError(() => validateConfig(config))).toContain("has no entry in fireworks.pricing_usd_per_million");
    },
  );

  test("the first broken rule is the one reported", () => {
    const config = filledConfig();
    config.candidate.email = "nope";
    config.budget.daily_cap_usd = -1;
    expect(configError(() => validateConfig(config))).toContain("candidate.email");
  });
});

describe("loadConfig", () => {
  test("the example config loads", () => {
    const config = loadConfig(EXAMPLE_CONFIG);
    expect(config.candidate.name).toBe(PLACEHOLDER);
    expect(config.fact_bank.achievements).toHaveLength(2);
    expect(config.budget.daily_cap_usd).toBe(1.5);
  });

  test("the example config's achievements are format examples, never usable facts", () => {
    const { achievements } = loadConfig(EXAMPLE_CONFIG).fact_bank;
    expect(achievements.map((achievement) => achievement.id)).toEqual(["ach_example_agents", "ach_example_fullstack"]);
    expect(achievements.map((achievement) => achievement.verified)).toEqual([false, false]);
    expect(achievements[1].positioning).toEqual(["fullstack_product", "frontend_systems"]);
  });

  test("the example config leaves the sections it does not mention at their defaults", () => {
    const config = loadConfig(EXAMPLE_CONFIG);
    expect(config.pipeline).toEqual(defaultConfig().pipeline);
    expect(config.pipeline.require_human_review).toBe(false);
    expect(config.candidate.screening_notes).toBe("");
    expect(config.fireworks.model in config.fireworks.pricing_usd_per_million).toBe(true);
    expect(config.cop.min_pdf_bytes).toBe(10240);
  });

  test("the example config spells out every source, and they are the defaults", () => {
    // The file is what a new user copies: its source lists must not drift from the code's.
    expect(loadConfig(EXAMPLE_CONFIG).discovery).toEqual(defaultConfig().discovery);
    const written = fs.readFileSync(EXAMPLE_CONFIG, "utf8");
    for (const key of Object.keys(defaultConfig().discovery)) expect(written).toContain(`\n  ${key}:`);
  });

  test("a partial file is merged over the defaults", () => {
    const file = write("candidate:\n  name: Test Candidate\nbudget:\n  daily_cap_usd: 3\ndiscovery:\n  greenhouse_boards: [gitlab, acme]\n");
    const config = loadConfig(file);
    expect(config.candidate.name).toBe("Test Candidate");
    expect(config.candidate.location).toBe("Cameroon (UTC+1)");
    expect(config.budget).toEqual({ daily_cap_usd: 3, day_utc_offset_hours: 1 });
    expect(config.discovery.greenhouse_boards).toEqual(["gitlab", "acme"]);
    expect(config.discovery.hn_who_is_hiring).toBe(true);
    expect(config.fireworks).toEqual(defaultConfig().fireworks);
  });

  test("an empty file, or one with only comments, is the defaults", () => {
    expect(loadConfig(write(""))).toEqual(defaultConfig());
    expect(loadConfig(write("# nothing set yet\n\n"))).toEqual(defaultConfig());
  });

  test("a section with every setting commented out keeps its defaults", () => {
    const file = write("cop:\n  # max_autofix_retries: 2\nbudget:\npipeline: ~\ncandidate:\n  name: Test Candidate\n");
    const config = loadConfig(file);
    expect(config.cop).toEqual(defaultConfig().cop);
    expect(config.budget).toEqual(defaultConfig().budget);
    expect(config.pipeline).toEqual(defaultConfig().pipeline);
    expect(config.candidate.name).toBe("Test Candidate");
  });

  test("unknown keys are rejected rather than ignored", () => {
    const file = write("budget:\n  daily_cap: 5\n");
    expect(configError(() => loadConfig(file))).toBe("Unknown config key 'budget.daily_cap'");
  });

  test("wrong types are rejected and the message names the key", () => {
    const file = write('budget:\n  daily_cap_usd: "lots"\n');
    expect(configError(() => loadConfig(file))).toContain("budget.daily_cap_usd");
    expect(configError(() => loadConfig(write("pipeline:\n  require_human_review: sometimes\n")))).toContain(
      "pipeline.require_human_review",
    );
    expect(configError(() => loadConfig(write("budget:\n  daily_cap_usd: .inf\n")))).toContain("budget.daily_cap_usd");
    expect(configError(() => loadConfig(write("db_path:\n")))).toContain("db_path");
  });

  test("values that make no sense are rejected", () => {
    expect(configError(() => loadConfig(write("budget:\n  daily_cap_usd: -1\n")))).toContain("budget.daily_cap_usd");
    expect(configError(() => loadConfig(write("fireworks:\n  max_tokens: 4000\n")))).toContain("fireworks.max_tokens");
    expect(configError(() => loadConfig(write("candidate:\n  email: not-an-email\n")))).toContain("candidate.email");
  });

  test("a file that is not a mapping is rejected", () => {
    expect(() => loadConfig(write("- budget\n- cop\n"))).toThrow(ConfigError);
    expect(() => loadConfig(write("just some text\n"))).toThrow(ConfigError);
  });

  test("invalid YAML is reported as such, naming the file", () => {
    const file = write("candidate: [unclosed\n");
    const message = configError(() => loadConfig(file));
    expect(message).toContain("not valid YAML");
    expect(message).toContain(file);
  });

  test("a key given twice is invalid YAML, not a silent last-one-wins", () => {
    const file = write("budget:\n  daily_cap_usd: 1\n  daily_cap_usd: 100\n");
    expect(configError(() => loadConfig(file))).toContain("not valid YAML");
  });

  test("a missing explicit config is an error", () => {
    const missing = path.join(dir, "nope", "reygent-config.yaml");
    expect(configError(() => loadConfig(missing))).toBe(`Config file not found: ${missing}`);
  });

  test("a missing explicit config is fine when the caller will create it", () => {
    const missing = path.join(dir, "config.yaml");
    expect(loadConfig(missing, { missingOk: true })).toEqual(defaultConfig());
    expect(fs.existsSync(missing)).toBe(false); // loading never creates the file
  });

  test("$REYGENT_CONFIG names the file when no path is given", () => {
    process.env[CONFIG_ENV_VAR] = write("budget:\n  daily_cap_usd: 0.75\n", "from-env.yaml");
    expect(resolveConfigPath()).toBe(path.join(dir, "from-env.yaml"));
    expect(loadConfig().budget.daily_cap_usd).toBe(0.75);
    expect(loadConfig(null).budget.daily_cap_usd).toBe(0.75);
  });

  test("an explicit path wins over $REYGENT_CONFIG", () => {
    process.env[CONFIG_ENV_VAR] = write("budget:\n  daily_cap_usd: 0.75\n", "from-env.yaml");
    const explicit = write("budget:\n  daily_cap_usd: 0.25\n", "explicit.yaml");
    expect(resolveConfigPath(explicit)).toBe(explicit);
    expect(loadConfig(explicit).budget.daily_cap_usd).toBe(0.25);
  });

  test("a missing $REYGENT_CONFIG file is an error unless missingOk", () => {
    const missing = path.join(dir, "from-env.yaml");
    process.env[CONFIG_ENV_VAR] = missing;
    expect(configError(() => loadConfig())).toBe(`Config file not found: ${missing}`);
    expect(loadConfig(undefined, { missingOk: true })).toEqual(defaultConfig());
  });

  test("a missing default ./config.yaml yields pure defaults", () => {
    vi.spyOn(process, "cwd").mockReturnValue(dir);
    expect(resolveConfigPath()).toBe(path.join(dir, "config.yaml"));
    expect(loadConfig()).toEqual(defaultConfig());
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  test("the default ./config.yaml is read when it exists", () => {
    write("budget:\n  daily_cap_usd: 0.5\n");
    vi.spyOn(process, "cwd").mockReturnValue(dir);
    expect(loadConfig().budget.daily_cap_usd).toBe(0.5);
  });

  test("a config written by the Python web UI still loads", () => {
    // The body PyYAML's safe_dump produces for a Python Config(): no discovery or pipeline
    // sections, no quoted_hourly_rate_usd, and a folded long string.
    const file = write(
      "# Reygent configuration — written by the web UI (python3 -m reygent.cli web).\n\n" +
        "candidate:\n  name: Test Candidate\n  email: candidate@example.com\n  phone: +237 600 000 000\n" +
        "  github_url: https://github.com/test-candidate\n  linkedin_url: CHANGE_ME\n  portfolio_url: CHANGE_ME\n" +
        "  location: Cameroon (UTC+1)\n  timezone: Africa/Douala (WAT, UTC+1)\n" +
        "  work_authorization: Eligible for Global Independent B2B Contractor & 1099 Engagements. Invoices\n" +
        "    via direct wire / Deel / Remote / Wise.\n" +
        "  notice_period: 2 weeks\n  years_experience: 8.0\n  employers:\n  - Initech\n  skills: []\n" +
        "fact_bank:\n  achievements:\n  - id: ach_agents\n    verified: true\n    technologies:\n    - Python\n" +
        "compensation:\n  hourly_floor_usd: 40.0\n  monthly_floor_usd: 2500.0\n  monthly_income_goal_usd: 10000.0\n" +
        "  max_concurrent_engagements: 3\n" +
        "budget:\n  daily_cap_usd: 1.25\n  day_utc_offset_hours: 1\n" +
        `fireworks:\n  model: ${DEEPSEEK}\n  max_tokens: 450\n  timeout_seconds: 60.0\n  pricing_usd_per_million:\n` +
        `    ${DEEPSEEK}:\n      input: 0.9\n      output: 0.9\n` +
        "db_path: ~/.reygent/reygent.db\nbrowser_profile_dir: ~/.reygent/browser_profile/default\n",
    );
    const config = loadConfig(file);
    expect(config.candidate.name).toBe("Test Candidate");
    expect(config.candidate.phone).toBe("+237 600 000 000");
    expect(config.candidate.years_experience).toBe(8);
    expect(config.candidate.work_authorization).toBe(defaultConfig().candidate.work_authorization);
    expect(config.fact_bank.achievements).toEqual([{ id: "ach_agents", verified: true, technologies: ["Python"] }]);
    expect(config.budget.daily_cap_usd).toBe(1.25);
    expect(config.compensation.quoted_hourly_rate_usd).toBe(50);
    expect(config.pipeline).toEqual(defaultConfig().pipeline);
  });
});

describe("saveConfig", () => {
  test("a saved config round-trips through loadConfig", () => {
    const file = path.join(dir, "config.yaml");
    const config = filledConfig();
    config.budget.daily_cap_usd = 1.25;
    config.discovery.greenhouse_boards = ["gitlab"];
    config.pipeline.require_human_review = false;

    expect(saveConfig(config, file)).toBe(file);
    expect(loadConfig(file)).toEqual(config);
  });

  test("strings that look like other YAML types survive the round trip", () => {
    const file = path.join(dir, "config.yaml");
    const config = filledConfig();
    config.candidate.name = "Zoë Ngôlé — “the” engineer";
    config.candidate.phone = "+237 600 000 000";
    config.candidate.notice_period = "no";
    config.candidate.location = "null";
    config.candidate.timezone = "~";
    config.candidate.work_authorization = "B2B: yes # really\n  second line, indented\n\ttabbed\n";
    config.candidate.employers = ["123", "1e3", "true", "", " padded ", "a: b", "- dash", "[x]", "{y}", "'quoted'", '"double"', "0x1F", "2026-10-12"];
    config.candidate.skills = ["C#", "C++", "@scope/pkg", "*star", "&anchor", "!tag", "%percent", "`tick`", "|pipe", ">fold"];
    config.fact_bank.achievements = [{
      id: "ach_1", headline: "Cut p95 latency: 480ms -> 120ms (75%)", impact_metric: "x".repeat(250),
      technologies: ["Python"], verified: true, nested: { deep: [1, 2.5, null, false, "s"] },
    }];

    saveConfig(config, file);
    expect(loadConfig(file)).toEqual(config);
  });

  test("the file is owner-only, because it holds contact details", () => {
    const file = path.join(dir, "config.yaml");
    saveConfig(filledConfig(), file);
    expect(mode(file)).toBe(0o600);
  });

  test("a config file that was world-readable becomes owner-only", () => {
    const file = write("budget:\n  daily_cap_usd: 1\n");
    fs.chmodSync(file, 0o644);
    saveConfig(filledConfig(), file);
    expect(mode(file)).toBe(0o600);
  });

  test("the previous file is kept as .bak", () => {
    const file = path.join(dir, "config.yaml");
    saveConfig(filledConfig(), file);
    expect(fs.existsSync(`${file}.bak`)).toBe(false); // nothing to back up on the first save
    const first = fs.readFileSync(file);

    const changed = filledConfig();
    changed.budget.daily_cap_usd = 0.5;
    saveConfig(changed, file);
    expect(fs.readFileSync(`${file}.bak`).equals(first)).toBe(true);
    expect(loadConfig(`${file}.bak`).budget.daily_cap_usd).toBe(1.5);
    expect(loadConfig(file).budget.daily_cap_usd).toBe(0.5);

    const third = filledConfig();
    third.budget.daily_cap_usd = 0.25;
    saveConfig(third, file);
    expect(loadConfig(`${file}.bak`).budget.daily_cap_usd).toBe(0.5); // only one generation is kept
  });

  test("a hand-written file is backed up byte for byte, comments included", () => {
    const original = "# my notes\nbudget:\n  daily_cap_usd: 1   # keep it low\n";
    const file = write(original);
    saveConfig(filledConfig(), file);
    expect(fs.readFileSync(`${file}.bak`, "utf8")).toBe(original);
  });

  test("the write is atomic: the file is replaced whole and no temporary file remains", () => {
    const file = write("budget:\n  daily_cap_usd: 1\n");
    const before = fs.statSync(file).ino;
    saveConfig(filledConfig(), file);
    expect(fs.statSync(file).ino).not.toBe(before); // renamed into place, not rewritten in place
    expect(fs.readdirSync(dir).sort()).toEqual(["config.yaml", "config.yaml.bak"]);
  });

  test("a temporary file left by a crashed save is overwritten", () => {
    const file = path.join(dir, "config.yaml");
    fs.writeFileSync(`${file}.tmp`, "half-written garbage: [", { mode: 0o644 });
    fs.chmodSync(`${file}.tmp`, 0o644);
    saveConfig(filledConfig(), file);
    expect(loadConfig(file)).toEqual(filledConfig());
    expect(mode(file)).toBe(0o600);
    expect(fs.readdirSync(dir)).toEqual(["config.yaml"]);
  });

  test("missing parent directories are created", () => {
    const file = path.join(dir, "nested", "deeper", "config.yaml");
    expect(saveConfig(filledConfig(), file)).toBe(file);
    expect(loadConfig(file).candidate.name).toBe("Test Candidate");
  });

  test("the saved file starts with a comment and never holds an API key", () => {
    const file = path.join(dir, "config.yaml");
    saveConfig(filledConfig(), file);
    const text = fs.readFileSync(file, "utf8");
    expect(text.startsWith("# Reygent configuration")).toBe(true);
    expect(text).toContain("api_key_env: FIREWORKS_API_KEY"); // the variable's name, not its value
    expect(text).not.toMatch(/api_key:/);
  });

  test("with no path it writes $REYGENT_CONFIG", () => {
    const file = path.join(dir, "from-env.yaml");
    process.env[CONFIG_ENV_VAR] = file;
    expect(saveConfig(filledConfig())).toBe(file);
    expect(loadConfig().candidate.name).toBe("Test Candidate");
  });

  test("saving does not modify the config it was given", () => {
    const config = filledConfig();
    const snapshot = structuredClone(config);
    saveConfig(config, path.join(dir, "config.yaml"));
    expect(config).toEqual(snapshot);
  });

  /** The invalid-settings cases of tests/test_web.py::SetupTests. */
  const REJECTED: ReadonlyArray<[string, (config: Config) => unknown, string]> = [
    ["a negative cap", (c) => { c.budget.daily_cap_usd = -1; return c; }, "daily_cap_usd"],
    ["an unknown key", (c) => ({ ...c, budget: { ...c.budget, daily_cap: 5 } }), "budget.daily_cap"],
    ["a bad email", (c) => { c.candidate.email = "not-an-email"; return c; }, "email"],
    ["max_tokens over the limit", (c) => { c.fireworks.max_tokens = 4000; return c; }, "max_tokens"],
    ["an unpriced model", (c) => { c.fireworks.model = "accounts/fireworks/models/unpriced"; return c; }, "pricing"],
    ["a wrong type", (c) => ({ ...c, pipeline: { ...c.pipeline, require_human_review: "no" } }), "pipeline.require_human_review"],
    ["a quoted rate under the floor", (c) => { c.compensation.quoted_hourly_rate_usd = 10; return c; }, "quoted_hourly_rate_usd"],
  ];

  test.each(REJECTED)("%s is rejected and nothing is written", (_label, breakIt, fragment) => {
    const original = "# hand-written\nbudget:\n  daily_cap_usd: 1\n";
    const file = write(original);
    const bad = breakIt(filledConfig()) as Config;

    expect(configError(() => saveConfig(bad, file))).toContain(fragment);
    expect(fs.readFileSync(file, "utf8")).toBe(original);
    expect(fs.readdirSync(dir)).toEqual(["config.yaml"]); // no .bak, no .tmp
  });

  test("an invalid config does not create a missing file either", () => {
    const file = path.join(dir, "fresh", "config.yaml");
    const bad = filledConfig();
    bad.budget.daily_cap_usd = -1;
    expect(() => saveConfig(bad, file)).toThrow(ConfigError);
    expect(fs.existsSync(path.dirname(file))).toBe(false);
  });
});

describe("paths", () => {
  test("expandHome expands a leading ~ and nothing else", () => {
    expect(expandHome("~")).toBe(os.homedir());
    expect(expandHome("~/.reygent/reygent.db")).toBe(path.join(os.homedir(), ".reygent", "reygent.db"));
    expect(expandHome("/var/data/reygent.db")).toBe("/var/data/reygent.db");
    expect(expandHome("data/~/reygent.db")).toBe("data/~/reygent.db");
    expect(expandHome("~other/reygent.db")).toBe("~other/reygent.db");
    expect(expandHome(":memory:")).toBe(":memory:");
  });

  test("the database lives at the config's db_path, with ~ expanded", () => {
    expect(resolveDbPath(defaultConfig())).toBe(path.join(os.homedir(), ".reygent", "reygent.db"));
    const config = defaultConfig();
    config.db_path = path.join(dir, "data", "reygent.db");
    expect(resolveDbPath(config)).toBe(path.join(dir, "data", "reygent.db"));
  });

  test("a relative db_path is made absolute", () => {
    const config = defaultConfig();
    config.db_path = "data/reygent.db";
    expect(resolveDbPath(config)).toBe(path.resolve("data/reygent.db"));
    expect(path.isAbsolute(resolveDbPath(config))).toBe(true);
  });

  test("$REYGENT_DB overrides the config", () => {
    const config = defaultConfig();
    config.db_path = path.join(dir, "from-config.db");
    process.env[DB_ENV_VAR] = path.join(dir, "from-env.db");
    expect(resolveDbPath(config)).toBe(path.join(dir, "from-env.db"));

    process.env[DB_ENV_VAR] = "~/elsewhere/reygent.db";
    expect(resolveDbPath(config)).toBe(path.join(os.homedir(), "elsewhere", "reygent.db"));

    process.env[DB_ENV_VAR] = "";
    expect(resolveDbPath(config)).toBe(path.join(dir, "from-config.db")); // empty means unset
  });

  test(":memory: is passed through untouched", () => {
    const config = defaultConfig();
    config.db_path = ":memory:";
    expect(resolveDbPath(config)).toBe(":memory:");

    config.db_path = path.join(dir, "reygent.db");
    process.env[DB_ENV_VAR] = ":memory:";
    expect(resolveDbPath(config)).toBe(":memory:");
  });

  test("the config path is the explicit one, then $REYGENT_CONFIG, then ./config.yaml", () => {
    expect(resolveConfigPath()).toBe(path.resolve("config.yaml"));
    process.env[CONFIG_ENV_VAR] = "~/reygent/from-env.yaml";
    expect(resolveConfigPath()).toBe(path.join(os.homedir(), "reygent", "from-env.yaml"));
    expect(resolveConfigPath("relative/explicit.yaml")).toBe(path.resolve("relative/explicit.yaml"));
    expect(resolveConfigPath("~/explicit.yaml")).toBe(path.join(os.homedir(), "explicit.yaml"));
  });
});

describe("ConfigError", () => {
  test("is an Error that callers can tell apart from a crash", () => {
    const error = new ConfigError("budget.daily_cap_usd cannot be negative");
    expect(error).toBeInstanceOf(Error);
    expect(error).toBeInstanceOf(ConfigError);
    expect(error.message).toBe("budget.daily_cap_usd cannot be negative");
  });
});
