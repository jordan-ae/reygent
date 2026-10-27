import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { Repository } from "@/core/db/repository";
import { CircuitBreakerError } from "@/core/llm/ledger";
import type { Decider, DecisionLike } from "@/core/llm/types";
import {
  B2B_INVESTIGATION,
  type EligibilityReport,
  EligibilityTier,
  type FitEvaluation,
  type JobInput,
  type JobOpportunity,
  PipelineStage,
  createJob,
} from "@/core/models";
import {
  type InvestigationVerdict,
  NEEDS_HUMAN,
  investigateJob,
  resolveInvestigation,
  runInvestigations,
} from "@/core/qualification/investigator";

// ---------- Fixtures ----------

const CONFIDENCE = 0.8;
const NO_COUNTS = { qualified: 0, disqualified: 0, needs_human: 0 };

let repo: Repository;
beforeEach(() => {
  repo = new Repository(":memory:");
});
afterEach(() => repo.close());

/** The evaluation the eligibility step stores for a Tier 2 job. */
const tier2 = (jobId: string): EligibilityReport => ({
  jobId,
  tier: EligibilityTier.POTENTIALLY_ELIGIBLE,
  reasonCodes: ["GEO_UNSPECIFIED"],
  positiveSignals: ["CONTRACTOR_FRIENDLY: independent contractor"],
  disqualifiers: [],
  needsB2bInvestigation: true,
  summary: "Remote with no stated geographic scope.",
});

/** A Tier 2 job as the eligibility step leaves it: INVESTIGATING, evaluated and queued. */
function queued(company: string, fields: Partial<JobInput> = {}): JobOpportunity {
  const job = createJob({
    source: "test", sourceId: company, company, title: "Senior Engineer", location: "Remote",
    description: "A fully remote team.", stage: PipelineStage.INVESTIGATING, ...fields,
  });
  expect(repo.insertJob(job)).toBe(true);
  repo.saveEvaluation(tier2(job.id));
  repo.enqueueTask({ taskType: B2B_INVESTIGATION, jobId: job.id });
  return job;
}

const stageOf = (jobId: string) => repo.getJob(jobId)?.stage;
const taskStatus = (jobId: string): string | undefined =>
  repo.query<{ status: string }>("SELECT status FROM pipeline_tasks WHERE task_type = ? AND job_id = ?", [
    B2B_INVESTIGATION, jobId,
  ])[0]?.status;

/** Asserts the job is exactly as the eligibility step left it, with its task in `status`. */
function expectUntouched(job: JobOpportunity, status: string): void {
  expect(stageOf(job.id)).toBe(PipelineStage.INVESTIGATING);
  expect(repo.getEvaluation(job.id)).toEqual(tier2(job.id));
  expect(taskStatus(job.id)).toBe(status);
}

interface EnumCall {
  state: unknown;
  instructions: string;
  options: Record<string, string>;
  taskType: string;
}

/** A Decider whose choice answer (or failure) is produced by `answer`. */
function enumDecider(answer: (state: unknown) => DecisionLike | Promise<DecisionLike>): {
  decider: Decider;
  calls: EnumCall[];
} {
  const calls: EnumCall[] = [];
  const decider: Decider = {
    decideBool: async () => {
      throw new Error("the investigator must not ask a yes/no question");
    },
    decideScore: async () => {
      throw new Error("the investigator must not ask a score question");
    },
    decideEnum: async (state, instructions, options, taskType) => {
      calls.push({ state, instructions, options, taskType });
      return answer(state);
    },
  };
  return { decider, calls };
}

const says = (value: DecisionLike["value"], confidence: number): DecisionLike => ({
  value, confidence, probabilities: {},
});
/** Whether the state sent to the decider is about `company`. */
const about = (state: unknown, company: string): boolean => JSON.stringify(state).includes(company);

// ---------- investigateJob ----------

