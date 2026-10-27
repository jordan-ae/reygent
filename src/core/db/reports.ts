/**
 * Read-only views over the database for the web console.
 *
 * Everything here returns plain camelCase objects ready for JSON. Nothing writes.
 */

import { type Repository, toIso } from "@/core/db/repository";
import {
  B2B_INVESTIGATION,
  Channel,
  DraftStatus,
  type EligibilityReport,
  type FitEvaluation,
  type JobOpportunity,
  NEEDS_CODE,
  PipelineStage,
  type StoredDraft,
  sentByHand,
} from "@/core/models";
import { NEEDS_HUMAN } from "@/core/qualification/investigator";
import { cleanText } from "@/core/text";

const BREAKER_STATE_KEY = "circuit_breaker";
/**
 * The inspector joins a rule's critiques as "[field] message; [field] message". Splitting
 * only before a "[field] " marker keeps a critique that itself contains "; " in one piece.
 * Field names are snake_case in databases written by the Python version and camelCase now.
 */
const CRITIQUE_SPLIT = /; (?=\[[A-Za-z_]+(?:\[\d+\])?\] )/;
const JOB_COLUMNS = "j.id AS job_id, j.company, j.title";

/** The Cop Tool rule that judges answers to a form's questions. */
const SCREENING_RULE = "2_screening_sanity";
/** A critique of one form answer names it by its position in the draft. */
const ANSWER_FIELD = /^\[(?:screeningAnswers|screening_answers)\[(\d+)\]\] /;
/** Critiques that the candidate clears by answering the question themselves. */
const NEEDS_AN_ANSWER =
  /could not be answered from your data|is not supported by your data|needs an answer from you|is not one of the offered options/;

type Row = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

// ---------- Shapes ----------

export type StageCounts = Record<string, number>;

export interface PendingCounts {
  /** Drafts held by the Cop Tool that the user has not reviewed. */
  quarantine: number;
  /** Jobs queued for the pipeline's own B2B investigation. */
  investigation: number;
  /** Investigations the pipeline could not settle; they stay put until the user decides. */
  needsDecision: number;
  /** Applications the operator handed off (a login, a CAPTCHA, a form it could not finish). */
  needsAttention: number;
  /** Of those, the ones held for a code the site emails: "I'm ready", then Approve. */
  needsCode: number;
  /** Drafts that passed the Cop Tool and wait for the user's approval. */
  awaitingReview: number;
  /** Approved pitches with no form to fill: nothing sends them but the user. */
  toSend: number;
}

export interface ApplicationSummary {
  id: string;
  company: string;
  title: string;
  location: string | null;
  source: string;
  channel: string;
  stage: string;
  employmentType: string | null;
  compMin: number | null;
  compMax: number | null;
  compPeriod: string | null;
  compCurrency: string | null;
  createdAt: string;
  updatedAt: string;
  /** null until the listing has been classified. */
  tier: string | null;
  reasonCodes: string[];
  /** Pending holds on this job. */
  held: number;
}

export interface ApplicationJob extends ApplicationSummary {
  sourceId: string;
  applyUrl: string | null;
  companyDomain: string | null;
  postedAt: string | null;
  isRemote: boolean | null;
  skills: string[];
  /** Listing text with markup stripped. Still untrusted: render as text only. */
  description: string;
}

export type EvaluationSummary = Omit<EligibilityReport, "jobId">;
export type FitSummary = Omit<FitEvaluation, "jobId">;

/** What a draft says, in one fixed shape whichever version of Reygent stored it. */
export interface DraftContent {
  channel: string;
  positioningProfileId: string;
  pitch: string;
  cvBullets: Array<{ text: string; achievementId: string }>;
  /** One entry per form question, in the form's order. */
  screeningAnswers: Array<{ question: string; answer: string; options: string[] }>;
  resumePdfPath: string;
  quotedRateUsd: number | null;
  quotedRatePeriod: string;
  contact: string;
  /** How the attached CV lines up with the listing, when it was tuned to it; null when the CV went as it is. */
  cvMatch: { headline: string; asked: string[]; matched: string[]; missing: string[]; pages: number } | null;
  /** The summary written for this listing's CV; "" when the candidate's own summary is printed. */
  cvSummary: string;
}

