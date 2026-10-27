/**
 * The web console's behaviour, independent of HTTP and of Next.
 *
 * `WebApp` edits config.yaml, stores API keys, reports on every tracked application and
 * every action the agent has taken, and carries out the user's decisions about them.
 * Each method returns the status and JSON body to send, or throws an `ApiError`. An API
 * key is never part of any response.
 */

import fs from "node:fs";
import path from "node:path";

import {
  type Config,
  ConfigError,
  configFromObject,
  defaultConfig,
  expandHome,
  loadConfig,
  resolveConfigPath,
  resolveDbPath,
  saveConfig,
} from "@/core/config";
import * as reports from "@/core/db/reports";
import { Repository } from "@/core/db/repository";
import { BOARD_PROVIDERS, BOARD_SETTINGS } from "@/core/discovery/boards";
import { CostLedger } from "@/core/llm/ledger";
import { type CandidateProfile, type EligibilityReport, PLACEHOLDER } from "@/core/models";
import { describeMode } from "@/core/orchestrator/commands";
import { type CycleReport, HEARTBEAT_KEY, type Step, draftingBlockers } from "@/core/orchestrator/pipeline";
import { EVIDENCE_DIR, type Runtime, createRuntime } from "@/core/orchestrator/runtime";
import { ProfileManager } from "@/core/profile/manager";
import { imapReader, inboxAccounts } from "@/core/mail/inbox";
import { mailerFor, sendingAddress, signInAccount } from "@/core/mail/mailer";
import { evaluateRemoteEligibility, qualifyJob } from "@/core/qualification/eligibility";
import { deleteApiKey, keySource, resolveApiKey, secretsPath, storeApiKey } from "@/core/secrets";
import { codeHoldView } from "@/core/orchestrator/codeHold";
import { actOnCode, actOnDraft, addOutcome, decideInvestigation, putAnswer, removeAnswer, retryHold } from "@/core/web/actions";
import { ApiError, type ApiResult, JOB_ID, type JsonObject, type Query, isJsonObject, itemIds, ok } from "@/core/web/contract";
import { jobFromForm } from "@/core/web/listing";
import type {
  ActivityBody,
  AddApplicationBody,
  AnswersBody,
  ApplicationBody,
  ApplicationsBody,
  Budget,
  CodeHoldBody,
  CostsBody,
  EligibilityCheckBody,
  EvaluationSummary,
  KeyStatus,
  KeyTestBody,
  OverviewBody,
  PipelineRunBody,
  QuarantineBody,
  ReadinessItem,
  RetryBody,
  ReviewBody,
  StateBody,
  SystemPart,
} from "@/core/web/types";

export { ApiError, type ApiResult, type JsonObject, type Query, isJsonObject } from "@/core/web/contract";
export { jobFromForm } from "@/core/web/listing";

const COST_HISTORY_DAYS = 14;
const KEY_TEST_TIMEOUT_MS = 15_000;
/** The steps "Run discovery now" runs: everything that needs neither a browser nor a draft. */
const DISCOVERY_STEPS: readonly Step[] = ["discover", "investigate", "score"];
/** Every PNG starts with these eight bytes. */
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const reason = (error: unknown): string => (error instanceof Error ? error.message : String(error));

function reportBody(report: EligibilityReport): EvaluationSummary {
  return {
    tier: report.tier, summary: report.summary, reasonCodes: report.reasonCodes,
    positiveSignals: report.positiveSignals, disqualifiers: report.disqualifiers,
    needsB2bInvestigation: report.needsB2bInvestigation,
  };
}

interface Provider {
  id: string;
  label: string;
  purpose: string;
  env: string;
  /** A free endpoint that only answers 2xx to a valid key. */
  testUrl: string;
}

/** What is known about the setup: the config, and everything derived from it that can be wrong. */
interface Setup {
  config: Config;
  /** Why the config could not be used, or "". */
  configError: string;
  /** null when the config cannot be turned into a profile. */
  profile: CandidateProfile | null;
  readiness: ReadinessItem[];
  keys: KeyStatus[];
}

