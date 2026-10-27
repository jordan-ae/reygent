/**
 * Repository over the Reygent SQLite database.
 *
 * Every method is synchronous. Composite operations run inside `transaction()`, which
 * takes the write lock up front (BEGIN IMMEDIATE), so they are atomic even when the
 * web console and the daemon share one database file. Never `await` inside a
 * transaction callback.
 */

import { createHash } from "node:crypto";
import type { DatabaseSync, SQLInputValue } from "node:sqlite";

import { openDatabase } from "@/core/db/schema";
import {
  type Achievement,
  type ApplicationDraft,
  type CandidateProfile,
  type Channel,
  type CostTelemetry,
  type DispatchRecord,
  type DraftStatus,
  type EligibilityReport,
  type EligibilityTier,
  type FitEvaluation,
  type JobOpportunity,
  type Outcome,
  type OutcomeKind,
  type PipelineTask,
  type PositioningProfile,
  type QuarantinedItem,
  type StandingAnswer,
  type StoredDraft,
  AGGREGATOR_SOURCES,
  COMPANY_BOARD_SOURCES,
  OutcomeKind as Outcomes,
  PipelineStage,
} from "@/core/models";
import { questionKey, roleKey } from "@/core/text";

export const DEFAULT_CANDIDATE_ID = "default";

type Row = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
type Param = SQLInputValue | boolean | undefined;

/** A UTC instant in a fixed-width ISO format, so timestamps sort lexicographically. */
export function toIso(moment: Date): string {
  return moment.toISOString().replace("Z", "000+00:00");
}

export function utcNowIso(): string {
  return toIso(new Date());
}

/** Source-independent identity of a listing: the same role scraped twice collides. */
export function jobFingerprint(job: Pick<JobOpportunity, "company" | "title" | "location">): string {
  const key = [job.company, job.title, job.location]
    .map((part) => part.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim())
    .join("|");
  return createHash("sha1").update(key).digest("hex");
}

const list = (json: string | null): string[] => JSON.parse(json || "[]");

const AGGREGATORS = [...AGGREGATOR_SOURCES];
const IN_AGGREGATORS = `IN (${AGGREGATORS.map(() => "?").join(", ")})`;
/**
 * A tracked job nobody has acted on yet: qualification put it where it is, there is no
 * draft and nothing was sent, and the user has not ruled on it. Only such a job may give
 * way to a better copy of the same role.
 */
const UNTOUCHED = `
  j.stage IN ('discovered', 'qualified', 'investigating', 'disqualified')
  AND NOT EXISTS (SELECT 1 FROM application_drafts d WHERE d.job_id = j.id)
  AND NOT EXISTS (SELECT 1 FROM dispatch_log l WHERE l.job_id = j.id)
  AND NOT EXISTS (SELECT 1 FROM job_evaluations e WHERE e.job_id = j.id AND e.reason_codes_json LIKE '%BY_USER%')`;

export class Repository {
  readonly db: DatabaseSync;
  private depth = 0;

  constructor(dbPath: string) {
    this.db = openDatabase(dbPath);
  }

  close(): void {
    this.db.close();
  }

  /**
   * Atomic unit of work: commits on success, rolls everything back if `work` throws.
   * Re-entrant — a nested call joins the outer transaction.
   */
  transaction<T>(work: () => T): T {
    if (this.depth > 0) return work();
    this.db.exec("BEGIN IMMEDIATE");
    this.depth = 1;
    try {
      const result = work();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    } finally {
      this.depth = 0;
    }
  }

  private bind(params: readonly Param[]): SQLInputValue[] {
    return params.map((value) => (value === undefined ? null : typeof value === "boolean" ? Number(value) : value));
  }

  /** Run a read statement and return every row. */
  query<T = Row>(sql: string, params: readonly Param[] = []): T[] {
    return this.db.prepare(sql).all(...this.bind(params)) as T[];
  }