describe("investigateJob", () => {
  test("a confident 'viable' qualifies the job and records why", async () => {
    const job = queued("Alpha");
    const { decider, calls } = enumDecider(() => says("viable", 0.93));

    expect(await investigateJob(repo, job, decider, CONFIDENCE)).toBe("qualified");

    expect(stageOf(job.id)).toBe(PipelineStage.QUALIFIED);
    expect(repo.getEvaluation(job.id)).toEqual({
      ...tier2(job.id),
      tier: EligibilityTier.CONFIRMED_ELIGIBLE,
      reasonCodes: ["GEO_UNSPECIFIED", "B2B_CONFIRMED"],
      needsB2bInvestigation: false,
      summary: expect.stringMatching(/confirmed.*93%/i),
    });
    expect(taskStatus(job.id)).toBe("done");

    expect(calls).toHaveLength(1);
    expect(calls[0].taskType).toBe("b2b_investigation");
    expect(Object.keys(calls[0].options)).toEqual(["viable", "not_viable", "unclear"]);
    expect(calls[0].instructions).toMatch(/contractor/i);
  });

  test("a confident 'not_viable' disqualifies the job and records why", async () => {
    const job = queued("Alpha");
    const { decider } = enumDecider(() => says("not_viable", 0.88));

    expect(await investigateJob(repo, job, decider, CONFIDENCE)).toBe("disqualified");

    expect(stageOf(job.id)).toBe(PipelineStage.DISQUALIFIED);
    expect(repo.getEvaluation(job.id)).toEqual({
      ...tier2(job.id),
      tier: EligibilityTier.INELIGIBLE,
      reasonCodes: ["GEO_UNSPECIFIED", "B2B_NOT_VIABLE"],
      needsB2bInvestigation: false,
      summary: expect.stringMatching(/88%/),
    });
    expect(taskStatus(job.id)).toBe("done");
  });

  test.each<[DecisionLike["value"], number, InvestigationVerdict]>([
    // Exactly at the bar is enough; a hair under it is not.
    ["viable", 0.8, "qualified"],
    ["viable", 0.7999, "needs_human"],
    ["not_viable", 0.8, "disqualified"],
    ["not_viable", 0.7999, "needs_human"],
    ["viable", 1, "qualified"],
    ["viable", 0, "needs_human"],
    // Certainty about not knowing is still not a verdict.
    ["unclear", 0.99, "needs_human"],
    // Answers outside the offered options, or without a usable confidence, are never acted on.
    ["probably", 0.99, "needs_human"],
    [true, 0.99, "needs_human"],
    ["viable", Number.NaN, "needs_human"],
    ["not_viable", Number.NaN, "needs_human"],
  ])("answer %s at confidence %d gives %s", async (value, confidence, verdict) => {
    const job = queued("Alpha");
    const { decider } = enumDecider(() => says(value, confidence));

    expect(await investigateJob(repo, job, decider, CONFIDENCE)).toBe(verdict);

    if (verdict === "needs_human") {
      expectUntouched(job, NEEDS_HUMAN);
    } else {
      expect(stageOf(job.id)).toBe(verdict === "qualified" ? PipelineStage.QUALIFIED : PipelineStage.DISQUALIFIED);
      expect(taskStatus(job.id)).toBe("done");
    }
  });

  test("the bar is the caller's: a stricter threshold holds back the same answer", async () => {
    const [lenient, strict] = [queued("Alpha"), queued("Bravo")];
    const { decider } = enumDecider(() => says("not_viable", 0.9));
    expect(await investigateJob(repo, lenient, decider, 0.9)).toBe("disqualified");
    expect(await investigateJob(repo, strict, decider, 0.95)).toBe("needs_human");
    expectUntouched(strict, NEEDS_HUMAN);
  });

  test("with no decider the job waits for the user", async () => {
    const job = queued("Alpha");
    expect(await investigateJob(repo, job, null, CONFIDENCE)).toBe("needs_human");
    expectUntouched(job, NEEDS_HUMAN);
  });

  test("a transient decider failure is rethrown and leaves the task pending", async () => {
    const job = queued("Alpha");
    const failure = new Error("HTTP 502: bad gateway");
    const { decider } = enumDecider(() => {
      throw failure;
    });
    await expect(investigateJob(repo, job, decider, CONFIDENCE)).rejects.toBe(failure);
    expectUntouched(job, "pending");
  });

  test("the spend cap propagates and leaves the task pending", async () => {
    const job = queued("Alpha");
    const { decider } = enumDecider(() => {
      throw new CircuitBreakerError(1.5, 1.5);
    });
    await expect(investigateJob(repo, job, decider, CONFIDENCE)).rejects.toBeInstanceOf(CircuitBreakerError);
    expectUntouched(job, "pending");
  });

  test("the decider sees the listing, cleaned", async () => {
    const job = queued("Alpha", {
      title: "Staff Engineer", location: "Remote (US)", employmentType: "contract",
      description: "<p>We hire <b>independent contractors</b> &amp; invoice monthly.</p>",
    });
    const { decider, calls } = enumDecider(() => says("unclear", 0.5));
    await investigateJob(repo, job, decider, CONFIDENCE);
    expect(calls[0].state).toEqual({
      title: "Staff Engineer", company: "Alpha", location: "Remote (US)", employmentType: "contract",
      description: "We hire independent contractors & invoice monthly.",
    });
  });

  test("a long listing keeps its closing lines, where hiring restrictions usually sit", async () => {
    const filler = "We build developer tools. ".repeat(400);
    const job = queued("Alpha", {
      description: `HEADMARKER ${filler} MIDMARKER ${filler} Applicants must be authorized to work in the US. TAILMARKER`,
    });
    const { decider, calls } = enumDecider(() => says("not_viable", 0.97));
    await investigateJob(repo, job, decider, CONFIDENCE);
    const sent = (calls[0].state as { description: string }).description;
    expect(sent.length).toBeLessThan(6100);
    expect(sent).toContain("HEADMARKER");
    expect(sent).toContain("authorized to work in the US. TAILMARKER");
    expect(sent).not.toContain("MIDMARKER");
  });

  test("a job with no stored evaluation still gets one", async () => {
    const job = createJob({ source: "test", sourceId: "bare", company: "Bare", title: "Engineer", stage: PipelineStage.INVESTIGATING });
    repo.insertJob(job);
    const { decider } = enumDecider(() => says("viable", 0.9));
    expect(await investigateJob(repo, job, decider, CONFIDENCE)).toBe("qualified");
    expect(repo.getEvaluation(job.id)).toMatchObject({
      tier: EligibilityTier.CONFIRMED_ELIGIBLE, reasonCodes: ["B2B_CONFIRMED"], needsB2bInvestigation: false,
    });
    expect(stageOf(job.id)).toBe(PipelineStage.QUALIFIED);
  });

  test("routing is atomic: a failure part-way rolls the whole verdict back", async () => {
    const job = queued("Alpha");
    const { decider } = enumDecider(() => says("viable", 0.99));
    const spy = vi.spyOn(repo, "setTaskStatus").mockImplementation(() => {
      throw new Error("disk full");
    });
    await expect(investigateJob(repo, job, decider, CONFIDENCE)).rejects.toThrow("disk full");
    spy.mockRestore();
    expectUntouched(job, "pending");
  });

  test.each([
    ["disqualify", "viable", "disqualified", "B2B_REJECTED_BY_USER"],
    ["qualify", "not_viable", "qualified", "B2B_CONFIRMED_BY_USER"],
  ] as const)(
    "a user who chose to %s while the decider was answering %s is not overruled",
    async (userDecision, answer, standing, reasonCode) => {
      const job = queued("Alpha");
      const { decider } = enumDecider(() => {
        expect(resolveInvestigation(repo, job.id, userDecision)).toBe(true);
        return says(answer, 0.99);
      });

      expect(await investigateJob(repo, job, decider, CONFIDENCE)).toBe(standing);

      expect(stageOf(job.id)).toBe(standing === "qualified" ? PipelineStage.QUALIFIED : PipelineStage.DISQUALIFIED);
      expect(repo.getEvaluation(job.id)?.reasonCodes).toEqual(["GEO_UNSPECIFIED", reasonCode]);
      expect(taskStatus(job.id)).toBe("done");
    },
  );

  test("a job that was never queued is refused rather than routed", async () => {
    const untracked = createJob({ source: "test", sourceId: "x", company: "Nowhere", title: "Engineer" });
    const discovered = createJob({ source: "test", sourceId: "y", company: "Fresh", title: "Engineer" });
    repo.insertJob(discovered);
    const { decider } = enumDecider(() => says("not_viable", 0.99));

    await expect(investigateJob(repo, untracked, decider, CONFIDENCE)).rejects.toThrow(/never queued/);
    await expect(investigateJob(repo, discovered, decider, CONFIDENCE)).rejects.toThrow(/never queued/);
    expect(stageOf(discovered.id)).toBe(PipelineStage.DISCOVERED);
    expect(repo.getEvaluation(discovered.id)).toBeNull();
  });
});