export interface WebAppOptions {
  /** Defaults to $REYGENT_CONFIG or ./config.yaml. */
  configPath?: string | null;
  /** Defaults to $REYGENT_DB or the config's db_path. */
  dbPath?: string | null;
  clock?: () => Date;
  /** How key tests reach the provider; injectable so tests make no network calls. */
  fetch?: typeof fetch;
  /**
   * Runs pipeline steps for "Run discovery now". The default runs them in this process
   * against the current config, without a browser; tests inject one that touches no network.
   */
  cycle?: (steps: readonly Step[]) => Promise<CycleReport>;
  /** Where the operator keeps confirmation screenshots. Defaults to ~/.reygent/evidence. */
  evidenceDir?: string;
}

export class WebApp {
  readonly repo: Repository;
  readonly dbPath: string;
  private readonly configPath: string | null;
  private readonly clock: () => Date;
  private readonly fetch: typeof fetch;
  private readonly evidenceDir: string;
  private readonly cycle: (steps: readonly Step[]) => Promise<CycleReport>;
  private runtime: Runtime | null = null;
  /** True while "Run discovery now" is in progress: two runs at once would fetch everything twice. */
  private cycleRunning = false;

  constructor(options: WebAppOptions = {}) {
    this.configPath = options.configPath ?? null;
    this.clock = options.clock ?? (() => new Date());
    this.fetch = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
    this.evidenceDir = path.resolve(expandHome(options.evidenceDir ?? EVIDENCE_DIR));
    this.dbPath = options.dbPath || resolveDbPath(this.load().config);
    this.repo = new Repository(this.dbPath);
    this.cycle =
      options.cycle ??
      ((steps) => {
        // The console never drives Chrome: reading forms and applying belong to the terminal run.
        this.runtime ??= createRuntime(() => loadConfig(this.configPath, { missingOk: true }), this.repo, {
          browser: false,
        });
        return this.runtime.cycle(steps);
      });
  }

  close(): void {
    this.repo.close();
  }

  /** The config on disk, or defaults plus the reason it could not be read. */
  private load(): { config: Config; error: string } {
    try {
      return { config: loadConfig(this.configPath, { missingOk: true }), error: "" };
    } catch (error) {
      return { config: defaultConfig(), error: reason(error) };
    }
  }

  private setup(): Setup {
    const { config, error } = this.load();
    let configError = error;
    let profile: CandidateProfile | null = null;
    if (!configError) {
      try {
        profile = new ProfileManager(this.repo, config).build();
      } catch (invalid) {
        // The file parsed but its fact bank is unusable (duplicate ids, unknown positioning, ...).
        if (!(invalid instanceof ConfigError)) throw invalid;
        configError = invalid.message;
      }
    }
    const readiness: ReadinessItem[] = profile ? [...ProfileManager.readinessIssues(profile)] : [];
    const keys: KeyStatus[] = [];
    for (const provider of this.providers(config)) {
      const source = keySource(provider.env);
      keys.push({ id: provider.id, label: provider.label, purpose: provider.purpose, env: provider.env, source });
      if (source === null) {
        readiness.push({
          area: "settings",
          message:
            provider.id === "email"
              ? "The email app password is not set: nothing is sent by email, and you are not emailed what needs you"
              : provider.id.startsWith("inbox-")
                ? `${provider.label} is not set: Reygent does not read that inbox for replies`
                : `${provider.label} API key is not set`,
        });
      }
    }
    return { config, configError, profile, readiness, keys };
  }

  private ledger(config: Config): CostLedger {
    return new CostLedger(this.repo, { budget: config.budget, clock: this.clock });
  }

  private budget(config: Config): Budget {
    const ledger = this.ledger(config);
    return {
      spentUsd: ledger.spentToday(), capUsd: ledger.capUsd, remainingUsd: ledger.remainingToday(),
      tripped: ledger.isTripped(), utcOffsetHours: config.budget.day_utc_offset_hours,
    };
  }