export type HeldDraft = DraftContent;

/** A draft that passed the Cop Tool, and where it stands. */
export interface DraftView {
  id: number;
  status: string;
  /** Why the operator handed it off, when it did. */
  note: string;
  copRetries: number;
  createdAt: string;
  updatedAt: string;
  content: DraftContent;
}

export interface QuarantineFinding {
  rule: string;
  critiques: string[];
}

/** A form question a held draft is waiting on the candidate for. */
export interface HoldQuestion {
  question: string;
  /** The form's choices; empty for a free-text question. */
  options: string[];
  /** What the AI answered, when it did but the answer could not be verified; otherwise "". */
  answer: string;
  reason: "unanswered" | "unverified";
}

export interface QuarantineHold {
  /** One quarantined_items row per violated rule. */
  ids: number[];
  jobId: string;
  company: string | null;
  title: string | null;
  createdAt: string;
  retryCount: number;
  status: "pending" | "reviewed";
  /** null when the stored draft could not be read. */
  draft: HeldDraft | null;
  findings: QuarantineFinding[];
  questions: HoldQuestion[];
  /** Whether the job can be sent back to drafting: the hold is pending and the job still held. */
  canRetry: boolean;
}

export interface CallRecord {
  id: number;
  timestamp: string;
  provider: string;
  model: string;
  taskType: string;
  promptTokens: number;
  completionTokens: number;
  costUsd: number;
  latencyMs: number;
  outcome: string;
}

interface EventOf<Kind extends string, Detail> {
  at: string;
  kind: Kind;
  jobId: string | null;
  company: string | null;
  title: string | null;
  detail: Detail;
}

export type ActivityEvent =
  | EventOf<"discovered", { source: string; channel: string }>
  | EventOf<"evaluated", { tier: string; reasonCodes: string[]; summary: string | null }>
  | EventOf<"queued", { taskType: string; status: string; summary: string | null }>
  | EventOf<"drafted", { status: string; note: string; copRetries: number }>
  | EventOf<"quarantined", { rules: string[]; retryCount: number; status: string }>
  | EventOf<"dispatched", { channel: string; domain: string; contact: string }>
  | EventOf<"outcome", { outcome: string; note: string; monthlyValueUsd: number | null; channel: string }>
  | EventOf<"llm_call", CallRecord>
  | EventOf<"breaker", { spentUsd: number | null; day: string | null }>;

export type ActivityKind = ActivityEvent["kind"];

export interface DispatchSummary {
  channel: string;
  domain: string;
  contact: string;
  dispatchedAt: string;
}

export interface OutcomeSummary {
  kind: string;
  note: string;
  monthlyValueUsd: number | null;
  channel: string;
  recordedAt: string;
}

/** What the user can do to an application in its current state. */
export type ApplicationAction = "qualify" | "disqualify" | "approve" | "decline" | "submitted" | "retry" | "outcome";

export interface ApplicationDetail {
  job: ApplicationJob;
  evaluation: EvaluationSummary | null;
  /** null until the job has been scored. */
  fit: FitSummary | null;
  /** The latest draft that passed the Cop Tool, if any. */
  draft: DraftView | null;
  /** No form exists for the operator to fill, so the user sends the pitch. */
  sentByHand: boolean;
  actions: ApplicationAction[];
  quarantine: QuarantineHold[];
  dispatches: DispatchSummary[];
  outcomes: OutcomeSummary[];
  activity: ActivityEvent[];
}

export interface ModelSpend {
  provider: string;
  model: string;
  calls: number;
  promptTokens: number;
  completionTokens: number;
  costUsd: number;
  avgLatencyMs: number;
}

export interface DailySpend {
  /** Budget day, YYYY-MM-DD. */
  day: string;
  costUsd: number;
  calls: number;
}

// ---------- Counts ----------

/** Number of jobs in every pipeline stage (zero-filled). */
export function stageCounts(repo: Repository): StageCounts {
  const counts: StageCounts = Object.fromEntries(Object.values(PipelineStage).map((stage) => [stage, 0]));
  for (const row of repo.query<{ stage: string; n: number }>("SELECT stage, COUNT(*) AS n FROM jobs GROUP BY stage")) {
    counts[row.stage] = row.n;
  }
  return counts;
}

