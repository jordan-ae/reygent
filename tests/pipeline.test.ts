import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import type { FillReport, FormField, FormSchema } from "@/core/browser/types";
import { type Config, defaultConfig } from "@/core/config";
import { Repository, toIso } from "@/core/db/repository";
import { BOARDS_KEY } from "@/core/discovery";
import type { BoardFinder, EmployerLookup } from "@/core/discovery/employer";
import type { DraftInspector } from "@/core/drafting/tailor";
import { CircuitBreakerError } from "@/core/llm/ledger";
import type { Decider } from "@/core/llm/types";
import {
  type ApplicationDraft,
  Channel,
  DraftStatus,
  type JobOpportunity,
  NEEDS_CODE,
  PipelineStage,
  createDraft,
  createJob,
  sentByHand,
} from "@/core/models";
import {
  type Applier,
  HEARTBEAT_KEY,
  INTERRUPTED,
  type PipelineDeps,
  chooseJobsToDraft,
  dispatchKeys,
  draftingBlockers,
  learnBoards,
  moveLeadsToForms,
  readmitLowFit,
  recordSubmission,
  retryHolds,
  runCycle,
} from "@/core/orchestrator/pipeline";
import { ProfileManager } from "@/core/profile/manager";
import { qualifyJob } from "@/core/qualification/eligibility";

const NOW = new Date("2026-10-12T12:00:00Z");

function makeConfig(): Config {
  const config = defaultConfig();
  Object.assign(config.candidate, {
    name: "Test Candidate", email: "candidate@example.com", phone: "+237 600 000 000",
    github_url: "https://github.com/test-candidate", linkedin_url: "https://www.linkedin.com/in/test-candidate",
    portfolio_url: "https://candidate.example.com", notice_period: "2 weeks", years_experience: 8,
    employers: ["Initech"], skills: ["Python", "Docker"],
  });
  config.fact_bank.achievements = [{
    id: "ach_agents", category: "ai_systems",
    positioning: ["ai_platform_agent", "fullstack_product", "applied_ai_llm", "frontend_systems"],
    headline: "Built a LangGraph agent runtime with checkpoint recovery",
    impact_metric: "Cut workflow latency by 45%", technologies: ["Python", "LangGraph", "PostgreSQL"],
    employer: "Initech", verified: true,
  }];
  return config;
}

const listing = (sourceId: string, fields: Partial<JobOpportunity> & Pick<JobOpportunity, "company" | "title">) =>
  createJob({ source: "greenhouse", sourceId, applyUrl: `https://boards.greenhouse.io/x/jobs/${sourceId}`, ...fields });

const LISTINGS = () => [
  listing("1", {
    company: "Northwind Labs", title: "Senior AI Agent Engineer", location: "Remote (Worldwide)",
    description: "Build LangGraph agents in Python. Contractors are paid through Deel.", skills: ["Python", "LangGraph"],
  }),
  listing("2", {
    company: "Fathom Systems", title: "Agent Platform Engineer", location: "Remote",
    description: "San Francisco startup with a fully remote team. Python and LangGraph.", skills: ["Python", "LangGraph"],
  }),
  listing("3", {
    company: "Aegis Federal", title: "Senior Software Engineer", location: "Remote",
    description: "US citizenship required. Must hold an active security clearance.",
  }),
  listing("4", {
    company: "Brightline", title: "Sales Associate", location: "Remote (Worldwide)",
    description: "Cold-call prospects and close deals. Sales role.",
  }),
];

/**
 * A decider that calls Tier 2 jobs viable, answers yes/no form questions "No", and
 * scores everything but the sales role highly.
 */
const fakeDecider = (overrides: Partial<Decider> = {}): Decider => ({
  decideBool: async () => ({ value: true, confidence: 0.95, probabilities: {} }),
  decideEnum: async (_state, _instructions, options) => ({
    value: "No" in options ? "No" : "viable", confidence: 0.95, probabilities: {},
  }),
  decideScore: async (state) => ({
    value: JSON.stringify(state).includes("Sales Associate") ? 0 : 3, confidence: 0.9, probabilities: {},
  }),
  ...overrides,
});

const passingInspector: DraftInspector = {
  inspectApplicationDraft: async (draft) => ({ passed: true, draft, retries: 0, quarantineIds: [] }),
};

const filled = (status: FillReport["status"], extra: Partial<FillReport> = {}): FillReport => ({
  status, reason: "", filled: ["Email"], unfilled: [], blockers: [], requiredUnfilled: [], ...extra,
});

const NO_FORM = async (job: JobOpportunity): Promise<FormSchema> => ({ url: job.applyUrl, fields: [], blockers: [] });