  private providers(config: Config): Provider[] {
    return [
      {
        id: "jev", label: "TypeSafe Jev", purpose: "Typed decisions (Tier 1)", env: config.jev.api_key_env,
        testUrl: config.jev.base_url.replace(/\/systemone\/?$/, "/models"),
      },
      {
        id: "fireworks", label: "Fireworks AI", purpose: "Text generation (Tier 2)", env: config.fireworks.api_key_env,
        testUrl: config.fireworks.base_url.replace(/\/chat\/completions\/?$/, "/models"),
      },
      {
        id: "email", label: "Email app password",
        purpose:
          `Sends applications by email and the notes after a run, as ${sendingAddress(config) || "your email"}` +
          ` (the app password of ${signInAccount(config) || "your mailbox"} on ${config.email.smtp_host})`,
        env: config.email.password_env, testUrl: "",
      },
      // An inbox read with its own password (one that is not also the sending mailbox).
      ...inboxAccounts(config)
        .filter((account) => account.password_env !== config.email.password_env)
        .map((account, index) => ({
          id: `inbox-${index}`, label: `Inbox app password: ${account.user}`,
          purpose: `Lets Reygent read ${account.user} for confirmations, rejections and replies (read only)`,
          env: account.password_env, testUrl: "",
        })),
    ];
  }

  private provider(providerId: string): Provider {
    const provider = this.providers(this.load().config).find((candidate) => candidate.id === providerId);
    if (!provider) throw new ApiError(404, `Unknown provider '${providerId}'`);
    return provider;
  }

  /** The last cycle any process finished, and whether that was recent enough to call the pipeline running. */
  private heartbeat(config: Config): { lastCycle: CycleReport | null; recent: boolean } {
    const stored = this.repo.getState<CycleReport>(HEARTBEAT_KEY);
    const finished = isJsonObject(stored) ? Date.parse(String(stored.finishedAt)) : Number.NaN;
    if (!stored || Number.isNaN(finished)) return { lastCycle: null, recent: false };
    // A daemon finishes a cycle every interval; allow one missed beat before calling it stopped.
    const allowedMs = (2 * config.pipeline.loop_interval_minutes + 5) * 60_000;
    return { lastCycle: stored, recent: this.clock().getTime() - finished <= allowedMs };
  }

  // ---------- Setup ----------

  state(): ApiResult<StateBody> {
    const setup = this.setup();
    const { config, configError, profile, readiness, keys } = setup;
    return ok({
      config,
      configError,
      configPath: resolveConfigPath(this.configPath),
      dbPath: this.dbPath,
      secretsPath: secretsPath(),
      placeholder: PLACEHOLDER,
      readiness,
      keys,
      positioning: Object.values(profile?.positioning ?? {}).map((positioning) => ({
        id: positioning.id, title: positioning.title, coreSkills: positioning.coreSkills,
        verifiedAchievements: positioning.highlightedAchievements.length,
      })),
      system: this.system(setup),
    });
  }

