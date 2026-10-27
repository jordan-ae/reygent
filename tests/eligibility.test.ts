/** 3-tier Cameroon remote eligibility: global vs ambiguous vs restricted listings. */

import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { defaultConfig } from "@/core/config";
import { Repository } from "@/core/db/repository";
import {
  B2B_INVESTIGATION,
  createJob,
  type EligibilityReport,
  EligibilityTier,
  type JobInput,
  type JobOpportunity,
  PipelineStage,
} from "@/core/models";
import { evaluateRemoteEligibility, qualifyJob } from "@/core/qualification/eligibility";

const CONFIRMED = EligibilityTier.CONFIRMED_ELIGIBLE;
const POTENTIAL = EligibilityTier.POTENTIALLY_ELIGIBLE;
const INELIGIBLE = EligibilityTier.INELIGIBLE;

function makeJob(fields: Partial<JobInput> = {}): JobOpportunity {
  const { location = "Remote", description = "" } = fields;
  return createJob({
    source: "test", sourceId: `${location}|${description}`, company: "Acme", title: "Senior Engineer",
    ...fields, location, description,
  });
}

/** Evaluate a listing and check its tier and, optionally, one of its reason codes. */
function expectTier(tier: EligibilityTier, code: string | null, fields: Partial<JobInput>): EligibilityReport {
  const report = evaluateRemoteEligibility(makeJob(fields));
  const listing = `${JSON.stringify(fields)} -> ${report.summary}`;
  expect(report.tier, listing).toBe(tier);
  if (code) expect(report.reasonCodes, listing).toContain(code);
  return report;
}