export { sentByHand };

/** Everything that is waiting: on the pipeline's next cycle, or on the user. */
export function pendingCounts(repo: Repository): PendingCounts {
  const count = (sql: string, params: readonly string[] = []): number => repo.query<{ n: number }>(sql, params)[0].n;
  const inStage = (stage: PipelineStage): number => count("SELECT COUNT(*) AS n FROM jobs WHERE stage = ?", [stage]);
  // Decided by the same predicate the apply step uses, row by row: there are never many approved jobs.
  const approved = repo.query<{ channel: Channel; apply_url: string | null; source: string }>(
    "SELECT channel, apply_url, source FROM jobs WHERE stage = ?", [PipelineStage.APPROVED],
  );
  return {
    quarantine: count(
      "SELECT COUNT(*) AS n FROM (SELECT 1 FROM quarantined_items WHERE status = 'pending' GROUP BY job_id, created_at)",
    ),
    investigation: count("SELECT COUNT(*) AS n FROM pipeline_tasks WHERE status = 'pending'"),
    needsDecision: count(
      `SELECT COUNT(*) AS n FROM pipeline_tasks t JOIN jobs j ON j.id = t.job_id
       WHERE t.task_type = ? AND t.status = ? AND j.stage = ?`,
      [B2B_INVESTIGATION, NEEDS_HUMAN, PipelineStage.INVESTIGATING],
    ),
    needsAttention: inStage(PipelineStage.NEEDS_ATTENTION),
    needsCode: count(
      `SELECT COUNT(*) AS n FROM application_drafts d JOIN jobs j ON j.id = d.job_id
       WHERE d.status = ? AND j.stage = ? AND substr(d.note, 1, ${NEEDS_CODE.length}) = ?`,
      [DraftStatus.NEEDS_ATTENTION, PipelineStage.NEEDS_ATTENTION, NEEDS_CODE],
    ),
    awaitingReview: inStage(PipelineStage.AWAITING_REVIEW),
    toSend: approved.filter((row) => sentByHand({ channel: row.channel, applyUrl: row.apply_url ?? "", source: row.source })).length,
  };
}

// ---------- Applications ----------

const APPLICATION_SQL = `
  SELECT j.*, e.eligibility_tier, e.reason_codes_json,
         (SELECT COUNT(DISTINCT q.created_at) FROM quarantined_items q
           WHERE q.job_id = j.id AND q.status = 'pending') AS held
  FROM jobs j LEFT JOIN job_evaluations e ON e.job_id = j.id
`;

const stringList = (json: string | null): string[] => JSON.parse(json || "[]");

function applicationFromRow(row: Row): ApplicationSummary {
  return {
    id: row.id, company: row.company, title: row.title, location: row.location, source: row.source,
    channel: row.channel, stage: row.stage, employmentType: row.employment_type, compMin: row.comp_min,
    compMax: row.comp_max, compPeriod: row.comp_period, compCurrency: row.comp_currency,
    createdAt: row.created_at, updatedAt: row.updated_at, tier: row.eligibility_tier ?? null,
    reasonCodes: stringList(row.reason_codes_json), held: row.held,
  };
}

/** Tracked jobs with their eligibility tier, most recently touched first. */
export function listApplications(
  repo: Repository,
  filter: { stage?: string; tier?: string; search?: string; limit?: number } = {},
): ApplicationSummary[] {
  const clauses: string[] = [];
  const params: Array<string | number> = [];
  if (filter.stage) {
    clauses.push("j.stage = ?");
    params.push(filter.stage);
  }
  if (filter.tier) {
    clauses.push("e.eligibility_tier = ?");
    params.push(filter.tier);
  }
  if (filter.search) {
    // The search is literal text: % and _ must not act as LIKE wildcards.
    const escaped = filter.search.replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_");
    clauses.push("(j.company LIKE ? ESCAPE '\\' OR j.title LIKE ? ESCAPE '\\' OR j.location LIKE ? ESCAPE '\\')");
    params.push(`%${escaped}%`, `%${escaped}%`, `%${escaped}%`);
  }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  return repo
    .query(`${APPLICATION_SQL} ${where} ORDER BY j.updated_at DESC LIMIT ?`, [...params, filter.limit ?? 500])
    .map(applicationFromRow);
}