  /** Run a write statement. */
  run(sql: string, params: readonly Param[] = []): { changes: number; lastInsertRowid: number } {
    const result = this.db.prepare(sql).run(...this.bind(params));
    return { changes: Number(result.changes), lastInsertRowid: Number(result.lastInsertRowid) };
  }

  // ---------- Candidate fact bank ----------

  /** Replace the stored profile, achievements and positioning variants atomically. */
  saveProfile(profile: CandidateProfile): void {
    this.transaction(() => {
      this.run(
        `INSERT INTO candidate_profile (
           id, name, email, phone, location, timezone, work_authorization, notice_period,
           github_url, linkedin_url, portfolio_url, years_experience, employers_json, skills_json, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           name=excluded.name, email=excluded.email, phone=excluded.phone, location=excluded.location,
           timezone=excluded.timezone, work_authorization=excluded.work_authorization,
           notice_period=excluded.notice_period, github_url=excluded.github_url,
           linkedin_url=excluded.linkedin_url, portfolio_url=excluded.portfolio_url,
           years_experience=excluded.years_experience, employers_json=excluded.employers_json,
           skills_json=excluded.skills_json, updated_at=excluded.updated_at`,
        [
          profile.id, profile.name, profile.email, profile.phone, profile.location, profile.timezone,
          profile.workAuthorization, profile.noticePeriod, profile.githubUrl, profile.linkedinUrl,
          profile.portfolioUrl, profile.yearsExperience, JSON.stringify(profile.employers),
          JSON.stringify(profile.skills), utcNowIso(),
        ],
      );
      this.run("DELETE FROM achievements WHERE candidate_id = ?", [profile.id]);
      for (const a of profile.achievements) {
        this.run(
          `INSERT INTO achievements (
             id, candidate_id, category, headline, impact_metric, technologies_json, context,
             employer, evidence_url, positioning_json, verified
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            a.id, profile.id, a.category, a.headline, a.impactMetric, JSON.stringify(a.technologies),
            a.context, a.employer, a.evidenceUrl, JSON.stringify(a.positioning), a.verified,
          ],
        );
      }
      this.run("DELETE FROM positioning_profiles WHERE candidate_id = ?", [profile.id]);
      for (const p of Object.values(profile.positioning)) {
        this.run(
          `INSERT INTO positioning_profiles (
             id, candidate_id, title, target_summary, core_skills_json, highlighted_achievements_json, pitch_angle
           ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
          [
            p.id, profile.id, p.title, p.targetSummary, JSON.stringify(p.coreSkills),
            JSON.stringify(p.highlightedAchievements), p.pitchAngle,
          ],
        );
      }
    });
  }

  getProfile(candidateId: string = DEFAULT_CANDIDATE_ID): CandidateProfile | null {
    const row = this.query("SELECT * FROM candidate_profile WHERE id = ?", [candidateId])[0];
    if (!row) return null;
    const achievements: Achievement[] = this.query(
      "SELECT * FROM achievements WHERE candidate_id = ? ORDER BY rowid",
      [candidateId],
    ).map((a) => ({
      id: a.id, category: a.category ?? "", headline: a.headline, impactMetric: a.impact_metric ?? "",
      technologies: list(a.technologies_json), context: a.context ?? "", employer: a.employer ?? "",
      evidenceUrl: a.evidence_url ?? "", positioning: list(a.positioning_json), verified: Boolean(a.verified),
    }));
    const positioning: Record<string, PositioningProfile> = {};
    for (const p of this.query("SELECT * FROM positioning_profiles WHERE candidate_id = ? ORDER BY rowid", [candidateId])) {
      positioning[p.id] = {
        id: p.id, title: p.title, targetSummary: p.target_summary ?? "", coreSkills: list(p.core_skills_json),
        pitchAngle: p.pitch_angle ?? "", highlightedAchievements: list(p.highlighted_achievements_json),
      };
    }
    return {
      id: row.id, name: row.name, email: row.email, phone: row.phone ?? "", location: row.location ?? "",
      timezone: row.timezone ?? "", workAuthorization: row.work_authorization ?? "",
      noticePeriod: row.notice_period ?? "", githubUrl: row.github_url ?? "",
      linkedinUrl: row.linkedin_url ?? "", portfolioUrl: row.portfolio_url ?? "",
      yearsExperience: row.years_experience, employers: list(row.employers_json),
      skills: list(row.skills_json), achievements, positioning,
    };
  }

  // ---------- Jobs ----------

  /**
   * Insert a job once. Returns false when it is already tracked.
   *
   * Duplicates are rejected by the database itself — the same id, the same
   * (source, source_id), or the same company/title/location from another source —
   * so concurrent discovery runs cannot double-insert.
   *
   * The same role also reaches Reygent from job boards that word its location their own
   * way; `findTrackedJobId` recognises those. And when the company's own board lists a
   * role first tracked from a job board, the board's listing takes its place: its apply
   * URL is the real form and its location is the employer's own wording. The job board's
   * copy is removed only while nobody has acted on it, so the new one is qualified afresh.
   */
  insertJob(job: JobOpportunity): boolean {
    return this.transaction(() => {
      if (this.findTrackedJobId(job)) return false;
      const role = roleKey(job.company, job.title);
      if (COMPANY_BOARD_SOURCES.has(job.source)) {
        this.run(`DELETE FROM jobs AS j WHERE j.role_key = ? AND j.source ${IN_AGGREGATORS} AND ${UNTOUCHED}`, [role, ...AGGREGATORS]);
      }
      const now = utcNowIso();
      return (
        this.run(
          `INSERT OR IGNORE INTO jobs (
             id, source, source_id, company, title, location, description, apply_url, company_domain,
             channel, is_remote, employment_type, comp_min, comp_max, comp_period, comp_currency,
             skills_json, posted_at, stage, fingerprint, role_key, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            job.id, job.source, job.sourceId, job.company, job.title, job.location, job.description,
            job.applyUrl, job.companyDomain, job.channel, job.isRemote, job.employmentType, job.compMin,
            job.compMax, job.compPeriod, job.compCurrency, JSON.stringify(job.skills), job.postedAt,
            job.stage, jobFingerprint(job), role, now, now,
          ],
        ).changes === 1
      );
    });
  }

  /**
   * Id under which `job` (or the same role from another source) is already tracked.
   *
   * A job board's copy of a role is tracked as soon as any other source has that role.
   * A company board's listing is not held back by a job board's copy that nobody has
   * acted on (inserting it replaces that copy), but once the copy has a draft, a dispatch
   * or the user's ruling, the role is in hand and the listing counts as tracked.
   */
  findTrackedJobId(job: JobOpportunity): string | null {
    const row = this.query(
      "SELECT id FROM jobs WHERE id = ? OR (source = ? AND source_id = ?) OR fingerprint = ? LIMIT 1",
      [job.id, job.source, job.sourceId, jobFingerprint(job)],
    )[0];
    if (row) return row.id;
    const role = roleKey(job.company, job.title);
    if (AGGREGATOR_SOURCES.has(job.source)) {
      const other = this.query("SELECT id FROM jobs WHERE role_key = ? AND source <> ? LIMIT 1", [role, job.source])[0];
      return other ? other.id : null;
    }
    if (COMPANY_BOARD_SOURCES.has(job.source)) {
      const held = this.query(
        `SELECT j.id FROM jobs AS j WHERE j.role_key = ? AND j.source ${IN_AGGREGATORS} AND NOT (${UNTOUCHED}) LIMIT 1`,
        [role, ...AGGREGATORS],
      )[0];
      return held ? held.id : null;
    }
    return null;
  }

  /**
   * Make way for the employer's own listing of a role first tracked from a job site. The
   * job site's copy stays as a record, with whatever was written for it, but no longer
   * stands for the role: the employer's listing is tracked beside it, not taken for it.
   */
  releaseRole(jobId: string): void {
    this.run("UPDATE jobs SET role_key = '', fingerprint = ?, updated_at = ? WHERE id = ?", [
      `released:${jobId}`, utcNowIso(), jobId,
    ]);
  }

  getJob(jobId: string): JobOpportunity | null {
    const row = this.query("SELECT * FROM jobs WHERE id = ?", [jobId])[0];
    return row ? Repository.jobFromRow(row) : null;
  }

  listJobs(stage?: PipelineStage): JobOpportunity[] {
    const rows = stage
      ? this.query("SELECT * FROM jobs WHERE stage = ? ORDER BY created_at, rowid", [stage])
      : this.query("SELECT * FROM jobs ORDER BY created_at, rowid");
    return rows.map(Repository.jobFromRow);
  }

  setJobStage(jobId: string, stage: PipelineStage): void {
    this.run("UPDATE jobs SET stage = ?, updated_at = ? WHERE id = ?", [stage, utcNowIso(), jobId]);
  }

  static jobFromRow(row: Row): JobOpportunity {
    return {
      id: row.id, source: row.source, sourceId: row.source_id, company: row.company, title: row.title,
      location: row.location ?? "", description: row.description ?? "", applyUrl: row.apply_url ?? "",
      companyDomain: row.company_domain ?? "", channel: row.channel,
      isRemote: row.is_remote === null ? null : Boolean(row.is_remote),
      employmentType: row.employment_type ?? "", compMin: row.comp_min, compMax: row.comp_max,
      compPeriod: row.comp_period ?? "", compCurrency: row.comp_currency ?? "USD",
      skills: list(row.skills_json), postedAt: row.posted_at, stage: row.stage,
    };
  }

  // ---------- Evaluations ----------

  saveEvaluation(report: EligibilityReport): void {
    this.run(
      `INSERT INTO job_evaluations (
         job_id, eligibility_tier, reason_codes_json, positive_signals_json, disqualifiers_json,
         needs_b2b_investigation, summary, evaluated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(job_id) DO UPDATE SET
         eligibility_tier=excluded.eligibility_tier, reason_codes_json=excluded.reason_codes_json,
         positive_signals_json=excluded.positive_signals_json, disqualifiers_json=excluded.disqualifiers_json,
         needs_b2b_investigation=excluded.needs_b2b_investigation, summary=excluded.summary,
         evaluated_at=excluded.evaluated_at`,
      [
        report.jobId, report.tier, JSON.stringify(report.reasonCodes), JSON.stringify(report.positiveSignals),
        JSON.stringify(report.disqualifiers), report.needsB2bInvestigation, report.summary, utcNowIso(),
      ],
    );
  }

  getEvaluation(jobId: string): EligibilityReport | null {
    const row = this.query("SELECT * FROM job_evaluations WHERE job_id = ?", [jobId])[0];
    if (!row) return null;
    return {
      jobId: row.job_id, tier: row.eligibility_tier as EligibilityTier,
      reasonCodes: list(row.reason_codes_json), positiveSignals: list(row.positive_signals_json),
      disqualifiers: list(row.disqualifiers_json),
      needsB2bInvestigation: Boolean(row.needs_b2b_investigation), summary: row.summary ?? "",
    };
  }

  /** Attach a fit score to a job that already has an eligibility evaluation. */
  saveFit(fit: FitEvaluation): void {
    this.run(
      `UPDATE job_evaluations SET fit_score = ?, best_positioning_profile = ?, matched_skills_json = ?,
         missing_skills_json = ? WHERE job_id = ?`,
      [
        fit.fitScore, fit.bestPositioningProfile, JSON.stringify(fit.matchedSkills),
        JSON.stringify(fit.missingSkills), fit.jobId,
      ],
    );
  }

  getFit(jobId: string): FitEvaluation | null {
    const row = this.query("SELECT * FROM job_evaluations WHERE job_id = ? AND fit_score IS NOT NULL", [jobId])[0];
    if (!row) return null;
    return {
      jobId: row.job_id, fitScore: row.fit_score, bestPositioningProfile: row.best_positioning_profile ?? "",
      matchedSkills: list(row.matched_skills_json), missingSkills: list(row.missing_skills_json),
    };
  }

  // ---------- Task queue ----------

  /** Queue a task once per (taskType, job). Returns false when already queued. */
  enqueueTask(task: Pick<PipelineTask, "taskType" | "jobId"> & Partial<PipelineTask>): boolean {
    return (
      this.run(
        "INSERT OR IGNORE INTO pipeline_tasks (task_type, job_id, detail, status, created_at) VALUES (?, ?, ?, ?, ?)",
        [task.taskType, task.jobId, task.detail ?? "", task.status ?? "pending", utcNowIso()],
      ).changes === 1
    );
  }

  listTasks(taskType: string, status = "pending"): PipelineTask[] {
    return this.query(
      "SELECT * FROM pipeline_tasks WHERE task_type = ? AND status = ? ORDER BY id",
      [taskType, status],
    ).map((row) => ({
      id: row.id, taskType: row.task_type, jobId: row.job_id, detail: row.detail ?? "",
      status: row.status, createdAt: row.created_at,
    }));
  }

  setTaskStatus(taskType: string, jobId: string, status: string): void {
    this.run("UPDATE pipeline_tasks SET status = ? WHERE task_type = ? AND job_id = ?", [status, taskType, jobId]);
  }

  // ---------- Cost telemetry ----------

  recordTelemetry(entry: Partial<CostTelemetry> & Pick<CostTelemetry, "provider" | "model" | "taskType">): number {
    return this.run(
      `INSERT INTO cost_telemetry (
         timestamp, provider, model, prompt_tokens, completion_tokens, cost_usd, task_type, outcome, latency_ms
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        entry.timestamp || utcNowIso(), entry.provider, entry.model, entry.promptTokens ?? 0,
        entry.completionTokens ?? 0, entry.costUsd ?? 0, entry.taskType, entry.outcome ?? "ok",
        entry.latencyMs ?? 0,
      ],
    ).lastInsertRowid;
  }

  /** Replace a reserved entry's worst-case figures with what was actually billed. */
  settleTelemetry(
    entryId: number,
    settled: Pick<CostTelemetry, "promptTokens" | "completionTokens" | "costUsd" | "latencyMs" | "outcome">,
  ): void {
    this.run(
      `UPDATE cost_telemetry SET prompt_tokens = ?, completion_tokens = ?, cost_usd = ?, latency_ms = ?,
         outcome = ? WHERE id = ?`,
      [settled.promptTokens, settled.completionTokens, settled.costUsd, settled.latencyMs, settled.outcome, entryId],
    );
  }

  getTelemetry(entryId: number): CostTelemetry | null {
    const row = this.query("SELECT * FROM cost_telemetry WHERE id = ?", [entryId])[0];
    return row ? Repository.telemetryFromRow(row) : null;
  }

  listTelemetry(limit = 100): CostTelemetry[] {
    return this.query("SELECT * FROM cost_telemetry ORDER BY timestamp DESC, id DESC LIMIT ?", [limit]).map(
      Repository.telemetryFromRow,
    );
  }

  static telemetryFromRow(row: Row): CostTelemetry {
    return {
      id: row.id, timestamp: row.timestamp, provider: row.provider, model: row.model,
      taskType: row.task_type, promptTokens: row.prompt_tokens, completionTokens: row.completion_tokens,
      costUsd: row.cost_usd, latencyMs: row.latency_ms, outcome: row.outcome,
    };
  }

  /** Total recorded spend (including open reservations) since `startIso`. */
  spendSince(startIso: string): number {
    return this.query<{ total: number }>(
      "SELECT COALESCE(SUM(cost_usd), 0) AS total FROM cost_telemetry WHERE timestamp >= ?",
      [startIso],
    )[0].total;
  }

  /** Calls, tokens and spend per provider/model since `startIso` (all time if empty). */
  spendBreakdown(startIso = ""): Array<{
    provider: string; model: string; calls: number; promptTokens: number; completionTokens: number;
    costUsd: number; avgLatencyMs: number;
  }> {
    return this.query(
      `SELECT provider, model, COUNT(*) AS calls, SUM(prompt_tokens) AS prompt_tokens,
              SUM(completion_tokens) AS completion_tokens, SUM(cost_usd) AS cost_usd,
              CAST(AVG(latency_ms) AS INTEGER) AS avg_latency_ms
       FROM cost_telemetry WHERE timestamp >= ? GROUP BY provider, model ORDER BY cost_usd DESC`,
      [startIso],
    ).map((row) => ({
      provider: row.provider, model: row.model, calls: row.calls, promptTokens: row.prompt_tokens,
      completionTokens: row.completion_tokens, costUsd: row.cost_usd, avgLatencyMs: row.avg_latency_ms,
    }));
  }

  // ---------- Quarantine ----------

  /** Hold items for the user and mark their jobs quarantined, atomically. Returns the new ids. */
  quarantine(items: ReadonlyArray<Omit<QuarantinedItem, "id" | "status" | "createdAt"> & Partial<QuarantinedItem>>): number[] {
    const now = utcNowIso();
    return this.transaction(() => {
      const ids = items.map(
        (item) =>
          this.run(
            `INSERT INTO quarantined_items (
               job_id, violation_rule, original_content, critique, retry_count, status, created_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
            [
              item.jobId, item.violationRule, item.originalContent, item.critique, item.retryCount,
              item.status ?? "pending", item.createdAt || now,
            ],
          ).lastInsertRowid,
      );
      for (const jobId of new Set(items.map((item) => item.jobId))) {
        this.run("UPDATE jobs SET stage = ?, updated_at = ? WHERE id = ?", [PipelineStage.QUARANTINED, now, jobId]);
      }
      return ids;
    });
  }

  listQuarantined(status = "pending"): QuarantinedItem[] {
    return this.query("SELECT * FROM quarantined_items WHERE status = ? ORDER BY id", [status]).map((row) => ({
      id: row.id, jobId: row.job_id, violationRule: row.violation_rule, originalContent: row.original_content,
      critique: row.critique, retryCount: row.retry_count, status: row.status, createdAt: row.created_at,
    }));
  }

  /** Record that the user has looked at these held items. Returns how many were pending. */
  markQuarantineReviewed(itemIds: readonly number[]): number {
    if (!itemIds.length) return 0;
    const marks = itemIds.map(() => "?").join(", ");
    return this.run(
      `UPDATE quarantined_items SET status = 'reviewed' WHERE status = 'pending' AND id IN (${marks})`,
      itemIds,
    ).changes;
  }

  // ---------- Drafts awaiting review / dispatch ----------

  /** Store a greenlit draft and move its job to the matching stage, atomically. */
  saveDraft(draft: ApplicationDraft, status: DraftStatus, copRetries = 0): number {
    const now = utcNowIso();
    return this.transaction(() => {
      const id = this.run(
        `INSERT INTO application_drafts (job_id, status, content_json, cop_retries, note, created_at, updated_at)
         VALUES (?, ?, ?, ?, '', ?, ?)`,
        [draft.jobId, status, JSON.stringify(draft), copRetries, now, now],
      ).lastInsertRowid;
      this.setJobStage(draft.jobId, status as PipelineStage);
      return id;
    });
  }

  getDraft(draftId: number): StoredDraft | null {
    const row = this.query("SELECT * FROM application_drafts WHERE id = ?", [draftId])[0];
    return row ? Repository.draftFromRow(row) : null;
  }

  listDrafts(status?: DraftStatus): StoredDraft[] {
    const rows = status
      ? this.query("SELECT * FROM application_drafts WHERE status = ? ORDER BY id", [status])
      : this.query("SELECT * FROM application_drafts ORDER BY id");
    return rows.map(Repository.draftFromRow);
  }

  latestDraftForJob(jobId: string): StoredDraft | null {
    const row = this.query("SELECT * FROM application_drafts WHERE job_id = ? ORDER BY id DESC LIMIT 1", [jobId])[0];
    return row ? Repository.draftFromRow(row) : null;
  }

  /** Move a draft (and its job) to `status`. Returns false if the draft is unknown. */
  setDraftStatus(draftId: number, status: DraftStatus, note = ""): boolean {
    return this.transaction(() => {
      const row = this.query("SELECT job_id FROM application_drafts WHERE id = ?", [draftId])[0];
      if (!row) return false;
      this.run("UPDATE application_drafts SET status = ?, note = ?, updated_at = ? WHERE id = ?", [
        status, note, utcNowIso(), draftId,
      ]);
      this.setJobStage(row.job_id, status as PipelineStage);
      return true;
    });
  }

  updateDraftContent(draftId: number, draft: ApplicationDraft): void {
    this.run("UPDATE application_drafts SET content_json = ?, updated_at = ? WHERE id = ?", [
      JSON.stringify(draft), utcNowIso(), draftId,
    ]);
  }

  static draftFromRow(row: Row): StoredDraft {
    return {
      id: row.id, jobId: row.job_id, status: row.status, draft: JSON.parse(row.content_json),
      copRetries: row.cop_retries, note: row.note, createdAt: row.created_at, updatedAt: row.updated_at,
    };
  }

  // ---------- Dispatch log (30-day de-duplication, channel pulls) ----------

  recordDispatch(record: Omit<DispatchRecord, "id" | "dispatchedAt"> & { dispatchedAt?: string }): number {
    return this.run(
      "INSERT INTO dispatch_log (job_id, channel, company_key, domain, contact, dispatched_at) VALUES (?, ?, ?, ?, ?, ?)",
      [record.jobId, record.channel, record.companyKey, record.domain, record.contact, record.dispatchedAt || utcNowIso()],
    ).lastInsertRowid;
  }

  /** Most recent dispatch since `sinceIso` to the same company, domain or contact. */
  lastDispatch(
    sinceIso: string,
    keys: { companyKey?: string; domain?: string; contact?: string },
  ): DispatchRecord | null {
    const clauses: string[] = [];
    const params: Param[] = [sinceIso];
    for (const [column, value] of [
      ["company_key", keys.companyKey], ["domain", keys.domain], ["contact", keys.contact],
    ] as const) {
      if (value) {
        clauses.push(`${column} = ?`);
        params.push(value);
      }
    }
    if (!clauses.length) return null;
    const row = this.query(
      `SELECT * FROM dispatch_log WHERE dispatched_at >= ? AND (${clauses.join(" OR ")})
       ORDER BY dispatched_at DESC, id DESC LIMIT 1`,
      params,
    )[0];
    return row ? Repository.dispatchFromRow(row) : null;
  }

  listDispatches(jobId?: string): DispatchRecord[] {
    const rows = jobId
      ? this.query("SELECT * FROM dispatch_log WHERE job_id = ? ORDER BY dispatched_at DESC, id DESC", [jobId])
      : this.query("SELECT * FROM dispatch_log ORDER BY dispatched_at DESC, id DESC");
    return rows.map(Repository.dispatchFromRow);
  }

  countDispatchesSince(sinceIso: string): number {
    return this.query<{ n: number }>("SELECT COUNT(*) AS n FROM dispatch_log WHERE dispatched_at >= ?", [sinceIso])[0].n;
  }

  static dispatchFromRow(row: Row): DispatchRecord {
    return {
      id: row.id, jobId: row.job_id, channel: row.channel, companyKey: row.company_key,
      domain: row.domain, contact: row.contact, dispatchedAt: row.dispatched_at,
    };
  }

  // ---------- Outcomes (allocator rewards, income goal) ----------

  recordOutcome(outcome: Omit<Outcome, "id" | "recordedAt"> & { recordedAt?: string }): number {
    return this.run(
      "INSERT INTO outcomes (job_id, channel, kind, note, monthly_value_usd, recorded_at) VALUES (?, ?, ?, ?, ?, ?)",
      [outcome.jobId, outcome.channel, outcome.kind, outcome.note, outcome.monthlyValueUsd, outcome.recordedAt || utcNowIso()],
    ).lastInsertRowid;
  }

  listOutcomes(jobId?: string): Outcome[] {
    const rows = jobId
      ? this.query("SELECT * FROM outcomes WHERE job_id = ? ORDER BY recorded_at DESC, id DESC", [jobId])
      : this.query("SELECT * FROM outcomes ORDER BY recorded_at DESC, id DESC");
    return rows.map((row) => ({
      id: row.id, jobId: row.job_id, channel: row.channel as Channel, kind: row.kind as OutcomeKind,
      note: row.note, monthlyValueUsd: row.monthly_value_usd, recordedAt: row.recorded_at,
    }));
  }

  /** Monthly income from accepted engagements — progress toward the income goal. */
  securedMonthlyIncome(): number {
    return this.query<{ total: number }>(
      "SELECT COALESCE(SUM(monthly_value_usd), 0) AS total FROM outcomes WHERE kind = ?",
      [Outcomes.ACCEPTED],
    )[0].total;
  }

  // ---------- Standing answers to screening questions ----------

  /** The answer on file for this exact question, if any. */
  getStandingAnswer(question: string): StandingAnswer | null {
    const row = this.query("SELECT * FROM standing_answers WHERE question_key = ?", [questionKey(question)])[0];
    return row ? Repository.standingAnswerFromRow(row) : null;
  }

  listStandingAnswers(): StandingAnswer[] {
    return this.query("SELECT * FROM standing_answers ORDER BY updated_at DESC, question_key").map(
      Repository.standingAnswerFromRow,
    );
  }

  /**
   * Remember `answer` for `question`. The candidate's own answer always replaces what is
   * on file; an AI answer never overwrites one the candidate gave. Returns whether it was stored.
   */
  saveStandingAnswer(answer: Omit<StandingAnswer, "updatedAt">): boolean {
    const guard = answer.source === "ai" ? "WHERE standing_answers.source = 'ai'" : "";
    return (
      this.run(
        `INSERT INTO standing_answers (question_key, question, answer, options_json, source, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(question_key) DO UPDATE SET
           question = excluded.question, answer = excluded.answer, options_json = excluded.options_json,
           source = excluded.source, updated_at = excluded.updated_at ${guard}`,
        [
          questionKey(answer.question), answer.question, answer.answer, JSON.stringify(answer.options),
          answer.source, utcNowIso(),
        ],
      ).changes === 1
    );
  }

  /** Forget the answer to `question`. Returns false if there was none. */
  deleteStandingAnswer(question: string): boolean {
    return this.run("DELETE FROM standing_answers WHERE question_key = ?", [questionKey(question)]).changes === 1;
  }

  static standingAnswerFromRow(row: Row): StandingAnswer {
    return {
      question: row.question, answer: row.answer, options: list(row.options_json),
      source: row.source, updatedAt: row.updated_at,
    };
  }

  // ---------- System state ----------

  getState<T = unknown>(key: string, fallback: T | null = null): T | null {
    const row = this.query("SELECT value_json FROM system_state WHERE key = ?", [key])[0];
    return row ? (JSON.parse(row.value_json) as T) : fallback;
  }

  setState(key: string, value: unknown): void {
    this.run(
      `INSERT INTO system_state (key, value_json, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`,
      [key, JSON.stringify(value), utcNowIso()],
    );
  }
}