// ---------- Fit score survives ----------

describe("an existing fit score", () => {
  const fitFor = (jobId: string): FitEvaluation => ({
    jobId, fitScore: 82, bestPositioningProfile: "fullstack_product",
    matchedSkills: ["TypeScript", "PostgreSQL"], missingSkills: ["Go"],
  });

  test.each<[string, (job: JobOpportunity) => Promise<unknown>]>([
    ["a qualifying verdict", (job) => investigateJob(repo, job, enumDecider(() => says("viable", 0.9)).decider, CONFIDENCE)],
    ["a disqualifying verdict", (job) => investigateJob(repo, job, enumDecider(() => says("not_viable", 0.9)).decider, CONFIDENCE)],
    ["the user qualifying", async (job) => resolveInvestigation(repo, job.id, "qualify")],
    ["the user disqualifying", async (job) => resolveInvestigation(repo, job.id, "disqualify")],
  ])("is not wiped by %s", async (_name, act) => {
    const job = queued("Alpha");
    repo.saveFit(fitFor(job.id));
    await act(job);
    expect(stageOf(job.id)).not.toBe(PipelineStage.INVESTIGATING);
    expect(repo.getFit(job.id)).toEqual(fitFor(job.id));
  });
});

// ---------- runInvestigations ----------

describe("runInvestigations", () => {
  test("works through pending tasks oldest first, up to the limit", async () => {
    const [alpha, bravo, charlie] = [queued("Alpha"), queued("Bravo"), queued("Charlie")];
    const { decider, calls } = enumDecider(() => says("viable", 0.9));

    expect(await runInvestigations(repo, decider, { confidence: CONFIDENCE, limit: 2 })).toEqual({
      ...NO_COUNTS, qualified: 2,
    });

    expect(calls.map((call) => ["Alpha", "Bravo", "Charlie"].find((company) => about(call.state, company)))).toEqual([
      "Alpha", "Bravo",
    ]);
    expect(stageOf(alpha.id)).toBe(PipelineStage.QUALIFIED);
    expect(stageOf(bravo.id)).toBe(PipelineStage.QUALIFIED);
    expectUntouched(charlie, "pending");
  });

  test("counts each verdict and applies the confidence bar", async () => {
    const jobs = [queued("Alpha"), queued("Bravo"), queued("Charlie"), queued("Delta")];
    const { decider } = enumDecider((state) => {
      if (about(state, "Alpha")) return says("viable", 0.95);
      if (about(state, "Bravo")) return says("not_viable", 0.9);
      if (about(state, "Charlie")) return says("unclear", 0.9);
      return says("viable", 0.5);
    });

    expect(await runInvestigations(repo, decider, { confidence: CONFIDENCE, limit: 10 })).toEqual({
      qualified: 1, disqualified: 1, needs_human: 2,
    });
    expect(jobs.map((job) => stageOf(job.id))).toEqual([
      PipelineStage.QUALIFIED, PipelineStage.DISQUALIFIED, PipelineStage.INVESTIGATING, PipelineStage.INVESTIGATING,
    ]);
    expect(jobs.map((job) => taskStatus(job.id))).toEqual(["done", "done", NEEDS_HUMAN, NEEDS_HUMAN]);
  });

  test("tasks whose job moved on or is gone are closed, not counted, and cost no call", async () => {
    const [moved, gone, live] = [queued("Alpha"), queued("Bravo"), queued("Charlie")];
    repo.setJobStage(moved.id, PipelineStage.AWAITING_REVIEW);
    // Deleting a job normally takes its tasks with it; a leftover row has to be forced.
    repo.db.exec("PRAGMA foreign_keys = OFF");
    repo.run("DELETE FROM jobs WHERE id = ?", [gone.id]);
    const { decider, calls } = enumDecider(() => says("viable", 0.9));

    // The stale tasks are older than the live one and must not use up the limit.
    expect(await runInvestigations(repo, decider, { confidence: CONFIDENCE, limit: 1 })).toEqual({
      ...NO_COUNTS, qualified: 1,
    });

    expect(calls).toHaveLength(1);
    expect(about(calls[0].state, "Charlie")).toBe(true);
    expect(taskStatus(moved.id)).toBe("done");
    expect(taskStatus(gone.id)).toBe("done");
    expect(stageOf(moved.id)).toBe(PipelineStage.AWAITING_REVIEW);
    expect(repo.getEvaluation(moved.id)).toEqual(tier2(moved.id));
    expect(stageOf(live.id)).toBe(PipelineStage.QUALIFIED);
  });

  test("a transient failure on one job is skipped and retried by the next run", async () => {
    const [alpha, bravo, charlie] = [queued("Alpha"), queued("Bravo"), queued("Charlie")];
    let healthy = false;
    const { decider, calls } = enumDecider((state) => {
      if (about(state, "Bravo") && !healthy) throw new Error("HTTP 502: bad gateway");
      return about(state, "Charlie") ? says("not_viable", 0.9) : says("viable", 0.9);
    });

    expect(await runInvestigations(repo, decider, { confidence: CONFIDENCE, limit: 10 })).toEqual({
      qualified: 1, disqualified: 1, needs_human: 0,
    });
    expect(calls).toHaveLength(3);
    expect(stageOf(alpha.id)).toBe(PipelineStage.QUALIFIED);
    expectUntouched(bravo, "pending");
    expect(stageOf(charlie.id)).toBe(PipelineStage.DISQUALIFIED);

    healthy = true;
    expect(await runInvestigations(repo, decider, { confidence: CONFIDENCE, limit: 10 })).toEqual({
      ...NO_COUNTS, qualified: 1,
    });
    expect(calls).toHaveLength(4);
    expect(stageOf(bravo.id)).toBe(PipelineStage.QUALIFIED);
  });

  test("a failed call still uses up the limit, so a broken provider is not hammered", async () => {
    const jobs = [queued("Alpha"), queued("Bravo"), queued("Charlie")];
    const { decider, calls } = enumDecider(() => {
      throw new Error("timeout");
    });
    expect(await runInvestigations(repo, decider, { confidence: CONFIDENCE, limit: 2 })).toEqual(NO_COUNTS);
    expect(calls).toHaveLength(2);
    for (const job of jobs) expectUntouched(job, "pending");
  });

  test("the spend cap stops the run and propagates", async () => {
    const [alpha, bravo, charlie] = [queued("Alpha"), queued("Bravo"), queued("Charlie")];
    const { decider, calls } = enumDecider((state) => {
      if (about(state, "Alpha")) return says("viable", 0.9);
      throw new CircuitBreakerError(1.5, 1.5);
    });

    await expect(runInvestigations(repo, decider, { confidence: CONFIDENCE, limit: 10 })).rejects.toBeInstanceOf(
      CircuitBreakerError,
    );

    expect(calls).toHaveLength(2); // Charlie was never attempted
    expect(stageOf(alpha.id)).toBe(PipelineStage.QUALIFIED); // decided before the cap: kept
    expectUntouched(bravo, "pending");
    expectUntouched(charlie, "pending");
  });

  test("with no decider every job in reach is handed to the user, once", async () => {
    const jobs = [queued("Alpha"), queued("Bravo"), queued("Charlie")];
    expect(await runInvestigations(repo, null, { confidence: CONFIDENCE, limit: 2 })).toEqual({
      ...NO_COUNTS, needs_human: 2,
    });
    expectUntouched(jobs[0], NEEDS_HUMAN);
    expectUntouched(jobs[1], NEEDS_HUMAN);
    expectUntouched(jobs[2], "pending");

    // Tasks already waiting on the user are not pending, so a decider never re-reads them.
    const { decider, calls } = enumDecider(() => says("viable", 0.99));
    expect(await runInvestigations(repo, decider, { confidence: CONFIDENCE, limit: 10 })).toEqual({
      ...NO_COUNTS, qualified: 1,
    });
    expect(calls).toHaveLength(1);
    expectUntouched(jobs[0], NEEDS_HUMAN);
    expect(stageOf(jobs[2].id)).toBe(PipelineStage.QUALIFIED);
  });

  test("an empty queue, or a limit that is zero or not a number, does nothing", async () => {
    const { decider, calls } = enumDecider(() => says("viable", 0.99));
    expect(await runInvestigations(repo, decider, { confidence: CONFIDENCE, limit: 10 })).toEqual(NO_COUNTS);
    const job = queued("Alpha");
    for (const limit of [0, -1, Number.NaN]) {
      expect(await runInvestigations(repo, decider, { confidence: CONFIDENCE, limit })).toEqual(NO_COUNTS);
    }
    expect(calls).toHaveLength(0);
    expectUntouched(job, "pending");
  });
});

