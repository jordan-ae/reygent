/**
 * Typed configuration for Reygent.
 *
 * Values come from config.yaml (see config.example.yaml); anything not set there
 * falls back to the defaults below. The object mirrors the YAML file key for key
 * (snake_case), so what is loaded is exactly what is saved. API keys are never
 * stored here — each provider section names the environment variable that holds its key.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import YAML from "yaml";
import { z } from "zod";

import { JOB_BOARDS, PLACEHOLDER } from "@/core/models";

export const CONFIG_ENV_VAR = "REYGENT_CONFIG";
export const DB_ENV_VAR = "REYGENT_DB";
export const DEFAULT_CONFIG_FILE = "config.yaml";

export class ConfigError extends Error {}

/** A config section: unknown keys are rejected, and a missing section gets every default. */
const section = <T extends z.ZodRawShape>(shape: T) =>
  // Every field carries a default, so {} is a valid input; the generic hides that from the checker.
  z.strictObject(shape).prefault({} as never);

const AchievementRecord = z.record(z.string(), z.unknown());

export const ConfigSchema = z.strictObject({
  candidate: section({
    name: z.string().default(PLACEHOLDER),
    email: z.string().default(PLACEHOLDER),
    phone: z.string().default(PLACEHOLDER),
    github_url: z.string().default(PLACEHOLDER),
    linkedin_url: z.string().default(PLACEHOLDER),
    portfolio_url: z.string().default(PLACEHOLDER),
    location: z.string().default("Cameroon (UTC+1)"),
    timezone: z.string().default("Africa/Douala (WAT, UTC+1)"),
    work_authorization: z
      .string()
      .default(
        "Eligible for Global Independent B2B Contractor & 1099 Engagements. " +
          "Invoices via direct wire / Deel / Remote / Wise.",
      ),
    notice_period: z.string().default(PLACEHOLDER),
    years_experience: z.number().nullable().default(null),
    employers: z.array(z.string()).default([]),
    skills: z.array(z.string()).default([]),
    /**
     * Anything else the candidate wants screening questions answered from, in their own
     * words: citizenship, whether sponsorship is needed, where they may legally work.
     * The AI answers form questions from this and the facts above — never from guesses.
     */
    screening_notes: z.string().default(""),
    /**
     * The candidate's own summary, in their words. A tuned CV rewrites it for each listing
     * from this and the verified work, and prints it as written when a rewrite cannot be
     * verified; nothing is said about them that they did not write or verify.
     */
    summary: z.string().default(""),
    /**
     * The candidate's own CV as a PDF. When set, that file is what applications attach,
     * instead of a one-page resume generated from the fact bank.
     */
    resume_path: z.string().default(""),
    /**
     * The candidate's work history as their CV has it, most recent first. With it, each
     * application gets the whole CV rebuilt around its listing (see `pipeline.tune_cv`):
     * these roles, the verified achievements that name each employer, and `highlights`,
     * which are lines of the CV in the candidate's own words, printed as written.
     */
    experience: z
      .array(
        z.strictObject({
          employer: z.string(),
          title: z.string(),
          location: z.string().default(""),
          /** As it should read on the CV: "Jan 2025". */
          start: z.string().default(""),
          /** "Jan 2026", or "Present". */
          end: z.string().default(""),
          highlights: z.array(z.string()).default([]),
        }),
      )
      .default([]),
    /** Projects of the candidate's own: verified achievements by id, and lines in their own words. */
    projects: z
      .array(
        z.strictObject({
          name: z.string(),
          achievements: z.array(z.string()).default([]),
          highlights: z.array(z.string()).default([]),
        }),
      )
      .default([]),
    /** One line per qualification, as the CV has it. Left empty, the CV prints no Education section. */
    education: z.array(z.string()).default([]),
  }),
  fact_bank: section({
    /** Raw achievement records; validated into Achievement models by the ProfileManager. */
    achievements: z.array(AchievementRecord).default([]),
  }),
  compensation: section({
    hourly_floor_usd: z.number().default(40),
    monthly_floor_usd: z.number().default(2500),
    monthly_income_goal_usd: z.number().default(10000),
    max_concurrent_engagements: z.number().int().default(3),
    /** The rate Reygent quotes when a form or a founder asks. Must not be below the floor. */
    quoted_hourly_rate_usd: z.number().default(50),
  }),
  budget: section({
    daily_cap_usd: z.number().default(1.5),
    /** The budget day rolls over at the candidate's local midnight (WAT has no DST). */
    day_utc_offset_hours: z.number().int().default(1),
  }),
  jev: section({
    base_url: z.string().default("https://api.typesafe.ai/v1/systemone"),
    api_key_env: z.string().default("TYPESAFE_API_KEY"),
    model: z.string().default("jev-latest"),
    input_usd_per_million: z.number().default(0.042),
    output_usd_per_million: z.number().default(0),
    timeout_seconds: z.number().default(15),
  }),
  fireworks: section({
    base_url: z.string().default("https://api.fireworks.ai/inference/v1/chat/completions"),
    api_key_env: z.string().default("FIREWORKS_API_KEY"),
    model: z.string().default("accounts/fireworks/models/deepseek-v4p1-flash"),
    max_tokens: z.number().int().default(450),
    /**
     * Sent with every request as `reasoning_effort`; empty sends nothing. Fireworks'
     * current models all reason before they answer, and the reasoning is billed out of
     * `max_tokens`: left on, a 450-token budget is spent thinking and no text comes back.
     * "none" turns it off where the model allows (DeepSeek V4.1 Flash); GLM 5.3 and
     * GPT OSS cannot turn it off and take "low".
     */
    reasoning_effort: z.string().default("none"),
    timeout_seconds: z.number().default(60),
    /**
     * model id -> USD per 1M prompt ("input") and completion ("output") tokens, from
     * docs.fireworks.ai/serverless/pricing as read on 2026-10-12. Cached input is billed
     * lower by Fireworks; it is metered here at the full input price.
     */
    pricing_usd_per_million: z
      .record(z.string(), z.strictObject({ input: z.number(), output: z.number() }))
      // A factory, not a literal: zod hands a literal default out by (shallow) reference, so
      // editing one config's prices would silently change every later default config.
      .default(() => ({
        "accounts/fireworks/models/deepseek-v4p1-flash": { input: 0.3, output: 1.2 },
        "accounts/fireworks/models/glm-5p3-flash": { input: 0.15, output: 0.5 },
        "accounts/fireworks/models/gpt-oss-120b": { input: 0.15, output: 0.6 },
      })),
  }),
  cop: section({
    max_autofix_retries: z.number().int().default(2),
    dedup_window_days: z.number().int().default(30),
    max_pitch_words: z.number().int().default(200),
    min_pdf_bytes: z.number().int().default(10 * 1024),
    max_pdf_pages: z.number().int().default(2),
  }),
  discovery: section({
    // The default boards were checked live on 2026-10-12: each resolves, has listings whose
    // titles match the keywords, and belongs to a remote-first employer whose listings name
    // remote, worldwide or EMEA locations. Edit the lists freely.
    /** Greenhouse board tokens, e.g. "gitlab" for boards.greenhouse.io/gitlab. */
    greenhouse_boards: z
      .array(z.string())
      .default(() => [
        "canonical", "gitlab", "grafanalabs", "automatticcareers", "sourcegraph91", "mozilla", "planetscale",
        "consensys", "fivetran", "wikimedia", "jetbrains", "nearform", "mattermost", "tailscale",
      ]),
    /** Ashby organisation slugs, e.g. "supabase" for jobs.ashbyhq.com/supabase. */
    ashby_orgs: z
      .array(z.string())
      .default(() => [
        "supabase", "n8n", "linear", "elevenlabs", "cohere", "railway", "livekit", "clickhouse", "oyster",
        "resend", "sanity", "mastra", "triggerdev", "docker",
      ]),
    /** Lever company slugs, e.g. "metabase" for jobs.lever.co/metabase. */
    lever_companies: z
      .array(z.string())
      .default(() => ["metabase", "gohighlevel", "superside", "anchorage", "toptal", "jumpcloud", "swissborg", "1inch"]),
    /** Workable accounts, e.g. "zyte" for apply.workable.com/zyte. */
    workable_accounts: z.array(z.string()).default(() => ["zyte", "modash", "huggingface"]),
    /** Recruitee companies, e.g. "tether" for tether.recruitee.com. */
    recruitee_companies: z.array(z.string()).default(() => ["tether"]),
    /** Teamtailor companies, e.g. "axmed" for axmed.teamtailor.com. */
    teamtailor_companies: z.array(z.string()).default(() => ["axmed"]),
    /** Breezy companies, e.g. "abstractgroup" for abstractgroup.breezy.hr. */
    breezy_companies: z.array(z.string()).default(() => ["abstractgroup"]),
    /**
     * The job boards read through their public API or RSS feed. Each is read no more often
     * than its own terms ask, however short the cycle. Remove a name to stop reading it.
     */
    job_boards: z.array(z.enum(JOB_BOARDS)).default(() => [...JOB_BOARDS]),
    /** Read the monthly Hacker News "Who is hiring?" thread. */
    hn_who_is_hiring: z.boolean().default(true),
    /** Read the monthly Hacker News "Freelancer? Seeking freelancer?" thread for contract gigs. */
    hn_freelancer: z.boolean().default(true),
    /**
     * When a listing links to its employer's own board on one of the providers above, read
     * that board too from then on. This is how coverage grows by itself. It also lets a job
     * site's listing be looked up on its employer's board by the company's name, so that
     * the role is applied for through the form instead of being left as a pitch.
     */
    follow_board_links: z.boolean().default(true),
    /**
     * How many of the boards found that way are read in one cycle. They take turns, and a
     * board with no listing matching the keywords after three reads is dropped.
     */
    found_boards_per_cycle: z.number().int().default(20),
    /** Only listings whose title contains one of these (case-insensitive) are tracked. */
    title_keywords: z
      .array(z.string())
      .default([
        "engineer", "developer", "full-stack", "full stack", "fullstack", "frontend", "front-end",
        "backend", "ai", "llm", "machine learning", "agent",
      ]),
    /**
     * A listing whose title contains one of these is not tracked, whatever else the title
     * says. The defaults turn away roles below a senior engineer's level.
     */
    title_exclude_keywords: z
      .array(z.string())
      .default(() => [
        "junior", "intern", "internship", "graduate", "trainee", "apprentice", "entry level", "entry-level",
        "working student",
      ]),
    /**
     * High enough that the first cycle takes in every matching listing: a company is only
     * applied to once all its openings are known, so its best match can be picked.
     */
    max_new_jobs_per_cycle: z.number().int().default(3000),
  }),
  pipeline: section({
    /**
     * Hands-free by default: a draft that passes the Cop Tool goes straight to the
     * operator. Set true to have every draft wait for the user's approval first.
     */
    require_human_review: z.boolean().default(false),
    /**
     * true: the operator presses Submit itself when the form shows no login, MFA or
     * CAPTCHA and every required field is filled. false: it fills the form in a visible
     * window and leaves Submit to the user.
     */
    auto_submit: z.boolean().default(true),
    /**
     * Most application forms carry an invisible CAPTCHA that only runs when Submit is
     * pressed. false: press Submit and let the site's own check decide (a challenge, if
     * one comes up, is handed to the user). true: treat even an invisible one as a stop,
     * so every such form is filled and left for the user to submit.
     */
    stop_at_invisible_captcha: z.boolean().default(false),
    /**
     * A Tier 2 job the investigation could not settle is still applied for, with a pitch
     * that states the contractor arrangement, instead of waiting for the user to decide.
     */
    pitch_unconfirmed_tier2: z.boolean().default(true),
    /**
     * With `pitch_unconfirmed_tier2`, a listing that names one country ("Remote, Spain")
     * and that the investigation could not settle is applied for too, the same way. At a
     * company with another open role Reygent can apply for, that role is chosen instead.
     * false: such listings wait for the user.
     */
    apply_single_country: z.boolean().default(false),
    /**
     * How sure the decision model must be before an AI-written answer to a screening
     * question is used, and again before the Cop Tool accepts it.
     */
    answer_confidence: z.number().default(0.85),
    /**
     * Rebuild the CV around each listing: a summary that opens with what the listing is
     * hiring for, the listing's own words for the skills the candidate has and the work
     * they describe, the most relevant work first, in a layout a parser reads cleanly.
     * Needs `candidate.experience`; the CV file is then not used. false: every application
     * attaches the CV file as it is.
     */
    tune_cv: z.boolean().default(true),
    /** Minimum fit score (0–100) for a qualified job to be drafted. */
    fit_threshold: z.number().default(60),
    max_drafts_per_cycle: z.number().int().default(10),
    max_submissions_per_day: z.number().int().default(10),
    loop_interval_minutes: z.number().int().default(60),
    /** Jev confidence needed before an investigation verdict is acted on. */
    investigation_confidence: z.number().default(0.8),
  }),
  apply: section({
    /**
     * Hold an application whose site emails a code after Submit on the dashboard, for the
     * candidate to press "I'm ready" and approve the code. false: such an application is set aside.
     */
    code_handoff: z.boolean().default(false),
    /** How long the Approve card waits for the candidate once the site has emailed its code. */
    code_wait_minutes: z.number().int().min(1).default(10),
    /** How long Reygent searches the candidate's inbox for that code before asking them to paste it. */
    code_look_minutes: z.number().min(0).max(10).default(2),
  }),
  /**
   * The browser agent: when the fixed patterns cannot reach a form, fill it or find its
   * Submit button — an Apply button they do not know, a pop-up over the page, a cookie
   * banner, a form in steps — the writing model reads the page and decides what to press.
   * What it types still comes from the candidate's data and the draft's answers.
   */
  agent: section({
    enabled: z.boolean().default(true),
    /** The model it decides with. Empty: `fireworks.model`. It needs a price in `fireworks.pricing_usd_per_million`. */
    model: z.string().default(""),
    /** The most decisions it makes for one application before it gives up. */
    max_steps: z.number().int().min(1).max(200).default(30),
    /** The most it may spend on one application, in USD; it stops there. The daily cap still applies. */
    max_usd_per_application: z.number().min(0).default(0.1),
    /**
     * Questions met while applying that the draft holds no answer for — on a later step of
     * the form, or revealed by a choice — are answered from the candidate's data by the same
     * rules as drafting. false: such a question is left, and stops a required one.
     */
    answer_new_questions: z.boolean().default(true),
    /** Feed the "Autofill from resume" box some boards put above the form, as well as the resume field. */
    resume_autofill: z.boolean().default(false),
    /** A cookie banner: "reject" what is not essential, "accept" it all, or "close" it. */
    cookies: z.enum(["reject", "accept", "close"]).default("reject"),
    /** Follow an Apply link that leads to another site: a listing on a job site to the employer's own form. */
    follow_other_sites: z.boolean().default(true),
    /**
     * Apply through forms that ask applicants not to use AI, as any other form. false
     * (default): such a listing is left for the candidate to apply for by hand.
     */
    apply_where_ai_is_forbidden: z.boolean().default(false),
    /**
     * Buttons and links it never presses, as case-insensitive patterns matched against
     * their caption. By default: signing in or up through another site, and anything
     * that would make an account.
     */
    never_click: z
      .array(z.string())
      .default([
        "\\b(?:with|via|using)\\s+(?:linked\\s?in|google|indeed|github|facebook|apple|microsoft|seek|xing)\\b",
        "\\b(?:sign|log)\\s?(?:in|up|on)\\b",
        "\\b(?:create|register)\\s+(?:an\\s+)?account\\b",
      ]),
  }),
  email: section({
    /**
     * Send applications by email from the candidate's own mailbox where the employer takes
     * them by email: a founder's post that gives an address, or a listing whose company
     * publishes a hiring address. Hands-free only, and only once the mailbox's app
     * password is stored (Settings).
     */
    send_applications: z.boolean().default(true),
    /** Look for that address on the company's own website when the listing gives none. */
    find_contacts: z.boolean().default(true),
    /** After a run, email the candidate what needs them that no earlier note said: a reply at once, questions at most daily. */
    notify: z.boolean().default(true),
    /** Where those notes go. Empty: the candidate's email. */
    notify_to: z.string().default(""),
    /** The account that signs in to the mail server. Empty: the candidate's email. */
    smtp_user: z.string().default(""),
    /**
     * The address mail is sent as, when it is not the sign-in account itself: iCloud+ signs
     * in with the @icloud.com address and sends as an address on the custom domain. Empty:
     * `smtp_user`. Replies come back to it.
     */
    from_address: z.string().default(""),
    smtp_host: z.string().default("smtp.gmail.com"),
    smtp_port: z.number().int().default(465),
    /** The stored secret (or environment variable) holding that mailbox's app password. */
    password_env: z.string().default("REYGENT_SMTP_PASSWORD"),
    /** The most applications sent by email in a day; they count toward `pipeline.max_submissions_per_day` too. */
    max_per_day: z.number().int().default(20),
  }),
  inbox: section({
    /**
     * Read the candidate's inboxes for what came of their applications: a confirmation
     * settles one that may or may not have gone through, a rejection or a reply is recorded,
     * and a reply that needs an answer goes in the note to the candidate. Only mail from a
     * company applied to (or a hiring platform writing for one) is opened; nothing is marked
     * read, moved or answered.
     */
    watch: z.boolean().default(true),
    /** The inboxes to read. Empty: the mailbox mail is sent from, with the same app password. */
    accounts: z
      .array(
        z.strictObject({
          host: z.string(),
          port: z.number().int().default(993),
          user: z.string(),
          /** The stored secret (or environment variable) holding this inbox's app password. */
          password_env: z.string(),
        }),
      )
      .default([]),
    /** On the first read of an inbox, how many days back to look. */
    first_read_days: z.number().int().default(14),
  }),
  db_path: z.string().default("~/.reygent/reygent.db"),
  browser_profile_dir: z.string().default("~/.reygent/browser_profile/default"),
});

