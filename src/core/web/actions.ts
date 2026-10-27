/**
 * What the user can do to the pipeline from the console: settle an investigation, approve
 * or decline a draft, record that something was sent and what came of it, answer the
 * questions a held draft is waiting on, and curate the standing answers.
 *
 * Each function checks the job is in a state the action fits and makes its changes in
 * one transaction, because the pipeline may be running in another process on the same
 * database. They throw `ApiError`; nothing here knows about HTTP.
 */

import { type ApplicationAction, type QuarantineHold, availableActions, quarantineHolds } from "@/core/db/reports";
import { type Repository, toIso } from "@/core/db/repository";
import {
  DraftStatus,
  type JobOpportunity,
  OutcomeKind,
  PipelineStage,
  type StandingAnswer,
} from "@/core/models";
import { actOnCodeHold } from "@/core/orchestrator/codeHold";
import { recordSubmission } from "@/core/orchestrator/pipeline";
import { resolveInvestigation } from "@/core/qualification/investigator";
import { questionKey } from "@/core/text";
import { ApiError, JOB_ID, type JsonObject, isJsonObject, itemIds, textField } from "@/core/web/contract";

const QUESTION_LIMIT = 1000;
const ANSWER_LIMIT = 5000;
const OUTCOME_KINDS: readonly string[] = Object.values(OutcomeKind);

function trackedJob(repo: Repository, jobId: string): JobOpportunity {
  const job = JOB_ID.test(jobId) ? repo.getJob(jobId) : null;
  if (!job) throw new ApiError(404, "No such application");
  return job;
}

/** Equal but for case and spacing — how the Cop Tool compares an answer with a form's option. */
const sameText = (a: string, b: string): boolean =>
  a.toLowerCase().split(/\s+/).filter(Boolean).join(" ") === b.toLowerCase().split(/\s+/).filter(Boolean).join(" ");

/**
 * The answer as it will be stored: one of the form's own options, spelled as the form
 * spells it, when the question is multiple choice; any non-empty text otherwise.
 */
function fittedAnswer(question: string, answer: string, options: readonly string[]): string {
  if (!options.length) return answer;
  const option = options.find((candidate) => sameText(candidate, answer));
  if (option === undefined) {
    throw new ApiError(400, `The answer to '${question}' must be one of: ${options.join(" / ")}`);
  }
  return option;
}

// ---------- Investigations ----------

/** The user's own call on a Tier 2 job the investigation is still open on. */
export function decideInvestigation(repo: Repository, jobId: string, body: JsonObject): void {
  const { decision } = body;
  if (decision !== "qualify" && decision !== "disqualify") {
    throw new ApiError(400, "'decision' must be qualify or disqualify");
  }
  trackedJob(repo, jobId);
  if (!resolveInvestigation(repo, jobId, decision)) {
    throw new ApiError(409, "This application is not waiting on an investigation");
  }
}

// ---------- Drafts ----------

const DRAFT_ACTIONS = ["approve", "decline", "submitted", "retry"] as const;
type DraftAction = (typeof DRAFT_ACTIONS)[number];

const NOT_NOW: Record<DraftAction, string> = {
  approve: "Only a draft that is awaiting review can be approved",
  decline: "Only a draft that is awaiting review, approved or needing attention can be declined",
  submitted: "Only a pitch you send yourself, or an application that needs attention, can be marked as submitted",
  retry: "Only an application that needs attention can be retried",
};

/** Approve, decline, retry or mark as sent the draft of `jobId`. */
export function actOnDraft(repo: Repository, jobId: string, body: JsonObject, now: Date): void {
  const action = body.action as DraftAction;
  if (!DRAFT_ACTIONS.includes(action)) {
    throw new ApiError(400, "'action' must be approve, decline, submitted or retry");
  }
  repo.transaction(() => {
    const job = trackedJob(repo, jobId);
    const stored = repo.latestDraftForJob(jobId);
    const allowed: ApplicationAction[] = availableActions(job, stored);
    if (!stored || !allowed.includes(action)) throw new ApiError(409, NOT_NOW[action]);
    switch (action) {
      case "approve":
      case "retry":
        // Both hand the draft (back) to the operator: the next cycle with a browser applies it.
        repo.setDraftStatus(stored.id, DraftStatus.APPROVED);
        break;
      case "decline":
        repo.setDraftStatus(stored.id, DraftStatus.DECLINED);
        break;
      case "submitted":
        // The user sent it themselves; the dispatch log must know, or the company could be contacted twice.
        recordSubmission(repo, stored, job, now);
        break;
    }
  });
}

// ---------- Emailed codes ----------

const CODE_ACTIONS = ["ready", "approve", "skip"] as const;
type CodeAction = (typeof CODE_ACTIONS)[number];

/**
 * "I'm ready", Approve (with the code as found or typed) or "Not now" on an application
 * held for a code the site emails. The running loop does the rest.
 */
export function actOnCode(repo: Repository, jobId: string, body: JsonObject, now: Date): void {
  const action = body.action as CodeAction;
  if (!CODE_ACTIONS.includes(action)) throw new ApiError(400, "'action' must be ready, approve or skip");
  trackedJob(repo, jobId);
  const code = action === "approve" ? textField(body, "code", 40) : "";
  const refused = actOnCodeHold(repo, jobId, action, code, now);
  if (refused) throw new ApiError(409, refused);
}