  /** Every component of Reygent and whether it is usable today. */
  private system({ config, profile, readiness, keys }: Setup): SystemPart[] {
    const budget = this.budget(config);
    const factsReady = !readiness.some((issue) => issue.area === "profile" || issue.area === "fact_bank");
    const hasKey = (providerId: string): boolean => keys.some((key) => key.id === providerId && key.source !== null);
    const { hn_who_is_hiring: hn, hn_freelancer: freelancer, job_boards: jobBoards } = config.discovery;
    const boards = BOARD_PROVIDERS.reduce((count, provider) => count + config.discovery[BOARD_SETTINGS[provider]].length, 0);
    const threads = Number(hn) + Number(freelancer);
    const sources = boards + jobBoards.length + threads;
    const blockers = profile ? draftingBlockers(profile) : ["config.yaml cannot be read"];
    const { lastCycle, recent } = this.heartbeat(config);
    return [
      {
        name: "Profile & fact bank", status: factsReady ? "ready" : "needs_setup",
        detail: factsReady ? "Every claim is grounded on it." : "Finish the profile and verify your achievements.",
      },
      {
        name: "Pipeline", status: recent ? "running" : "idle",
        detail:
          (recent
            ? "A cycle finished recently."
            : lastCycle
              ? "No cycle has finished recently."
              : "No cycle has run yet.") + " It runs from the terminal: npm run wake",
      },
      {
        name: "Job discovery", status: sources ? "ready" : "needs_setup",
        detail: sources
          ? `Reads ${boards} job ${boards === 1 ? "board" : "boards"}` +
            (jobBoards.length ? `, ${jobBoards.length} remote-job ${jobBoards.length === 1 ? "site" : "sites"}` : "") +
            (hn ? ` and the Hacker News hiring thread${freelancer ? "s" : ""}` : freelancer ? " and the Hacker News freelancer thread" : "") +
            ". Free."
          : "No sources are configured. Add some in Settings.",
      },
      {
        name: "3-tier eligibility scorer", status: "ready",
        detail: "Deterministic and free. Runs on every listing.",
      },
      {
        name: "Fit scoring", status: hasKey("jev") || config.pipeline.require_human_review ? "ready" : "needs_setup",
        detail: hasKey("jev")
          ? "Jev scores each qualified job against your positioning profiles."
          : config.pipeline.require_human_review
            ? "Using the free keyword score until a Jev key is set."
            : "Waiting for the Jev key: hands-free, nothing is investigated, scored or drafted without it.",
      },
      {
        name: "Tailoring & drafting", status: blockers.length ? "needs_setup" : "ready",
        detail: blockers.length
          ? `Blocked: ${blockers.join("; ")}.`
          : hasKey("fireworks")
            ? "Writes CV bullets, pitches and form answers from the fact bank."
            : "No Fireworks key: drafts are assembled from your verified text only.",
      },
      {
        name: "Cop Tool (9 invariants)", status: "ready",
        detail: "Gates every draft before dispatch; holds anything doubtful in Quarantine.",
      },
      {
        name: "Browser operator", status: "ready",
        detail: "Fills and submits forms from the terminal run, never from this console. Stops at logins, MFA and CAPTCHAs.",
      },
      {
        name: "Channel allocator", status: "ready",
        detail: "UCB1 over the four channels decides where each cycle's drafts go.",
      },
      {
        name: "Cost ledger & circuit breaker", status: budget.tripped ? "paused" : "ready",
        detail: budget.tripped
          ? "Tripped — paid calls are refused until the next budget day."
          : `Refuses any paid call past $${budget.capUsd.toFixed(2)} a day.`,
      },
      ...(["jev", "fireworks"] as const).map((providerId): SystemPart => ({
        name: providerId === "jev" ? "Jev decisions" : "Fireworks generation",
        status: hasKey(providerId) ? "ready" : "needs_setup",
        detail: hasKey(providerId) ? "Key set. Test it in Settings." : "Add the API key in Settings.",
      })),
      {
        name: "Web console", status: "ready",
        detail: "Next.js, on 127.0.0.1 only. Refuses any request that does not come from its own page.",
      },
    ];
  }

  saveConfig(body: JsonObject): ApiResult<StateBody> {
    if (!isJsonObject(body.config)) throw new ApiError(400, "Request must carry a 'config' object");
    let config: Config;
    let profile: CandidateProfile;
    try {
      config = configFromObject(body.config);
      profile = new ProfileManager(this.repo, config).build();
    } catch (invalid) {
      // Nothing has been written yet: an invalid config leaves the file and the fact bank untouched.
      if (!(invalid instanceof ConfigError)) throw invalid;
      throw new ApiError(400, invalid.message);
    }
    // Both writes are synchronous, so no other request can run between them.
    saveConfig(config, this.configPath);
    this.repo.saveProfile(profile);
    return this.state();
  }