export type Config = z.infer<typeof ConfigSchema>;
export type CompensationConfig = Config["compensation"];
export type BudgetConfig = Config["budget"];
export type JevConfig = Config["jev"];
export type FireworksConfig = Config["fireworks"];
export type CopConfig = Config["cop"];
export type DiscoveryConfig = Config["discovery"];
export type PipelineConfig = Config["pipeline"];
export type EmailConfig = Config["email"];
export type InboxConfig = Config["inbox"];
export type AgentConfig = Config["agent"];

/** Pure defaults — what you get with no config file at all. */
export function defaultConfig(): Config {
  return ConfigSchema.parse({});
}

/** "~" and "~/x" to the user's home directory. */
export function expandHome(value: string): string {
  if (value === "~") return os.homedir();
  return value.startsWith("~/") ? path.join(os.homedir(), value.slice(2)) : value;
}

function describeIssue(issue: z.core.$ZodIssue): string {
  const where = issue.path.join(".");
  if (issue.code === "unrecognized_keys") {
    const key = [...issue.path, issue.keys[0]].join(".");
    return `Unknown config key '${key}'`;
  }
  return where ? `Config key '${where}': ${issue.message}` : issue.message;
}

/** Reject values that are well-typed but make no sense (negative caps, bad URLs, ...). */
export function validateConfig(config: Config): void {
  const check = (ok: boolean, message: string): void => {
    if (!ok) throw new ConfigError(message);
  };
  const { candidate, compensation, budget, cop, jev, fireworks, pipeline, discovery } = config;

  if (candidate.email && !candidate.email.includes(PLACEHOLDER)) {
    check(/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(candidate.email), "candidate.email is not a valid email address");
  }
  for (const name of ["github_url", "linkedin_url", "portfolio_url"] as const) {
    const value = candidate[name];
    if (value && !value.includes(PLACEHOLDER)) {
      check(/^https?:\/\/\S+$/.test(value), `candidate.${name} must be an http(s) URL`);
    }
  }
  if (candidate.years_experience !== null) {
    check(
      candidate.years_experience >= 0 && candidate.years_experience <= 60,
      "candidate.years_experience must be between 0 and 60",
    );
  }

  check(
    compensation.hourly_floor_usd >= 0 && compensation.monthly_floor_usd >= 0,
    "compensation floors cannot be negative",
  );
  check(compensation.monthly_income_goal_usd > 0, "compensation.monthly_income_goal_usd must be positive");
  check(compensation.max_concurrent_engagements >= 1, "compensation.max_concurrent_engagements must be at least 1");
  check(
    compensation.quoted_hourly_rate_usd >= compensation.hourly_floor_usd,
    "compensation.quoted_hourly_rate_usd cannot be below the hourly floor",
  );
  check(budget.daily_cap_usd >= 0, "budget.daily_cap_usd cannot be negative");
  check(
    budget.day_utc_offset_hours >= -12 && budget.day_utc_offset_hours <= 14,
    "budget.day_utc_offset_hours must be between -12 and 14",
  );
  check(
    cop.max_autofix_retries >= 0 && cop.max_autofix_retries <= 5,
    "cop.max_autofix_retries must be between 0 and 5",
  );
  check(cop.dedup_window_days >= 0, "cop.dedup_window_days cannot be negative");
  check(cop.max_pitch_words >= 20, "cop.max_pitch_words must be at least 20");
  check(cop.max_pdf_pages >= 1 && cop.min_pdf_bytes >= 0, "cop PDF limits must be positive");

  check(jev.input_usd_per_million >= 0 && jev.output_usd_per_million >= 0, "jev prices cannot be negative");
  check(fireworks.max_tokens >= 1 && fireworks.max_tokens <= 450, "fireworks.max_tokens must be between 1 and 450");
  for (const [model, price] of Object.entries(fireworks.pricing_usd_per_million)) {
    check(
      price.input >= 0 && price.output >= 0,
      `fireworks.pricing_usd_per_million['${model}'] needs non-negative input and output prices`,
    );
  }
  check(
    // Own entries only: `in` would accept a model called "constructor" or "toString".
    Object.hasOwn(fireworks.pricing_usd_per_million, fireworks.model),
    `fireworks.model '${fireworks.model}' has no entry in fireworks.pricing_usd_per_million`,
  );
  const { agent } = config;
  check(
    !agent.model || Object.hasOwn(fireworks.pricing_usd_per_million, agent.model),
    `agent.model '${agent.model}' has no entry in fireworks.pricing_usd_per_million`,
  );
  for (const pattern of agent.never_click) {
    let valid = true;
    try {
      new RegExp(pattern, "i");
    } catch {
      valid = false;
    }
    check(valid, `agent.never_click: '${pattern}' is not a valid pattern`);
  }

  check(pipeline.fit_threshold >= 0 && pipeline.fit_threshold <= 100, "pipeline.fit_threshold must be between 0 and 100");
  check(pipeline.max_drafts_per_cycle >= 0, "pipeline.max_drafts_per_cycle cannot be negative");
  check(pipeline.max_submissions_per_day >= 0, "pipeline.max_submissions_per_day cannot be negative");
  check(pipeline.loop_interval_minutes >= 1, "pipeline.loop_interval_minutes must be at least 1");
  check(
    pipeline.investigation_confidence >= 0.5 && pipeline.investigation_confidence <= 1,
    "pipeline.investigation_confidence must be between 0.5 and 1",
  );
  check(
    pipeline.answer_confidence >= 0.5 && pipeline.answer_confidence <= 1,
    "pipeline.answer_confidence must be between 0.5 and 1",
  );
  check(discovery.max_new_jobs_per_cycle >= 1, "discovery.max_new_jobs_per_cycle must be at least 1");
  check(discovery.found_boards_per_cycle >= 0, "discovery.found_boards_per_cycle cannot be negative");
}