describe("pipeline cycle with the user in the loop", () => {
  let repo: Repository;
  let tmp: string;
  let config: Config;
  let applied: Array<{ job: JobOpportunity; draft: ApplicationDraft }>;

  beforeEach(() => {
    repo = new Repository(":memory:");
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "reygent-pipeline-"));
    config = makeConfig();
    // Review-first mode: drafts wait for approval and unsettled Tier 2 jobs wait for a decision.
    config.pipeline.require_human_review = true;
    config.pipeline.pitch_unconfirmed_tier2 = false;
    applied = [];
  });
  afterEach(() => {
    repo.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  const applier = (result: FillReport = filled("submitted")): Applier => ({
    inspect: NO_FORM,
    apply: async (job, draft) => {
      applied.push({ job, draft });
      return result;
    },
  });

  const deps = (overrides: Partial<PipelineDeps> = {}): PipelineDeps => ({
    repo, config, decider: fakeDecider(), generator: null, inspector: passingInspector,
    discover: async () => ({ jobs: LISTINGS(), errors: [] }),
    renderPdf: async (_html, outputPath) => {
      fs.mkdirSync(path.dirname(outputPath), { recursive: true });
      fs.writeFileSync(outputPath, "%PDF-1.4 test");
    },
    applier: null, clock: () => NOW, resumeDir: tmp, ...overrides,
  });

  const stages = () => Object.fromEntries(repo.listJobs().map((job) => [job.company, job.stage]));

  test("one cycle takes new listings from discovery to drafts awaiting review", async () => {
    const report = await runCycle(deps());

    expect(report).toMatchObject({
      fetched: 4, added: 4, tiers: { confirmed: 2, potentially_eligible: 1, ineligible: 1 },
      investigated: { qualified: 1, disqualified: 0, needs_human: 0 },
      scored: 3, lowFit: 1, drafts: { awaitingReview: 2, approved: 0, quarantined: 0, skipped: 0 },
      paused: false, blocked: [], errors: [],
    });
    expect(stages()).toEqual({
      "Northwind Labs": PipelineStage.AWAITING_REVIEW, "Fathom Systems": PipelineStage.AWAITING_REVIEW,
      "Aegis Federal": PipelineStage.DISQUALIFIED, Brightline: PipelineStage.DISQUALIFIED,
    });
    const drafts = repo.listDrafts(DraftStatus.AWAITING_REVIEW);
    expect(drafts).toHaveLength(2);
    for (const stored of drafts) {
      expect(stored.draft.cvBullets[0].achievementId).toBe("ach_agents");
      expect(fs.existsSync(stored.draft.resumePdfPath)).toBe(true);
      expect(stored.draft.screeningAnswers).toEqual([]);
    }
    const lowFit = repo.listJobs().find((job) => job.company === "Brightline")!;
    expect(repo.getEvaluation(lowFit.id)!.reasonCodes).toContain("LOW_FIT");
    expect(repo.getState(HEARTBEAT_KEY)).toMatchObject({ added: 4, finishedAt: report.finishedAt });
  });

  test("a second cycle over the same listings adds and drafts nothing new", async () => {
    await runCycle(deps());
    const again = await runCycle(deps());
    expect(again).toMatchObject({ fetched: 4, added: 0, scored: 0, drafts: { awaitingReview: 0, quarantined: 0 } });
    expect(repo.listDrafts()).toHaveLength(2);
  });

  test("a job put back in the queue after its draft was declined is drafted afresh", async () => {
    await runCycle(deps());
    const [first] = repo.listDrafts(DraftStatus.AWAITING_REVIEW);
    repo.setDraftStatus(first.id, DraftStatus.DECLINED);
    repo.setJobStage(first.jobId, PipelineStage.QUALIFIED);

    const again = await runCycle(deps());
    expect(again.drafts.awaitingReview).toBe(1);
    expect(repo.latestDraftForJob(first.jobId)).toMatchObject({ status: DraftStatus.AWAITING_REVIEW });
    expect(repo.latestDraftForJob(first.jobId)!.id).not.toBe(first.id);
  });

  test("nothing is applied for until the user approves, and then only approved drafts", async () => {
    await runCycle(deps());
    const [first] = repo.listDrafts(DraftStatus.AWAITING_REVIEW);

    await runCycle(deps({ applier: applier() }), ["apply"]);
    expect(applied).toEqual([]);

    repo.setDraftStatus(first.id, DraftStatus.APPROVED);
    const report = await runCycle(deps({ applier: applier() }), ["apply"]);
    expect(report.applications).toEqual({ submitted: 1, handedOff: 0, failed: 0 });
    expect(applied.map((entry) => entry.job.id)).toEqual([first.jobId]);
    expect(repo.getDraft(first.id)!.status).toBe(DraftStatus.SUBMITTED);
    expect(repo.getJob(first.jobId)!.stage).toBe(PipelineStage.SUBMITTED);
    expect(repo.listDispatches(first.jobId)).toHaveLength(1);

    await runCycle(deps({ applier: applier() }), ["apply"]);
    expect(applied).toHaveLength(1); // a submitted draft is never applied for twice
  });

  test("a form left for the user is marked as needing attention, with what is left", async () => {
    await runCycle(deps());
    const [first] = repo.listDrafts(DraftStatus.AWAITING_REVIEW);
    repo.setDraftStatus(first.id, DraftStatus.APPROVED);
    const handedOff = filled("handed_off", { reason: "Waiting for you to press Submit", unfilled: ["Work authorization"] });

    const report = await runCycle(deps({ applier: applier(handedOff) }), ["apply"]);
    expect(report.applications).toEqual({ submitted: 0, handedOff: 1, failed: 0 });
    const stored = repo.getDraft(first.id)!;
    expect(stored.status).toBe(DraftStatus.NEEDS_ATTENTION);
    expect(stored.note).toContain("Work authorization");
    expect(repo.listDispatches()).toEqual([]); // not counted as sent until it is
  });

  test("an operator crash on one application does not stop the cycle", async () => {
    await runCycle(deps());
    for (const stored of repo.listDrafts(DraftStatus.AWAITING_REVIEW)) repo.setDraftStatus(stored.id, DraftStatus.APPROVED);
    let calls = 0;
    const flaky: Applier = {
      inspect: NO_FORM,
      apply: async () => {
        calls += 1;
        if (calls === 1) throw new Error("Chrome crashed");
        return filled("submitted");
      },
    };
    const report = await runCycle(deps({ applier: flaky }), ["apply"]);
    expect(report.applications).toEqual({ submitted: 1, handedOff: 0, failed: 1 });
    expect(repo.listDrafts(DraftStatus.NEEDS_ATTENTION)[0].note).toContain("Chrome crashed");
  });

  test("a draft whose form is open is already marked, so a process that dies there cannot submit it twice", async () => {
    await runCycle(deps());
    const [first] = repo.listDrafts(DraftStatus.AWAITING_REVIEW);
    repo.setDraftStatus(first.id, DraftStatus.APPROVED);
    let during: { status: string; note: string } | null = null;
    const watching: Applier = {
      inspect: NO_FORM,
      apply: async () => {
        const stored = repo.getDraft(first.id)!;
        during = { status: stored.status, note: stored.note };
        return filled("submitted");
      },
    };
    await runCycle(deps({ applier: watching }), ["apply"]);
    // Had the process stopped inside apply, this is the state the next run would have found: not approved.
    expect(during).toEqual({ status: DraftStatus.NEEDS_ATTENTION, note: INTERRUPTED });
    expect(repo.getDraft(first.id)).toMatchObject({ status: DraftStatus.SUBMITTED, note: "" });
  });

  test("the user is told once per cycle about everything left for them, and not at all when nothing is", async () => {
    await runCycle(deps());
    for (const stored of repo.listDrafts(DraftStatus.AWAITING_REVIEW)) repo.setDraftStatus(stored.id, DraftStatus.APPROVED);
    const told: string[] = [];
    const notify = (message: string) => told.push(message);

    await runCycle(deps({ applier: applier(filled("handed_off", { reason: "Login required" })), notify }), ["apply"]);
    expect(told).toEqual(["2 applications need you — run: npm run reygent -- assist"]);

    for (const stored of repo.listDrafts(DraftStatus.NEEDS_ATTENTION)) repo.setDraftStatus(stored.id, DraftStatus.APPROVED);
    await runCycle(deps({ applier: applier(), notify }), ["apply"]);
    expect(told).toHaveLength(1);
  });

  test("the daily submission limit is respected", async () => {
    config.pipeline.max_submissions_per_day = 1;
    await runCycle(deps());
    for (const stored of repo.listDrafts(DraftStatus.AWAITING_REVIEW)) repo.setDraftStatus(stored.id, DraftStatus.APPROVED);
    await runCycle(deps({ applier: applier() }), ["apply"]);
    expect(applied).toHaveLength(1);
    expect(repo.listDrafts(DraftStatus.APPROVED)).toHaveLength(1);
  });

  test("a company already contacted inside the window is not contacted again at apply time", async () => {
    await runCycle(deps());
    const [first, second] = repo.listDrafts(DraftStatus.AWAITING_REVIEW);
    const firstJob = repo.getJob(first.jobId)!;
    repo.recordDispatch({ jobId: "earlier", channel: Channel.ATS_INBOUND, ...dispatchKeys(first.draft, firstJob) });
    repo.setDraftStatus(first.id, DraftStatus.APPROVED);
    repo.setDraftStatus(second.id, DraftStatus.APPROVED);

    await runCycle(deps({ applier: applier() }), ["apply"]);
    expect(applied.map((entry) => entry.job.id)).toEqual([second.jobId]);
    expect(repo.getDraft(first.id)).toMatchObject({ status: DraftStatus.NEEDS_ATTENTION });
    expect(repo.getDraft(first.id)!.note).toContain("Already contacted");
  });

  test("a founder-direct pitch is never pushed through the browser", async () => {
    const hn = createJob({
      source: "hn", sourceId: "42", company: "Lattice Works", title: "Founding AI Engineer",
      location: "Remote (Worldwide)", channel: Channel.FOUNDER_DIRECT,
      description: "Remote worldwide. Python, LangGraph. Email founder@latticeworks.dev", skills: ["Python"],
      applyUrl: "https://news.ycombinator.com/item?id=42",
    });
    await runCycle(deps({ discover: async () => ({ jobs: [hn], errors: [] }) }));
    const [stored] = repo.listDrafts(DraftStatus.AWAITING_REVIEW);
    expect(stored.draft.contact).toBe("founder@latticeworks.dev");
    expect(stored.draft.resumePdfPath).toBe("");
    repo.setDraftStatus(stored.id, DraftStatus.APPROVED);

    await runCycle(deps({ applier: applier() }), ["apply"]);
    expect(applied).toEqual([]);
    expect(repo.getDraft(stored.id)!.status).toBe(DraftStatus.APPROVED); // waits for the user to send it
  });

  test("drafting is blocked, and says why, until the profile and fact bank are real", async () => {
    config.candidate.name = "CHANGE_ME";
    config.fact_bank.achievements[0].verified = false;
    const report = await runCycle(deps());
    expect(report.blocked).toHaveLength(2);
    expect(report.drafts).toEqual({ awaitingReview: 0, approved: 0, quarantined: 0, skipped: 0 });
    expect(repo.listDrafts()).toEqual([]);
    expect(report.added).toBe(4); // discovery and qualification still ran
  });

  test("a draft the Cop Tool rejects is counted as quarantined and not stored", async () => {
    const rejecting: DraftInspector = {
      inspectApplicationDraft: async (draft) => ({ passed: false, draft, retries: 2, quarantineIds: [7] }),
    };
    const report = await runCycle(deps({ inspector: rejecting }));
    expect(report.drafts).toMatchObject({ awaitingReview: 0, quarantined: 2 });
    expect(repo.listDrafts()).toEqual([]);
  });

  test("reaching the spend cap pauses paid steps but free ones carry on", async () => {
    const capped = fakeDecider({
      decideEnum: async () => {
        throw new CircuitBreakerError(1.5, 1.5);
      },
    });
    const report = await runCycle(deps({ decider: capped }));
    expect(report.paused).toBe(true);
    expect(report.added).toBe(4);
    expect(report.scored).toBe(2); // the two Tier 1 jobs, scored by the free fallback
    expect(report.drafts).toEqual({ awaitingReview: 0, approved: 0, quarantined: 0, skipped: 0 });
    expect(stages()["Fathom Systems"]).toBe(PipelineStage.INVESTIGATING); // still queued for tomorrow
  });

  test("with no API keys the pipeline still classifies, scores and drafts for free", async () => {
    const report = await runCycle(deps({ decider: null }));
    expect(report.investigated).toEqual({ qualified: 0, disqualified: 0, needs_human: 1 });
    expect(report.scored).toBe(2);
    expect(report.paused).toBe(false);
    expect(report.drafts.awaitingReview).toBeGreaterThanOrEqual(1);
  });

  test("a failing source is reported without losing the rest", async () => {
    const report = await runCycle(deps({
      discover: async () => ({ jobs: LISTINGS().slice(0, 1), errors: [{ source: "lever:acme", message: "HTTP 404" }] }),
    }));
    expect(report.errors).toEqual(["lever:acme: HTTP 404"]);
    expect(report.added).toBe(1);

    const crashed = await runCycle(deps({
      discover: async () => {
        throw new Error("network down");
      },
    }));
    expect(crashed.errors).toEqual(["discover: network down"]);
  });

  test("only the requested steps run", async () => {
    const report = await runCycle(deps(), ["discover"]);
    expect(report).toMatchObject({ added: 4, scored: 0, steps: ["discover"] });
    expect(stages()["Northwind Labs"]).toBe(PipelineStage.QUALIFIED);
  });
});