  setKey(providerId: string, body: JsonObject): ApiResult<StateBody> {
    const provider = this.provider(providerId);
    if (typeof body.key !== "string") throw new ApiError(400, "Request must carry a 'key' string");
    try {
      // Google shows an app password in four groups ("abcd efgh ijkl mnop"); the spaces are not part of it.
      const appPassword = provider.id === "email" || provider.id.startsWith("inbox-");
      storeApiKey(provider.env, appPassword ? body.key.replace(/\s+/g, "") : body.key);
    } catch (error) {
      // A rejected key is the caller's mistake; a file-system failure (which carries a code) is ours.
      if (error instanceof Error && "code" in error) throw error;
      throw new ApiError(400, reason(error));
    }
    return this.state();
  }

  deleteKey(providerId: string): ApiResult<StateBody> {
    deleteApiKey(this.provider(providerId).env);
    return this.state();
  }

  /** Check the key in use against the provider's free model-listing endpoint. */
  async testKey(providerId: string): Promise<ApiResult<KeyTestBody>> {
    const provider = this.provider(providerId);
    const key = resolveApiKey(provider.env);
    if (!key) return ok({ ok: false, message: "No key is set." });
    if (provider.id.startsWith("inbox-")) {
      // Sign in to the inbox and out again; nothing is read.
      const account = inboxAccounts(this.load().config).find((candidate) => candidate.password_env === provider.env);
      if (!account) return ok({ ok: false, message: "That inbox is no longer configured." });
      try {
        await imapReader(account, key, 1).verify();
        return ok({ ok: true, message: `Signed in to ${account.host} as ${account.user}: Reygent can read it.` });
      } catch (error) {
        return ok({ ok: false, message: `${account.host} did not accept it for ${account.user}: ${reason(error)}` });
      }
    }
    if (provider.id === "email") {
      // Log in to the mailbox and out again; nothing is sent.
      const config = this.load().config;
      const mailer = mailerFor(config);
      if (!mailer) return ok({ ok: false, message: "Set your email in Profile first: mail is sent from it." });
      try {
        await mailer.verify();
        return ok({ ok: true, message: `Signed in to ${config.email.smtp_host}: Reygent can send as ${mailer.address}.` });
      } catch (error) {
        return ok({ ok: false, message: `${config.email.smtp_host} did not accept it for ${signInAccount(config)}: ${reason(error)}` });
      }
    }
    let status: number;
    try {
      const response = await this.fetch(provider.testUrl, {
        headers: { Authorization: `Bearer ${key}`, Accept: "application/json", "User-Agent": "reygent/0.2" },
        cache: "no-store",
        signal: AbortSignal.timeout(KEY_TEST_TIMEOUT_MS),
      });
      status = response.status;
      // Only the status matters; drop the model list rather than download it.
      await response.body?.cancel();
    } catch (error) {
      const cause = error instanceof Error && error.cause instanceof Error ? ` (${error.cause.message})` : "";
      return ok({ ok: false, message: `Could not reach ${provider.label}: ${reason(error)}${cause}` });
    }
    if (status >= 200 && status < 300) return ok({ ok: true, message: `${provider.label} accepted the key.` });
    if (status === 401 || status === 403) {
      return ok({ ok: false, message: `${provider.label} rejected the key (HTTP ${status}).` });
    }
    return ok({ ok: false, message: `Could not verify: ${provider.label} answered HTTP ${status}.` });
  }

  // ---------- The pipeline ----------

  overview(): ApiResult<OverviewBody> {
    const setup = this.setup();
    const { config } = setup;
    const { lastCycle, recent } = this.heartbeat(config);
    return ok({
      stages: reports.stageCounts(this.repo),
      pending: reports.pendingCounts(this.repo),
      budget: this.budget(config),
      goal: {
        monthlyIncomeGoalUsd: config.compensation.monthly_income_goal_usd,
        maxConcurrentEngagements: config.compensation.max_concurrent_engagements,
        securedMonthlyUsd: this.repo.securedMonthlyIncome(),
      },
      mode: {
        description: describeMode(config),
        reviewFirst: config.pipeline.require_human_review,
        // With this off, a Tier 2 job the investigation cannot settle waits for the user.
        pitchUnconfirmed: config.pipeline.pitch_unconfirmed_tier2,
      },
      lastCycle,
      cycleIsRecent: recent,
      system: this.system(setup),
      recentActivity: reports.activity(this.repo, { limit: 8 }),
    });
  }