describe("tier classification", () => {
  test("explicit worldwide listings are confirmed", () => {
    for (const [location, description] of [
      ["Remote (Worldwide)", ""],
      ["Remote - Anywhere", ""],
      ["Global", "Fully remote."],
      ["Remote", "Work from anywhere in the world."],
      ["Remote", "We are a globally distributed team and hire in any country."],
      ["Remote", "Any timezone is fine; we work async."],
    ]) {
      expectTier(CONFIRMED, "WORLDWIDE", { location, description });
    }
  });

  test("EMEA and Africa coverage is confirmed", () => {
    expectTier(CONFIRMED, "AFRICA_EMEA", { location: "Remote, EMEA" });
    expectTier(CONFIRMED, "AFRICA_EMEA", { description: "Remote role open to candidates across Africa." });
  });

  test("global contractor rails are confirmed", () => {
    expectTier(CONFIRMED, "CONTRACTOR_RAILS", { description: "Contractors are paid through Deel." });
    expectTier(CONFIRMED, "CONTRACTOR_RAILS", { description: "We engage international contractors." });
  });

  test("ambiguous remote is potentially eligible and never discarded", () => {
    const report = expectTier(POTENTIAL, "GEO_UNSPECIFIED", {
      description: "San Francisco startup with a fully remote team.",
    });
    expect(report.needsB2bInvestigation).toBe(true);
    expect(report.disqualifiers).toEqual([]);
  });

  test("single-country location without a restriction is investigated", () => {
    expectTier(POTENTIAL, "SINGLE_COUNTRY_LOCATION", { location: "Remote - US" });
  });

  test("contract listing without scope stays tier two with a hint", () => {
    expectTier(POTENTIAL, "CONTRACTOR_FRIENDLY", { description: "6-month contract role, remote." });
  });

  test("spec hard disqualifiers are ineligible", () => {
    for (const [description, code] of [
      ["US citizenship required.", "CITIZENSHIP_REQUIRED"],
      ["Must hold an active security clearance.", "SECURITY_CLEARANCE"],
      ["Open to candidates in the 50 US states only.", "GEO_RESTRICTED"],
      ["UK PAYE only.", "LOCAL_PAYROLL_ONLY"],
      ["This is a hybrid on-site position.", "ONSITE_REQUIRED"],
    ]) {
      expectTier(INELIGIBLE, code, { description });
    }
  });

  test("explicit geographic restrictions are ineligible", () => {
    for (const [location, description] of [
      ["Remote (US only)", ""],
      ["Remote", "Candidates must be based in the United States."],
      ["Remote", "Work from anywhere in the US."],
      ["Remote", "This role is open to EU residents."],
      ["Remote", "We are only hiring in Canada for this role."],
      ["Remote", "Applicants must be located in South Africa."],
    ]) {
      expectTier(INELIGIBLE, "GEO_RESTRICTED", { location, description });
    }
  });

  test("legal and payroll restrictions are ineligible", () => {
    expectTier(INELIGIBLE, "WORK_AUTHORIZATION_REQUIRED", {
      description: "You must be authorized to work in the United States.",
    });
    expectTier(INELIGIBLE, "CITIZENSHIP_REQUIRED", { description: "US citizen or green card holder." });
    expectTier(INELIGIBLE, "LOCAL_PAYROLL_ONLY", { description: "W2 only, no C2C." });
    expectTier(INELIGIBLE, "SECURITY_CLEARANCE", { location: "Remote Worldwide", description: "TS/SCI required." });
  });

  test("on-site and non-remote listings are ineligible", () => {
    expectTier(INELIGIBLE, "ONSITE_REQUIRED", { location: "London (Hybrid)" });
    expectTier(INELIGIBLE, "ONSITE_REQUIRED", { description: "Remote, but 3 days a week in the office." });
    expectTier(INELIGIBLE, "ONSITE_REQUIRED", { description: "Remote at first; relocation is required." });
    expectTier(INELIGIBLE, "NOT_REMOTE", { location: "San Francisco, CA", description: "Join our team." });
    expectTier(INELIGIBLE, "NOT_REMOTE", { location: "Remote Worldwide", isRemote: false });
  });

  test("hard disqualifier overrides a worldwide signal", () => {
    const report = expectTier(INELIGIBLE, "CITIZENSHIP_REQUIRED", {
      location: "Remote (Worldwide)", description: "US citizenship required.",
    });
    expect(report.positiveSignals.some((signal) => signal.startsWith("WORLDWIDE"))).toBe(true);
  });

  test("negated requirements do not disqualify", () => {
    expectTier(CONFIRMED, null, {
      location: "Remote (Worldwide)",
      description: "US citizenship is not required. No security clearance required. No on-site requirement.",
    });
  });

  test("lookalike phrases are not misread", () => {
    // "hybrid search" is a retrieval technique; "us" is a pronoun; team offsites are not on-site work.
    for (const description of [
      "You will build hybrid search and hybrid retrieval pipelines. Remote.",
      "Join us only if you love shipping. Remote.",
      "Remote team; we meet for an onsite twice a year.",
      "Remote. You will support our EMEA customers.",
      "Remote. You will not find this anywhere else.",
    ]) {
      expectTier(POTENTIAL, null, { description });
    }
  });

  test("the pronoun 'us' is never read as the United States", () => {
    // Each of these phrases is a disqualifier once it names the country in capitals.
    for (const description of [
      "Work with us only if you enjoy ownership.",
      "It makes us citizens of the internet.",
      "Our city made us residents for life.",
      "That makes us persons of interest.",
    ]) {
      expectTier(POTENTIAL, null, { description });
    }
    expectTier(INELIGIBLE, "GEO_RESTRICTED", { description: "US ONLY." });
    expectTier(INELIGIBLE, "GEO_RESTRICTED", { description: "U.S. only." });
    expectTier(INELIGIBLE, "GEO_RESTRICTED", { description: "Open to US residents." });
    expectTier(INELIGIBLE, "CITIZENSHIP_REQUIRED", { description: "US persons only." });
  });

  test("region restriction that includes Africa is not a disqualifier", () => {
    expectTier(CONFIRMED, "AFRICA_EMEA", { description: "Candidates must be based in Europe or Africa." });
  });

  test("HTML descriptions are cleaned before matching", () => {
    expectTier(INELIGIBLE, "CITIZENSHIP_REQUIRED", {
      description: "&lt;p&gt;Remote. &lt;strong&gt;US&lt;/strong&gt; citizenship required.&lt;/p&gt;",
    });
  });

  test("rate floor", () => {
    const worldwide = { location: "Remote Worldwide" };
    expectTier(INELIGIBLE, "RATE_BELOW_FLOOR", { compMax: 25, compPeriod: "hour", ...worldwide });
    expectTier(INELIGIBLE, "RATE_BELOW_FLOOR", { compMax: 2000, compPeriod: "month", ...worldwide });
    expectTier(INELIGIBLE, "RATE_BELOW_FLOOR", { compMax: 24000, compPeriod: "year", ...worldwide });
    expectTier(CONFIRMED, null, { compMin: 30, compMax: 55, compPeriod: "hour", ...worldwide });
    expectTier(CONFIRMED, null, { compMin: 40, compPeriod: "hour", ...worldwide });
    // Non-USD figures are not compared against the USD floor.
    expectTier(CONFIRMED, null, { compMax: 30, compPeriod: "hour", compCurrency: "EUR", ...worldwide });
  });

  test("rate floor is configurable", () => {
    const job = makeJob({ location: "Remote Worldwide", compMax: 45, compPeriod: "hour" });
    const compensation = { ...defaultConfig().compensation, hourly_floor_usd: 50 };
    expect(evaluateRemoteEligibility(job, compensation).tier).toBe(INELIGIBLE);
    expect(evaluateRemoteEligibility(job).tier).toBe(CONFIRMED);
  });

  test("evidence quotes the rate and the floor it missed", () => {
    const yearly = expectTier(INELIGIBLE, "RATE_BELOW_FLOOR", {
      location: "Remote Worldwide", compMax: 24000, compPeriod: "year",
    });
    expect(yearly.disqualifiers).toEqual(["RATE_BELOW_FLOOR: $24,000/year is below the $2,500/mo floor"]);
    expect(yearly.summary).toBe("Ineligible: RATE_BELOW_FLOOR ($24,000/year is below the $2,500/mo floor)");
    const hourly = expectTier(INELIGIBLE, "RATE_BELOW_FLOOR", {
      location: "Remote Worldwide", compMax: 22.5, compPeriod: "hour",
    });
    expect(hourly.disqualifiers).toEqual(["RATE_BELOW_FLOOR: $22/hour is below the $40/hr floor"]);
  });
});