/**
 * What the user can do to a job as it stands. The same list decides which buttons the
 * console shows and which requests the API accepts, so the two cannot disagree.
 */
export function availableActions(
  job: Pick<JobOpportunity, "stage" | "channel" | "applyUrl"> & { source?: string },
  draft: Pick<StoredDraft, "status"> | null,
): ApplicationAction[] {
  if (job.stage === PipelineStage.INVESTIGATING) return ["qualify", "disqualify"];
  if (job.stage === PipelineStage.SUBMITTED) return ["outcome"];
  // A draft and its job always move together; if they disagree, another process is mid-change.
  if (!draft || draft.status !== job.stage) return [];
  switch (draft.status) {
    case DraftStatus.AWAITING_REVIEW:
      return ["approve", "decline"];
    case DraftStatus.APPROVED:
      // With a form, the pipeline submits it; all the user can do is call it off.
      return sentByHand(job) ? ["submitted", "decline"] : ["decline"];
    case DraftStatus.NEEDS_ATTENTION:
      return ["submitted", "retry", "decline"];
    default:
      return [];
  }
}

/** Everything known about one job: listing, evaluation, fit, draft, holds, dispatches, outcomes and history. */
export function applicationDetail(repo: Repository, jobId: string): ApplicationDetail | null {
  const row = repo.query(`${APPLICATION_SQL} WHERE j.id = ?`, [jobId])[0];
  if (!row) return null;
  const evaluation = repo.getEvaluation(jobId);
  const fit = repo.getFit(jobId);
  const stored = repo.latestDraftForJob(jobId);
  const content = stored && draftContent(stored.draft);
  const routing = {
    stage: row.stage as PipelineStage, channel: row.channel as Channel, applyUrl: row.apply_url ?? "", source: row.source as string,
  };
  return {
    job: {
      ...applicationFromRow(row),
      sourceId: row.source_id, applyUrl: row.apply_url, companyDomain: row.company_domain,
      postedAt: row.posted_at, isRemote: row.is_remote === null ? null : Boolean(row.is_remote),
      skills: stringList(row.skills_json), description: cleanText(row.description),
    },
    evaluation: evaluation && {
      tier: evaluation.tier, summary: evaluation.summary, reasonCodes: evaluation.reasonCodes,
      positiveSignals: evaluation.positiveSignals, disqualifiers: evaluation.disqualifiers,
      needsB2bInvestigation: evaluation.needsB2bInvestigation,
    },
    fit: fit && {
      fitScore: fit.fitScore, bestPositioningProfile: fit.bestPositioningProfile,
      matchedSkills: fit.matchedSkills, missingSkills: fit.missingSkills,
    },
    draft: stored && content && {
      id: stored.id, status: stored.status, note: stored.note, copRetries: stored.copRetries,
      createdAt: stored.createdAt, updatedAt: stored.updatedAt, content,
    },
    sentByHand: sentByHand(routing),
    actions: availableActions(routing, stored),
    quarantine: quarantineHolds(repo, { status: "", jobId }),
    dispatches: repo.listDispatches(jobId).map((sent) => ({
      channel: sent.channel, domain: sent.domain, contact: sent.contact, dispatchedAt: sent.dispatchedAt,
    })),
    outcomes: repo.listOutcomes(jobId).map((outcome) => ({
      kind: outcome.kind, note: outcome.note, monthlyValueUsd: outcome.monthlyValueUsd,
      channel: outcome.channel, recordedAt: outcome.recordedAt,
    })),
    activity: activity(repo, { limit: 200, jobId }),
  };
}

// ---------- Drafts & quarantine ----------

const text = (value: unknown): string => (typeof value === "string" ? value : value == null ? "" : String(value));
const isRecord = (value: unknown): value is Row => value !== null && typeof value === "object" && !Array.isArray(value);
const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

/**
 * A draft in one fixed shape, or null when it is not a draft at all.
 *
 * Drafts are JSON written by whichever version stored them: camelCase from this
 * implementation, snake_case from the original Python one. Both are read.
 */