  /**
   * "Run discovery now": fetch listings, investigate and score them, in this process.
   * Drafting and applying are left to the terminal run, which has the browser.
   */
  async runDiscovery(): Promise<ApiResult<PipelineRunBody>> {
    if (this.cycleRunning) throw new ApiError(409, "A discovery run is already in progress");
    this.cycleRunning = true;
    try {
      return ok({ report: await this.cycle(DISCOVERY_STEPS) });
    } catch (error) {
      // A config the pipeline cannot use is the user's to fix, not a server fault.
      if (error instanceof ConfigError) throw new ApiError(400, error.message);
      throw error;
    } finally {
      this.cycleRunning = false;
    }
  }

  // ---------- Applications ----------

  applications(query: Query): ApiResult<ApplicationsBody> {
    return ok({
      applications: reports.listApplications(this.repo, {
        stage: query.stage ?? "", tier: query.tier ?? "", search: (query.q ?? "").trim().slice(0, 200),
      }),
      stages: reports.stageCounts(this.repo),
    });
  }

  application(jobId: string): ApiResult<ApplicationBody> {
    const detail = JOB_ID.test(jobId) ? reports.applicationDetail(this.repo, jobId) : null;
    if (!detail) throw new ApiError(404, "No such application");
    return ok({ ...detail, hasEvidence: this.findEvidence(jobId) !== null, codeHold: codeHoldView(this.repo, jobId, this.clock()) });
  }

  /** Where an application held for an emailed code stands: the dashboard polls this while it moves. */
  codeHold(jobId: string): ApiResult<CodeHoldBody> {
    if (!JOB_ID.test(jobId) || !this.repo.getJob(jobId)) throw new ApiError(404, "No such application");
    return ok({ codeHold: codeHoldView(this.repo, jobId, this.clock()) });
  }

  /** "I'm ready", Approve or "Not now" on an application held for an emailed code. */
  codeAction(jobId: string, body: JsonObject): ApiResult<CodeHoldBody> {
    actOnCode(this.repo, jobId, body, this.clock());
    return this.codeHold(jobId);
  }

  /** Classify a listing without saving it. */
  checkEligibility(body: JsonObject): ApiResult<EligibilityCheckBody> {
    const { config } = this.load();
    return ok({ report: reportBody(evaluateRemoteEligibility(jobFromForm(body), config.compensation)) });
  }

  /** Track a listing typed in by hand: classify it and route it by tier. */
  addApplication(body: JsonObject): ApiResult<AddApplicationBody> {
    const { config } = this.load();
    const job = jobFromForm(body);
    const existing = this.repo.findTrackedJobId(job);
    if (existing) return ok({ duplicate: true, jobId: existing });
    const report = qualifyJob(this.repo, job, config.compensation);
    return { status: 201, body: { duplicate: false, jobId: job.id, report: reportBody(report) } };
  }

  /** Qualify or disqualify a Tier 2 job the investigation is still open on. */
  resolveInvestigation(jobId: string, body: JsonObject): ApiResult<ApplicationBody> {
    decideInvestigation(this.repo, jobId, body);
    return this.application(jobId);
  }

  /** Approve, decline, retry or mark as sent the job's draft. */
  draftAction(jobId: string, body: JsonObject): ApiResult<ApplicationBody> {
    actOnDraft(this.repo, jobId, body, this.clock());
    return this.application(jobId);
  }

  /** Record a response, interview, offer, accepted engagement or rejection. */
  recordOutcome(jobId: string, body: JsonObject): ApiResult<ApplicationBody> {
    addOutcome(this.repo, jobId, body, this.clock());
    return { status: 201, body: this.application(jobId).body };
  }