describe("hands-free pipeline (the default)", () => {
  let repo: Repository;
  let tmp: string;
  let config: Config;

  const SPONSORSHIP = "Will you now or in the future require visa sponsorship?";
  const field = (id: string, label: string, extra: Partial<FormField> = {}): FormField => ({
    id, label, type: "text", required: true, options: [], ...extra,
  });
  const FORM: FormField[] = [
    field("first", "First Name"),
    field("last", "Last Name"),
    field("email", "Email", { type: "email" }),
    field("resume", "Resume/CV", { type: "file" }),
    field("sponsor", SPONSORSHIP, { type: "select", options: ["Yes", "No"] }),
    field("felony", "Have you ever been convicted of a felony?", { type: "select", options: ["Yes", "No"], required: true }),
  ];
  /** A form with nothing but the standard fields: name, email, resume. */
  const STANDARD = FORM.slice(0, 4);

  beforeEach(() => {
    repo = new Repository(":memory:");
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "reygent-pipeline-"));
    config = makeConfig();
  });
  afterEach(() => {
    repo.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  const applied: Array<{ job: JobOpportunity; draft: ApplicationDraft }> = [];
  const applier = (fields: FormField[], result: FillReport = filled("submitted")): Applier => ({
    inspect: async (job) => ({ url: job.applyUrl, fields, blockers: [] }),
    apply: async (job, draft) => {
      applied.push({ job, draft });
      return result;
    },
  });
  const deps = (overrides: Partial<PipelineDeps> = {}): PipelineDeps => ({
    repo, config, decider: fakeDecider(), generator: null, inspector: passingInspector,
    discover: async () => ({ jobs: LISTINGS(), errors: [] }),
    renderPdf: async (_html, outputPath) => {
      fs.mkdirSync(path.dirname(outputPath), { recursive: true });
      fs.writeFileSync(outputPath, "%PDF-1.4 test");
    },
    applier: null, clock: () => NOW, resumeDir: tmp, ...overrides,
  });

  test("one cycle goes from a new listing to a submitted application with nobody in the loop", async () => {
    applied.length = 0;
    const report = await runCycle(deps({ applier: applier(FORM.slice(0, 5)) }));

    expect(report.drafts).toEqual({ awaitingReview: 0, approved: 2, quarantined: 0, skipped: 0 });
    expect(report.applications).toEqual({ submitted: 2, handedOff: 0, failed: 0 });
    expect(applied).toHaveLength(2);
    expect(repo.listJobs().filter((job) => job.stage === PipelineStage.SUBMITTED)).toHaveLength(2);
    expect(repo.listDispatches()).toHaveLength(2);
    // The form's custom question was answered from the candidate's data, not left blank.
    expect(applied[0].draft.screeningAnswers).toEqual([
      { question: SPONSORSHIP, answer: "No", options: ["Yes", "No"], factKey: "" },
    ]);
  });

  test("an AI answer is remembered, so the same question gets the same answer next time", async () => {
    await runCycle(deps({ applier: applier(FORM.slice(0, 5)) }));
    expect(repo.getStandingAnswer(SPONSORSHIP)).toMatchObject({ answer: "No", source: "ai", options: ["Yes", "No"] });

    // The user corrects it once; every later draft uses their answer, without asking the model again.
    repo.saveStandingAnswer({ question: SPONSORSHIP, answer: "Yes", options: ["Yes", "No"], source: "user" });
    let asked = 0;
    const counting = fakeDecider({
      decideEnum: async (_state, _instructions, options) => {
        if ("No" in options) asked += 1;
        return { value: "No" in options ? "No" : "viable", confidence: 0.95, probabilities: {} };
      },
    });
    const later = listing("9", {
      company: "Kestrel", title: "Senior AI Agent Engineer", location: "Remote (Worldwide)",
      description: "Python and LangGraph agents.", skills: ["Python", "LangGraph"],
    });
    applied.length = 0;
    await runCycle(deps({ decider: counting, applier: applier(FORM.slice(0, 5)), discover: async () => ({ jobs: [later], errors: [] }) }));
    expect(applied.at(-1)!.draft.screeningAnswers[0].answer).toBe("Yes");
    expect(asked).toBe(0);
    expect(repo.getStandingAnswer(SPONSORSHIP)).toMatchObject({ answer: "Yes", source: "user" });
  });

  test("a question the model is not sure about is left unanswered rather than guessed", async () => {
    const unsure = fakeDecider({
      decideEnum: async (_state, _instructions, options) =>
        "No" in options
          ? { value: "No", confidence: 0.6, probabilities: {} }
          : { value: "viable", confidence: 0.95, probabilities: {} },
    });
    applied.length = 0;
    await runCycle(deps({ decider: unsure, applier: applier(FORM) }));
    for (const { draft } of applied) {
      // Sponsorship is settled by where the candidate lives; the felony question is the model's,
      // and it is unsure: required, so listed — but empty.
      expect(draft.screeningAnswers.map((item) => item.answer)).toEqual(["No", ""]);
    }
    // Nothing unverified is remembered: only the sponsorship answer, which is no guess.
    expect(repo.listStandingAnswers().map((item) => [item.question, item.answer])).toEqual([[SPONSORSHIP, "No"]]);
  });

  test("a Tier 2 job the investigation cannot settle is applied for anyway, with a contractor pitch", async () => {
    applied.length = 0;
    const unsure = fakeDecider({ decideEnum: async () => ({ value: "viable", confidence: 0.4, probabilities: {} }) });
    const report = await runCycle(deps({ decider: unsure, applier: applier(STANDARD) }));
    expect(report.investigated.needs_human).toBe(1);
    expect(report.pitchedUnconfirmed).toBe(1);
    const fathom = repo.listJobs().find((job) => job.company === "Fathom Systems")!;
    expect(repo.getEvaluation(fathom.id)!.reasonCodes).toContain("B2B_UNCONFIRMED");
    expect(fathom.stage).not.toBe(PipelineStage.INVESTIGATING);
  });

  test("an unsettled job whose listing names a country is parked for the user, not applied for on a guess", async () => {
    applied.length = 0;
    const scoped = listing("pl", {
      company: "Vistula", title: "Agent Platform Engineer", location: "Remote, Poland",
      description: "Fully remote team. Python and LangGraph.", skills: ["Python", "LangGraph"],
    });
    const unsure = fakeDecider({ decideEnum: async () => ({ value: "viable", confidence: 0.4, probabilities: {} }) });
    const first = await runCycle(deps({ decider: unsure, applier: applier(STANDARD), discover: async () => ({ jobs: [scoped], errors: [] }) }));
    expect(first.investigated.needs_human).toBe(1);
    expect(first.pitchedUnconfirmed).toBe(0);
    expect(repo.getJob(scoped.id)!.stage).toBe(PipelineStage.INVESTIGATING);
    expect(applied).toEqual([]);

    // It is not asked about again every cycle, and the user can still wave it through.
    let asked = 0;
    const counting = fakeDecider({
      decideEnum: async () => {
        asked += 1;
        return { value: "viable", confidence: 0.4, probabilities: {} };
      },
    });
    await runCycle(deps({ decider: counting, applier: applier(STANDARD), discover: async () => ({ jobs: [], errors: [] }) }));
    expect(asked).toBe(0);
    expect(repo.getJob(scoped.id)!.stage).toBe(PipelineStage.INVESTIGATING);
  });

  test("with single-country listings let through, one already parked is applied for like any unsettled job", async () => {
    applied.length = 0;
    const scoped = listing("pl", {
      company: "Vistula", title: "Agent Platform Engineer", location: "Remote, Poland",
      description: "Fully remote team. Python and LangGraph.", skills: ["Python", "LangGraph"],
    });
    const unsure = fakeDecider({ decideEnum: async () => ({ value: "viable", confidence: 0.4, probabilities: {} }) });
    await runCycle(deps({ decider: unsure, applier: applier(STANDARD), discover: async () => ({ jobs: [scoped], errors: [] }) }));
    expect(repo.getJob(scoped.id)!.stage).toBe(PipelineStage.INVESTIGATING);

    config.pipeline.apply_single_country = true;
    const next = await runCycle(deps({ decider: unsure, applier: applier(STANDARD), discover: async () => ({ jobs: [], errors: [] }) }));
    expect(next.pitchedUnconfirmed).toBe(1);
    expect(repo.getEvaluation(scoped.id)!.reasonCodes).toEqual(expect.arrayContaining(["SINGLE_COUNTRY_LOCATION", "B2B_UNCONFIRMED"]));
    expect(repo.getJob(scoped.id)!.stage).not.toBe(PipelineStage.INVESTIGATING);
  });

  test("with no decision model, hands-free does nothing past discovery — and says why", async () => {
    applied.length = 0;
    const report = await runCycle(deps({ decider: null, applier: applier(STANDARD) }));
    expect(report.added).toBe(4);
    expect(report).toMatchObject({
      investigated: { qualified: 0, disqualified: 0, needs_human: 0 }, pitchedUnconfirmed: 0, scored: 0,
      drafts: { awaitingReview: 0, approved: 0, quarantined: 0, skipped: 0 },
    });
    expect(report.blocked).toEqual([expect.stringContaining("TypeSafe (Jev) key")]);
    const stages = Object.fromEntries(repo.listJobs().map((job) => [job.company, job.stage]));
    expect(stages["Fathom Systems"]).toBe(PipelineStage.INVESTIGATING); // still queued, not waved through
    expect(repo.getFit(repo.listJobs().find((job) => job.company === "Northwind Labs")!.id)).toBeNull();
    expect(applied).toEqual([]);
  });

  test("hands-free never applies on the keyword score: a failed or capped scoring call leaves the job unscored", async () => {
    const failing = fakeDecider({
      decideScore: async () => {
        throw new Error("HTTP 500");
      },
    });
    const failed = await runCycle(deps({ decider: failing, applier: applier(STANDARD) }));
    expect(failed.scored).toBe(0);
    expect(failed.drafts.approved).toBe(0);
    expect(failed.errors.some((line) => line.includes("HTTP 500"))).toBe(true);

    const capped = fakeDecider({
      decideScore: async () => {
        throw new CircuitBreakerError(1.5, 1.5);
      },
    });
    const paused = await runCycle(deps({ decider: capped, applier: applier(STANDARD) }));
    expect(paused).toMatchObject({ paused: true, scored: 0, drafts: { approved: 0 } });

    // Once the model answers again, the same jobs are scored and move on.
    const recovered = await runCycle(deps({ applier: applier(STANDARD) }));
    expect(recovered.scored).toBe(3);
    expect(recovered.drafts.approved).toBe(2);
  });

  test("a failing decision service is reported once and stops being called", async () => {
    let calls = 0;
    const down = fakeDecider({
      decideEnum: async () => {
        calls += 1;
        throw new Error("HTTP 401 invalid key");
      },
    });
    const many = Array.from({ length: 8 }, (_, i) =>
      listing(`t2-${i}`, { company: `Vague ${i}`, title: "Agent Platform Engineer", location: "Remote", description: "Fully remote team. Python." }),
    );
    const report = await runCycle(deps({ decider: down, discover: async () => ({ jobs: many, errors: [] }) }), ["discover", "investigate"]);
    expect(calls).toBe(3);
    expect(report.errors).toEqual([expect.stringMatching(/^investigate: 3 calls failed, e\.g\. Vague \d — Agent Platform Engineer: HTTP 401 invalid key$/)]);
    expect(report.pitchedUnconfirmed).toBe(0); // a job nobody investigated is not "unsettled"
  });

  test("a form that cannot be completed hands-free is set aside, not retried forever, and nobody is told to finish it", async () => {
    applied.length = 0;
    const told: string[] = [];
    const captcha = filled("handed_off", { reason: "CAPTCHA on the form", blockers: ["captcha"] });
    const report = await runCycle(deps({ applier: applier(STANDARD, captcha), notify: (message) => told.push(message) }));
    // The second form is on the same host, and is tried all the same.
    expect(report).toMatchObject({ unattended: true, applications: { submitted: 0, handedOff: 2, failed: 0 } });
    expect(repo.listDrafts(DraftStatus.DECLINED).map((stored) => stored.note)).toEqual([
      "Set aside: CAPTCHA on the form.", "Set aside: CAPTCHA on the form.",
    ]);
    expect(repo.listDrafts(DraftStatus.APPROVED)).toHaveLength(0);
    expect(report.waiting).toEqual({ toSend: 0, held: 0, needsAttention: 0 });
    expect(told).toEqual([]);
    applied.length = 0;
    await runCycle(deps({ applier: applier(STANDARD, captcha) }));
    expect(applied).toEqual([]);
    expect(repo.listDispatches()).toEqual([]);
  });

  test("with someone at the window, or with Submit already pressed, an unfinished form waits instead", async () => {
    // `assist` and `--watch`: a person finishes it.
    const handedOff = filled("handed_off", { reason: "Required question not answered: Location" });
    await runCycle(deps({ applier: applier(STANDARD, handedOff), attended: true }));
    expect(repo.listDrafts(DraftStatus.NEEDS_ATTENTION)).toHaveLength(2);
    expect(repo.listDrafts(DraftStatus.DECLINED)).toEqual([]);
  });

  test("an application that may have gone through is never set aside: its company stays spoken for", async () => {
    const unconfirmed = filled("handed_off", {
      reason: "Submit was pressed but no confirmation page appeared — check before re-applying", pressed: true,
    });
    const report = await runCycle(deps({ applier: applier(STANDARD, unconfirmed) }));
    expect(repo.listDrafts(DraftStatus.NEEDS_ATTENTION)).toHaveLength(2);
    expect(report.waiting.needsAttention).toBe(2);
  });

  test("a site that asks for a human check is never paused: its other forms are still tried", async () => {
    applied.length = 0;
    const checked = filled("handed_off", {
      reason: "Not submitted: after Submit the site emailed you a security code to confirm a person is applying.",
      blockers: ["captcha"], pressed: true,
    });
    const report = await runCycle(deps({ applier: applier(STANDARD, checked) }));
    // Both forms are on the same host, and the first asking for a person does not stop the second.
    expect(applied).toHaveLength(2);
    expect(report.applications).toEqual({ submitted: 0, handedOff: 2, failed: 0 });
  });

  test("an application that needs an emailed code is held for the candidate, keeps its company, and is not submitted again by itself", async () => {
    config.apply.code_handoff = true;
    applied.length = 0;
    const coded = filled("handed_off", {
      reason: "Not submitted: after Submit the site emailed you a code to confirm a person is applying",
      blockers: ["captcha"], pressed: false, emailedCode: true,
    });
    await runCycle(deps({ applier: applier(STANDARD, coded) }));
    expect(applied).toHaveLength(2);
    const held = repo.listDrafts(DraftStatus.NEEDS_ATTENTION);
    expect(held.map((draft) => draft.note)).toEqual([
      `${NEEDS_CODE}: Not submitted: after Submit the site emailed you a code to confirm a person is applying`,
      `${NEEDS_CODE}: Not submitted: after Submit the site emailed you a code to confirm a person is applying`,
    ]);

    // Pressing Submit again unasked would only send another code nobody is there for.
    applied.length = 0;
    await runCycle(deps({ applier: applier(STANDARD, filled("submitted")) }), ["apply"]);
    expect(applied).toHaveLength(0);
  });

  test("without code_handoff, an application that needs an emailed code is set aside", async () => {
    config.apply.code_handoff = false;
    const coded = filled("handed_off", { reason: "Not submitted: after Submit the site emailed you a code", pressed: false, emailedCode: true });
    await runCycle(deps({ applier: applier(STANDARD, coded) }));
    expect(repo.listDrafts(DraftStatus.DECLINED).map((draft) => draft.note)).toEqual([
      "Set aside: Not submitted: after Submit the site emailed you a code.", "Set aside: Not submitted: after Submit the site emailed you a code.",
    ]);
  });

  test("applications that waited for a code by email are moved to the dashboard without being submitted again", async () => {
    config.apply.code_handoff = true;
    await runCycle(deps({ applier: applier(STANDARD, filled("handed_off", { reason: "Login required" })) }), ["discover", "investigate", "score", "draft"]);
    const [first, second] = repo.listDrafts(DraftStatus.APPROVED);
    repo.setDraftStatus(first.id, DraftStatus.APPROVED, "Waiting for the next day's emailed codes: Not submitted: today's emailed-code request limit was reached");
    repo.setDraftStatus(second.id, DraftStatus.APPROVED, "The emailed code went unanswered once: Not submitted: no reply with the emailed code came within 10 minutes");
    applied.length = 0;
    await runCycle(deps({ applier: applier(STANDARD, filled("submitted")) }), ["apply"]);
    expect(applied).toHaveLength(0);
    expect(repo.listDrafts(DraftStatus.NEEDS_ATTENTION).map((draft) => draft.note)).toEqual([
      `${NEEDS_CODE}: after Submit the site emailed you a code to confirm a person is applying`,
      `${NEEDS_CODE}: after Submit the site emailed you a code to confirm a person is applying`,
    ]);
  });

  test("a form that did not open is tried once more before it is set aside", async () => {
    const down = filled("failed", { reason: "page.goto: Timeout 30000ms exceeded" });
    await runCycle(deps({ applier: applier(STANDARD, down) }));
    expect(repo.listDrafts(DraftStatus.APPROVED).map((stored) => stored.note)).toEqual([
      "Could not be opened once: page.goto: Timeout 30000ms exceeded",
      "Could not be opened once: page.goto: Timeout 30000ms exceeded",
    ]);

    applied.length = 0;
    await runCycle(deps({ applier: applier(STANDARD, down) }), ["apply"]);
    expect(applied).toHaveLength(2);
    expect(repo.listDrafts(DraftStatus.DECLINED).map((stored) => stored.note)).toEqual([
      "Set aside: page.goto: Timeout 30000ms exceeded.", "Set aside: page.goto: Timeout 30000ms exceeded.",
    ]);
  });

  test("an application set aside frees its company: the next best role there is applied for", async () => {
    const opening = (sourceId: string, title: string) =>
      listing(sourceId, {
        company: "Northwind Labs", title, location: "Remote (Worldwide)", skills: ["Python", "LangGraph"],
        description: "Build LangGraph agents in Python. Contractors are paid through Deel.",
      });
    const best = opening("n1", "Senior AI Agent Engineer");
    const next = opening("n2", "AI Agent Engineer");
    const scores = fakeDecider({
      decideScore: async (state) => ({ value: JSON.stringify(state).includes("Senior AI Agent") ? 4 : 3, confidence: 0.9, probabilities: {} }),
    });
    const tried: string[] = [];
    const firstFails: Applier = {
      inspect: async (job) => ({ url: job.applyUrl, fields: STANDARD, blockers: [] }),
      apply: async (job) => {
        tried.push(job.id);
        return job.id === best.id ? filled("handed_off", { reason: "CAPTCHA on the form" }) : filled("submitted");
      },
    };
    const run = () => runCycle(deps({ decider: scores, applier: firstFails, discover: async () => ({ jobs: [best, next], errors: [] }) }));

    await run();
    expect(tried).toEqual([best.id]);
    await run();
    expect(tried).toEqual([best.id, next.id]);
    expect(repo.getJob(next.id)!.stage).toBe(PipelineStage.SUBMITTED);
    // One application at the company, and only one.
    expect(repo.listDispatches()).toHaveLength(1);
  });

  test("a listing whose application page shows no form is not drafted for, and is dropped on the second miss", async () => {
    applied.length = 0;
    const gone: Applier = {
      inspect: async (job) => ({ url: job.applyUrl, fields: [], blockers: [] }),
      apply: async (job, draft) => {
        applied.push({ job, draft });
        return filled("submitted");
      },
    };
    const first = await runCycle(deps({ applier: gone }));
    expect(first.drafts).toEqual({ awaitingReview: 0, approved: 0, quarantined: 0, skipped: 2 });
    expect(repo.listDrafts()).toEqual([]);
    const northwind = () => repo.listJobs().find((job) => job.company === "Northwind Labs")!;
    // A page can fail to load once: the job keeps its place for one more look.
    expect(northwind().stage).toBe(PipelineStage.QUALIFIED);
    expect(repo.getEvaluation(northwind().id)!.reasonCodes).toContain("FORM_NOT_FOUND");

    const second = await runCycle(deps({ applier: gone }));
    expect(second.drafts.skipped).toBe(2);
    expect(northwind().stage).toBe(PipelineStage.DISQUALIFIED);
    expect(repo.getEvaluation(northwind().id)!.reasonCodes).toContain("NO_APPLICATION_FORM");
    expect(applied).toEqual([]);

    // A login wall in front of the form is not a missing form: the draft is written and the user is asked.
    const walled: Applier = { ...gone, inspect: async (job) => ({ url: job.applyUrl, fields: [], blockers: ["login"] }) };
    const later = listing("9", {
      company: "Kestrel", title: "Senior AI Agent Engineer", location: "Remote (Worldwide)",
      description: "Python and LangGraph agents.", skills: ["Python", "LangGraph"],
    });
    const third = await runCycle(deps({ applier: walled, discover: async () => ({ jobs: [later], errors: [] }) }));
    expect(third.drafts.approved).toBe(1);
  });

  test("a form that makes applicants agree not to use AI is left to the candidate: nothing is written for it", async () => {
    applied.length = 0;
    const ownWords = field(
      "pledge",
      "During this application process I agree to use only my own words. I understand that plagiarism, the use of AI or other generated content will result in disqualification.",
      { type: "select", options: ["Yes", "No"] },
    );
    const report = await runCycle(deps({ applier: applier([...STANDARD, ownWords]) }));
    expect(report.drafts).toEqual({ awaitingReview: 0, approved: 0, quarantined: 0, skipped: 2 });
    expect(repo.listDrafts()).toEqual([]);
    expect(applied).toEqual([]);
    const northwind = repo.listJobs().find((job) => job.company === "Northwind Labs")!;
    expect(northwind.stage).toBe(PipelineStage.DISQUALIFIED);
    expect(repo.getEvaluation(northwind.id)!.reasonCodes).toContain("OWN_WORDS_ONLY");
  });

  test("a form that asks the applicant to prove they are a person is left to the candidate: nothing is written for it", async () => {
    applied.length = 0;
    const robots = field("code", "What is the application code found in the browser console at https://metabase.com/jobs (to help us filter out robots)");
    const report = await runCycle(deps({ applier: applier([...STANDARD, robots]) }));
    expect(report.drafts).toEqual({ awaitingReview: 0, approved: 0, quarantined: 0, skipped: 2 });
    expect(repo.listDrafts()).toEqual([]);
    expect(applied).toEqual([]);
    const northwind = repo.listJobs().find((job) => job.company === "Northwind Labs")!;
    expect(northwind.stage).toBe(PipelineStage.DISQUALIFIED);
    expect(repo.getEvaluation(northwind.id)!.reasonCodes).toContain("PROVE_HUMAN");
  });

  test("an employer's consent to its own use of AI is an ordinary question, not a ban on the applicant's", async () => {
    applied.length = 0;
    const consent = field("ai", "By selecting Yes, I am consenting to the use of AI for evaluating my candidacy.", { type: "select", options: ["Yes", "No"] });
    const agree = fakeDecider({ decideEnum: async (_state, _instructions, options) => ({ value: "Yes" in options ? "Yes" : "viable", confidence: 0.95, probabilities: {} }) });
    const report = await runCycle(deps({ decider: agree, applier: applier([...STANDARD, consent]) }));
    expect(report.drafts.approved).toBe(2);
    expect(applied[0].draft.screeningAnswers).toEqual([{ question: consent.label, answer: "Yes", options: ["Yes", "No"], factKey: "" }]);
  });

  test("without a browser nothing is submitted: approved drafts wait for a process that has one", async () => {
    const report = await runCycle(deps());
    expect(report.drafts.approved).toBe(2);
    expect(report.applications).toEqual({ submitted: 0, handedOff: 0, failed: 0 });
    expect(repo.listDrafts(DraftStatus.APPROVED)).toHaveLength(2);
  });
});