function draftContent(raw: unknown): DraftContent | null {
  if (!isRecord(raw)) return null;
  const rate = raw.quotedRateUsd ?? raw.quoted_rate_usd;
  return {
    channel: text(raw.channel),
    positioningProfileId: text(raw.positioningProfileId ?? raw.positioning_profile_id),
    pitch: text(raw.pitch),
    cvBullets: list(raw.cvBullets ?? raw.cv_bullets).filter(isRecord).map((bullet) => ({
      text: text(bullet.text), achievementId: text(bullet.achievementId ?? bullet.achievement_id),
    })),
    // Mapped, never filtered: critiques name an answer by its position in this list.
    screeningAnswers: list(raw.screeningAnswers ?? raw.screening_answers).map((entry) => {
      const answer = isRecord(entry) ? entry : {};
      return { question: text(answer.question), answer: text(answer.answer), options: list(answer.options).map(text) };
    }),
    resumePdfPath: text(raw.resumePdfPath ?? raw.resume_pdf_path),
    quotedRateUsd: typeof rate === "number" ? rate : null,
    quotedRatePeriod: text(raw.quotedRatePeriod ?? raw.quoted_rate_period),
    contact: text(raw.contact),
    cvMatch: isRecord(raw.cvMatch)
      ? {
          headline: text(raw.cvMatch.headline),
          asked: list(raw.cvMatch.asked).map(text),
          matched: list(raw.cvMatch.matched).map(text),
          missing: list(raw.cvMatch.missing).map(text),
          pages: typeof raw.cvMatch.pages === "number" ? raw.cvMatch.pages : 0,
        }
      : null,
    cvSummary: text(raw.cvSummary),
  };
}

function heldDraft(stored: string): HeldDraft | null {
  try {
    return draftContent(JSON.parse(stored));
  } catch {
    return null;
  }
}

/**
 * The form questions a held draft needs the candidate to answer: ones the AI could not
 * answer from their data, and ones it answered without being able to verify the answer.
 */
function holdQuestions(draft: HeldDraft | null, findings: readonly QuarantineFinding[]): HoldQuestion[] {
  if (!draft) return [];
  const byPosition = new Map<number, HoldQuestion>();
  for (const critique of findings.filter((finding) => finding.rule === SCREENING_RULE).flatMap((f) => f.critiques)) {
    const position = Number(ANSWER_FIELD.exec(critique)?.[1] ?? Number.NaN);
    const item = draft.screeningAnswers[position];
    if (!item?.question || !NEEDS_AN_ANSWER.test(critique)) continue;
    const blank = !item.answer.trim();
    // Only an answer the form could actually take is offered back for the candidate to confirm.
    const usable = !blank && (item.options.length === 0 || item.options.includes(item.answer));
    byPosition.set(position, {
      question: item.question, options: item.options, answer: usable ? item.answer : "",
      reason: blank ? "unanswered" : "unverified",
    });
  }
  return [...byPosition.entries()].sort(([a], [b]) => a - b).map(([, question]) => question);
}

/**
 * Drafts held by the Cop Tool, newest first.
 *
 * The inspector writes one row per violated rule; rows from the same inspection share a
 * job and timestamp and are returned here as a single hold with several findings.
 * `status` is "pending", "reviewed" or "" for both.
 */
export function quarantineHolds(
  repo: Repository,
  filter: { status?: "pending" | "reviewed" | ""; jobId?: string } = {},
): QuarantineHold[] {
  const status = filter.status ?? "pending";
  const rows = repo.query(
    `SELECT q.*, j.company, j.title, j.stage AS job_stage FROM quarantined_items q LEFT JOIN jobs j ON j.id = q.job_id
     ${filter.jobId ? "WHERE q.job_id = ?" : ""} ORDER BY q.created_at DESC, q.id`,
    filter.jobId ? [filter.jobId] : [],
  );
  const holds = new Map<string, QuarantineHold & { jobStage: string | null }>();
  for (const row of rows) {
    const key = `${row.job_id}\u0000${row.created_at}`;
    let hold = holds.get(key);
    if (!hold) {
      hold = {
        ids: [], jobId: row.job_id, company: row.company, title: row.title, createdAt: row.created_at,
        retryCount: row.retry_count, status: "reviewed", draft: heldDraft(row.original_content), findings: [],
        questions: [], canRetry: false, jobStage: row.job_stage,
      };
      holds.set(key, hold);
    }
    hold.ids.push(row.id);
    hold.findings.push({ rule: row.violation_rule, critiques: String(row.critique).split(CRITIQUE_SPLIT) });
    // A hold stays pending until every one of its findings has been reviewed.
    if (row.status === "pending") hold.status = "pending";
  }
  return [...holds.values()]
    .filter((hold) => !status || hold.status === status)
    .map(({ jobStage, ...hold }) => ({
      ...hold,
      questions: holdQuestions(hold.draft, hold.findings),
      canRetry: hold.status === "pending" && jobStage === PipelineStage.QUARANTINED,
    }));
}