  /**
   * The screenshot of the job's confirmation page, if one was kept: only ever
   * `<evidence dir>/<job id>.png`, a real PNG file that lives in that directory.
   */
  private findEvidence(jobId: string): string | null {
    if (!JOB_ID.test(jobId)) return null;
    try {
      const root = fs.realpathSync(this.evidenceDir);
      // Resolving links first means a link planted under the right name cannot lead elsewhere.
      const file = fs.realpathSync(path.join(root, `${jobId}.png`));
      if (file !== path.join(root, `${jobId}.png`) || !fs.statSync(file).isFile()) return null;
      const head = Buffer.alloc(PNG_SIGNATURE.length);
      const handle = fs.openSync(file, "r");
      try {
        fs.readSync(handle, head, 0, head.length, 0);
      } finally {
        fs.closeSync(handle);
      }
      return head.equals(PNG_SIGNATURE) ? file : null;
    } catch {
      // No evidence directory, no such file, or not readable: all mean "nothing to show".
      return null;
    }
  }

  /** The path of the job's confirmation screenshot. Throws 404 when there is none to serve. */
  evidenceFile(jobId: string): string {
    const file = JOB_ID.test(jobId) && this.repo.getJob(jobId) ? this.findEvidence(jobId) : null;
    if (!file) throw new ApiError(404, "No confirmation screenshot was kept for this application");
    return file;
  }

  // ---------- Activity & quarantine ----------

  activity(query: Query): ApiResult<ActivityBody> {
    const requested = query.limit ?? "200";
    if (!/^\s*[+-]?\d+\s*$/.test(requested)) throw new ApiError(400, "'limit' must be a number");
    const limit = Math.max(1, Math.min(Number(requested), 1000));
    return ok({ events: reports.activity(this.repo, { limit, kind: query.kind ?? "" }) });
  }

  quarantine(query: Query): ApiResult<QuarantineBody> {
    const status = query.status ?? "pending";
    if (status !== "pending" && status !== "reviewed" && status !== "all") {
      throw new ApiError(400, "'status' must be pending, reviewed or all");
    }
    return ok({
      holds: reports.quarantineHolds(this.repo, { status: status === "all" ? "" : status }),
      pending: reports.pendingCounts(this.repo).quarantine,
    });
  }

  /** Mark every finding of a held draft as seen by the user. */
  reviewQuarantine(body: JsonObject): ApiResult<ReviewBody> {
    if (!this.repo.markQuarantineReviewed(itemIds(body))) {
      throw new ApiError(404, "No pending quarantined item with those ids");
    }
    return ok({ ok: true });
  }

  /** Send a held draft's job back to drafting, after storing any answers the user gave. */
  retryQuarantine(body: JsonObject): ApiResult<RetryBody> {
    return ok({ ok: true, ...retryHold(this.repo, body) });
  }

  // ---------- Standing answers ----------

  answers(): ApiResult<AnswersBody> {
    return ok({ answers: this.repo.listStandingAnswers() });
  }

  saveAnswer(body: JsonObject): ApiResult<AnswersBody> {
    putAnswer(this.repo, body);
    return this.answers();
  }

  deleteAnswer(body: JsonObject): ApiResult<AnswersBody> {
    removeAnswer(this.repo, body);
    return this.answers();
  }

  // ---------- Costs ----------

  costs(): ApiResult<CostsBody> {
    const { config } = this.load();
    const byModel = reports.spendByModel(this.repo);
    return ok({
      budget: this.budget(config),
      byModel,
      allTimeUsd: Math.round(byModel.reduce((sum, row) => sum + row.costUsd, 0) * 1e6) / 1e6,
      daily: reports.dailySpend(this.repo, COST_HISTORY_DAYS, config.budget.day_utc_offset_hours, this.clock()),
      recent: reports.recentCalls(this.repo, 100),
    });
  }
}