describe("pipeline helpers", () => {
  let repo: Repository;
  beforeEach(() => {
    repo = new Repository(":memory:");
  });
  afterEach(() => repo.close());

  test("dispatch keys identify the company, its own domain, and the person", () => {
    const job = createJob({ source: "hn", sourceId: "1", company: "Acme, Inc.", title: "Engineer" });
    expect(dispatchKeys(createDraft({ jobId: job.id, contact: "Jane@Acme.io" }), job)).toEqual({
      companyKey: "acme", domain: "acme.io", contact: "jane@acme.io",
    });
    // A shared mailbox provider or a social handle says nothing about the company.
    expect(dispatchKeys(createDraft({ jobId: job.id, contact: "jane@gmail.com" }), job).domain).toBe("");
    expect(dispatchKeys(createDraft({ jobId: job.id, contact: "@jane" }), job).domain).toBe("");
    const known = createJob({ source: "x", sourceId: "2", company: "Acme", title: "Engineer", companyDomain: "www.Acme.com" });
    expect(dispatchKeys(createDraft({ jobId: known.id }), known).domain).toBe("acme.com");
  });

  test("recording a submission logs the dispatch and moves draft and job together", () => {
    const job = createJob({ source: "greenhouse", sourceId: "1", company: "Acme", title: "Engineer" });
    repo.insertJob(job);
    const id = repo.saveDraft(createDraft({ jobId: job.id, channel: Channel.CONTRACT_GIGS }), DraftStatus.APPROVED);
    recordSubmission(repo, repo.getDraft(id)!, job, NOW);
    expect(repo.getDraft(id)!.status).toBe(DraftStatus.SUBMITTED);
    expect(repo.getJob(job.id)!.stage).toBe(PipelineStage.SUBMITTED);
    expect(repo.listDispatches(job.id)[0]).toMatchObject({ channel: Channel.CONTRACT_GIGS, companyKey: "acme" });
  });

  test("drafting blockers name what is missing", () => {
    const config = makeConfig();
    expect(draftingBlockers(new ProfileManager(repo, config).build())).toEqual([]);
    config.candidate.email = "CHANGE_ME";
    config.fact_bank.achievements = [];
    expect(draftingBlockers(new ProfileManager(repo, config).build())).toHaveLength(2);
  });

  test("jobs to draft are the best-fitting ones, within the limit, without an existing draft", () => {
    const scores = [95, 80, 70, 40];
    const jobs = scores.map((score, i) => {
      const job = createJob({ source: "greenhouse", sourceId: String(i), company: `Company ${i}`, title: "Engineer", location: "Remote (Worldwide)" });
      qualifyJob(repo, job);
      repo.saveFit({ jobId: job.id, fitScore: score, bestPositioningProfile: "fullstack_product", matchedSkills: [], missingSkills: [] });
      return job;
    });
    repo.saveDraft(createDraft({ jobId: jobs[1].id }), DraftStatus.AWAITING_REVIEW); // already drafted

    const chosen = chooseJobsToDraft(repo, 2, 60);
    expect(chosen.map((entry) => entry.fit.fitScore)).toEqual([95, 70]);
    expect(chooseJobsToDraft(repo, 10, 60).map((entry) => entry.fit.fitScore)).toEqual([95, 70]); // 40 is under the threshold
  });

  test("a listing that names one country gives way to another open role at its company", () => {
    const qualified = (sourceId: string, company: string, location: string, fit: number) => {
      const job = createJob({
        source: "greenhouse", sourceId, company, title: `Engineer ${sourceId}`, location,
        applyUrl: `https://job-boards.greenhouse.io/${company.toLowerCase()}/jobs/${sourceId}`,
      });
      qualifyJob(repo, job);
      repo.setJobStage(job.id, PipelineStage.QUALIFIED); // as an unsettled one is once let through
      repo.saveFit({ jobId: job.id, fitScore: fit, bestPositioningProfile: "fullstack_product", matchedSkills: [], missingSkills: [] });
      return job;
    };
    const spain = qualified("es", "Acme", "Remote, Spain", 90);
    const broad = qualified("ww", "Acme", "Remote (Worldwide)", 70);
    const alone = qualified("pt", "Solo", "Remote, Portugal", 80);
    expect(repo.getEvaluation(spain.id)!.reasonCodes).toContain("SINGLE_COUNTRY_LOCATION");

    // Acme's broader role goes, though it fits less; Solo has nothing else, so its one goes.
    expect(chooseJobsToDraft(repo, 10, 60).map((entry) => entry.job.id)).toEqual([alone.id, broad.id]);
  });

  test("lowering the fit threshold brings back what was passed over only for its fit", () => {
    const scored = (sourceId: string, fit: number, codes: string[]) => {
      const job = createJob({ source: "greenhouse", sourceId, company: `Co ${sourceId}`, title: "Engineer", location: "Remote (Worldwide)" });
      qualifyJob(repo, job);
      repo.saveFit({ jobId: job.id, fitScore: fit, bestPositioningProfile: "fullstack_product", matchedSkills: [], missingSkills: [] });
      repo.saveEvaluation({ ...repo.getEvaluation(job.id)!, reasonCodes: ["WORLDWIDE", ...codes] });
      repo.setJobStage(job.id, PipelineStage.DISQUALIFIED);
      return job;
    };
    const partial = scored("p", 55, ["LOW_FIT"]);
    const poor = scored("q", 30, ["LOW_FIT"]);
    const formGone = scored("r", 58, ["LOW_FIT", "FORM_NOT_FOUND", "NO_APPLICATION_FORM"]);
    const ruledOut = scored("s", 70, ["NOT_REMOTE"]);

    expect(readmitLowFit(repo, 60)).toBe(0);
    expect(readmitLowFit(repo, 50)).toBe(1);
    expect(repo.getJob(partial.id)!.stage).toBe(PipelineStage.QUALIFIED);
    expect(repo.getEvaluation(partial.id)!.reasonCodes).toEqual(["WORLDWIDE"]);
    for (const job of [poor, formGone, ruledOut]) expect(repo.getJob(job.id)!.stage).toBe(PipelineStage.DISQUALIFIED);
    expect(readmitLowFit(repo, 50)).toBe(0);
  });

  test("one application per company at a time", () => {
    const opening = (sourceId: string, company: string, score: number) => {
      const job = createJob({ source: "greenhouse", sourceId, company, title: `Engineer ${sourceId}`, location: "Remote (Worldwide)" });
      qualifyJob(repo, job);
      repo.saveFit({ jobId: job.id, fitScore: score, bestPositioningProfile: "fullstack_product", matchedSkills: [], missingSkills: [] });
      return job;
    };
    const best = opening("a1", "Acme", 90);
    opening("a2", "Acme, Inc.", 85); // the same company under another spelling
    const other = opening("b1", "Borealis", 70);
    const inFlight = opening("c1", "Cobalt", 95);
    opening("c2", "Cobalt", 92);
    repo.saveDraft(createDraft({ jobId: inFlight.id }), DraftStatus.NEEDS_ATTENTION);
    repo.setJobStage(inFlight.id, PipelineStage.NEEDS_ATTENTION);
    const contacted = opening("d1", "Dunmore", 99);
    repo.recordDispatch({ jobId: "earlier", channel: Channel.ATS_INBOUND, dispatchedAt: "2026-10-01T00:00:00.000000+00:00", companyKey: "dunmore", domain: "", contact: "" });

    // Of two Acme openings only the better; nothing more for Cobalt while one is in flight;
    // nothing for Dunmore inside the de-duplication window.
    const since = "2026-09-12T00:00:00.000000+00:00";
    expect(chooseJobsToDraft(repo, 10, 60, { contactedSince: since }).map((entry) => entry.job.id)).toEqual([best.id, other.id]);
    // Outside the window Dunmore is open again.
    expect(chooseJobsToDraft(repo, 10, 60, { contactedSince: "2026-10-05T00:00:00.000000+00:00" }).map((entry) => entry.job.id)).toEqual([
      contacted.id, best.id, other.id,
    ]);
  });

  test("a company stays spoken for while an application there is alive, however long ago it was sent", () => {
    const opening = (sourceId: string, company: string, score: number | null, stage: PipelineStage = PipelineStage.QUALIFIED) => {
      const job = createJob({ source: "greenhouse", sourceId, company, title: `Engineer ${sourceId}`, location: "Remote (Worldwide)" });
      qualifyJob(repo, job);
      if (score !== null) {
        repo.saveFit({ jobId: job.id, fitScore: score, bestPositioningProfile: "fullstack_product", matchedSkills: [], missingSkills: [] });
      }
      repo.setJobStage(job.id, stage);
      return job;
    };
    const chosen = () =>
      chooseJobsToDraft(repo, 10, 60, { contactedSince: "2026-09-12T00:00:00.000000+00:00" }).map((entry) => entry.job.company);

    // Sent months ago and never answered: another role there would be a second application.
    const sent = opening("s1", "Sentinel", 90, PipelineStage.SUBMITTED);
    opening("s2", "Sentinel", 95);
    // Held by the Cop Tool: the best match is waiting on the user, not abandoned.
    opening("h1", "Harbor", 90, PipelineStage.QUARANTINED);
    opening("h2", "Harbor", 80);
    // Turned down, and long enough ago: a different role is a fresh application.
    const declined = opening("r1", "Rowan", 90, PipelineStage.SUBMITTED);
    repo.recordOutcome({ jobId: declined.id, channel: Channel.ATS_INBOUND, kind: "rejection", note: "", monthlyValueUsd: null, recordedAt: "2026-06-01T00:00:00.000000+00:00" });
    opening("r2", "Rowan", 85);
    expect(chosen()).toEqual(["Rowan"]);

    // Once Sentinel says no, it opens up too — but not inside the re-contact window of what was sent.
    repo.recordOutcome({ jobId: sent.id, channel: Channel.ATS_INBOUND, kind: "rejection", note: "", monthlyValueUsd: null, recordedAt: "2026-10-10T00:00:00.000000+00:00" });
    expect(chosen()).toEqual(["Sentinel", "Rowan"]);
    repo.recordDispatch({ jobId: sent.id, channel: Channel.ATS_INBOUND, dispatchedAt: "2026-10-01T00:00:00.000000+00:00", companyKey: "sentinel", domain: "", contact: "" });
    expect(chosen()).toEqual(["Rowan"]);
  });

  test("a job-site listing is a lead the user sends; left unsent long enough, it stops speaking for its company", async () => {
    const lead = createJob({
      source: "himalayas", sourceId: "h1", company: "Larkspur", title: "Senior Engineer", location: "Worldwide",
      applyUrl: "https://himalayas.app/companies/larkspur/jobs/senior-engineer",
    });
    // The same listing on a board the operator reads is applied for like any other.
    const direct = createJob({
      source: "weworkremotely", sourceId: "w1", company: "Mistral Peak", title: "Senior Engineer", location: "Anywhere in the World",
      applyUrl: "https://jobs.lever.co/mistralpeak/123/apply",
    });
    expect(sentByHand(lead)).toBe(true);
    expect(sentByHand(direct)).toBe(false);
    expect(sentByHand({ ...lead, source: "greenhouse" })).toBe(false);
    expect(sentByHand({ ...lead, source: "breezy" })).toBe(true);

    // Drafted and approved, the lead is never opened in the browser: the user is given the pitch and the link.
    qualifyJob(repo, lead);
    repo.saveFit({ jobId: lead.id, fitScore: 90, bestPositioningProfile: "fullstack_product", matchedSkills: [], missingSkills: [] });
    const draftId = repo.saveDraft(createDraft({ jobId: lead.id, pitch: "A pitch." }), DraftStatus.APPROVED);
    repo.setDraftStatus(draftId, DraftStatus.APPROVED);
    const opened: string[] = [];
    const applier: Applier = {
      inspect: async (job) => {
        opened.push(job.id);
        return { url: job.applyUrl, fields: [], blockers: [] };
      },
      apply: async (job) => {
        opened.push(job.id);
        return filled("submitted");
      },
    };
    const config = makeConfig();
    await runCycle(
      {
        repo, config, decider: fakeDecider(), generator: null, inspector: passingInspector, applier, clock: () => NOW,
        discover: async () => ({ jobs: [], errors: [] }), renderPdf: async () => {},
      },
      ["apply"],
    );
    expect(opened).toEqual([]);
    expect(repo.getDraft(draftId)!.status).toBe(DraftStatus.APPROVED);

    // While the pitch is fresh, another Larkspur role waits; two weeks unsent, it no longer holds the company.
    const other = createJob({ source: "greenhouse", sourceId: "g1", company: "Larkspur", title: "Staff Engineer", location: "Remote (Worldwide)" });
    qualifyJob(repo, other);
    repo.saveFit({ jobId: other.id, fitScore: 80, bestPositioningProfile: "fullstack_product", matchedSkills: [], missingSkills: [] });
    const touched = repo.getJob(lead.id) && repo.query<{ updated_at: string }>("SELECT updated_at FROM jobs WHERE id = ?", [lead.id])[0].updated_at;
    expect(chooseJobsToDraft(repo, 10, 60, { leadsSince: "2000-01-01T00:00:00.000000+00:00" })).toEqual([]);
    expect(chooseJobsToDraft(repo, 10, 60, { leadsSince: `${touched}z` }).map((entry) => entry.job.id)).toEqual([other.id]);
  });

  test("unattended, a held best match waits for nobody: the next best role at its company is chosen", () => {
    const opening = (sourceId: string, score: number, stage: PipelineStage = PipelineStage.QUALIFIED) => {
      const job = createJob({
        source: "greenhouse", sourceId, company: "Harbor", title: `Engineer ${sourceId}`, location: "Remote (Worldwide)",
        applyUrl: `https://job-boards.greenhouse.io/harbor/jobs/${sourceId}`,
      });
      qualifyJob(repo, job);
      repo.saveFit({ jobId: job.id, fitScore: score, bestPositioningProfile: "fullstack_product", matchedSkills: [], missingSkills: [] });
      repo.setJobStage(job.id, stage);
      return job;
    };
    opening("h1", 90, PipelineStage.QUARANTINED);
    const next = opening("h2", 80);
    expect(chooseJobsToDraft(repo, 10, 60)).toEqual([]);
    expect(chooseJobsToDraft(repo, 10, 60, { unattended: true }).map((entry) => entry.job.id)).toEqual([next.id]);
    // One that may have been sent still holds the company, attended or not.
    opening("h3", 85, PipelineStage.NEEDS_ATTENTION);
    expect(chooseJobsToDraft(repo, 10, 60, { unattended: true })).toEqual([]);
  });

  test("unattended, two held roles at a company are enough: a third would be held for the same questions", () => {
    const opening = (sourceId: string, score: number, stage: PipelineStage = PipelineStage.QUALIFIED) => {
      const job = createJob({
        source: "greenhouse", sourceId, company: "Camunda", title: `Engineer ${sourceId}`, location: "Remote (Worldwide)",
        applyUrl: `https://job-boards.greenhouse.io/camunda/jobs/${sourceId}`,
      });
      qualifyJob(repo, job);
      repo.saveFit({ jobId: job.id, fitScore: score, bestPositioningProfile: "fullstack_product", matchedSkills: [], missingSkills: [] });
      repo.setJobStage(job.id, stage);
      return job;
    };
    opening("c1", 90, PipelineStage.QUARANTINED);
    opening("c2", 85, PipelineStage.QUARANTINED);
    opening("c3", 80);
    expect(chooseJobsToDraft(repo, 10, 60, { unattended: true })).toEqual([]);
  });

  test("no role is chosen at a company until all its openings are scored, so the one drafted is the best match", () => {
    const opening = (sourceId: string, score: number | null) => {
      const job = createJob({ source: "greenhouse", sourceId, company: "Meridian", title: `Engineer ${sourceId}`, location: "Remote (Worldwide)" });
      qualifyJob(repo, job);
      if (score !== null) {
        repo.saveFit({ jobId: job.id, fitScore: score, bestPositioningProfile: "fullstack_product", matchedSkills: [], missingSkills: [] });
      }
      return job;
    };
    opening("m1", 70);
    const unscored = opening("m2", null);
    expect(chooseJobsToDraft(repo, 10, 60)).toEqual([]);

    repo.saveFit({ jobId: unscored.id, fitScore: 95, bestPositioningProfile: "fullstack_product", matchedSkills: [], missingSkills: [] });
    expect(chooseJobsToDraft(repo, 10, 60).map((entry) => entry.job.id)).toEqual([unscored.id]);

    // A listing still waiting to be investigated does not hold the company back: few of
    // those turn out eligible, and the queue for them can be hours long.
    const vague = createJob({ source: "greenhouse", sourceId: "m3", company: "Meridian", title: "Engineer m3", location: "Remote", description: "Fully remote team." });
    qualifyJob(repo, vague);
    expect(repo.getJob(vague.id)!.stage).toBe(PipelineStage.INVESTIGATING);
    expect(chooseJobsToDraft(repo, 10, 60).map((entry) => entry.job.id)).toEqual([unscored.id]);
  });

  test("applications Reygent can make itself come before leads, and a cycle drafts only a few leads", () => {
    const opening = (source: string, sourceId: string, company: string, score: number, applyUrl: string) => {
      const job = createJob({ source, sourceId, company, title: "Engineer", location: "Remote (Worldwide)", applyUrl });
      qualifyJob(repo, job);
      repo.saveFit({ jobId: job.id, fitScore: score, bestPositioningProfile: "fullstack_product", matchedSkills: [], missingSkills: [] });
      return job;
    };
    // Six leads that fit better than any form, and four forms.
    for (let i = 0; i < 6; i += 1) opening("himalayas", `h${i}`, `Lead ${i}`, 95 - i, `https://himalayas.app/companies/lead-${i}/jobs/engineer`);
    for (let i = 0; i < 4; i += 1) opening("greenhouse", `g${i}`, `Form ${i}`, 70 - i, `https://job-boards.greenhouse.io/form${i}/jobs/1`);

    // Of six places, three are kept for leads however well the other leads fit; the forms
    // take the rest although every lead outscores them.
    const chosen = chooseJobsToDraft(repo, 6, 60).map((entry) => entry.job.company);
    expect([...chosen].sort()).toEqual(["Form 0", "Form 1", "Form 2", "Lead 0", "Lead 1", "Lead 2"]);
    // With room to spare the leads still stop at three, and every form is taken.
    const roomy = chooseJobsToDraft(repo, 10, 60);
    expect(roomy.filter((entry) => entry.job.source === "himalayas")).toHaveLength(3);
    expect(roomy.filter((entry) => entry.job.source === "greenhouse")).toHaveLength(4);
    // Where there are no forms to draft (none fits this well), leads still stop at three.
    expect(chooseJobsToDraft(repo, 10, 80).map((entry) => entry.job.company).sort()).toEqual(["Lead 0", "Lead 1", "Lead 2"]);
  });

  test("a pitch waiting to be sent does not stop the company's own form; the form then replaces it", async () => {
    const config = makeConfig();
    // The founder's post and the company's own board list the same role.
    const post = createJob({
      source: "hn", sourceId: "p1", company: "Mastra", title: "AI Engineer", location: "REMOTE (AMER or EMEA time zones)",
      channel: Channel.FOUNDER_DIRECT, applyUrl: "https://news.ycombinator.com/item?id=1",
    });
    qualifyJob(repo, post);
    repo.setJobStage(post.id, PipelineStage.QUALIFIED);
    repo.saveFit({ jobId: post.id, fitScore: 85, bestPositioningProfile: "ai_platform_agent", matchedSkills: [], missingSkills: [] });
    const leadId = repo.saveDraft(createDraft({ jobId: post.id, channel: Channel.FOUNDER_DIRECT, pitch: "A pitch." }), DraftStatus.APPROVED);
    repo.setDraftStatus(leadId, DraftStatus.APPROVED);

    const form = createJob({
      source: "ashby", sourceId: "a1", company: "Mastra", title: "AI Engineer", location: "Remote (Worldwide)",
      applyUrl: "https://jobs.ashbyhq.com/mastra/1/application",
    });
    const another = createJob({
      source: "hn", sourceId: "p2", company: "Mastra", title: "Customer Engineer", location: "Remote (Worldwide)",
      channel: Channel.FOUNDER_DIRECT, applyUrl: "https://news.ycombinator.com/item?id=2",
    });
    for (const job of [form, another]) {
      qualifyJob(repo, job);
      repo.saveFit({ jobId: job.id, fitScore: job === form ? 79 : 90, bestPositioningProfile: "ai_platform_agent", matchedSkills: [], missingSkills: [] });
    }
    // The form is chosen although a pitch is waiting; a second pitch to the same company is not.
    expect(chooseJobsToDraft(repo, 10, 60).map((entry) => entry.job.id)).toEqual([form.id]);

    const report = await runCycle(
      {
        repo, config, decider: fakeDecider(), generator: null, inspector: passingInspector, applier: null, clock: () => NOW,
        discover: async () => ({ jobs: [], errors: [] }), resumeDir: fs.mkdtempSync(path.join(os.tmpdir(), "reygent-lead-")),
        renderPdf: async (_html, outputPath) => {
          fs.mkdirSync(path.dirname(outputPath), { recursive: true });
          fs.writeFileSync(outputPath, "%PDF-1.4 test");
        },
      },
      ["draft"],
    );
    expect(report.drafts.approved).toBe(1);
    expect(report.leadsDrafted).toBe(0);
    expect(repo.latestDraftForJob(form.id)!.status).toBe(DraftStatus.APPROVED);
    // One application per company: the pitch is withdrawn, and says why.
    expect(repo.getDraft(leadId)).toMatchObject({ status: DraftStatus.DECLINED, note: "Withdrawn: applying through Mastra's own form instead" });
  });
});

