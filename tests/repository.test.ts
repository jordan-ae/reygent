/**
 * Repository: atomic transactions, duplicate-proof job inserts, round trips, and the
 * upgrade of a database written by the original Python implementation.
 *
 * Ports tests/test_repository.py. Python's thread tests have no Node equivalent (every
 * call is synchronous), so concurrency is exercised with two Repository instances —
 * two connections — on one database file, which is how the web console and the daemon
 * actually share it.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { DEFAULT_CANDIDATE_ID, Repository, jobFingerprint, toIso, utcNowIso } from "@/core/db/repository";
import { SCHEMA_VERSION } from "@/core/db/schema";
import { CircuitBreakerError, CostLedger } from "@/core/llm/ledger";
import {
  type ApplicationDraft,
  B2B_INVESTIGATION,
  type CandidateProfile,
  Channel,
  DraftStatus,
  type EligibilityReport,
  EligibilityTier,
  type FitEvaluation,
  type JobInput,
  type JobOpportunity,
  OutcomeKind,
  PipelineStage,
  createDraft,
  createJob,
  jobId,
} from "@/core/models";
import { roleKey } from "@/core/text";

const ISO_RX = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}\+00:00$/;
const LLAMA = "accounts/fireworks/models/llama-v3p3-70b-instruct";
/** A timestamp exactly as Python's `to_iso` writes it: microseconds, not milliseconds. */
const PYTHON_TIMESTAMP = "2026-10-12T10:50:00.123456+00:00";
/** Stands in for "before this test ran", so a fresh stamp can be told from a stale one. */
const LONG_AGO = "2020-01-01T00:00:00.000000+00:00";

const openRepositories: Repository[] = [];
const tempDirs: string[] = [];
let repo: Repository;

/** A repository that is closed again when the test ends. */
function open(dbPath: string): Repository {
  const opened = new Repository(dbPath);
  openRepositories.push(opened);
  return opened;
}

/** Path of a database file in a fresh temporary directory. */
function tempDbPath(...segments: string[]): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "reygent-db-"));
  tempDirs.push(dir);
  return path.join(dir, ...(segments.length ? segments : ["reygent.db"]));
}

function makeJob(overrides: Partial<JobInput> = {}): JobOpportunity {
  return createJob({ source: "greenhouse", sourceId: "1", company: "Acme", title: "Senior Engineer", ...overrides });
}

function makeProfile(overrides: Partial<CandidateProfile> = {}): CandidateProfile {
  return {
    id: DEFAULT_CANDIDATE_ID, name: "Test Candidate", email: "candidate@example.com", phone: "+237 600 000 000",
    location: "Cameroon (UTC+1)", timezone: "Africa/Douala", workAuthorization: "B2B contractor",
    noticePeriod: "2 weeks", githubUrl: "https://github.com/test-candidate",
    linkedinUrl: "https://www.linkedin.com/in/test-candidate", portfolioUrl: "https://candidate.example.com",
    yearsExperience: 8, employers: ["Initech"], skills: ["Python"],
    achievements: [
      {
        id: "ach_1", category: "ai", headline: "Built X", impactMetric: "Cut latency by 45%",
        technologies: ["Python"], context: "", employer: "", evidenceUrl: "", positioning: [], verified: true,
      },
      {
        id: "ach_2", category: "web", headline: "Built Y", impactMetric: "Unverified claim",
        technologies: ["React"], context: "", employer: "", evidenceUrl: "", positioning: [], verified: false,
      },
    ],
    positioning: {
      p1: {
        id: "p1", title: "Title", targetSummary: "Summary", coreSkills: ["Python"], pitchAngle: "Angle",
        highlightedAchievements: ["ach_1"],
      },
    },
    ...overrides,
  };
}

function makeReport(job: JobOpportunity, overrides: Partial<EligibilityReport> = {}): EligibilityReport {
  return {
    jobId: job.id, tier: EligibilityTier.CONFIRMED_ELIGIBLE, reasonCodes: ["CONTRACTOR_RAILS"],
    positiveSignals: ["CONTRACTOR_RAILS: paid through Deel"], disqualifiers: [], needsB2bInvestigation: false,
    summary: "Worldwide contractor role", ...overrides,
  };
}

function makeDraft(job: JobOpportunity, overrides: Partial<ApplicationDraft> = {}): ApplicationDraft {
  return createDraft({
    jobId: job.id, channel: Channel.FOUNDER_DIRECT, positioningProfileId: "ai_platform_agent",
    pitch: "I cut workflow latency by 45% at Initech — happy to do the same for Acme.",
    cvBullets: [{ text: "Cut workflow latency by 45% with a LangGraph runtime.", achievementId: "ach_1" }],
    screeningAnswers: [
      { question: "Notice period?", answer: "2 weeks", options: [], factKey: "notice_period" },
      { question: "Are you authorised to work?", answer: "Yes", options: ["Yes", "No"], factKey: "" },
    ],
    resumePdfPath: "/tmp/cv.pdf", quotedRateUsd: 50, quotedRatePeriod: "hour", contact: "founder@acme.com",
    ...overrides,
  });
}

/** Insert `job` and return it, for tests that need a tracked job. */
function track(job: JobOpportunity = makeJob(), into: Repository = repo): JobOpportunity {
  expect(into.insertJob(job)).toBe(true);
  return job;
}

const count = (table: string, from: Repository = repo): number =>
  from.query<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table}`)[0].n;

beforeEach(() => {
  repo = open(":memory:");
});

afterEach(() => {
  for (const opened of openRepositories.splice(0)) {
    try {
      opened.close();
    } catch {
      // already closed by the test
    }
  }
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("toIso", () => {
  // Expected values are the output of Python's to_iso() for the same instants.
  test.each([
    ["2026-10-12T10:50:00.123Z", "2026-10-12T10:50:00.123000+00:00"],
    ["2026-10-12T10:50:00Z", "2026-10-12T10:50:00.000000+00:00"],
    ["2026-10-12T12:50:00.005+02:00", "2026-10-12T10:50:00.005000+00:00"],
    ["2026-01-02T03:04:05.999-05:00", "2026-01-02T08:04:05.999000+00:00"],
    ["1999-12-31T23:59:59.999Z", "1999-12-31T23:59:59.999000+00:00"],
  ])("%s is written as %s, exactly as Python writes it", (instant, expected) => {
    expect(toIso(new Date(instant))).toBe(expected);
  });

  test("is fixed width: six fractional digits and a +00:00 suffix", () => {
    for (const instant of ["2026-10-12T10:50:00Z", "2026-10-12T10:50:00.001Z", "2026-10-12T10:50:00.010Z", "2026-10-12T10:50:00.999Z"]) {
      const written = toIso(new Date(instant));
      expect(written).toMatch(ISO_RX);
      expect(written).toHaveLength(32);
      expect(written.endsWith("+00:00")).toBe(true);
      expect(written.split(".")[1].slice(0, 6)).toMatch(/^\d{3}000$/);
      expect(new Date(written).getTime()).toBe(new Date(instant).getTime()); // and it parses back
    }
  });

  test("sorts lexicographically in time order", () => {
    const instants = [
      "2026-10-12T10:50:00.000Z", "2026-10-12T10:50:00.001Z", "2026-10-12T10:50:00.009Z",
      "2026-10-12T10:50:00.010Z", "2026-10-12T10:50:00.099Z", "2026-10-12T10:50:00.100Z",
      "2026-10-12T10:50:00.999Z", "2026-10-12T10:50:01.000Z", "2026-10-12T10:59:59.999Z",
      "2026-10-12T11:00:00.000Z", "2026-10-12T23:59:59.999Z", "2026-10-13T00:00:00.000Z",
      "2026-12-31T23:59:59.999Z", "2027-01-01T00:00:00.000Z", "1999-12-31T23:59:59.999Z",
      "2000-01-01T00:00:00.000Z", "2026-02-28T12:00:00.000Z", "2026-03-01T00:00:00.000Z",
    ].map((instant) => new Date(instant));
    const byTime = [...instants].sort((a, b) => a.getTime() - b.getTime()).map(toIso);
    const byText = instants.map(toIso).sort();
    expect(byText).toEqual(byTime);
  });

  test("compares correctly against timestamps written by Python", () => {
    const justBefore = toIso(new Date("2026-10-12T10:50:00.123Z"));
    const justAfter = toIso(new Date("2026-10-12T10:50:00.124Z"));
    expect(justBefore).toHaveLength(PYTHON_TIMESTAMP.length);
    expect(justBefore < PYTHON_TIMESTAMP).toBe(true);
    expect(justAfter > PYTHON_TIMESTAMP).toBe(true);
    expect([justAfter, PYTHON_TIMESTAMP, justBefore].sort()).toEqual([justBefore, PYTHON_TIMESTAMP, justAfter]);
  });

  test("the database agrees: Python-written rows fall on the right side of a TypeScript cut-off", () => {
    repo.recordTelemetry({ provider: "fireworks", model: LLAMA, taskType: "pitch", costUsd: 0.25, timestamp: PYTHON_TIMESTAMP });
    repo.recordDispatch({
      jobId: "job-1", channel: Channel.ATS_INBOUND, companyKey: "acme", domain: "", contact: "",
      dispatchedAt: PYTHON_TIMESTAMP,
    });
    const before = toIso(new Date("2026-10-12T10:50:00.123Z"));
    const after = toIso(new Date("2026-10-12T10:50:00.124Z"));

    expect(repo.spendSince(before)).toBe(0.25);
    expect(repo.spendSince(after)).toBe(0);
    expect(repo.countDispatchesSince(before)).toBe(1);
    expect(repo.countDispatchesSince(after)).toBe(0);
    expect(repo.lastDispatch(before, { companyKey: "acme" })?.dispatchedAt).toBe(PYTHON_TIMESTAMP);
    expect(repo.lastDispatch(after, { companyKey: "acme" })).toBeNull();
  });

  test("utcNowIso is the current instant in the same format", () => {
    const before = Date.now();
    const written = utcNowIso();
    const after = Date.now();
    expect(written).toMatch(ISO_RX);
    expect(new Date(written).getTime()).toBeGreaterThanOrEqual(before);
    expect(new Date(written).getTime()).toBeLessThanOrEqual(after);
  });
});

describe("job identity", () => {
  // Ids and fingerprints computed by the Python implementation for the same listings: an
  // existing database must keep rejecting duplicates of the rows Python stored in it.
  test.each([
    [{ source: "greenhouse", sourceId: "1", company: "Acme", title: "Senior Engineer" }, "5a18be0cd702ebe8", "5eb34da4bf2165d9e5ef9a52dd2aa49e95aac8f6"],
    [{ source: "greenhouse", sourceId: "1", company: "Acme", title: "Senior Engineer", location: "Remote" }, "5a18be0cd702ebe8", "4f605714f3f50947ca14fbf803397a8c37db2227"],
    [{ source: "lever", sourceId: "x9", company: "ACME ", title: "Senior Engineer", location: "remote" }, "4160a9a698ec70c7", "4f605714f3f50947ca14fbf803397a8c37db2227"],
    [{ source: "ashby", sourceId: "abc-123", company: "Acme, Inc.", title: "Senior Engineer (AI/ML)", location: "Remote — Worldwide" }, "e7bd1556cb9f1b84", "7ccce76352723ff8bd0c730d0df9ab129232943e"],
    [{ source: "hn", sourceId: "42", company: "Café Zoë", title: "Développeur Full-Stack", location: "Île-de-France" }, "280c8a1f6f1d89af", "36782be8d5fc496cc64f0ca77cc733dc37d5fa2d"],
  ])("%j has the id and fingerprint Python gives it", (input, id, fingerprint) => {
    const job = createJob(input);
    expect(job.id).toBe(id);
    expect(jobId(input.source, input.sourceId)).toBe(id);
    expect(jobFingerprint(job)).toBe(fingerprint);
  });

  test("the fingerprint ignores source, case, punctuation and spacing", () => {
    const reference = jobFingerprint({ company: "Acme", title: "Senior Engineer", location: "Remote" });
    expect(jobFingerprint({ company: "ACME ", title: "senior  engineer", location: "remote" })).toBe(reference);
    expect(jobFingerprint({ company: "Acme.", title: "Senior-Engineer", location: "(Remote)" })).toBe(reference);
    expect(jobFingerprint(makeJob({ source: "lever", sourceId: "x9", location: "Remote" }))).toBe(reference);
  });

  test("the fingerprint tells different roles, companies and locations apart", () => {
    const reference = jobFingerprint({ company: "Acme", title: "Senior Engineer", location: "Remote" });
    expect(jobFingerprint({ company: "Acme", title: "Staff Engineer", location: "Remote" })).not.toBe(reference);
    expect(jobFingerprint({ company: "Initech", title: "Senior Engineer", location: "Remote" })).not.toBe(reference);
    expect(jobFingerprint({ company: "Acme", title: "Senior Engineer", location: "Berlin" })).not.toBe(reference);
    // Fields are kept apart, so words cannot slide from one field into the next.
    expect(jobFingerprint({ company: "Acme Senior", title: "Engineer", location: "Remote" })).not.toBe(reference);
  });
});

describe("job insertion", () => {
  test("the same listing is inserted once", () => {
    expect(repo.insertJob(makeJob())).toBe(true);
    expect(repo.insertJob(makeJob())).toBe(false);
    expect(repo.listJobs()).toHaveLength(1);
  });

  test("the same role from another source is a duplicate", () => {
    expect(repo.insertJob(makeJob({ source: "greenhouse", location: "Remote" }))).toBe(true);
    expect(repo.insertJob(makeJob({ source: "lever", sourceId: "x9", company: "ACME ", location: "remote" }))).toBe(false);
    expect(repo.listJobs()).toHaveLength(1);
    expect(repo.listJobs()[0].source).toBe("greenhouse"); // the first sighting is the one kept
  });

  test("the same source listing under a different id is a duplicate", () => {
    track(makeJob());
    const renumbered = makeJob({ id: "some-other-id", title: "Senior Engineer II", location: "Berlin" });
    expect(repo.insertJob(renumbered)).toBe(false);
    expect(repo.listJobs()).toHaveLength(1);
  });

  test("distinct roles at one company are kept", () => {
    expect(repo.insertJob(makeJob({ sourceId: "1", title: "Senior Engineer" }))).toBe(true);
    expect(repo.insertJob(makeJob({ sourceId: "2", title: "Staff Engineer" }))).toBe(true);
    expect(repo.listJobs()).toHaveLength(2);
  });

  test("the same title in two locations is two jobs", () => {
    expect(repo.insertJob(makeJob({ sourceId: "1", location: "Remote (EMEA)" }))).toBe(true);
    expect(repo.insertJob(makeJob({ sourceId: "2", location: "Remote (Americas)" }))).toBe(true);
    expect(repo.listJobs()).toHaveLength(2);
  });

  test("a job round trip preserves every field", () => {
    const job = makeJob({
      location: "Remote", description: "Build things.", applyUrl: "https://boards.greenhouse.io/acme/1",
      companyDomain: "acme.com", channel: Channel.CONTRACT_GIGS, isRemote: true, employmentType: "contract",
      compMin: 50, compMax: 70.5, compPeriod: "hour", compCurrency: "EUR", skills: ["Python", "LangGraph"],
      postedAt: "2026-10-01T09:00:00Z", stage: PipelineStage.QUALIFIED,
    });
    repo.insertJob(job);
    expect(repo.getJob(job.id)).toEqual(job);
  });

  test("a job with only the required fields round-trips to the same defaults", () => {
    const job = makeJob();
    repo.insertJob(job);
    const stored = repo.getJob(job.id);
    expect(stored).toEqual(job);
    expect(stored).toMatchObject({
      isRemote: null, compMin: null, compMax: null, postedAt: null, compCurrency: "USD", skills: [],
      channel: Channel.ATS_INBOUND, stage: PipelineStage.DISCOVERED,
    });
  });

  test("an explicit 'not remote' is kept distinct from 'not stated'", () => {
    const onsite = makeJob({ sourceId: "onsite", title: "Onsite Engineer", isRemote: false });
    const unstated = makeJob({ sourceId: "unstated", title: "Mystery Engineer" });
    repo.insertJob(onsite);
    repo.insertJob(unstated);
    expect(repo.getJob(onsite.id)?.isRemote).toBe(false);
    expect(repo.getJob(unstated.id)?.isRemote).toBeNull();
  });

  test("text is stored verbatim: quotes, markup, emoji and non-Latin scripts", () => {
    const description = `It's "remote" <b>worldwide</b>; DROP TABLE jobs; -- \u{1F680} 日本語\n\tsecond line \u00a0— end`;
    const job = makeJob({ company: "Café O'Brien & Søn", description, skills: ["C++", "C#", 'say "hi"'] });
    repo.insertJob(job);
    expect(repo.getJob(job.id)).toEqual(job);
    expect(repo.listJobs()).toHaveLength(1); // and nothing was dropped
  });

  test("a duplicate insert does not overwrite pipeline progress", () => {
    const job = track();
    repo.setJobStage(job.id, PipelineStage.SUBMITTED);
    expect(repo.insertJob(makeJob({ description: "Reposted with a new description." }))).toBe(false);
    const stored = repo.getJob(job.id);
    expect(stored?.stage).toBe(PipelineStage.SUBMITTED);
    expect(stored?.description).toBe("");
  });

  test("an unknown job is null, and moving its stage changes nothing", () => {
    expect(repo.getJob("deadbeef")).toBeNull();
    expect(() => repo.setJobStage("deadbeef", PipelineStage.QUALIFIED)).not.toThrow();
    expect(repo.listJobs()).toEqual([]);
  });

  test("jobs are listed in the order they were discovered, optionally by stage", () => {
    const first = track(makeJob({ sourceId: "1", title: "First" }));
    const second = track(makeJob({ sourceId: "2", title: "Second" }));
    const third = track(makeJob({ sourceId: "3", title: "Third" }));
    repo.setJobStage(second.id, PipelineStage.QUALIFIED);
    repo.setJobStage(first.id, PipelineStage.QUALIFIED);

    expect(repo.listJobs().map((job) => job.title)).toEqual(["First", "Second", "Third"]);
    expect(repo.listJobs(PipelineStage.QUALIFIED).map((job) => job.title)).toEqual(["First", "Second"]);
    expect(repo.listJobs(PipelineStage.DISCOVERED).map((job) => job.id)).toEqual([third.id]);
    expect(repo.listJobs(PipelineStage.SUBMITTED)).toEqual([]);
  });

  test("setJobStage moves one job and stamps the change", () => {
    const job = track();
    const other = track(makeJob({ sourceId: "2", title: "Other" }));
    repo.run("UPDATE jobs SET updated_at = ?", [LONG_AGO]);

    repo.setJobStage(job.id, PipelineStage.INVESTIGATING);

    const rows = repo.query<{ id: string; stage: string; created_at: string; updated_at: string }>("SELECT * FROM jobs");
    const moved = rows.find((row) => row.id === job.id)!;
    const untouched = rows.find((row) => row.id === other.id)!;
    expect(moved.stage).toBe("investigating");
    expect(moved.updated_at).toMatch(ISO_RX);
    expect(moved.updated_at > LONG_AGO).toBe(true);
    expect(moved.created_at).toMatch(ISO_RX);
    expect(untouched.stage).toBe("discovered");
    expect(untouched.updated_at).toBe(LONG_AGO);
  });

  test("findTrackedJobId recognises a job by id, by source listing or by role", () => {
    const tracked = track(makeJob({ location: "Remote" }));

    expect(repo.findTrackedJobId(tracked)).toBe(tracked.id);
    // the same role scraped from another board
    expect(repo.findTrackedJobId(makeJob({ source: "lever", sourceId: "x9", company: "ACME ", location: "remote" }))).toBe(tracked.id);
    // the same board listing, retitled and carrying another id
    expect(repo.findTrackedJobId(makeJob({ id: "other-id", title: "Principal Engineer", location: "Berlin" }))).toBe(tracked.id);
    // the same id reused for something else entirely
    expect(repo.findTrackedJobId(makeJob({ id: tracked.id, source: "hn", sourceId: "9", company: "Initech", title: "CTO" }))).toBe(tracked.id);
    // a genuinely new role
    expect(repo.findTrackedJobId(makeJob({ sourceId: "2", title: "Staff Engineer" }))).toBeNull();
  });
});