// ---------- resolveInvestigation ----------

describe("resolveInvestigation", () => {
  test("the user qualifies a pending job", () => {
    const job = queued("Alpha");
    expect(resolveInvestigation(repo, job.id, "qualify")).toBe(true);
    expect(stageOf(job.id)).toBe(PipelineStage.QUALIFIED);
    expect(repo.getEvaluation(job.id)).toEqual({
      ...tier2(job.id),
      tier: EligibilityTier.CONFIRMED_ELIGIBLE,
      reasonCodes: ["GEO_UNSPECIFIED", "B2B_CONFIRMED_BY_USER"],
      needsB2bInvestigation: false,
      summary: expect.stringMatching(/you confirmed/i),
    });
    expect(taskStatus(job.id)).toBe("done");
  });

  test("the user disqualifies a job that was waiting on them", async () => {
    const job = queued("Alpha");
    await investigateJob(repo, job, null, CONFIDENCE);
    expect(taskStatus(job.id)).toBe(NEEDS_HUMAN);

    expect(resolveInvestigation(repo, job.id, "disqualify")).toBe(true);
    expect(stageOf(job.id)).toBe(PipelineStage.DISQUALIFIED);
    expect(repo.getEvaluation(job.id)).toEqual({
      ...tier2(job.id),
      tier: EligibilityTier.INELIGIBLE,
      reasonCodes: ["GEO_UNSPECIFIED", "B2B_REJECTED_BY_USER"],
      needsB2bInvestigation: false,
      summary: expect.stringMatching(/you ruled/i),
    });
    expect(taskStatus(job.id)).toBe("done");
  });

  test.each([
    PipelineStage.DISCOVERED, PipelineStage.QUALIFIED, PipelineStage.DISQUALIFIED, PipelineStage.AWAITING_REVIEW,
    PipelineStage.SUBMITTED,
  ])("a job that is %s is left alone", (stage) => {
    const job = queued("Alpha");
    repo.setJobStage(job.id, stage);
    for (const decision of ["qualify", "disqualify"] as const) {
      expect(resolveInvestigation(repo, job.id, decision)).toBe(false);
    }
    expect(stageOf(job.id)).toBe(stage);
    expect(repo.getEvaluation(job.id)).toEqual(tier2(job.id));
    expect(taskStatus(job.id)).toBe("pending");
  });

  test("an unknown job is refused", () => {
    expect(resolveInvestigation(repo, "no-such-job", "qualify")).toBe(false);
    expect(repo.getEvaluation("no-such-job")).toBeNull();
  });

  test("a job can only be resolved once", () => {
    const job = queued("Alpha");
    expect(resolveInvestigation(repo, job.id, "disqualify")).toBe(true);
    expect(resolveInvestigation(repo, job.id, "qualify")).toBe(false);
    expect(stageOf(job.id)).toBe(PipelineStage.DISQUALIFIED);
    expect(repo.getEvaluation(job.id)?.reasonCodes).toEqual(["GEO_UNSPECIFIED", "B2B_REJECTED_BY_USER"]);
  });

  test("a resolved job is not investigated afterwards", async () => {
    const job = queued("Alpha");
    resolveInvestigation(repo, job.id, "qualify");
    const { decider, calls } = enumDecider(() => says("not_viable", 0.99));
    expect(await runInvestigations(repo, decider, { confidence: CONFIDENCE, limit: 10 })).toEqual(NO_COUNTS);
    expect(calls).toHaveLength(0);
    expect(stageOf(job.id)).toBe(PipelineStage.QUALIFIED);
  });

  test("is atomic: a failure part-way rolls the decision back", () => {
    const job = queued("Alpha");
    const spy = vi.spyOn(repo, "setTaskStatus").mockImplementation(() => {
      throw new Error("disk full");
    });
    expect(() => resolveInvestigation(repo, job.id, "qualify")).toThrow("disk full");
    spy.mockRestore();
    expectUntouched(job, "pending");
  });
});