/** Top-level keys that hold a section (a mapping of settings) rather than a single value. */
const SECTION_NAMES = new Set(
  Object.entries(ConfigSchema.parse({}))
    .filter(([, value]) => typeof value === "object")
    .map(([name]) => name),
);

/**
 * A section written with nothing under it ("cop:" with every setting commented out) is
 * YAML null. It means "all defaults", exactly like leaving the section out.
 */
function withoutEmptySections(raw: unknown): unknown {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return raw;
  return Object.fromEntries(
    Object.entries(raw).filter(([name, value]) => !(value === null && SECTION_NAMES.has(name))),
  );
}

/** Build a validated Config from a plain object (parsed YAML or a web form). */
export function configFromObject(raw: unknown): Config {
  const parsed = ConfigSchema.safeParse(withoutEmptySections(raw ?? {}));
  if (!parsed.success) throw new ConfigError(describeIssue(parsed.error.issues[0]));
  validateConfig(parsed.data);
  return parsed.data;
}

/** The config file in effect: explicit path, $REYGENT_CONFIG or ./config.yaml. */
export function resolveConfigPath(configPath?: string | null): string {
  return path.resolve(expandHome(configPath || process.env[CONFIG_ENV_VAR] || DEFAULT_CONFIG_FILE));
}

/**
 * Load configuration from `configPath`, $REYGENT_CONFIG or ./config.yaml.
 *
 * A missing default file yields pure defaults. A missing explicit path is an error
 * unless `missingOk` (used by the web console, which creates the file on first save).
 */