describe("one role listed by several sources", () => {
  // A role as its employer's board lists it, and as a job board re-lists it: the same
  // company and title, the location in the job board's own words (here, none).
  const onCompanyBoard = (overrides: Partial<JobInput> = {}): JobOpportunity =>
    makeJob({
      source: "ashby", sourceId: "supabase:1", company: "Supabase", title: "Platform Engineer, Managed Postgres",
      location: "Remote, EMEA", applyUrl: "https://jobs.ashbyhq.com/supabase/1/application", ...overrides,
    });
  const onJobBoard = (overrides: Partial<JobInput> = {}): JobOpportunity =>
    makeJob({
      source: "realworkfromanywhere", sourceId: "platform-engineer-managed-postgres-supabase-3762", company: "Supabase",
      title: "Platform Engineer, Managed Postgres", location: "",
      applyUrl: "https://www.realworkfromanywhere.com/jobs/platform-engineer-managed-postgres-supabase-3762", ...overrides,
    });
  const tracked = (): Array<[string, string]> => repo.listJobs().map((job) => [job.source, job.sourceId]);

  test("the role key ignores the location, the company's legal form and a title's remote tag", () => {
    expect(roleKey("Supabase", "Platform Engineer, Managed Postgres")).toBe("supabase|platform engineer managed postgres");
    expect(roleKey("Supabase Inc.", "Platform Engineer – Managed Postgres (Remote)")).toBe(roleKey("Supabase", "Platform Engineer, Managed Postgres"));
    // Lemon.io's role as Remotive and as Remote OK spell it.
    expect(roleKey("Lemon.io", "Senior React Full-stack Developer")).toBe(roleKey("Lemon.io", "Senior React Full stack Developer"));
    expect(roleKey("Supabase", "Platform Engineer, Edge & Networking")).not.toBe(roleKey("Supabase", "Platform Engineer, Managed Postgres"));
    expect(roleKey("Neon", "Platform Engineer, Managed Postgres")).not.toBe(roleKey("Supabase", "Platform Engineer, Managed Postgres"));
  });

  test("a job board's copy counts as tracked once any other source has the role", () => {
    const board = track(onCompanyBoard());

    expect(repo.findTrackedJobId(onJobBoard())).toBe(board.id);
    expect(repo.insertJob(onJobBoard())).toBe(false);
    // A second job board, with its own spelling of everything.
    const reworded = makeJob({ source: "remoteok", sourceId: "9", company: "Supabase Inc.", title: "Platform Engineer - Managed Postgres (Remote)", location: "Worldwide" });
    expect(repo.findTrackedJobId(reworded)).toBe(board.id);
    expect(repo.insertJob(reworded)).toBe(false);
    expect(tracked()).toEqual([["ashby", "supabase:1"]]);
  });

  test("of two job boards' copies the first one tracked is kept", () => {
    const first = track(onJobBoard());
    const second = makeJob({ source: "remotive", sourceId: "77", company: "Supabase", title: "Platform Engineer, Managed Postgres", location: "Worldwide" });

    expect(repo.findTrackedJobId(second)).toBe(first.id);
    expect(repo.insertJob(second)).toBe(false);
    expect(tracked()).toEqual([["realworkfromanywhere", first.sourceId]]);
  });

  test("the company's own listing takes the place of a job board's copy nobody has acted on", () => {
    const copy = track(onJobBoard());
    repo.saveEvaluation(makeReport(copy, { tier: EligibilityTier.POTENTIALLY_ELIGIBLE, needsB2bInvestigation: true }));
    repo.setJobStage(copy.id, PipelineStage.INVESTIGATING);
    repo.enqueueTask({ taskType: B2B_INVESTIGATION, jobId: copy.id });

    // Not tracked: the listing is let through, and inserting it replaces the copy.
    expect(repo.findTrackedJobId(onCompanyBoard())).toBeNull();
    expect(repo.insertJob(onCompanyBoard())).toBe(true);

    expect(tracked()).toEqual([["ashby", "supabase:1"]]);
    expect(repo.listJobs()[0]).toMatchObject({ applyUrl: "https://jobs.ashbyhq.com/supabase/1/application", location: "Remote, EMEA", stage: "discovered" });
    // The copy's evaluation and queued investigation went with it; the listing is qualified afresh.
    expect(repo.getEvaluation(copy.id)).toBeNull();
    expect(repo.listTasks(B2B_INVESTIGATION)).toEqual([]);
    // From then on the job board's copy is the duplicate.
    expect(repo.findTrackedJobId(onJobBoard())).toBe(onCompanyBoard().id);
  });

  test.each<[string, (copy: JobOpportunity) => void]>([
    ["has a draft", (copy) => void repo.saveDraft(makeDraft(copy), DraftStatus.AWAITING_REVIEW)],
    ["was sent", (copy) => void repo.recordDispatch({ jobId: copy.id, channel: Channel.ATS_INBOUND, companyKey: "supabase", domain: "", contact: "" })],
    ["was ruled on by the user", (copy) => repo.saveEvaluation(makeReport(copy, { reasonCodes: ["GEO_UNSPECIFIED", "B2B_REJECTED_BY_USER"] }))],
    ["is waiting on the user", (copy) => repo.setJobStage(copy.id, PipelineStage.NEEDS_ATTENTION)],
  ])("a job board's copy that %s stands for the role", (_what, act) => {
    const copy = track(onJobBoard());
    act(copy);

    expect(repo.findTrackedJobId(onCompanyBoard())).toBe(copy.id);
    expect(repo.insertJob(onCompanyBoard())).toBe(false);
    expect(tracked()).toEqual([["realworkfromanywhere", copy.sourceId]]);
  });

  test("a copy that has released the role lets the company's own listing in beside it, and stays on record", () => {
    // The same wording everywhere, so the two would also collide on the fingerprint.
    const copy = track(onJobBoard({ location: "Remote, EMEA" }));
    const draftId = repo.saveDraft(makeDraft(copy), DraftStatus.APPROVED);
    expect(repo.insertJob(onCompanyBoard())).toBe(false);

    repo.releaseRole(copy.id);

    expect(repo.findTrackedJobId(onCompanyBoard())).toBeNull();
    expect(repo.insertJob(onCompanyBoard())).toBe(true);
    expect(tracked()).toEqual([["realworkfromanywhere", copy.sourceId], ["ashby", "supabase:1"]]);
    // What was written for the copy is kept, and the job site listing it again adds nothing.
    expect(repo.getDraft(draftId)!.jobId).toBe(copy.id);
    expect(repo.findTrackedJobId(onJobBoard({ location: "Remote, EMEA" }))).toBe(copy.id);
    // Another job site's copy of the role is now the duplicate of the company's listing.
    const elsewhere = makeJob({ source: "remoteok", sourceId: "9", company: "Supabase", title: "Platform Engineer, Managed Postgres", location: "Worldwide" });
    expect(repo.findTrackedJobId(elsewhere)).toBe(onCompanyBoard().id);
  });

  test("two listings from one source are two openings, whatever their titles", () => {
    track(onCompanyBoard());
    expect(repo.insertJob(onCompanyBoard({ sourceId: "supabase:2", location: "Remote, AMER" }))).toBe(true);

    track(onJobBoard({ company: "Lemon.io", title: "Senior AI Engineer", location: "Europe" }));
    expect(repo.insertJob(onJobBoard({ sourceId: "other-listing", company: "Lemon.io", title: "Senior AI Engineer", location: "LATAM" }))).toBe(true);
    expect(count("jobs")).toBe(4);
  });

  test("a hiring-thread post neither replaces a copy nor is replaced", () => {
    const post = track(makeJob({ source: "hn", sourceId: "50033036", company: "Supabase", title: "Platform Engineer, Managed Postgres", location: "REMOTE", channel: Channel.FOUNDER_DIRECT }));

    // The company's board is another way in, on another channel: both are kept.
    expect(repo.insertJob(onCompanyBoard())).toBe(true);
    // A job board's copy adds nothing to either.
    expect(repo.findTrackedJobId(onJobBoard())).toBe(post.id);
    expect(count("jobs")).toBe(2);
  });
});