describe("routing", () => {
  let repo: Repository;

  beforeEach(() => {
    repo = new Repository(":memory:");
  });
  afterEach(() => {
    repo.close();
  });

  test("tier one is greenlit", () => {
    const job = makeJob({ location: "Remote (Worldwide)" });
    qualifyJob(repo, job);
    expect(repo.getJob(job.id)?.stage).toBe(PipelineStage.QUALIFIED);
    expect(repo.listTasks(B2B_INVESTIGATION)).toEqual([]);
    expect(repo.getEvaluation(job.id)?.tier).toBe(CONFIRMED);
  });

  test("tier two is routed to the B2B investigation queue once", () => {
    const job = makeJob({ description: "Fully remote team." });
    qualifyJob(repo, job);
    qualifyJob(repo, job); // rediscovered on the next crawl
    const tasks = repo.listTasks(B2B_INVESTIGATION);
    expect(tasks.map((task) => task.jobId)).toEqual([job.id]);
    expect(repo.getJob(job.id)?.stage).toBe(PipelineStage.INVESTIGATING);
    expect(repo.getEvaluation(job.id)?.needsB2bInvestigation).toBe(true);
  });

  test("tier three is archived with reason codes", () => {
    const job = makeJob({ description: "Remote. US citizenship required." });
    qualifyJob(repo, job);
    expect(repo.getJob(job.id)?.stage).toBe(PipelineStage.DISQUALIFIED);
    expect(repo.getEvaluation(job.id)?.reasonCodes).toEqual(["CITIZENSHIP_REQUIRED"]);
    expect(repo.listTasks(B2B_INVESTIGATION)).toEqual([]);
  });

  test("requalifying does not reset a job that has moved on", () => {
    const job = makeJob({ location: "Remote (Worldwide)" });
    qualifyJob(repo, job);
    repo.setJobStage(job.id, PipelineStage.SUBMITTED);
    qualifyJob(repo, job);
    expect(repo.getJob(job.id)?.stage).toBe(PipelineStage.SUBMITTED);
  });

  test("routing is atomic: a failure part-way leaves nothing behind", () => {
    const job = makeJob({ description: "Fully remote team." });
    repo.enqueueTask = () => {
      throw new Error("queue unavailable");
    };
    expect(() => qualifyJob(repo, job)).toThrow("queue unavailable");
    expect(repo.getJob(job.id)).toBeNull();
    expect(repo.getEvaluation(job.id)).toBeNull();
  });

  test("a duplicate of a tracked listing is evaluated but not routed", () => {
    const first = makeJob({ location: "Remote (Worldwide)" });
    qualifyJob(repo, first);
    const again = createJob({ ...first, id: "", source: "elsewhere", sourceId: "42" });
    const report = qualifyJob(repo, again);
    expect(report.tier).toBe(CONFIRMED);
    expect(repo.getJob(again.id)).toBeNull();
    expect(repo.listJobs().map((job) => job.id)).toEqual([first.id]);
  });
});
