/**
 * Tier 2 investigation: can a Cameroon-based B2B contractor actually be engaged for this role?
 *
 * Tier 2 listings say "Remote" without saying where they can hire. They are never
 * discarded automatically: Jev reads the listing for contractor viability, and only a
 * confident answer moves the job. Everything else waits for the user's own call.
 */

import type { Repository } from "@/core/db/repository";
import { CircuitBreakerError } from "@/core/llm/ledger";
import type { Decider, DecisionLike } from "@/core/llm/types";
import { B2B_INVESTIGATION, EligibilityTier, type JobOpportunity, PipelineStage } from "@/core/models";
import { cleanText, clipEnd, clipStart } from "@/core/text";

/**
 * qualified    — contractor / international hiring is viable: the job moves to QUALIFIED.
 * disqualified — the listing rules it out: the job moves to DISQUALIFIED.
 * needs_human  — unclear or low confidence: the job stays INVESTIGATING for the user to decide.
 */
export type InvestigationVerdict = "qualified" | "disqualified" | "needs_human";

/** pipeline_tasks.status for investigations waiting on the user. */
export const NEEDS_HUMAN = "needs_human";

const TASK_DONE = "done";

const INSTRUCTIONS =
  "The candidate is an independent B2B contractor based in Cameroon (UTC+1) who invoices the employer" +
  " directly or through a contractor platform. Going only by what this listing states, can the employer" +
  " engage them for the role?";

const OPTIONS = {
  viable:
    "The listing indicates contractors, international or any-location hiring, or an employer-of-record," +
    " or nothing in it ties the hire to one country",
  not_viable:
    "The listing requires residence, work authorization or local employment in a specific country," +
    " or on-site presence",
  unclear: "The listing gives conflicting signals, or too little about who can be hired to tell",
};

/** Long listings are sent as their first and last halves of this many characters. */
const DESCRIPTION_EXCERPT_CHARS = 6000;

/** Hiring restrictions tend to sit in the closing boilerplate, so the end matters as much as the start. */
function headAndTail(text: string, limit: number): string {
  if (text.length <= limit) return text;
  const half = Math.floor(limit / 2);
  return `${clipStart(text, half)} [...] ${clipEnd(text, half)}`;
}

function listingState(job: JobOpportunity): unknown {
  return {
    title: job.title,
    company: job.company,
    location: job.location,
    employmentType: job.employmentType,
    description: headAndTail(cleanText(job.description), DESCRIPTION_EXCERPT_CHARS),
  };
}

/** A concluded investigation: where the job goes and what the stored evaluation records. */
interface Ruling {
  verdict: Exclude<InvestigationVerdict, "needs_human">;
  reasonCode: string;
  summary: string;
}

const ROUTES = {
  qualified: { stage: PipelineStage.QUALIFIED, tier: EligibilityTier.CONFIRMED_ELIGIBLE },
  disqualified: { stage: PipelineStage.DISQUALIFIED, tier: EligibilityTier.INELIGIBLE },
} as const;

const USER_RULINGS: Record<"qualify" | "disqualify", Ruling> = {
  qualify: {
    verdict: "qualified",
    reasonCode: "B2B_CONFIRMED_BY_USER",
    summary: "You confirmed the employer can engage a Cameroon-based B2B contractor.",
  },
  disqualify: {
    verdict: "disqualified",
    reasonCode: "B2B_REJECTED_BY_USER",
    summary: "You ruled this role out during the B2B investigation.",
  },
};

/** The ruling Jev's answer supports, or null when it is not sure enough to act on. */
function rulingFor(decision: DecisionLike, confidence: number): Ruling | null {
  // Written as a negated >= so that a NaN confidence fails the bar instead of slipping past a `<`.
  if (!(decision.confidence >= confidence)) return null;
  const certainty = `${Math.round(decision.confidence * 100)}% confidence`;
  if (decision.value === "viable") {
    return {
      verdict: "qualified",
      reasonCode: "B2B_CONFIRMED",
      summary: `Investigation confirmed the employer can engage a Cameroon-based B2B contractor (${certainty}).`,
    };
  }
  if (decision.value === "not_viable") {
    return {
      verdict: "disqualified",
      reasonCode: "B2B_NOT_VIABLE",
      summary: `Investigation found the hire tied to one country or to on-site work (${certainty}).`,
    };
  }
  return null;
}

/**
 * Record a ruling and move the job. Must run inside a transaction, on a job that is
 * INVESTIGATING. The evaluation is updated in place, so a fit score already attached
 * to it is kept.
 */
function conclude(repo: Repository, jobId: string, ruling: Ruling): void {
  const { stage, tier } = ROUTES[ruling.verdict];
  const stored = repo.getEvaluation(jobId);
  repo.saveEvaluation({
    jobId,
    tier,
    reasonCodes: [...(stored?.reasonCodes ?? []), ruling.reasonCode],
    positiveSignals: stored?.positiveSignals ?? [],
    disqualifiers: stored?.disqualifiers ?? [],
    needsB2bInvestigation: false,
    summary: ruling.summary,
  });
  repo.setJobStage(jobId, stage);
  repo.setTaskStatus(B2B_INVESTIGATION, jobId, TASK_DONE);
}