describe("job-site listings and their employers' own boards", () => {
  let repo: Repository;
  let tmp: string;
  let config: Config;
  let applied: JobOpportunity[];

  beforeEach(() => {
    repo = new Repository(":memory:");
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "reygent-pipeline-"));
    config = makeConfig();
    applied = [];
  });
  afterEach(() => {
    repo.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  const STANDARD: FormField[] = [
    { id: "first", label: "First Name", type: "text", required: true, options: [] },
    { id: "email", label: "Email", type: "email", required: true, options: [] },
    { id: "resume", label: "Resume/CV", type: "file", required: true, options: [] },
  ];
  const applier: Applier = {
    inspect: async (job) => ({ url: job.applyUrl, fields: STANDARD, blockers: [] }),
    apply: async (job) => {
      applied.push(job);
      return filled("submitted");
    },
  };
  const deps = (overrides: Partial<PipelineDeps> = {}): PipelineDeps => ({
    repo, config, decider: fakeDecider(), generator: null, inspector: passingInspector, applier,
    discover: async () => ({ jobs: [], errors: [] }),
    renderPdf: async (_html, outputPath) => {
      fs.mkdirSync(path.dirname(outputPath), { recursive: true });
      fs.writeFileSync(outputPath, "%PDF-1.4 test");
    },
    clock: () => NOW, resumeDir: tmp, ...overrides,
  });

  /** A role as a job site re-lists it: a good fit, and a lead, because the link is the job site's page. */
  const onJobSite = (fields: Partial<JobOpportunity> = {}): JobOpportunity => {
    const job = createJob({
      source: "weworkremotely", sourceId: "larkspur-1", company: "Larkspur", title: "Senior AI Agent Engineer",
      location: "Anywhere in the World", description: "Build LangGraph agents in Python.", skills: ["Python", "LangGraph"],
      applyUrl: "https://weworkremotely.com/remote-jobs/larkspur-senior-ai-agent-engineer", ...fields,
    });
    qualifyJob(repo, job);
    repo.saveFit({ jobId: job.id, fitScore: 90, bestPositioningProfile: "ai_platform_agent", matchedSkills: [], missingSkills: [] });
    return job;
  };
  /** The same role on the employer's own board. */
  const onEmployerBoard = (fields: Partial<JobOpportunity> = {}): JobOpportunity =>
    createJob({
      source: "greenhouse", sourceId: "larkspur:7", company: "Larkspur", title: "Senior AI Agent Engineer",
      location: "Remote (Worldwide)", description: "Build LangGraph agents in Python. Contractors are paid through Deel.",
      skills: ["Python", "LangGraph"], applyUrl: "https://job-boards.greenhouse.io/larkspur/jobs/7", ...fields,
    });
  const finding = (listings: JobOpportunity[], settled = true): { find: EmployerLookup; asked: string[] } => {
    const asked: string[] = [];
    return {
      asked,
      find: async (job) => {
        asked.push(job.id);
        return { listings, settled };
      },
    };
  };
  const reasons = (job: JobOpportunity): string[] => repo.getEvaluation(job.id)!.reasonCodes;

  test("a pitch waiting to be sent gives way to the employer's own form, which is applied through in the same cycle", async () => {
    const lead = onJobSite();
    const pitchId = repo.saveDraft(createDraft({ jobId: lead.id, pitch: "A pitch." }), DraftStatus.APPROVED);
    const { find } = finding([onEmployerBoard()]);

    const report = await runCycle(deps({ findEmployerListing: find }));

    expect(report.leadsMoved).toBe(1);
    // The employer's listing was judged like any new one, drafted for and submitted; no pitch was written.
    expect(report).toMatchObject({ scored: 1, leadsDrafted: 0, applications: { submitted: 1, handedOff: 0, failed: 0 } });
    expect(applied.map((job) => job.applyUrl)).toEqual(["https://job-boards.greenhouse.io/larkspur/jobs/7"]);
    expect(repo.getJob(onEmployerBoard().id)!.stage).toBe(PipelineStage.SUBMITTED);
    // The job site's copy is closed, and says why; nothing is left for the user to send.
    expect(repo.getDraft(pitchId)).toMatchObject({
      status: DraftStatus.DECLINED, note: "Withdrawn: Larkspur's own listing of this role is used instead",
    });
    expect(reasons(lead)).toContain("ON_EMPLOYER_BOARD");
    expect(report.waiting).toEqual({ toSend: 0, held: 0, needsAttention: 0 });
  });

  test("the employer's own word on where the role is decides: a role only the job site called worldwide is ruled out", async () => {
    const lead = onJobSite();
    const usOnly = onEmployerBoard({ location: "Remote", description: "US citizenship required. Must hold an active security clearance." });

    const report = await runCycle(deps({ findEmployerListing: finding([usOnly]).find }));

    expect(report.leadsMoved).toBe(1);
    expect(report.drafts).toEqual({ awaitingReview: 0, approved: 0, quarantined: 0, skipped: 0 });
    expect(applied).toEqual([]);
    expect(repo.getJob(usOnly.id)!.stage).toBe(PipelineStage.DISQUALIFIED);
    // No pitch is written for it either: the lead went with the listing it copied.
    expect(repo.getJob(lead.id)!.stage).toBe(PipelineStage.DISQUALIFIED);
    expect(repo.listDrafts()).toEqual([]);
  });

  test("a listing on no board Reygent reads stays a lead, and is looked up only once", async () => {
    const lead = onJobSite();
    const { find, asked } = finding([]);

    // Hands-free nobody would send a pitch, so none is written: the lead just stays on record.
    const first = await runCycle(deps({ findEmployerListing: find, applier: null }));
    expect(first).toMatchObject({ leadsMoved: 0, leadsDrafted: 0, waiting: { toSend: 0, held: 0, needsAttention: 0 } });
    expect(reasons(lead)).toContain("NO_EMPLOYER_BOARD");
    expect(repo.getJob(lead.id)!.stage).toBe(PipelineStage.QUALIFIED);

    // With the user pressing Submit themselves, the pitch is written for them to send.
    config.pipeline.auto_submit = false;
    const assisted = await runCycle(deps({ findEmployerListing: find, applier: null }));
    expect(assisted).toMatchObject({ unattended: false, leadsDrafted: 1, waiting: { toSend: 1, held: 0, needsAttention: 0 } });
    expect(asked).toEqual([lead.id]);
  });

  test("a board that could not be asked is asked again, and a lookup that fails outright stops nothing", async () => {
    const lead = onJobSite();
    const down = finding([], false);
    expect(await moveLeadsToForms(repo, down.find, { threshold: 60 })).toBe(0);
    expect(await moveLeadsToForms(repo, down.find, { threshold: 60 })).toBe(0);
    expect(down.asked).toEqual([lead.id, lead.id]);

    const broken: EmployerLookup = async () => {
      throw new Error("boom");
    };
    expect(await moveLeadsToForms(repo, broken, { threshold: 60 })).toBe(0);
    expect(reasons(lead)).not.toContain("NO_EMPLOYER_BOARD");
    expect(repo.getJob(lead.id)!.stage).toBe(PipelineStage.QUALIFIED);
  });

  test("only leads worth applying for are looked up: not a poor fit, a form Reygent already reads, or a founder's post", async () => {
    const poor = onJobSite({ sourceId: "poor", company: "Poor Fit" });
    repo.saveFit({ jobId: poor.id, fitScore: 40, bestPositioningProfile: "ai_platform_agent", matchedSkills: [], missingSkills: [] });
    onJobSite({ sourceId: "direct", company: "Direct", applyUrl: "https://jobs.lever.co/direct/1/apply" });
    onJobSite({ source: "hn", sourceId: "post", company: "Founder", channel: Channel.FOUNDER_DIRECT, applyUrl: "https://news.ycombinator.com/item?id=1" });
    const lead = onJobSite();
    const { find, asked } = finding([]);

    await moveLeadsToForms(repo, find, { threshold: 60 });
    expect(asked).toEqual([lead.id]);
  });
});