describe("two connections to one database file", () => {
  test("two connections cannot both insert the same job", () => {
    const file = tempDbPath();
    const first = open(file);
    const second = open(file);
    expect(first.insertJob(makeJob())).toBe(true);
    expect(second.insertJob(makeJob())).toBe(false);
    expect(second.listJobs()).toHaveLength(1);
    expect(first.listJobs()).toHaveLength(1);
  });

  test("nor the same role from different sources", () => {
    const file = tempDbPath();
    const first = open(file);
    const second = open(file);
    expect(first.insertJob(makeJob({ location: "Remote" }))).toBe(true);
    expect(second.insertJob(makeJob({ source: "lever", sourceId: "x9", company: "ACME ", location: "remote" }))).toBe(false);
    expect(second.insertJob(makeJob({ sourceId: "2", title: "Staff Engineer" }))).toBe(true);
    expect(first.listJobs().map((job) => job.title)).toEqual(["Senior Engineer", "Staff Engineer"]);
  });

  test("interleaved inserts of many jobs keep exactly one copy of each", () => {
    const file = tempDbPath();
    const connections = [open(file), open(file), open(file)];
    const accepted: boolean[] = [];
    for (let index = 0; index < 30; index += 1) {
      const job = makeJob({ sourceId: String(index % 10), title: `Engineer ${index % 10}` });
      accepted.push(connections[index % 3].insertJob(job));
    }
    expect(accepted.filter(Boolean)).toHaveLength(10);
    expect(accepted.slice(0, 10).every(Boolean)).toBe(true);
    expect(connections[2].listJobs()).toHaveLength(10);
  });

  test("what one connection commits, the other reads", () => {
    const file = tempDbPath();
    const first = open(file);
    const second = open(file);
    const job = track(makeJob(), first);
    first.setJobStage(job.id, PipelineStage.QUALIFIED);
    first.setState("cursor", { page: 3 });

    expect(second.getJob(job.id)?.stage).toBe(PipelineStage.QUALIFIED);
    expect(second.getState("cursor")).toEqual({ page: 3 });
  });

  test("an open transaction holds the write lock and hides its writes until it commits", () => {
    const file = tempDbPath();
    const first = open(file);
    const second = open(file);
    second.db.exec("PRAGMA busy_timeout = 25"); // do not wait five seconds to learn the lock is held

    first.transaction(() => {
      first.insertJob(makeJob());
      first.setState("marker", { written: true });

      expect(second.listJobs()).toEqual([]);
      expect(second.getState("marker")).toBeNull();
      expect(() => second.setState("other", 1)).toThrow(/locked/i);
      expect(() => second.transaction(() => undefined)).toThrow(/locked/i);
    });

    expect(second.listJobs()).toHaveLength(1);
    expect(second.getState("marker")).toEqual({ written: true });
    second.setState("other", 1);
    expect(first.getState("other")).toBe(1);
  });

  test("a failed attempt to start a transaction leaves the connection usable", () => {
    const file = tempDbPath();
    const first = open(file);
    const second = open(file);
    second.db.exec("PRAGMA busy_timeout = 25");

    first.transaction(() => {
      expect(() => second.transaction(() => second.setState("never", 1))).toThrow(/locked/i);
    });

    expect(second.db.isTransaction).toBe(false);
    expect(second.transaction(() => second.insertJob(makeJob()))).toBe(true);
    expect(first.getState("never")).toBeNull();
    expect(first.listJobs()).toHaveLength(1);
  });

  test("a transaction rolled back on one connection is never seen by the other", () => {
    const file = tempDbPath();
    const first = open(file);
    const second = open(file);

    expect(() =>
      first.transaction(() => {
        first.insertJob(makeJob());
        throw new Error("boom");
      }),
    ).toThrow("boom");

    expect(second.listJobs()).toEqual([]);
    expect(second.insertJob(makeJob())).toBe(true);
    expect(first.insertJob(makeJob())).toBe(false);
  });

  test("an up-to-date database can be opened while another connection is writing", () => {
    const file = tempDbPath();
    const first = open(file);
    track(makeJob({ sourceId: "0", title: "Committed" }), first);

    first.transaction(() => {
      first.insertJob(makeJob());
      // Opening must not need the write lock: the console starts while the daemon works.
      const late = open(file);
      expect(late.listJobs().map((job) => job.title)).toEqual(["Committed"]);
    });

    expect(open(file).listJobs()).toHaveLength(2);
  });

  test("opening an up-to-date database writes nothing to it", () => {
    const file = tempDbPath();
    const first = open(file);
    track(makeJob(), first);
    // data_version moves whenever some other connection commits a change to the file.
    const dataVersion = (): number => first.query<{ data_version: number }>("PRAGMA data_version")[0].data_version;
    const before = dataVersion();

    const second = open(file);
    expect(second.listJobs()).toHaveLength(1);
    second.close();
    new Repository(file).close();
    expect(dataVersion()).toBe(before);

    open(file).setState("written", true); // whereas a real write is seen
    expect(dataVersion()).not.toBe(before);
  });
});