export function loadConfig(configPath?: string | null, options: { missingOk?: boolean } = {}): Config {
  const explicit = configPath || process.env[CONFIG_ENV_VAR];
  const file = resolveConfigPath(configPath);
  let config: Config;
  if (!fs.existsSync(file)) {
    if (explicit && !options.missingOk) throw new ConfigError(`Config file not found: ${file}`);
    config = defaultConfig();
  } else {
    let raw: unknown;
    try {
      raw = YAML.parse(fs.readFileSync(file, "utf8"));
    } catch (error) {
      throw new ConfigError(`${file} is not valid YAML: ${(error as Error).message}`);
    }
    config = configFromObject(raw);
  }
  return config;
}

/** Where the database lives: $REYGENT_DB if set, else the config's db_path. */
export function resolveDbPath(config: Config): string {
  const value = process.env[DB_ENV_VAR] || config.db_path;
  return value === ":memory:" ? value : path.resolve(expandHome(value));
}

const SAVED_HEADER =
  "# Reygent configuration — written by the web console.\n" +
  "# See config.example.yaml for what each setting means. API keys are never stored here.\n\n";

/**
 * Validate `config` and write it to the config file atomically.
 *
 * The previous file is kept alongside as `<name>.bak`. The file is owner-only
 * because it holds the candidate's contact details.
 */
export function saveConfig(config: Config, configPath?: string | null): string {
  const validated = configFromObject(config);
  const file = resolveConfigPath(configPath);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (fs.existsSync(file)) fs.copyFileSync(file, `${file}.bak`);
  const temporary = `${file}.tmp`;
  fs.writeFileSync(temporary, SAVED_HEADER + YAML.stringify(validated, { lineWidth: 100 }), { mode: 0o600 });
  fs.chmodSync(temporary, 0o600);
  fs.renameSync(temporary, file);
  return file;
}