// ---------- Outcomes ----------

/** Record what came of a submitted application. An accepted engagement counts toward the income goal. */
export function addOutcome(repo: Repository, jobId: string, body: JsonObject, now: Date): void {
  const kind = body.kind as OutcomeKind;
  if (!OUTCOME_KINDS.includes(kind)) {
    throw new ApiError(400, `'kind' must be one of ${OUTCOME_KINDS.join(", ")}`);
  }
  const note = textField(body, "note", 1000);
  const value = body.monthlyValueUsd ?? null;
  if (kind === OutcomeKind.ACCEPTED) {
    if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
      throw new ApiError(400, "'monthlyValueUsd' must be a positive number for an accepted engagement");
    }
  } else if (value !== null) {
    throw new ApiError(400, "'monthlyValueUsd' only applies to an accepted engagement");
  }
  repo.transaction(() => {
    const job = trackedJob(repo, jobId);
    if (job.stage !== PipelineStage.SUBMITTED) {
      throw new ApiError(409, "An outcome can only be recorded for a submitted application");
    }
    // The channel it actually went out on is what the allocator should be rewarded for.
    const channel = repo.listDispatches(jobId)[0]?.channel ?? job.channel;
    repo.recordOutcome({ jobId, channel, kind, note, monthlyValueUsd: value, recordedAt: toIso(now) });
  });
}

// ---------- Held drafts ----------

interface GivenAnswer {
  question: string;
  answer: string;
}

function givenAnswers(raw: unknown): GivenAnswer[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw) || raw.length > 50 || !raw.every(isJsonObject)) {
    throw new ApiError(400, "'answers' must be a list of up to 50 { question, answer } pairs");
  }
  return raw.map((entry) => ({
    question: textField(entry, "question", QUESTION_LIMIT, true),
    answer: textField(entry, "answer", ANSWER_LIMIT, true),
  }));
}

/** The pending hold made of exactly these quarantined items, if they are one. */
function pendingHold(repo: Repository, ids: readonly number[]): QuarantineHold | undefined {
  const first = repo.query<{ job_id: string }>("SELECT job_id FROM quarantined_items WHERE id = ?", [ids[0]])[0];
  if (!first) return undefined;
  return quarantineHolds(repo, { status: "pending", jobId: first.job_id }).find((hold) =>
    ids.every((id) => hold.ids.includes(id)),
  );
}

/**
 * Send a held draft's job back to be drafted again, optionally after answering the form
 * questions the draft was held for. Each answer is remembered as the user's own, so the
 * redraft — and every later form asking the same thing — uses it.
 *
 * Returns the job and how many answers were stored.
 */
export function retryHold(repo: Repository, body: JsonObject): { jobId: string; saved: number } {
  const ids = itemIds(body);
  const given = givenAnswers(body.answers);
  return repo.transaction(() => {
    const hold = pendingHold(repo, ids);
    if (!hold) throw new ApiError(404, "No pending quarantined item with those ids");
    if (!hold.canRetry) {
      throw new ApiError(409, "This application is no longer held, so there is nothing to retry");
    }
    const asked = hold.draft?.screeningAnswers ?? [];
    const answers: Array<Omit<StandingAnswer, "updatedAt">> = given.map(({ question, answer }) => {
      // Only a question this form really asked is remembered, with the choices it offered.
      const item = asked.find((candidate) => questionKey(candidate.question) === questionKey(question));
      if (!item) throw new ApiError(400, `'${question}' is not a question on this draft`);
      return {
        question: item.question, answer: fittedAnswer(item.question, answer, item.options),
        options: item.options, source: "user",
      };
    });
    for (const answer of answers) repo.saveStandingAnswer(answer);
    // The job is being redrafted, so every draft of it still on hold is now out of date.
    repo.run("UPDATE quarantined_items SET status = 'reviewed' WHERE job_id = ? AND status = 'pending'", [hold.jobId]);
    repo.setJobStage(hold.jobId, PipelineStage.QUALIFIED);
    return { jobId: hold.jobId, saved: answers.length };
  });
}

// ---------- Standing answers ----------

/**
 * Add an answer, or replace the one on file for that question. Whatever its source was,
 * it is the user's from now on: the pipeline never overwrites an answer the user gave.
 */
export function putAnswer(repo: Repository, body: JsonObject): void {
  const question = textField(body, "question", QUESTION_LIMIT, true);
  const answer = textField(body, "answer", ANSWER_LIMIT, true);
  repo.transaction(() => {
    const existing = repo.getStandingAnswer(question);
    const options = existing?.options ?? [];
    repo.saveStandingAnswer({
      // The form's own wording is kept, so the list reads as the questions were asked.
      question: existing?.question ?? question, answer: fittedAnswer(question, answer, options), options,
      source: "user",
    });
  });
}

/** Forget the answer to a question; the next form that asks it is answered afresh. */
export function removeAnswer(repo: Repository, body: JsonObject): void {
  const question = textField(body, "question", QUESTION_LIMIT, true);
  if (!repo.deleteStandingAnswer(question)) throw new ApiError(404, "No answer is stored for that question");
}