/**
 * Ask the decider and route the job. Returns null when the job was no longer
 * INVESTIGATING by the time the answer arrived; it is then left exactly as it was.
 */
async function investigate(
  repo: Repository,
  job: JobOpportunity,
  decider: Decider | null,
  confidence: number,
): Promise<InvestigationVerdict | null> {
  // Nothing is written before this await, so a failed call leaves the task pending
  // and the next cycle retries it.
  const ruling = decider
    ? rulingFor(await decider.decideEnum(listingState(job), INSTRUCTIONS, OPTIONS, B2B_INVESTIGATION), confidence)
    : null;
  return repo.transaction<InvestigationVerdict | null>(() => {
    // The call can take seconds, and the console shares this database: the user may
    // have resolved the job in the meantime. Their decision stands.
    if (repo.getJob(job.id)?.stage !== PipelineStage.INVESTIGATING) {
      repo.setTaskStatus(B2B_INVESTIGATION, job.id, TASK_DONE);
      return null;
    }
    if (!ruling) {
      repo.setTaskStatus(B2B_INVESTIGATION, job.id, NEEDS_HUMAN);
      return "needs_human";
    }
    conclude(repo, job.id, ruling);
    return ruling.verdict;
  });
}

/**
 * Investigate one Tier 2 job and route it. A verdict is only acted on when the
 * decider's confidence reaches `confidence`; anything less is left for the user.
 * With no decider every job needs a human. Never discards a job on a guess.
 *
 * A failed decider call rejects with the decider's error and changes nothing, so the
 * task stays pending for the next cycle. If the job was resolved elsewhere while the
 * decider was answering, that outcome is kept and returned.
 */
export async function investigateJob(
  repo: Repository,
  job: JobOpportunity,
  decider: Decider | null,
  confidence: number,
): Promise<InvestigationVerdict> {
  const verdict = await investigate(repo, job, decider, confidence);
  if (verdict) return verdict;
  const stage = repo.getJob(job.id)?.stage;
  if (stage === undefined || stage === PipelineStage.DISCOVERED) {
    throw new Error(`Job ${job.id} was never queued for investigation`);
  }
  // Every stage past INVESTIGATING other than DISQUALIFIED is reached through QUALIFIED.
  return stage === PipelineStage.DISQUALIFIED ? "disqualified" : "qualified";
}

const MAX_FAILURES_IN_A_ROW = 3;

/**
 * Work through up to `limit` pending investigations, oldest first. Returns a count per verdict.
 *
 * `limit` caps the jobs actually investigated (the paid calls); tasks whose job is gone
 * or has left the queue are closed for free and not counted. A job whose decider call
 * fails is skipped with its task still pending and reported to `onError`, and the run
 * carries on — until `MAX_FAILURES_IN_A_ROW` calls have failed back to back, which means
 * the service is down or the key is wrong and the rest would fail too. CircuitBreakerError
 * stops the run at once: when the spend cap is reached every further call is refused.
 */
export async function runInvestigations(
  repo: Repository,
  decider: Decider | null,
  options: { confidence: number; limit: number; onError?: (job: JobOpportunity, error: unknown) => void },
): Promise<Record<InvestigationVerdict, number>> {
  const counts: Record<InvestigationVerdict, number> = { qualified: 0, disqualified: 0, needs_human: 0 };
  let investigated = 0;
  let failedInARow = 0;
  for (const task of repo.listTasks(B2B_INVESTIGATION)) {
    // Negated so that a NaN limit investigates nothing rather than everything.
    if (!(investigated < options.limit) || failedInARow >= MAX_FAILURES_IN_A_ROW) break;
    const job = repo.getJob(task.jobId);
    if (job?.stage !== PipelineStage.INVESTIGATING) {
      repo.setTaskStatus(B2B_INVESTIGATION, task.jobId, TASK_DONE);
      continue;
    }
    investigated += 1;
    try {
      const verdict = await investigate(repo, job, decider, options.confidence);
      if (verdict) counts[verdict] += 1;
      failedInARow = 0;
    } catch (error) {
      if (error instanceof CircuitBreakerError) throw error;
      // Transient (HTTP error, timeout, unusable answer): the task is still pending.
      failedInARow += 1;
      options.onError?.(job, error);
    }
  }
  return counts;
}

/**
 * The user's own call on a job in the investigation queue (from the console).
 * Returns false, changing nothing, if the job is not currently being investigated.
 */
export function resolveInvestigation(repo: Repository, jobId: string, decision: "qualify" | "disqualify"): boolean {
  return repo.transaction(() => {
    if (repo.getJob(jobId)?.stage !== PipelineStage.INVESTIGATING) return false;
    conclude(repo, jobId, USER_RULINGS[decision]);
    return true;
  });
}