describe("company boards found by name", () => {
  let repo: Repository;
  beforeEach(() => {
    repo = new Repository(":memory:");
  });
  afterEach(() => repo.close());

  const seen = (source: string, sourceId: string, company: string, title: string) =>
    repo.insertJob(createJob({ source, sourceId, company, title, location: "Anywhere in the World", applyUrl: `https://example.com/${sourceId}` }));

  test("companies seen on job sites and hiring threads are looked for once, and boards found are remembered by name", async () => {
    seen("weworkremotely", "w1", "Sticker Mule", "Software engineer");
    seen("remoteok", "r1", "Sticker Mule", "AI agent engineer");
    seen("hn", "h1", "Larkspur", "Senior Engineer");
    seen("greenhouse", "g1", "Canonical", "Golang Engineer"); // its own board is already read
    const asked: Array<[string, string[]]> = [];
    const find: BoardFinder = async (company, titles) => {
      asked.push([company, [...titles].sort()]);
      return company === "Sticker Mule"
        ? { boards: [{ provider: "ashby", token: "stickermule" }], settled: true }
        : { boards: [], settled: company !== "Larkspur" };
    };

    expect(await learnBoards(repo, find, { now: NOW })).toBe(1);
    expect(asked.sort()).toEqual([["Larkspur", ["Senior Engineer"]], ["Sticker Mule", ["AI agent engineer", "Software engineer"]]]);
    const remembered = repo.getState<Record<string, { company?: string; via: string; wanted: boolean }>>(BOARDS_KEY)!;
    expect(remembered["ashby:stickermule"]).toMatchObject({ company: "Sticker Mule", via: "name", wanted: true });

    // Sticker Mule is settled; Larkspur's boards could not all be asked, so it is asked again.
    asked.length = 0;
    expect(await learnBoards(repo, find, { now: NOW })).toBe(0);
    expect(asked).toEqual([["Larkspur", ["Senior Engineer"]]]);
  });
});