// ---------- Activity ----------

/**
 * Everything the agent has done, newest first, merged from every table that records an action.
 *
 * `kind` is one of discovered, evaluated, queued, drafted, quarantined, dispatched,
 * outcome, llm_call, breaker.
 */
export function activity(
  repo: Repository,
  filter: { limit?: number; kind?: string; jobId?: string } = {},
): ActivityEvent[] {
  const limit = filter.limit ?? 200;
  const { kind = "", jobId = "" } = filter;
  const events: ActivityEvent[] = [];
  const wanted = (name: ActivityKind): boolean => !kind || kind === name;
  const jobFilter = (column: string): string => (jobId ? `WHERE ${column} = ?` : "");
  const params = jobId ? [jobId, limit] : [limit];
  const subject = (row: Row) => ({ at: row.at as string, jobId: row.job_id, company: row.company, title: row.title });

  if (wanted("discovered")) {
    for (const row of repo.query(
      `SELECT ${JOB_COLUMNS}, j.created_at AS at, j.source, j.channel FROM jobs j
       ${jobFilter("j.id")} ORDER BY at DESC LIMIT ?`,
      params,
    )) {
      events.push({ ...subject(row), kind: "discovered", detail: { source: row.source, channel: row.channel } });
    }
  }
  if (wanted("evaluated")) {
    for (const row of repo.query(
      `SELECT ${JOB_COLUMNS}, e.evaluated_at AS at, e.eligibility_tier, e.reason_codes_json, e.summary
       FROM job_evaluations e JOIN jobs j ON j.id = e.job_id ${jobFilter("e.job_id")} ORDER BY at DESC LIMIT ?`,
      params,
    )) {
      events.push({
        ...subject(row), kind: "evaluated",
        detail: { tier: row.eligibility_tier, reasonCodes: stringList(row.reason_codes_json), summary: row.summary },
      });
    }
  }
  if (wanted("queued")) {
    for (const row of repo.query(
      `SELECT ${JOB_COLUMNS}, t.created_at AS at, t.task_type, t.status, t.detail
       FROM pipeline_tasks t JOIN jobs j ON j.id = t.job_id ${jobFilter("t.job_id")} ORDER BY at DESC LIMIT ?`,
      params,
    )) {
      events.push({
        ...subject(row), kind: "queued",
        detail: { taskType: row.task_type, status: row.status, summary: row.detail },
      });
    }
  }
  if (wanted("drafted")) {
    // One event per draft, at the moment it passed the Cop Tool, showing where it stands now.
    for (const row of repo.query(
      `SELECT ${JOB_COLUMNS}, d.created_at AS at, d.status, d.note, d.cop_retries
       FROM application_drafts d JOIN jobs j ON j.id = d.job_id ${jobFilter("d.job_id")} ORDER BY at DESC LIMIT ?`,
      params,
    )) {
      events.push({
        ...subject(row), kind: "drafted",
        detail: { status: row.status, note: row.note ?? "", copRetries: row.cop_retries },
      });
    }
  }
  if (wanted("quarantined")) {
    for (const hold of quarantineHolds(repo, { status: "", jobId }).slice(0, limit)) {
      events.push({
        at: hold.createdAt, kind: "quarantined", jobId: hold.jobId, company: hold.company, title: hold.title,
        detail: { rules: hold.findings.map((finding) => finding.rule), retryCount: hold.retryCount, status: hold.status },
      });
    }
  }
  if (wanted("dispatched")) {
    for (const row of repo.query(
      `SELECT d.job_id, j.company, j.title, d.dispatched_at AS at, d.channel, d.domain, d.contact
       FROM dispatch_log d LEFT JOIN jobs j ON j.id = d.job_id ${jobFilter("d.job_id")} ORDER BY at DESC LIMIT ?`,
      params,
    )) {
      events.push({
        ...subject(row), kind: "dispatched",
        detail: { channel: row.channel, domain: row.domain, contact: row.contact },
      });
    }
  }
  if (wanted("outcome")) {
    for (const row of repo.query(
      `SELECT o.job_id, j.company, j.title, o.recorded_at AS at, o.kind, o.note, o.monthly_value_usd, o.channel
       FROM outcomes o LEFT JOIN jobs j ON j.id = o.job_id ${jobFilter("o.job_id")} ORDER BY at DESC LIMIT ?`,
      params,
    )) {
      events.push({
        ...subject(row), kind: "outcome",
        detail: { outcome: row.kind, note: row.note ?? "", monthlyValueUsd: row.monthly_value_usd, channel: row.channel },
      });
    }
  }
  // Paid calls and the breaker belong to no single job, so a job's history leaves them out.
  if (!jobId && wanted("llm_call")) {
    for (const call of recentCalls(repo, limit)) {
      events.push({ at: call.timestamp, kind: "llm_call", jobId: null, company: null, title: null, detail: call });
    }
  }
  if (!jobId && wanted("breaker")) {
    const state = repo.getState<{ day?: string; tripped_at?: string; spent_usd?: number }>(BREAKER_STATE_KEY);
    if (state?.tripped_at) {
      events.push({
        at: state.tripped_at, kind: "breaker", jobId: null, company: null, title: null,
        detail: { spentUsd: state.spent_usd ?? null, day: state.day ?? null },
      });
    }
  }
  // Timestamps are fixed-width UTC ISO strings, so text order is time order.
  events.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
  return events.slice(0, limit);
}