describe("transactions", () => {
  test("a failure rolls back every write in the transaction", () => {
    const boom = new Error("boom");
    let thrown: unknown;
    try {
      repo.transaction(() => {
        repo.insertJob(makeJob());
        repo.setState("marker", { written: true });
        throw boom;
      });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBe(boom); // the caller sees the original error, not a wrapper
    expect(repo.listJobs()).toEqual([]);
    expect(repo.getState("marker")).toBeNull();
  });

  test("the repository stays usable after a rollback", () => {
    expect(() =>
      repo.transaction(() => {
        throw new Error("boom");
      }),
    ).toThrow("boom");
    expect(repo.db.isTransaction).toBe(false);
    expect(repo.insertJob(makeJob())).toBe(true);
    expect(repo.transaction(() => repo.listJobs().length)).toBe(1);
  });

  test("a database error inside the transaction rolls it back too", () => {
    const job = track();
    expect(() =>
      repo.transaction(() => {
        repo.setJobStage(job.id, PipelineStage.QUALIFIED);
        repo.enqueueTask({ taskType: B2B_INVESTIGATION, jobId: "no-such-job" }); // foreign key violation
      }),
    ).toThrow(/FOREIGN KEY/i);
    expect(repo.getJob(job.id)?.stage).toBe(PipelineStage.DISCOVERED);
    expect(repo.insertJob(makeJob({ sourceId: "2", title: "Next" }))).toBe(true);
  });

  test("the transaction returns what its work returns, and commits", () => {
    const result = repo.transaction(() => {
      repo.insertJob(makeJob());
      return { inserted: repo.listJobs().length };
    });
    expect(result).toEqual({ inserted: 1 });
    expect(repo.db.isTransaction).toBe(false);
    expect(repo.listJobs()).toHaveLength(1);
  });

  test("a nested transaction joins the outer one: an outer failure undoes the inner work", () => {
    expect(() =>
      repo.transaction(() => {
        repo.transaction(() => {
          repo.insertJob(makeJob());
          repo.setState("inner", 1);
        });
        // The inner block has ended, but nothing is committed until the outer one ends.
        expect(repo.db.isTransaction).toBe(true);
        expect(repo.listJobs()).toHaveLength(1);
        repo.setState("outer", 2);
        throw new Error("outer failed");
      }),
    ).toThrow("outer failed");

    expect(repo.listJobs()).toEqual([]);
    expect(repo.getState("inner")).toBeNull();
    expect(repo.getState("outer")).toBeNull();
    expect(repo.db.isTransaction).toBe(false);
  });

  test("a nested failure undoes the outer work as well", () => {
    expect(() =>
      repo.transaction(() => {
        repo.setState("outer", 1);
        repo.transaction(() => {
          repo.transaction(() => {
            repo.insertJob(makeJob());
            throw new Error("deep failure");
          });
        });
      }),
    ).toThrow("deep failure");

    expect(repo.getState("outer")).toBeNull();
    expect(repo.listJobs()).toEqual([]);
    expect(repo.insertJob(makeJob())).toBe(true);
  });

  test("nested transactions commit once, together, and return their values", () => {
    const outcome = repo.transaction(() => {
      const inner = repo.transaction(() => {
        repo.insertJob(makeJob());
        return "inner value";
      });
      repo.setState("after-inner", true);
      return [inner, repo.db.isTransaction];
    });
    expect(outcome).toEqual(["inner value", true]);
    expect(repo.db.isTransaction).toBe(false);
    expect(repo.listJobs()).toHaveLength(1);
    expect(repo.getState("after-inner")).toBe(true);
  });

  test("composite repository methods join a caller's transaction", () => {
    const job = track();
    expect(() =>
      repo.transaction(() => {
        repo.saveProfile(makeProfile());
        repo.saveEvaluation(makeReport(job));
        repo.saveDraft(makeDraft(job), DraftStatus.AWAITING_REVIEW);
        repo.quarantine([{ jobId: job.id, violationRule: "9_tone", originalContent: "{}", critique: "cliché", retryCount: 0 }]);
        repo.recordOutcome({ jobId: job.id, channel: Channel.ATS_INBOUND, kind: OutcomeKind.RESPONSE, note: "", monthlyValueUsd: null });
        throw new Error("caller failed");
      }),
    ).toThrow("caller failed");

    expect(repo.getProfile()).toBeNull();
    expect(repo.getEvaluation(job.id)).toBeNull();
    expect(repo.listDrafts()).toEqual([]);
    expect(repo.listQuarantined()).toEqual([]);
    expect(repo.listOutcomes()).toEqual([]);
    expect(repo.getJob(job.id)?.stage).toBe(PipelineStage.DISCOVERED);
  });
});

describe("statement parameters", () => {
  test("booleans are stored as 0/1 and undefined as NULL", () => {
    expect(repo.query("SELECT ? AS yes, ? AS no, ? AS missing, ? AS text, ? AS number", [true, false, undefined, "x", 1.5])).toEqual([
      { yes: 1, no: 0, missing: null, text: "x", number: 1.5 },
    ]);
  });

  test("run reports the rows changed and the new row id", () => {
    const inserted = repo.run("INSERT INTO system_state (key, value_json, updated_at) VALUES (?, ?, ?)", ["a", "1", utcNowIso()]);
    expect(inserted.changes).toBe(1);
    expect(typeof inserted.lastInsertRowid).toBe("number");
    expect(repo.run("UPDATE system_state SET value_json = '2' WHERE key = ?", ["missing"]).changes).toBe(0);
    expect(repo.run("DELETE FROM system_state").changes).toBe(1);
  });
});

describe("quarantine", () => {
  test("quarantine writes the items and the job stage together", () => {
    const job = track();
    const ids = repo.quarantine([
      { jobId: job.id, violationRule: "2_screening_sanity", originalContent: "{}", critique: "ambiguous question", retryCount: 0 },
      { jobId: job.id, violationRule: "9_tone", originalContent: "{}", critique: "cliché", retryCount: 2 },
    ]);

    expect(ids).toHaveLength(2);
    expect(repo.getJob(job.id)?.stage).toBe(PipelineStage.QUARANTINED);
    const held = repo.listQuarantined();
    expect(held.map((item) => item.violationRule)).toEqual(["2_screening_sanity", "9_tone"]);
    expect(held.map((item) => item.id)).toEqual(ids);
    expect(held[1].retryCount).toBe(2);
    expect(held[1]).toEqual({
      id: ids[1], jobId: job.id, violationRule: "9_tone", originalContent: "{}", critique: "cliché",
      retryCount: 2, status: "pending", createdAt: expect.stringMatching(ISO_RX),
    });
    expect(held[0].createdAt).toBe(held[1].createdAt); // one inspection, one moment
  });

  test("if one item cannot be stored, none are and the job is not marked", () => {
    const job = track();
    repo.setJobStage(job.id, PipelineStage.QUALIFIED);

    expect(() =>
      repo.quarantine([
        { jobId: job.id, violationRule: "9_tone", originalContent: "{}", critique: "cliché", retryCount: 1 },
        { jobId: job.id, violationRule: "1_grounding", originalContent: "{}", critique: null as unknown as string, retryCount: 1 },
      ]),
    ).toThrow(/NOT NULL/i);

    expect(repo.listQuarantined()).toEqual([]);
    expect(count("quarantined_items")).toBe(0);
    expect(repo.getJob(job.id)?.stage).toBe(PipelineStage.QUALIFIED);
    expect(repo.db.isTransaction).toBe(false);
  });

  test("items for several jobs quarantine each of those jobs and no others", () => {
    const first = track(makeJob({ sourceId: "1", title: "First" }));
    const second = track(makeJob({ sourceId: "2", title: "Second" }));
    const bystander = track(makeJob({ sourceId: "3", title: "Bystander" }));

    repo.quarantine([
      { jobId: first.id, violationRule: "9_tone", originalContent: "a", critique: "x", retryCount: 0 },
      { jobId: second.id, violationRule: "9_tone", originalContent: "b", critique: "y", retryCount: 0 },
      { jobId: first.id, violationRule: "8_deduplication", originalContent: "a", critique: "z", retryCount: 0 },
    ]);

    expect(repo.listJobs(PipelineStage.QUARANTINED).map((job) => job.id)).toEqual([first.id, second.id]);
    expect(repo.getJob(bystander.id)?.stage).toBe(PipelineStage.DISCOVERED);
  });

  test("an explicit creation time and status are kept", () => {
    const job = track();
    const heldAt = "2026-10-12T09:00:00.000000+00:00";
    repo.quarantine([
      { jobId: job.id, violationRule: "9_tone", originalContent: "{}", critique: "x", retryCount: 0, createdAt: heldAt },
      { jobId: job.id, violationRule: "7_rate", originalContent: "{}", critique: "y", retryCount: 0, status: "reviewed" },
    ]);
    expect(repo.listQuarantined().map((item) => [item.violationRule, item.createdAt])).toEqual([["9_tone", heldAt]]);
    expect(repo.listQuarantined("reviewed").map((item) => item.violationRule)).toEqual(["7_rate"]);
  });

  test("quarantining nothing does nothing", () => {
    const job = track();
    expect(repo.quarantine([])).toEqual([]);
    expect(repo.getJob(job.id)?.stage).toBe(PipelineStage.DISCOVERED);
  });

  test("markQuarantineReviewed counts only the items that were still pending", () => {
    const job = track();
    const ids = repo.quarantine([
      { jobId: job.id, violationRule: "9_tone", originalContent: "{}", critique: "a", retryCount: 0 },
      { jobId: job.id, violationRule: "8_deduplication", originalContent: "{}", critique: "b", retryCount: 0 },
      { jobId: job.id, violationRule: "1_grounding", originalContent: "{}", critique: "c", retryCount: 0 },
    ]);

    expect(repo.markQuarantineReviewed([ids[0], ids[1]])).toBe(2);
    expect(repo.listQuarantined().map((item) => item.id)).toEqual([ids[2]]);
    expect(repo.listQuarantined("reviewed").map((item) => item.id)).toEqual([ids[0], ids[1]]);

    expect(repo.markQuarantineReviewed([ids[0], ids[1]])).toBe(0); // already reviewed
    expect(repo.markQuarantineReviewed(ids)).toBe(1); // only the third was still pending
    expect(repo.markQuarantineReviewed(ids)).toBe(0);
    expect(repo.listQuarantined()).toEqual([]);
  });

  test("reviewing unknown ids, or none, changes nothing", () => {
    const job = track();
    const ids = repo.quarantine([{ jobId: job.id, violationRule: "9_tone", originalContent: "{}", critique: "a", retryCount: 0 }]);
    expect(repo.markQuarantineReviewed([])).toBe(0);
    expect(repo.markQuarantineReviewed([9999])).toBe(0);
    expect(repo.markQuarantineReviewed([9999, ids[0], ids[0]])).toBe(1);
  });

  test("reviewing a held item leaves the job quarantined for the user to resolve", () => {
    const job = track();
    const ids = repo.quarantine([{ jobId: job.id, violationRule: "9_tone", originalContent: "{}", critique: "a", retryCount: 0 }]);
    repo.markQuarantineReviewed(ids);
    expect(repo.getJob(job.id)?.stage).toBe(PipelineStage.QUARANTINED);
  });
});

describe("candidate profile", () => {
  test("a profile round-trips, and saving again replaces it", () => {
    const profile = makeProfile();
    repo.saveProfile(profile);
    expect(repo.getProfile()).toEqual(profile);

    profile.achievements = profile.achievements.slice(0, 1);
    profile.name = "Renamed Candidate";
    repo.saveProfile(profile);
    const stored = repo.getProfile();
    expect(stored?.achievements.map((achievement) => achievement.id)).toEqual(["ach_1"]);
    expect(stored?.name).toBe("Renamed Candidate");
    expect(stored).toEqual(profile);
    expect(count("candidate_profile")).toBe(1);
  });

  test("a missing profile is null", () => {
    expect(repo.getProfile()).toBeNull();
    expect(repo.getProfile("someone-else")).toBeNull();
  });

  test("replacing a profile replaces its positioning variants too", () => {
    const profile = makeProfile();
    repo.saveProfile(profile);
    profile.positioning = {
      p2: { id: "p2", title: "Second", targetSummary: "", coreSkills: [], pitchAngle: "", highlightedAchievements: [] },
      p0: { id: "p0", title: "Zeroth", targetSummary: "S", coreSkills: ["React"], pitchAngle: "A", highlightedAchievements: ["ach_2"] },
    };
    repo.saveProfile(profile);

    const stored = repo.getProfile();
    expect(stored?.positioning).toEqual(profile.positioning);
    expect(Object.keys(stored!.positioning)).toEqual(["p2", "p0"]); // saved order, not sorted
    expect(count("positioning_profiles")).toBe(2);
  });

  test("achievements keep their order and every field", () => {
    const profile = makeProfile({
      yearsExperience: null,
      employers: [],
      skills: [],
      achievements: [
        {
          id: "ach_z", category: "full_stack", headline: 'Shipped "Z"', impactMetric: "4M requests/day at p95 < 100ms",
          technologies: ["TypeScript", "Next.js"], context: "Solo build", employer: "Initech",
          evidenceUrl: "https://github.com/test-candidate/z", positioning: ["fullstack_product", "frontend_systems"],
          verified: true,
        },
        {
          id: "ach_a", category: "", headline: "Built A", impactMetric: "", technologies: [], context: "",
          employer: "", evidenceUrl: "", positioning: [], verified: false,
        },
      ],
      positioning: {},
    });
    repo.saveProfile(profile);
    const stored = repo.getProfile();
    expect(stored).toEqual(profile);
    expect(stored?.achievements.map((achievement) => achievement.id)).toEqual(["ach_z", "ach_a"]);
    expect(stored?.achievements.map((achievement) => achievement.verified)).toEqual([true, false]);
    expect(stored?.yearsExperience).toBeNull();
  });

  test("a save that fails part-way leaves the previous profile untouched", () => {
    const original = makeProfile();
    repo.saveProfile(original);

    const broken = makeProfile({ name: "Half Saved" });
    broken.achievements = [broken.achievements[0], { ...broken.achievements[1], id: "ach_1" }]; // duplicate id
    expect(() => repo.saveProfile(broken)).toThrow(/UNIQUE/i);

    expect(repo.getProfile()).toEqual(original);
  });

  test("profiles are kept per candidate id", () => {
    const main = makeProfile();
    const other = makeProfile({
      id: "other", name: "Other Candidate",
      achievements: [{ ...makeProfile().achievements[0], id: "ach_other" }],
      positioning: {},
    });
    repo.saveProfile(main);
    repo.saveProfile(other);

    expect(repo.getProfile()).toEqual(main);
    expect(repo.getProfile(DEFAULT_CANDIDATE_ID)).toEqual(main);
    expect(repo.getProfile("other")).toEqual(other);
  });
});

describe("system state", () => {
  test("state upserts", () => {
    expect(repo.getState("missing", 7)).toBe(7);
    repo.setState("key", { a: 1 });
    repo.setState("key", { a: 2 });
    expect(repo.getState("key")).toEqual({ a: 2 });
    expect(count("system_state")).toBe(1);
  });

  test("a missing key is null unless a fallback is given", () => {
    expect(repo.getState("missing")).toBeNull();
    expect(repo.getState("missing", { day: "" })).toEqual({ day: "" });
  });

  test("any JSON value round-trips, and a stored falsy value is not mistaken for missing", () => {
    const values: unknown[] = [0, false, "", [], {}, null, "text", 1.5, [1, "two", { three: [3] }], { nested: { deep: true } }];
    values.forEach((value, index) => {
      repo.setState(`key-${index}`, value);
      expect(repo.getState(`key-${index}`, "fallback")).toEqual(value);
    });
  });

  test("keys are independent", () => {
    repo.setState("a", 1);
    repo.setState("b", 2);
    repo.setState("a", 3);
    expect(repo.getState("a")).toBe(3);
    expect(repo.getState("b")).toBe(2);
  });
});

describe("eligibility evaluations", () => {
  test("an evaluation round-trips", () => {
    const job = track();
    const report = makeReport(job, {
      tier: EligibilityTier.POTENTIALLY_ELIGIBLE, reasonCodes: ["REMOTE_UNSPECIFIED", "US_HQ"],
      positiveSignals: ["REMOTE: fully remote team"], disqualifiers: ["US_HQ: San Francisco startup"],
      needsB2bInvestigation: true, summary: "Needs a contractor check",
    });
    repo.saveEvaluation(report);
    expect(repo.getEvaluation(job.id)).toEqual(report);
  });

  test("saving again replaces the evaluation", () => {
    const job = track();
    repo.saveEvaluation(makeReport(job, { tier: EligibilityTier.POTENTIALLY_ELIGIBLE, needsB2bInvestigation: true }));
    const final = makeReport(job, {
      tier: EligibilityTier.INELIGIBLE, reasonCodes: ["CITIZENSHIP_REQUIRED"], positiveSignals: [],
      disqualifiers: ["CITIZENSHIP_REQUIRED: US citizenship required"], summary: "",
    });
    repo.saveEvaluation(final);
    expect(repo.getEvaluation(job.id)).toEqual(final);
    expect(count("job_evaluations")).toBe(1);
  });

  test("a job that was never evaluated has no evaluation", () => {
    const job = track();
    expect(repo.getEvaluation(job.id)).toBeNull();
    expect(repo.getEvaluation("deadbeef")).toBeNull();
  });

  test("the database refuses an evaluation for an unknown job or an unknown tier", () => {
    const job = track();
    expect(() => repo.saveEvaluation(makeReport(makeJob({ sourceId: "untracked" })))).toThrow(/FOREIGN KEY/i);
    expect(() => repo.saveEvaluation(makeReport(job, { tier: "maybe" as EligibilityTier }))).toThrow(/CHECK/i);
    expect(repo.getEvaluation(job.id)).toBeNull();
  });
});

describe("fit scores", () => {
  const fitFor = (job: JobOpportunity, overrides: Partial<FitEvaluation> = {}): FitEvaluation => ({
    jobId: job.id, fitScore: 82.5, bestPositioningProfile: "ai_platform_agent",
    matchedSkills: ["Python", "LangGraph"], missingSkills: ["Rust"], ...overrides,
  });

  test("a fit is attached to an evaluated job and read back", () => {
    const job = track();
    const report = makeReport(job);
    repo.saveEvaluation(report);
    expect(repo.getFit(job.id)).toBeNull(); // evaluated, not yet scored

    repo.saveFit(fitFor(job));

    expect(repo.getFit(job.id)).toEqual(fitFor(job));
    expect(repo.getEvaluation(job.id)).toEqual(report); // the eligibility verdict is untouched
  });

  test("saving a fit again replaces it", () => {
    const job = track();
    repo.saveEvaluation(makeReport(job));
    repo.saveFit(fitFor(job));
    const rescored = fitFor(job, { fitScore: 41, bestPositioningProfile: "fullstack_product", matchedSkills: [], missingSkills: ["Go", "Kafka"] });
    repo.saveFit(rescored);
    expect(repo.getFit(job.id)).toEqual(rescored);
  });

  test("a score of zero is a score, not a missing fit", () => {
    const job = track();
    repo.saveEvaluation(makeReport(job));
    repo.saveFit(fitFor(job, { fitScore: 0, matchedSkills: [], missingSkills: ["Everything"] }));
    expect(repo.getFit(job.id)?.fitScore).toBe(0);
  });

  test("a job without an evaluation cannot carry a fit", () => {
    const job = track();
    repo.saveFit(fitFor(job));
    expect(repo.getFit(job.id)).toBeNull();
    expect(repo.getFit("deadbeef")).toBeNull();
    expect(count("job_evaluations")).toBe(0);
  });

  test("re-evaluating eligibility keeps the fit already scored", () => {
    const job = track();
    repo.saveEvaluation(makeReport(job));
    repo.saveFit(fitFor(job));
    repo.saveEvaluation(makeReport(job, { summary: "Re-checked" }));
    expect(repo.getFit(job.id)).toEqual(fitFor(job));
    expect(repo.getEvaluation(job.id)?.summary).toBe("Re-checked");
  });

  test("fits are kept per job", () => {
    const first = track(makeJob({ sourceId: "1", title: "First" }));
    const second = track(makeJob({ sourceId: "2", title: "Second" }));
    repo.saveEvaluation(makeReport(first));
    repo.saveEvaluation(makeReport(second));
    repo.saveFit(fitFor(first, { fitScore: 90 }));
    expect(repo.getFit(first.id)?.fitScore).toBe(90);
    expect(repo.getFit(second.id)).toBeNull();
  });
});

describe("task queue", () => {
  test("a task is queued once per type and job", () => {
    const job = track();
    expect(repo.enqueueTask({ taskType: B2B_INVESTIGATION, jobId: job.id, detail: "US HQ, remote unspecified" })).toBe(true);
    expect(repo.enqueueTask({ taskType: B2B_INVESTIGATION, jobId: job.id, detail: "again" })).toBe(false);
    expect(repo.enqueueTask({ taskType: "resume_render", jobId: job.id })).toBe(true);

    const [task] = repo.listTasks(B2B_INVESTIGATION);
    expect(repo.listTasks(B2B_INVESTIGATION)).toHaveLength(1);
    expect(task).toEqual({
      id: expect.any(Number), taskType: B2B_INVESTIGATION, jobId: job.id, detail: "US HQ, remote unspecified",
      status: "pending", createdAt: expect.stringMatching(ISO_RX),
    });
    expect(repo.listTasks("resume_render")[0].detail).toBe("");
  });

  test("tasks are listed oldest first", () => {
    const jobs = ["1", "2", "3"].map((sourceId) => track(makeJob({ sourceId, title: `Role ${sourceId}` })));
    for (const job of [jobs[2], jobs[0], jobs[1]]) repo.enqueueTask({ taskType: B2B_INVESTIGATION, jobId: job.id });
    expect(repo.listTasks(B2B_INVESTIGATION).map((task) => task.jobId)).toEqual([jobs[2].id, jobs[0].id, jobs[1].id]);
  });

  test("setTaskStatus moves one task out of the pending queue", () => {
    const first = track(makeJob({ sourceId: "1", title: "First" }));
    const second = track(makeJob({ sourceId: "2", title: "Second" }));
    repo.enqueueTask({ taskType: B2B_INVESTIGATION, jobId: first.id });
    repo.enqueueTask({ taskType: B2B_INVESTIGATION, jobId: second.id });
    repo.enqueueTask({ taskType: "resume_render", jobId: first.id });

    repo.setTaskStatus(B2B_INVESTIGATION, first.id, "done");

    expect(repo.listTasks(B2B_INVESTIGATION).map((task) => task.jobId)).toEqual([second.id]);
    expect(repo.listTasks(B2B_INVESTIGATION, "done").map((task) => [task.jobId, task.status])).toEqual([[first.id, "done"]]);
    expect(repo.listTasks("resume_render").map((task) => task.jobId)).toEqual([first.id]); // other types untouched
  });

  test("a finished task is not queued a second time", () => {
    const job = track();
    repo.enqueueTask({ taskType: B2B_INVESTIGATION, jobId: job.id });
    repo.setTaskStatus(B2B_INVESTIGATION, job.id, "done");
    expect(repo.enqueueTask({ taskType: B2B_INVESTIGATION, jobId: job.id })).toBe(false);
    expect(repo.listTasks(B2B_INVESTIGATION)).toEqual([]);
  });

  test("a task can be queued in another status, and setting an unknown task's status is harmless", () => {
    const job = track();
    expect(repo.enqueueTask({ taskType: B2B_INVESTIGATION, jobId: job.id, status: "blocked" })).toBe(true);
    expect(repo.listTasks(B2B_INVESTIGATION)).toEqual([]);
    expect(repo.listTasks(B2B_INVESTIGATION, "blocked")).toHaveLength(1);
    expect(() => repo.setTaskStatus("no-such-type", job.id, "done")).not.toThrow();
    expect(repo.listTasks(B2B_INVESTIGATION, "blocked")).toHaveLength(1);
  });

  test("a task cannot be queued for a job that is not tracked", () => {
    expect(() => repo.enqueueTask({ taskType: B2B_INVESTIGATION, jobId: "deadbeef" })).toThrow(/FOREIGN KEY/i);
    expect(count("pipeline_tasks")).toBe(0);
  });
});

describe("cost telemetry", () => {
  test("an entry records what is given and defaults the rest", () => {
    const id = repo.recordTelemetry({ provider: "fireworks", model: LLAMA, taskType: "pitch" });
    expect(repo.getTelemetry(id)).toEqual({
      id, timestamp: expect.stringMatching(ISO_RX), provider: "fireworks", model: LLAMA, taskType: "pitch",
      promptTokens: 0, completionTokens: 0, costUsd: 0, latencyMs: 0, outcome: "ok",
    });
  });

  test("a full entry round-trips", () => {
    const entry = {
      timestamp: PYTHON_TIMESTAMP, provider: "jev", model: "jev-latest", taskType: "b2b_investigation",
      promptTokens: 912, completionTokens: 31, costUsd: 0.0000383, latencyMs: 412, outcome: "pending",
    };
    const id = repo.recordTelemetry(entry);
    expect(repo.getTelemetry(id)).toEqual({ id, ...entry });
    expect(repo.getTelemetry(id + 1)).toBeNull();
  });

  test("settling replaces the reserved figures and nothing else", () => {
    const id = repo.recordTelemetry({ provider: "fireworks", model: LLAMA, taskType: "pitch", costUsd: 0.0015, outcome: "pending", timestamp: PYTHON_TIMESTAMP });
    const other = repo.recordTelemetry({ provider: "fireworks", model: LLAMA, taskType: "pitch", costUsd: 0.0015, outcome: "pending" });

    repo.settleTelemetry(id, { promptTokens: 1000, completionTokens: 200, costUsd: 0.00108, latencyMs: 800, outcome: "ok" });

    expect(repo.getTelemetry(id)).toEqual({
      id, timestamp: PYTHON_TIMESTAMP, provider: "fireworks", model: LLAMA, taskType: "pitch",
      promptTokens: 1000, completionTokens: 200, costUsd: 0.00108, latencyMs: 800, outcome: "ok",
    });
    expect(repo.getTelemetry(other)).toMatchObject({ costUsd: 0.0015, outcome: "pending", promptTokens: 0 });
  });

  test("entries are listed newest first, up to a limit", () => {
    const stamps = ["2026-10-12T08:00:00.000000+00:00", "2026-10-12T10:00:00.000000+00:00", "2026-10-12T09:00:00.000000+00:00", "2026-10-12T10:00:00.000000+00:00"];
    const ids = stamps.map((timestamp) => repo.recordTelemetry({ provider: "jev", model: "jev-latest", taskType: "t", timestamp }));

    expect(repo.listTelemetry().map((entry) => entry.id)).toEqual([ids[3], ids[1], ids[2], ids[0]]);
    expect(repo.listTelemetry(2).map((entry) => entry.id)).toEqual([ids[3], ids[1]]);
    expect(repo.listTelemetry(0)).toEqual([]);
  });

  test("the default listing stops at 100 entries", () => {
    repo.transaction(() => {
      for (let index = 0; index < 105; index += 1) repo.recordTelemetry({ provider: "jev", model: "jev-latest", taskType: "t" });
    });
    expect(repo.listTelemetry()).toHaveLength(100);
    expect(repo.listTelemetry(500)).toHaveLength(105);
  });

  test("spendSince totals everything from the cut-off on, reservations included", () => {
    const day = "2026-10-12T00:00:00.000000+00:00";
    expect(repo.spendSince(day)).toBe(0);

    repo.recordTelemetry({ provider: "fireworks", model: LLAMA, taskType: "pitch", costUsd: 0.25, timestamp: "2026-10-11T23:59:59.999000+00:00" });
    repo.recordTelemetry({ provider: "fireworks", model: LLAMA, taskType: "pitch", costUsd: 0.5, timestamp: day }); // exactly at the cut-off
    repo.recordTelemetry({ provider: "fireworks", model: LLAMA, taskType: "pitch", costUsd: 0.125, timestamp: PYTHON_TIMESTAMP, outcome: "pending" });

    expect(repo.spendSince(day)).toBe(0.625);
    expect(repo.spendSince("")).toBe(0.875);
    expect(repo.spendSince("2026-10-13T00:00:00.000000+00:00")).toBe(0);
  });

  test("spendBreakdown reports calls, tokens, spend and latency per model, dearest first", () => {
    const record = (provider: string, model: string, costUsd: number, latencyMs: number, timestamp: string) =>
      repo.recordTelemetry({ provider, model, taskType: "pitch", promptTokens: 1000, completionTokens: 200, costUsd, latencyMs, timestamp });
    record("jev", "jev-latest", 0.00004, 120, "2026-10-12T09:00:00.000000+00:00");
    record("fireworks", LLAMA, 0.001, 800, "2026-10-12T10:00:00.000000+00:00");
    record("fireworks", LLAMA, 0.25, 401, "2026-10-10T10:00:00.000000+00:00");
    record("fireworks", "accounts/fireworks/models/qwen2p5-72b-instruct", 0.002, 300, "2026-10-12T11:00:00.000000+00:00");

    const allTime = repo.spendBreakdown();
    expect(allTime.map((row) => [row.provider, row.model])).toEqual([
      ["fireworks", LLAMA],
      ["fireworks", "accounts/fireworks/models/qwen2p5-72b-instruct"],
      ["jev", "jev-latest"],
    ]);
    expect(allTime[0]).toEqual({
      provider: "fireworks", model: LLAMA, calls: 2, promptTokens: 2000, completionTokens: 400,
      costUsd: expect.closeTo(0.251, 9), avgLatencyMs: 600, // the mean of 800 and 401, truncated
    });
    expect(allTime[2]).toEqual({
      provider: "jev", model: "jev-latest", calls: 1, promptTokens: 1000, completionTokens: 200,
      costUsd: 0.00004, avgLatencyMs: 120,
    });

    const today = repo.spendBreakdown("2026-10-12T00:00:00.000000+00:00");
    expect(today.map((row) => [row.model, row.calls, row.costUsd])).toEqual([
      ["accounts/fireworks/models/qwen2p5-72b-instruct", 1, 0.002],
      [LLAMA, 1, 0.001],
      ["jev-latest", 1, 0.00004],
    ]);
    expect(repo.spendBreakdown("2026-10-13T00:00:00.000000+00:00")).toEqual([]);
  });

  test("spendBreakdown of an empty ledger is empty", () => {
    expect(repo.spendBreakdown()).toEqual([]);
  });
});

describe("drafts", () => {
  test("saveDraft stores the draft and moves the job to the matching stage", () => {
    const job = track();
    const draft = makeDraft(job);

    const id = repo.saveDraft(draft, DraftStatus.AWAITING_REVIEW, 2);

    expect(repo.getDraft(id)).toEqual({
      id, jobId: job.id, status: DraftStatus.AWAITING_REVIEW, draft, copRetries: 2, note: "",
      createdAt: expect.stringMatching(ISO_RX), updatedAt: expect.stringMatching(ISO_RX),
    });
    expect(repo.getDraft(id)?.createdAt).toBe(repo.getDraft(id)?.updatedAt);
    expect(repo.getJob(job.id)?.stage).toBe(PipelineStage.AWAITING_REVIEW);
  });

  test("a draft with only defaults round-trips, with no Cop retries", () => {
    const job = track();
    const draft = createDraft({ jobId: job.id });
    const id = repo.saveDraft(draft, DraftStatus.APPROVED);
    expect(repo.getDraft(id)).toMatchObject({ draft, copRetries: 0, status: DraftStatus.APPROVED });
    expect(repo.getDraft(id)?.draft.quotedRateUsd).toBeNull();
    expect(repo.getJob(job.id)?.stage).toBe(PipelineStage.APPROVED);
  });

  test("every draft status is also a pipeline stage", () => {
    const stages: string[] = Object.values(PipelineStage);
    for (const status of Object.values(DraftStatus)) expect(stages).toContain(status);
  });

  test.each(Object.values(DraftStatus))("setDraftStatus(%s) moves the draft and its job together", (status) => {
    const job = track();
    const bystander = track(makeJob({ sourceId: "2", title: "Bystander" }));
    const id = repo.saveDraft(makeDraft(job), DraftStatus.AWAITING_REVIEW);
    const otherId = repo.saveDraft(makeDraft(bystander), DraftStatus.AWAITING_REVIEW);

    expect(repo.setDraftStatus(id, status, "because")).toBe(true);

    expect(repo.getDraft(id)).toMatchObject({ status, note: "because" });
    expect(repo.getJob(job.id)?.stage).toBe(status);
    expect(repo.getDraft(otherId)).toMatchObject({ status: DraftStatus.AWAITING_REVIEW, note: "" });
    expect(repo.getJob(bystander.id)?.stage).toBe(PipelineStage.AWAITING_REVIEW);
  });

  test("setDraftStatus stamps the change, keeps the content and clears the note by default", () => {
    const job = track();
    const draft = makeDraft(job);
    const id = repo.saveDraft(draft, DraftStatus.AWAITING_REVIEW, 1);
    repo.run("UPDATE application_drafts SET updated_at = ?, created_at = ?", [LONG_AGO, LONG_AGO]);

    repo.setDraftStatus(id, DraftStatus.NEEDS_ATTENTION, "CAPTCHA on the application form");
    expect(repo.getDraft(id)).toMatchObject({ note: "CAPTCHA on the application form", draft, copRetries: 1, createdAt: LONG_AGO });
    expect(repo.getDraft(id)!.updatedAt).toMatch(ISO_RX);
    expect(repo.getDraft(id)!.updatedAt > LONG_AGO).toBe(true);

    repo.setDraftStatus(id, DraftStatus.APPROVED);
    expect(repo.getDraft(id)).toMatchObject({ status: DraftStatus.APPROVED, note: "" });
  });

  test("setDraftStatus on an unknown draft returns false and changes nothing", () => {
    const job = track();
    const id = repo.saveDraft(makeDraft(job), DraftStatus.AWAITING_REVIEW);

    expect(repo.setDraftStatus(id + 100, DraftStatus.APPROVED, "nope")).toBe(false);

    expect(repo.getDraft(id)).toMatchObject({ status: DraftStatus.AWAITING_REVIEW, note: "" });
    expect(repo.getJob(job.id)?.stage).toBe(PipelineStage.AWAITING_REVIEW);
    expect(repo.db.isTransaction).toBe(false);
  });

  test("updateDraftContent replaces the content and leaves the status, the stage and the rest alone", () => {
    const job = track();
    const id = repo.saveDraft(makeDraft(job), DraftStatus.AWAITING_REVIEW, 2);
    repo.setDraftStatus(id, DraftStatus.NEEDS_ATTENTION, "edit the pitch");
    repo.run("UPDATE application_drafts SET updated_at = ?", [LONG_AGO]);
    const edited = makeDraft(job, { pitch: "A shorter pitch.", cvBullets: [], quotedRateUsd: 65 });

    repo.updateDraftContent(id, edited);

    const stored = repo.getDraft(id)!;
    expect(stored.draft).toEqual(edited);
    expect(stored).toMatchObject({ status: DraftStatus.NEEDS_ATTENTION, note: "edit the pitch", copRetries: 2 });
    expect(stored.updatedAt).toMatch(ISO_RX);
    expect(stored.updatedAt > LONG_AGO).toBe(true);
    expect(repo.getJob(job.id)?.stage).toBe(PipelineStage.NEEDS_ATTENTION);
    expect(() => repo.updateDraftContent(id + 100, edited)).not.toThrow(); // unknown draft: nothing to update
    expect(repo.listDrafts()).toHaveLength(1);
  });

  test("latestDraftForJob is the newest draft written for that job", () => {
    const job = track();
    const other = track(makeJob({ sourceId: "2", title: "Other" }));
    expect(repo.latestDraftForJob(job.id)).toBeNull();

    const first = repo.saveDraft(makeDraft(job, { pitch: "first" }), DraftStatus.DECLINED);
    repo.saveDraft(makeDraft(other, { pitch: "other job" }), DraftStatus.AWAITING_REVIEW);
    const second = repo.saveDraft(makeDraft(job, { pitch: "second" }), DraftStatus.AWAITING_REVIEW);

    expect(second).toBeGreaterThan(first);
    expect(repo.latestDraftForJob(job.id)).toMatchObject({ id: second, draft: { pitch: "second" } });
    expect(repo.latestDraftForJob(other.id)?.draft.pitch).toBe("other job");
    expect(repo.latestDraftForJob("deadbeef")).toBeNull();
    expect(repo.getJob(job.id)?.stage).toBe(PipelineStage.AWAITING_REVIEW); // the latest save wins
  });

  test("drafts are listed oldest first, optionally by status", () => {
    const jobs = ["1", "2", "3"].map((sourceId) => track(makeJob({ sourceId, title: `Role ${sourceId}` })));
    const ids = [
      repo.saveDraft(makeDraft(jobs[0]), DraftStatus.AWAITING_REVIEW),
      repo.saveDraft(makeDraft(jobs[1]), DraftStatus.APPROVED),
      repo.saveDraft(makeDraft(jobs[2]), DraftStatus.AWAITING_REVIEW),
    ];
    expect(repo.listDrafts().map((draft) => draft.id)).toEqual(ids);
    expect(repo.listDrafts(DraftStatus.AWAITING_REVIEW).map((draft) => draft.id)).toEqual([ids[0], ids[2]]);
    expect(repo.listDrafts(DraftStatus.APPROVED).map((draft) => draft.jobId)).toEqual([jobs[1].id]);
    expect(repo.listDrafts(DraftStatus.SUBMITTED)).toEqual([]);
    expect(repo.getDraft(9999)).toBeNull();
  });

  test("a draft for an untracked job is refused and nothing is stored", () => {
    expect(() => repo.saveDraft(makeDraft(makeJob({ sourceId: "untracked" })), DraftStatus.AWAITING_REVIEW)).toThrow(/FOREIGN KEY/i);
    expect(repo.listDrafts()).toEqual([]);
    expect(repo.db.isTransaction).toBe(false);
  });
});

describe("dispatch log", () => {
  const dispatch = (overrides: Partial<Parameters<Repository["recordDispatch"]>[0]> = {}) =>
    repo.recordDispatch({
      jobId: "job-1", channel: Channel.FOUNDER_DIRECT, companyKey: "acme", domain: "acme.com",
      contact: "founder@acme.com", ...overrides,
    });

  test("a dispatch is recorded with the current time unless one is given", () => {
    const id = dispatch();
    const explicit = dispatch({ jobId: "job-2", dispatchedAt: PYTHON_TIMESTAMP });
    const all = repo.listDispatches();
    expect(all.find((record) => record.id === id)).toEqual({
      id, jobId: "job-1", channel: Channel.FOUNDER_DIRECT, companyKey: "acme", domain: "acme.com",
      contact: "founder@acme.com", dispatchedAt: expect.stringMatching(ISO_RX),
    });
    expect(all.find((record) => record.id === explicit)?.dispatchedAt).toBe(PYTHON_TIMESTAMP);
  });

  test("dispatches are listed newest first, optionally for one job", () => {
    const old = dispatch({ jobId: "job-1", dispatchedAt: "2026-09-01T09:00:00.000000+00:00" });
    const newest = dispatch({ jobId: "job-2", dispatchedAt: "2026-10-12T09:00:00.000000+00:00" });
    const middle = dispatch({ jobId: "job-1", dispatchedAt: "2026-10-01T09:00:00.000000+00:00" });

    expect(repo.listDispatches().map((record) => record.id)).toEqual([newest, middle, old]);
    expect(repo.listDispatches("job-1").map((record) => record.id)).toEqual([middle, old]);
    expect(repo.listDispatches("job-2").map((record) => record.id)).toEqual([newest]);
    expect(repo.listDispatches("job-3")).toEqual([]);
  });

  test("dispatches sent in the same instant are listed latest-recorded first", () => {
    const at = "2026-10-12T09:00:00.000000+00:00";
    const ids = [dispatch({ dispatchedAt: at }), dispatch({ dispatchedAt: at }), dispatch({ dispatchedAt: at })];
    expect(repo.listDispatches().map((record) => record.id)).toEqual([ids[2], ids[1], ids[0]]);
    expect(repo.listDispatches("job-1").map((record) => record.id)).toEqual([ids[2], ids[1], ids[0]]);
    expect(repo.lastDispatch("", { companyKey: "acme" })?.id).toBe(ids[2]);
  });

  test("countDispatchesSince counts from the cut-off on, inclusive", () => {
    dispatch({ dispatchedAt: "2026-10-11T23:59:59.999000+00:00" });
    dispatch({ dispatchedAt: "2026-10-12T00:00:00.000000+00:00" });
    dispatch({ dispatchedAt: "2026-10-12T15:30:00.000000+00:00" });
    expect(repo.countDispatchesSince("2026-10-12T00:00:00.000000+00:00")).toBe(2);
    expect(repo.countDispatchesSince("2026-10-12T00:00:00.001000+00:00")).toBe(1);
    expect(repo.countDispatchesSince("2026-10-13T00:00:00.000000+00:00")).toBe(0);
    expect(repo.countDispatchesSince("")).toBe(3);
  });

  test("lastDispatch finds the most recent contact with the same company, domain or person", () => {
    const window = "2026-09-12T00:00:00.000000+00:00";
    dispatch({ jobId: "too-old", dispatchedAt: "2026-09-11T23:59:59.999000+00:00" });
    const first = dispatch({ jobId: "first", dispatchedAt: "2026-09-20T09:00:00.000000+00:00" });
    const second = dispatch({ jobId: "second", companyKey: "acme labs", domain: "acme.com", contact: "cto@acme.com", dispatchedAt: "2026-10-01T09:00:00.000000+00:00" });
    dispatch({ jobId: "unrelated", companyKey: "initech", domain: "initech.com", contact: "bill@initech.com", dispatchedAt: "2026-10-05T09:00:00.000000+00:00" });

    expect(repo.lastDispatch(window, { companyKey: "acme" })?.id).toBe(first);
    expect(repo.lastDispatch(window, { domain: "acme.com" })?.id).toBe(second);
    expect(repo.lastDispatch(window, { contact: "founder@acme.com" })?.id).toBe(first);
    expect(repo.lastDispatch(window, { contact: "cto@acme.com" })?.id).toBe(second);
    // any one of the keys is enough
    expect(repo.lastDispatch(window, { companyKey: "someone new", domain: "new.example", contact: "cto@acme.com" })?.id).toBe(second);
    expect(repo.lastDispatch(window, { companyKey: "someone new", domain: "new.example", contact: "x@new.example" })).toBeNull();
    expect(repo.lastDispatch(window, { companyKey: "acme" })).toEqual({
      id: first, jobId: "first", channel: Channel.FOUNDER_DIRECT, companyKey: "acme", domain: "acme.com",
      contact: "founder@acme.com", dispatchedAt: "2026-09-20T09:00:00.000000+00:00",
    });
  });

  test("lastDispatch ignores anything before the window, and includes its first instant", () => {
    const at = "2026-09-12T00:00:00.000000+00:00";
    const id = dispatch({ dispatchedAt: at });
    expect(repo.lastDispatch(at, { companyKey: "acme" })?.id).toBe(id);
    expect(repo.lastDispatch("2026-09-12T00:00:00.001000+00:00", { companyKey: "acme" })).toBeNull();
  });

  test("blank keys never match: a dispatch with no domain is not 'the same domain' as another", () => {
    dispatch({ companyKey: "acme", domain: "", contact: "" });
    expect(repo.lastDispatch("", { domain: "" })).toBeNull();
    expect(repo.lastDispatch("", { contact: "" })).toBeNull();
    expect(repo.lastDispatch("", { companyKey: "", domain: "", contact: "" })).toBeNull();
    expect(repo.lastDispatch("", {})).toBeNull();
    expect(repo.lastDispatch("", { companyKey: "initech", domain: "", contact: "" })).toBeNull();
    expect(repo.lastDispatch("", { companyKey: "acme", domain: "", contact: "" })).not.toBeNull();
  });
});

describe("outcomes", () => {
  const outcome = (overrides: Partial<Parameters<Repository["recordOutcome"]>[0]> = {}) =>
    repo.recordOutcome({
      jobId: "job-1", channel: Channel.CONTRACT_GIGS, kind: OutcomeKind.RESPONSE, note: "", monthlyValueUsd: null,
      ...overrides,
    });

  test("an outcome is recorded and read back", () => {
    const id = outcome({ kind: OutcomeKind.INTERVIEW, note: "Intro call booked" });
    const explicit = outcome({ jobId: "job-2", kind: OutcomeKind.ACCEPTED, monthlyValueUsd: 4200.5, recordedAt: PYTHON_TIMESTAMP });

    expect(repo.listOutcomes("job-1")).toEqual([{
      id, jobId: "job-1", channel: Channel.CONTRACT_GIGS, kind: OutcomeKind.INTERVIEW, note: "Intro call booked",
      monthlyValueUsd: null, recordedAt: expect.stringMatching(ISO_RX),
    }]);
    expect(repo.listOutcomes("job-2")).toEqual([{
      id: explicit, jobId: "job-2", channel: Channel.CONTRACT_GIGS, kind: OutcomeKind.ACCEPTED, note: "",
      monthlyValueUsd: 4200.5, recordedAt: PYTHON_TIMESTAMP,
    }]);
  });

  test("outcomes are listed newest first, optionally for one job", () => {
    const old = outcome({ recordedAt: "2026-10-01T09:00:00.000000+00:00" });
    const newest = outcome({ jobId: "job-2", recordedAt: "2026-10-12T09:00:00.000000+00:00" });
    const middleA = outcome({ kind: OutcomeKind.INTERVIEW, recordedAt: "2026-10-05T09:00:00.000000+00:00" });
    const middleB = outcome({ kind: OutcomeKind.OFFER, recordedAt: "2026-10-05T09:00:00.000000+00:00" });

    expect(repo.listOutcomes().map((row) => row.id)).toEqual([newest, middleB, middleA, old]);
    expect(repo.listOutcomes("job-1").map((row) => row.kind)).toEqual([OutcomeKind.OFFER, OutcomeKind.INTERVIEW, OutcomeKind.RESPONSE]);
    expect(repo.listOutcomes("job-3")).toEqual([]);
  });

  test("securedMonthlyIncome totals accepted engagements only", () => {
    expect(repo.securedMonthlyIncome()).toBe(0);

    outcome({ kind: OutcomeKind.ACCEPTED, monthlyValueUsd: 4000 });
    outcome({ jobId: "job-2", kind: OutcomeKind.ACCEPTED, monthlyValueUsd: 2500.5 });
    outcome({ jobId: "job-3", kind: OutcomeKind.OFFER, monthlyValueUsd: 9000 }); // offered, not accepted
    outcome({ jobId: "job-4", kind: OutcomeKind.RESPONSE });
    outcome({ jobId: "job-5", kind: OutcomeKind.REJECTION, monthlyValueUsd: 7000 });
    outcome({ jobId: "job-6", kind: OutcomeKind.ACCEPTED, monthlyValueUsd: null }); // accepted, value unknown

    expect(repo.securedMonthlyIncome()).toBe(6500.5);
  });

  test("an accepted engagement with no stated value secures nothing", () => {
    outcome({ kind: OutcomeKind.ACCEPTED, monthlyValueUsd: null });
    expect(repo.securedMonthlyIncome()).toBe(0);
  });
});

describe("opening a database", () => {
  test("a new database file gets the current schema, WAL journaling and foreign keys", () => {
    const file = tempDbPath();
    const opened = open(file);
    expect(fs.existsSync(file)).toBe(true);
    expect(opened.query("PRAGMA user_version")).toEqual([{ user_version: SCHEMA_VERSION }]);
    expect(SCHEMA_VERSION).toBe(2);
    expect(opened.query("PRAGMA journal_mode")).toEqual([{ journal_mode: "wal" }]);
    expect(opened.query("PRAGMA foreign_keys")).toEqual([{ foreign_keys: 1 }]);
    const tables = opened.query<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name");
    expect(tables.map((table) => table.name)).toEqual([
      "achievements", "application_drafts", "candidate_profile", "cost_telemetry", "dispatch_log", "job_evaluations",
      "jobs", "outcomes", "pipeline_tasks", "positioning_profiles", "quarantined_items", "standing_answers",
      "system_state",
    ]);
  });

  test("a standing answer is found again however the question is typed, and the user's answer outranks the AI's", () => {
    const opened = new Repository(":memory:");
    const question = "Will you now or in the future require sponsorship?";
    expect(opened.getStandingAnswer(question)).toBeNull();

    expect(opened.saveStandingAnswer({ question, answer: "No", options: ["Yes", "No"], source: "ai" })).toBe(true);
    expect(opened.getStandingAnswer("  will you now or in the future REQUIRE sponsorship? * ")).toMatchObject({
      answer: "No", options: ["Yes", "No"], source: "ai",
    });
    // A differently worded question is a different question: similar wording can have the opposite answer.
    expect(opened.getStandingAnswer("Are you authorized to work without sponsorship?")).toBeNull();

    expect(opened.saveStandingAnswer({ question, answer: "Yes", options: ["Yes", "No"], source: "ai" })).toBe(true);
    expect(opened.saveStandingAnswer({ question, answer: "No", options: ["Yes", "No"], source: "user" })).toBe(true);
    // Once the candidate has answered, an AI answer never replaces theirs.
    expect(opened.saveStandingAnswer({ question, answer: "Yes", options: ["Yes", "No"], source: "ai" })).toBe(false);
    expect(opened.getStandingAnswer(question)).toMatchObject({ answer: "No", source: "user" });
    expect(opened.listStandingAnswers()).toHaveLength(1);

    expect(opened.deleteStandingAnswer(question)).toBe(true);
    expect(opened.deleteStandingAnswer(question)).toBe(false);
    opened.close();
  });

  test("the data directory is created owner-only, because the database holds contact details", () => {
    const file = tempDbPath("data", "reygent", "reygent.db");
    open(file);
    expect(fs.statSync(path.dirname(file)).mode & 0o777).toBe(0o700);
    expect(fs.statSync(path.dirname(path.dirname(file))).mode & 0o777).toBe(0o700);
  });

  test("data survives closing and reopening, and reopening changes nothing", () => {
    const file = tempDbPath();
    const first = open(file);
    const job = track(makeJob({ location: "Remote", skills: ["Python"] }), first);
    first.saveProfile(makeProfile());
    first.setState("cursor", 5);
    first.close();

    for (let round = 0; round < 3; round += 1) {
      const again = new Repository(file);
      expect(again.getJob(job.id)).toEqual(job);
      expect(again.getProfile()).toEqual(makeProfile());
      expect(again.getState("cursor")).toBe(5);
      expect(again.query("PRAGMA user_version")).toEqual([{ user_version: SCHEMA_VERSION }]);
      expect(again.insertJob(job)).toBe(false);
      again.close();
    }
  });

  test("an in-memory database is private to its repository", () => {
    const other = open(":memory:");
    track(makeJob());
    expect(other.listJobs()).toEqual([]);
  });

  test("deleting a job removes what hangs off it", () => {
    const job = track();
    repo.saveEvaluation(makeReport(job));
    repo.enqueueTask({ taskType: B2B_INVESTIGATION, jobId: job.id });
    repo.saveDraft(makeDraft(job), DraftStatus.AWAITING_REVIEW);

    repo.run("DELETE FROM jobs WHERE id = ?", [job.id]);

    expect(count("job_evaluations")).toBe(0);
    expect(count("pipeline_tasks")).toBe(0);
    expect(count("application_drafts")).toBe(0);
  });
});

/** The schema exactly as the original Python implementation created it (reygent/db/schema.py, SCHEMA_VERSION = 1). */
const PYTHON_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS candidate_profile (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    email TEXT NOT NULL,
    phone TEXT,
    location TEXT,
    timezone TEXT,
    work_authorization TEXT,
    notice_period TEXT,
    github_url TEXT,
    linkedin_url TEXT,
    portfolio_url TEXT,
    years_experience REAL,
    employers_json TEXT NOT NULL DEFAULT '[]',
    skills_json TEXT NOT NULL DEFAULT '[]',
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS achievements (
    id TEXT PRIMARY KEY,
    candidate_id TEXT NOT NULL REFERENCES candidate_profile(id) ON DELETE CASCADE,
    category TEXT,
    headline TEXT NOT NULL,
    impact_metric TEXT,
    technologies_json TEXT NOT NULL DEFAULT '[]',
    context TEXT,
    employer TEXT,
    evidence_url TEXT,
    positioning_json TEXT NOT NULL DEFAULT '[]',
    verified INTEGER NOT NULL DEFAULT 0 CHECK (verified IN (0, 1))
);

CREATE TABLE IF NOT EXISTS positioning_profiles (
    id TEXT PRIMARY KEY,
    candidate_id TEXT NOT NULL REFERENCES candidate_profile(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    target_summary TEXT,
    core_skills_json TEXT NOT NULL DEFAULT '[]',
    highlighted_achievements_json TEXT NOT NULL DEFAULT '[]',
    pitch_angle TEXT
);

CREATE TABLE IF NOT EXISTS jobs (
    id TEXT PRIMARY KEY,
    source TEXT NOT NULL,
    source_id TEXT NOT NULL,
    company TEXT NOT NULL,
    title TEXT NOT NULL,
    location TEXT,
    description TEXT,
    apply_url TEXT,
    company_domain TEXT,
    channel TEXT NOT NULL,
    is_remote INTEGER,
    employment_type TEXT,
    comp_min REAL,
    comp_max REAL,
    comp_period TEXT,
    comp_currency TEXT,
    skills_json TEXT NOT NULL DEFAULT '[]',
    posted_at TEXT,
    stage TEXT NOT NULL DEFAULT 'discovered',
    fingerprint TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (source, source_id),
    UNIQUE (fingerprint)
);
CREATE INDEX IF NOT EXISTS idx_jobs_stage ON jobs(stage);

CREATE TABLE IF NOT EXISTS job_evaluations (
    job_id TEXT PRIMARY KEY REFERENCES jobs(id) ON DELETE CASCADE,
    eligibility_tier TEXT NOT NULL
        CHECK (eligibility_tier IN ('confirmed', 'potentially_eligible', 'ineligible')),
    reason_codes_json TEXT NOT NULL DEFAULT '[]',
    positive_signals_json TEXT NOT NULL DEFAULT '[]',
    disqualifiers_json TEXT NOT NULL DEFAULT '[]',
    needs_b2b_investigation INTEGER NOT NULL DEFAULT 0,
    summary TEXT,
    fit_score REAL,
    best_positioning_profile TEXT,
    evaluated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS pipeline_tasks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    task_type TEXT NOT NULL,
    job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
    detail TEXT,
    status TEXT NOT NULL DEFAULT 'pending',
    created_at TEXT NOT NULL,
    UNIQUE (task_type, job_id)
);
CREATE INDEX IF NOT EXISTS idx_tasks_queue ON pipeline_tasks(task_type, status);

CREATE TABLE IF NOT EXISTS cost_telemetry (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp TEXT NOT NULL,
    provider TEXT NOT NULL,
    model TEXT NOT NULL,
    prompt_tokens INTEGER NOT NULL DEFAULT 0,
    completion_tokens INTEGER NOT NULL DEFAULT 0,
    cost_usd REAL NOT NULL DEFAULT 0,
    task_type TEXT NOT NULL,
    outcome TEXT NOT NULL,
    latency_ms INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_cost_timestamp ON cost_telemetry(timestamp);

CREATE TABLE IF NOT EXISTS quarantined_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    job_id TEXT NOT NULL,
    violation_rule TEXT NOT NULL,
    original_content TEXT NOT NULL,
    critique TEXT NOT NULL,
    retry_count INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'pending',
    created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_quarantine_status ON quarantined_items(status);

CREATE TABLE IF NOT EXISTS dispatch_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    job_id TEXT NOT NULL,
    channel TEXT NOT NULL,
    company_key TEXT NOT NULL,
    domain TEXT NOT NULL DEFAULT '',
    contact TEXT NOT NULL DEFAULT '',
    dispatched_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_dispatch_time ON dispatch_log(dispatched_at);

CREATE TABLE IF NOT EXISTS system_state (
    key TEXT PRIMARY KEY,
    value_json TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
`;

describe("upgrading a database written by the Python implementation", () => {
  const JOB_ID = "5a18be0cd702ebe8"; // Python's id for greenhouse:1
  const FINGERPRINT = "4f605714f3f50947ca14fbf803397a8c37db2227"; // Python's job_fingerprint for Acme / Senior Engineer / Remote
  const WRITTEN_AT = "2025-06-11T08:15:30.123456+00:00";

  const legacyJob = makeJob({
    location: "Remote", description: "Contractors are paid through Deel.",
    applyUrl: "https://boards.greenhouse.io/acme/1", companyDomain: "acme.com", channel: Channel.CONTRACT_GIGS,
    isRemote: true, employmentType: "contract", compMin: 50, compMax: 70, compPeriod: "hour", compCurrency: "USD",
    skills: ["Python", "LangGraph"], stage: PipelineStage.QUALIFIED,
  });
  const legacyReport = makeReport(legacyJob);

  /** Build the file the way Python did: its schema, its row formats, user_version 1. */
  function writeLegacyDatabase(file: string): void {
    const legacy = new DatabaseSync(file);
    legacy.exec("PRAGMA journal_mode=WAL");
    legacy.exec("PRAGMA foreign_keys=ON");
    legacy.exec(PYTHON_SCHEMA_SQL);
    legacy
      .prepare(
        `INSERT INTO jobs (id, source, source_id, company, title, location, description, apply_url, company_domain,
           channel, is_remote, employment_type, comp_min, comp_max, comp_period, comp_currency, skills_json, posted_at,
           stage, fingerprint, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        JOB_ID, "greenhouse", "1", "Acme", "Senior Engineer", "Remote", "Contractors are paid through Deel.",
        "https://boards.greenhouse.io/acme/1", "acme.com", "contract_gigs", 1, "contract", 50.0, 70.0, "hour", "USD",
        '["Python", "LangGraph"]', null, "qualified", FINGERPRINT, WRITTEN_AT, WRITTEN_AT,
      );
    legacy
      .prepare(
        `INSERT INTO job_evaluations (job_id, eligibility_tier, reason_codes_json, positive_signals_json,
           disqualifiers_json, needs_b2b_investigation, summary, evaluated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(JOB_ID, "confirmed", '["CONTRACTOR_RAILS"]', '["CONTRACTOR_RAILS: paid through Deel"]', "[]", 0, "Worldwide contractor role", WRITTEN_AT);
    legacy
      .prepare(
        `INSERT INTO cost_telemetry (timestamp, provider, model, prompt_tokens, completion_tokens, cost_usd, task_type,
           outcome, latency_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(PYTHON_TIMESTAMP, "fireworks", LLAMA, 1000, 200, 0.00108, "pitch", "ok", 800);
    legacy
      .prepare("INSERT INTO pipeline_tasks (task_type, job_id, detail, status, created_at) VALUES (?, ?, ?, ?, ?)")
      .run("b2b_investigation", JOB_ID, "", "pending", WRITTEN_AT);
    legacy
      .prepare(
        `INSERT INTO quarantined_items (job_id, violation_rule, original_content, critique, retry_count, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(JOB_ID, "9_tone", '{"pitch": "I hope this email finds you well."}', "[pitch] filler or cliché", 2, "pending", WRITTEN_AT);
    legacy
      .prepare("INSERT INTO dispatch_log (job_id, channel, company_key, domain, contact, dispatched_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(JOB_ID, "contract_gigs", "acme", "", "founder@acme.com", PYTHON_TIMESTAMP);
    legacy
      .prepare("INSERT INTO system_state (key, value_json, updated_at) VALUES (?, ?, ?)")
      .run("circuit_breaker", '{"day": "2026-10-01", "tripped_at": "2026-10-01T20:00:00.000000+00:00", "spent_usd": 1.4999}', WRITTEN_AT);
    legacy
      .prepare(
        `INSERT INTO candidate_profile (id, name, email, phone, location, timezone, work_authorization, notice_period,
           github_url, linkedin_url, portfolio_url, years_experience, employers_json, skills_json, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        "default", "Test Candidate", "candidate@example.com", "+237 600 000 000", "Cameroon (UTC+1)", "Africa/Douala",
        "B2B contractor", "2 weeks", "https://github.com/test-candidate", "https://www.linkedin.com/in/test-candidate",
        "https://candidate.example.com", 8.0, '["Initech"]', '["Python"]', WRITTEN_AT,
      );
    const achievement = legacy.prepare(
      `INSERT INTO achievements (id, candidate_id, category, headline, impact_metric, technologies_json, context,
         employer, evidence_url, positioning_json, verified) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    achievement.run("ach_1", "default", "ai", "Built X", "Cut latency by 45%", '["Python"]', "", "", "", "[]", 1);
    achievement.run("ach_2", "default", "web", "Built Y", "Unverified claim", '["React"]', "", "", "", "[]", 0);
    legacy
      .prepare(
        `INSERT INTO positioning_profiles (id, candidate_id, title, target_summary, core_skills_json,
           highlighted_achievements_json, pitch_angle) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run("p1", "default", "Title", "Summary", '["Python"]', '["ach_1"]', "Angle");
    legacy.exec("PRAGMA user_version=1");
    legacy.close();
  }

  /** What the fixture looks like before the TypeScript repository touches it. */
  function inspect(file: string): { version: number; evaluationColumns: string[]; tables: string[] } {
    const raw = new DatabaseSync(file);
    try {
      return {
        version: (raw.prepare("PRAGMA user_version").get() as { user_version: number }).user_version,
        evaluationColumns: (raw.prepare("PRAGMA table_info(job_evaluations)").all() as Array<{ name: string }>).map((column) => column.name),
        tables: (raw.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map((table) => table.name),
      };
    } finally {
      raw.close();
    }
  }

  test("the fixture really is the old schema", () => {
    const file = tempDbPath();
    writeLegacyDatabase(file);
    const before = inspect(file);
    expect(before.version).toBe(1);
    expect(before.evaluationColumns).not.toContain("matched_skills_json");
    expect(before.evaluationColumns).not.toContain("missing_skills_json");
    expect(before.tables).not.toContain("application_drafts");
    expect(before.tables).not.toContain("outcomes");
    expect(legacyJob.id).toBe(JOB_ID);
    expect(jobFingerprint(legacyJob)).toBe(FINGERPRINT);
  });

  test("the old rows are intact after the upgrade", () => {
    const file = tempDbPath();
    writeLegacyDatabase(file);
    const upgraded = open(file);

    expect(upgraded.getJob(JOB_ID)).toEqual(legacyJob);
    expect(upgraded.listJobs(PipelineStage.QUALIFIED)).toEqual([legacyJob]);
    expect(upgraded.getEvaluation(JOB_ID)).toEqual(legacyReport);
    expect(upgraded.getTelemetry(1)).toEqual({
      id: 1, timestamp: PYTHON_TIMESTAMP, provider: "fireworks", model: LLAMA, taskType: "pitch",
      promptTokens: 1000, completionTokens: 200, costUsd: 0.00108, latencyMs: 800, outcome: "ok",
    });
    expect(upgraded.spendSince("2026-10-12T00:00:00.000000+00:00")).toBe(0.00108);
    expect(upgraded.listTasks(B2B_INVESTIGATION)).toEqual([
      { id: 1, taskType: B2B_INVESTIGATION, jobId: JOB_ID, detail: "", status: "pending", createdAt: WRITTEN_AT },
    ]);
    expect(upgraded.listQuarantined()).toEqual([{
      id: 1, jobId: JOB_ID, violationRule: "9_tone", originalContent: '{"pitch": "I hope this email finds you well."}',
      critique: "[pitch] filler or cliché", retryCount: 2, status: "pending", createdAt: WRITTEN_AT,
    }]);
    expect(upgraded.listDispatches()).toEqual([{
      id: 1, jobId: JOB_ID, channel: Channel.CONTRACT_GIGS, companyKey: "acme", domain: "",
      contact: "founder@acme.com", dispatchedAt: PYTHON_TIMESTAMP,
    }]);
    expect(upgraded.getState("circuit_breaker")).toEqual({
      day: "2026-10-01", tripped_at: "2026-10-01T20:00:00.000000+00:00", spent_usd: 1.4999,
    });
    expect(upgraded.getProfile()).toEqual(makeProfile());
  });

  test("the new columns and tables exist, and the version is current", () => {
    const file = tempDbPath();
    writeLegacyDatabase(file);
    const upgraded = open(file);

    const columns = upgraded.query<{ name: string; dflt_value: string | null; notnull: number }>("PRAGMA table_info(job_evaluations)");
    for (const name of ["matched_skills_json", "missing_skills_json"]) {
      expect(columns.find((column) => column.name === name)).toMatchObject({ dflt_value: "'[]'", notnull: 1 });
    }
    expect(upgraded.query("SELECT matched_skills_json, missing_skills_json FROM job_evaluations")).toEqual([
      { matched_skills_json: "[]", missing_skills_json: "[]" },
    ]);
    const objects = upgraded.query<{ name: string }>("SELECT name FROM sqlite_master").map((row) => row.name);
    for (const name of ["application_drafts", "outcomes", "idx_drafts_status", "idx_drafts_job"]) {
      expect(objects).toContain(name);
    }
    expect(upgraded.query("PRAGMA user_version")).toEqual([{ user_version: 2 }]);
    expect(SCHEMA_VERSION).toBe(2);
    upgraded.close();
    expect(inspect(file).version).toBe(2); // and the upgrade is on disk, not only in this connection
  });

  test("the upgraded database supports everything the TypeScript port added", () => {
    const file = tempDbPath();
    writeLegacyDatabase(file);
    const upgraded = open(file);

    // The evaluation Python stored has no fit yet; one can now be attached to it.
    expect(upgraded.getFit(JOB_ID)).toBeNull();
    const fit: FitEvaluation = { jobId: JOB_ID, fitScore: 88, bestPositioningProfile: "ai_platform_agent", matchedSkills: ["Python"], missingSkills: ["Go"] };
    upgraded.saveFit(fit);
    expect(upgraded.getFit(JOB_ID)).toEqual(fit);
    expect(upgraded.getEvaluation(JOB_ID)).toEqual(legacyReport);

    const draftId = upgraded.saveDraft(makeDraft(legacyJob), DraftStatus.AWAITING_REVIEW);
    expect(upgraded.getDraft(draftId)?.jobId).toBe(JOB_ID);
    expect(upgraded.getJob(JOB_ID)?.stage).toBe(PipelineStage.AWAITING_REVIEW);

    upgraded.recordOutcome({ jobId: JOB_ID, channel: Channel.CONTRACT_GIGS, kind: OutcomeKind.ACCEPTED, note: "", monthlyValueUsd: 4000 });
    expect(upgraded.securedMonthlyIncome()).toBe(4000);
  });

  test("duplicates of the jobs Python stored are still rejected", () => {
    const file = tempDbPath();
    writeLegacyDatabase(file);
    const upgraded = open(file);

    expect(upgraded.insertJob(legacyJob)).toBe(false);
    expect(upgraded.insertJob(makeJob({ source: "lever", sourceId: "x9", company: "ACME ", location: "remote" }))).toBe(false);
    expect(upgraded.findTrackedJobId(makeJob({ source: "ashby", sourceId: "77", company: "acme", location: "REMOTE" }))).toBe(JOB_ID);
    expect(upgraded.insertJob(makeJob({ sourceId: "2", title: "Staff Engineer", location: "Remote" }))).toBe(true);
    expect(upgraded.listJobs().map((job) => job.id)).toEqual([JOB_ID, jobId("greenhouse", "2")]); // old rows sort first
  });

  test("the jobs Python stored are given the key that recognises a job board's copy of them", () => {
    const file = tempDbPath();
    writeLegacyDatabase(file);
    const upgraded = open(file);

    expect(upgraded.query<{ role_key: string }>("SELECT role_key FROM jobs").map((row) => row.role_key)).toEqual(["acme|senior engineer"]);
    // The same role as a job board words it: another company spelling, a decorated title, its own location.
    const relisted = makeJob({ source: "remotive", sourceId: "501", company: "Acme, Inc.", title: "Senior Engineer (Remote)", location: "Worldwide" });
    expect(upgraded.findTrackedJobId(relisted)).toBe(JOB_ID);
    expect(upgraded.insertJob(relisted)).toBe(false);
  });

  test("new and old timestamps share one ordering", () => {
    const file = tempDbPath();
    writeLegacyDatabase(file);
    const upgraded = open(file);
    // One millisecond either side of the row Python wrote at ...00.123456.
    const earlier = toIso(new Date("2026-10-12T10:50:00.123Z"));
    const later = toIso(new Date("2026-10-12T10:50:00.124Z"));
    const beforeId = upgraded.recordTelemetry({ provider: "jev", model: "jev-latest", taskType: "fit", costUsd: 0.25, timestamp: earlier });
    const afterId = upgraded.recordTelemetry({ provider: "jev", model: "jev-latest", taskType: "fit", costUsd: 0.5, timestamp: later });

    expect(upgraded.listTelemetry().map((entry) => entry.id)).toEqual([afterId, 1, beforeId]);
    expect(upgraded.spendSince(earlier)).toBeCloseTo(0.75108, 10);
    expect(upgraded.spendSince(PYTHON_TIMESTAMP)).toBeCloseTo(0.50108, 10);
    expect(upgraded.spendSince(later)).toBe(0.5);
    expect(upgraded.lastDispatch(earlier, { contact: "founder@acme.com" })?.jobId).toBe(JOB_ID);
    expect(upgraded.lastDispatch(later, { contact: "founder@acme.com" })).toBeNull();
  });

  test("upgrading twice is the same as upgrading once", () => {
    const file = tempDbPath();
    writeLegacyDatabase(file);
    new Repository(file).close();
    const first = inspect(file);
    const again = open(file);

    expect(inspect(file)).toEqual(first);
    expect(again.getJob(JOB_ID)).toEqual(legacyJob);
    expect(again.query("SELECT COUNT(*) AS n FROM pragma_table_info('job_evaluations') WHERE name LIKE '%_skills_json'")).toEqual([{ n: 2 }]);
  });
});

describe("the cost ledger on top of the repository", () => {
  test("reservations count as spend and the breaker trips at the cap", () => {
    const alerts: string[] = [];
    const ledger = new CostLedger(repo, { notifier: (message) => alerts.push(message) });

    const entry = ledger.reserve("fireworks", "m", "pitch", 1.0);
    ledger.settle(entry, { costUsd: 1.0, latencyMs: 5, outcome: "ok" });

    expect(() => ledger.reserve("fireworks", "m", "pitch", 0.6)).toThrow(CircuitBreakerError);
    expect(alerts).toHaveLength(1);
    expect(ledger.isTripped()).toBe(true);
    expect(repo.getTelemetry(entry)).toMatchObject({ costUsd: 1, outcome: "ok", latencyMs: 5 });
    expect(repo.listTelemetry()).toHaveLength(1); // the refused call left no entry behind
  });
});