describe("held drafts and the candidate's details", () => {
  let repo: Repository;
  let config: Config;
  let held: JobOpportunity;

  beforeEach(() => {
    repo = new Repository(":memory:");
    config = makeConfig();
    held = LISTINGS()[0];
    qualifyJob(repo, held);
    repo.quarantine([{ jobId: held.id, violationRule: "2_screening_sanity", originalContent: "{}", critique: "could not be answered", retryCount: 0 }]);
  });
  afterEach(() => repo.close());

  const stage = (): string => repo.getJob(held.id)!.stage;

  test("a held draft is sent back once the candidate's details change, and not again until they change again", () => {
    // The first look takes stock: whatever is held is given one go with the details as they are.
    expect(retryHolds(repo, config)).toBe(1);
    expect(stage()).toBe(PipelineStage.QUALIFIED);
    expect(repo.listQuarantined()).toEqual([]);

    // Held again with the same details: writing it once more would end the same way.
    repo.quarantine([{ jobId: held.id, violationRule: "2_screening_sanity", originalContent: "{}", critique: "could not be answered", retryCount: 0 }]);
    expect(retryHolds(repo, config)).toBe(0);
    expect(stage()).toBe(PipelineStage.QUARANTINED);

    config.candidate.screening_notes = "I find roles on company careers pages.";
    expect(retryHolds(repo, config)).toBe(1);
    expect(stage()).toBe(PipelineStage.QUALIFIED);
    expect(retryHolds(repo, config)).toBe(0);
  });

  test("a held draft is sent back once a day even when nothing changed: an answer near the verifier's bar can pass on another try", () => {
    const now = new Date("2026-10-14T12:00:00Z");
    expect(retryHolds(repo, config, now)).toBe(1);
    repo.quarantine([{ jobId: held.id, violationRule: "2_screening_sanity", originalContent: "{}", critique: "could not be answered", retryCount: 0 }]);
    expect(retryHolds(repo, config, new Date(now.getTime() + 23 * 3_600_000))).toBe(0);
    expect(retryHolds(repo, config, new Date(now.getTime() + 25 * 3_600_000))).toBe(1);
    expect(stage()).toBe(PipelineStage.QUALIFIED);
  });

  test("an answer the candidate gives counts as a change; one the AI wrote does not", () => {
    retryHolds(repo, config);
    const hold = () =>
      repo.quarantine([{ jobId: held.id, violationRule: "2_screening_sanity", originalContent: "{}", critique: "could not be answered", retryCount: 0 }]);

    hold();
    repo.saveStandingAnswer({ question: "How did you hear about us?", answer: "A job board", options: [], source: "ai" });
    expect(retryHolds(repo, config)).toBe(0);

    repo.saveStandingAnswer({ question: "Preferred name", answer: "Sam", options: [], source: "user" });
    expect(retryHolds(repo, config)).toBe(1);
    expect(stage()).toBe(PipelineStage.QUALIFIED);
  });

  test("an application set aside at its form is drafted afresh when the details change", () => {
    retryHolds(repo, config);
    const other = LISTINGS()[1];
    qualifyJob(repo, other);
    const draftId = repo.saveDraft(createDraft({ jobId: other.id }), DraftStatus.APPROVED);
    repo.setDraftStatus(draftId, DraftStatus.DECLINED, "Set aside: Required question not answered: Phone.");
    // Declined by the user is not the same thing: that one stays declined.
    const third = LISTINGS()[2];
    qualifyJob(repo, third);
    repo.setDraftStatus(repo.saveDraft(createDraft({ jobId: third.id }), DraftStatus.AWAITING_REVIEW), DraftStatus.DECLINED);

    config.candidate.phone = "+237 600 000 001";
    retryHolds(repo, config);
    expect(repo.getJob(other.id)!.stage).toBe(PipelineStage.QUALIFIED);
    expect(repo.getJob(third.id)!.stage).toBe(PipelineStage.DECLINED);
    expect(retryHolds(repo, config)).toBe(0);
  });

  test("a hold the user is already dealing with elsewhere is left alone", () => {
    retryHolds(repo, config);
    // Declined by hand in the console: the job has left the held stage, though its items are still pending.
    repo.quarantine([{ jobId: held.id, violationRule: "7_scam_filter", originalContent: "{}", critique: "scam", retryCount: 0 }]);
    repo.setJobStage(held.id, PipelineStage.DISQUALIFIED);
    config.candidate.screening_notes = "Something new.";

    expect(retryHolds(repo, config)).toBe(0);
    expect(stage()).toBe(PipelineStage.DISQUALIFIED);
  });

  test("a cycle sends held drafts back before it drafts, and says what is left for the user", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "reygent-holds-"));
    repo.saveFit({ jobId: held.id, fitScore: 90, bestPositioningProfile: "ai_platform_agent", matchedSkills: [], missingSkills: [] });
    const cycle = (inspector: DraftInspector) =>
      runCycle(
        {
          repo, config, decider: fakeDecider(), generator: null, inspector, applier: null, clock: () => NOW, resumeDir: tmp,
          discover: async () => ({ jobs: [], errors: [] }),
          renderPdf: async (_html, outputPath) => {
            fs.mkdirSync(path.dirname(outputPath), { recursive: true });
            fs.writeFileSync(outputPath, "%PDF-1.4 test");
          },
        },
        ["draft"],
      );
    const holding: DraftInspector = {
      inspectApplicationDraft: async (draft) => {
        const quarantineIds = repo.quarantine([
          { jobId: draft.jobId, violationRule: "2_screening_sanity", originalContent: "{}", critique: "could not be answered", retryCount: 0 },
        ]);
        return { passed: false, draft, retries: 0, quarantineIds };
      },
    };
    try {
      // Sent back, written again, and held again: it is the user's to answer now.
      expect(await cycle(holding)).toMatchObject({
        holdsRetried: 1, drafts: { quarantined: 1 }, waiting: { toSend: 0, held: 1, needsAttention: 0 },
      });
      expect(await cycle(passingInspector)).toMatchObject({ holdsRetried: 0, drafts: { approved: 0 } });

      // The user fills in what was missing; the next cycle gets the application through by itself.
      config.candidate.screening_notes = "I find roles on company careers pages.";
      expect(await cycle(passingInspector)).toMatchObject({
        holdsRetried: 1, drafts: { approved: 1, quarantined: 0 }, waiting: { toSend: 0, held: 0, needsAttention: 0 },
      });
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