// ---------- Costs ----------

/** The latest paid calls, newest first. */
export function recentCalls(repo: Repository, limit = 100): CallRecord[] {
  return repo
    .query("SELECT * FROM cost_telemetry ORDER BY timestamp DESC, id DESC LIMIT ?", [limit])
    .map((row) => ({
      id: row.id, timestamp: row.timestamp, provider: row.provider, model: row.model, taskType: row.task_type,
      promptTokens: row.prompt_tokens, completionTokens: row.completion_tokens, costUsd: row.cost_usd,
      latencyMs: row.latency_ms, outcome: row.outcome,
    }));
}

/** Calls, tokens and spend per provider and model, all time, costliest first. */
export function spendByModel(repo: Repository): ModelSpend[] {
  return repo.spendBreakdown();
}

/** Spend and call count for each of the last `days` budget days (zero-filled, oldest first). */
export function dailySpend(repo: Repository, days: number, utcOffsetHours: number, now: Date): DailySpend[] {
  const offsetMs = utcOffsetHours * 3_600_000;
  // Shifting the instant by the offset lets the UTC getters read the budget-local calendar date.
  const local = new Date(now.getTime() + offsetMs);
  const dayMs = (index: number): number =>
    Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate() - (days - 1) + index);
  const rows = repo.query<{ day: string; cost_usd: number; calls: number }>(
    `SELECT date(substr(timestamp, 1, 19), ?) AS day, SUM(cost_usd) AS cost_usd, COUNT(*) AS calls
     FROM cost_telemetry WHERE timestamp >= ? GROUP BY day`,
    [`${utcOffsetHours >= 0 ? "+" : ""}${utcOffsetHours} hours`, toIso(new Date(dayMs(0) - offsetMs))],
  );
  const byDay = new Map(rows.map((row) => [row.day, row]));
  return Array.from({ length: days }, (_, index) => {
    const day = new Date(dayMs(index)).toISOString().slice(0, 10);
    const row = byDay.get(day);
    return { day, costUsd: row ? Math.round(row.cost_usd * 1e6) / 1e6 : 0, calls: row ? row.calls : 0 };
  });
}
