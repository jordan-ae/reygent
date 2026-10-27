/** The Cop Tool: nine invariants, the 2-retry auto-fix loop, and quarantine. */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  type AnswerVerdict,
  CopInspector,
  type CopInspectorOptions,
  CopRule,
  type InspectionResult,
  type Rewriter,
  Verdict,
  dedupKeys,
  fireworksRewriter,
  groundingProblems,
  toneProblems,
} from "@/core/cop/inspector";
import { HttpLinkChecker, type LinkStatus, normalizeUrl } from "@/core/cop/links";
import { inspectPdf } from "@/core/cop/pdfIntegrity";
import { Repository } from "@/core/db/repository";
import { CircuitBreakerError } from "@/core/llm/ledger";
import {
  type Achievement,
  type ApplicationDraft,
  type CandidateProfile,
  Channel,
  type CvBullet,
  type JobInput,
  type JobOpportunity,
  PipelineStage,
  type ScreeningAnswer,
  createDraft,
  createJob,
} from "@/core/models";

const NOW = new Date("2026-10-12T12:00:00Z");
const DAY_MS = 86_400_000;
const REPO_URL = "https://github.com/test-candidate/agent-runtime";
const WORK_STATUS =
  "Eligible for Global Independent B2B Contractor & 1099 Engagements." +
  " Invoices via direct wire / Deel / Remote / Wise.";

// ---------- Fixtures ----------

function achievement(
  fields: Pick<Achievement, "id" | "category" | "headline" | "impactMetric"> & Partial<Achievement>,
): Achievement {
  return { technologies: [], context: "", employer: "", evidenceUrl: "", positioning: [], verified: false, ...fields };
}

function makeProfile(overrides: Partial<CandidateProfile> = {}): CandidateProfile {
  return {
    id: "default", name: "Test Candidate", email: "candidate@example.com", phone: "+237 600 000 000",
    location: "Cameroon (UTC+1)", timezone: "Africa/Douala (WAT, UTC+1)",
    workAuthorization: WORK_STATUS, noticePeriod: "2 weeks",
    githubUrl: "https://github.com/test-candidate",
    linkedinUrl: "https://www.linkedin.com/in/test-candidate",
    portfolioUrl: "https://candidate.example.com",
    yearsExperience: 8, employers: ["Initech"], skills: ["Python", "Docker"],
    achievements: [
      achievement({
        id: "ach_agents", category: "ai_systems",
        headline: "Built a LangGraph agent runtime with checkpoint recovery",
        impactMetric: "Cut workflow latency by 45% and raised eval accuracy from 71% to 94%",
        technologies: ["Python", "LangGraph", "PostgreSQL"], employer: "Initech",
        evidenceUrl: REPO_URL, positioning: ["ai_platform_agent"], verified: true,
      }),
      achievement({
        id: "ach_search", category: "ai_systems",
        headline: "Shipped semantic search over 4M documents",
        impactMetric: "Sub-80ms retrieval at p95",
        technologies: ["Python", "Qdrant", "pgvector"], positioning: ["applied_ai_llm"], verified: true,
      }),
      achievement({
        id: "ach_unverified", category: "full_stack",
        headline: "Scaled a SaaS product to 300k monthly users",
        impactMetric: "Held 99.98% uptime", technologies: ["TypeScript", "Next.js"],
      }),
    ],
    positioning: {
      ai_platform_agent: {
        id: "ai_platform_agent", title: "AI Platform / Agent Engineer", targetSummary: "Agent platforms.",
        coreSkills: ["LangGraph", "MCP", "Evals", "Tool Calling"], pitchAngle: "Reliable agents.",
        highlightedAchievements: ["ach_agents"],
      },
    },
    ...overrides,
  };
}

function makeJob(overrides: Partial<JobInput> = {}): JobOpportunity {
  return createJob({
    source: "greenhouse", sourceId: "123", company: "Acme Robotics", title: "Senior Agent Engineer",
    location: "Remote (Worldwide)",
    description: "Build production agents. Stack: Python, LangGraph, Temporal.",
    applyUrl: "https://boards.greenhouse.io/acme/jobs/123", companyDomain: "acme-robotics.com",
    skills: ["Python", "LangGraph", "Temporal"],
    ...overrides,
  });
}

const bullet = (text: string, achievementId: string): CvBullet => ({ text, achievementId });
const answer = (question: string, text: string, extra: Partial<ScreeningAnswer> = {}): ScreeningAnswer => ({
  question, answer: text, options: [], factKey: "", ...extra,
});

function makeDraft(job: JobOpportunity, overrides: Partial<ApplicationDraft> = {}): ApplicationDraft {
  return createDraft({
    jobId: job.id, channel: Channel.ATS_INBOUND, positioningProfileId: "ai_platform_agent",
    pitch:
      "I build agent runtimes in Python and LangGraph. At Initech I cut workflow latency by 45%" +
      ` and raised eval accuracy from 71% to 94%. Code: ${REPO_URL}. I can start within 2 weeks.`,
    cvBullets: [
      bullet("Built a LangGraph agent runtime with checkpoint recovery, cutting workflow latency by 45%.", "ach_agents"),
    ],
    screeningAnswers: [
      answer("Where are you based?", "Cameroon (UTC+1)", { factKey: "location" }),
      answer("What interests you about this role?", "The eval-driven approach to agent reliability matches how I work."),
    ],
    quotedRateUsd: 60, quotedRatePeriod: "hour",
    ...overrides,
  });
}

const latin1 = (text: string): Buffer => Buffer.from(text, "latin1");

/** A minimal PDF with `pages` pages that each draw `content`. */
function makePdf(
  options: { pages?: number; content?: string; padding?: number; compress?: boolean } = {},
): Buffer {
  const {
    pages = 1, content = "BT /F1 11 Tf 1 0 0 1 72 720 Tm (Test Candidate) Tj ET", padding = 12_000, compress = false,
  } = options;
  const stream = compress ? zlib.deflateSync(latin1(content)) : latin1(content);
  const filter = compress ? " /Filter /FlateDecode" : "";
  const kids = Array.from({ length: pages }, (_, i) => `${3 + 2 * i} 0 R`).join(" ");
  const parts = [
    latin1("%PDF-1.4\n"),
    latin1("1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n"),
    latin1(`2 0 obj\n<< /Type /Pages /Kids [${kids}] /Count ${pages} >>\nendobj\n`),
  ];
  for (let i = 0; i < pages; i++) {
    const page = 3 + 2 * i;
    const body = 4 + 2 * i;
    parts.push(
      latin1(`${page} 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents ${body} 0 R >>\nendobj\n`),
      latin1(`${body} 0 obj\n<< /Length ${stream.length}${filter} >>\nstream\n`),
      stream,
      latin1("\nendstream\nendobj\n"),
    );
  }
  parts.push(latin1(`%${"x".repeat(padding)}\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n`));
  return Buffer.concat(parts);
}

const replaceBytes = (data: Buffer, search: string, replacement: string): Buffer =>
  latin1(data.toString("latin1").replaceAll(search, replacement));

// ---------- Harness shared by every suite ----------

let repo: Repository;
let profile: CandidateProfile;
let job: JobOpportunity;
let checkedLinks: string[];
let inspector: CopInspector;

const linkChecker = async (url: string): Promise<LinkStatus> => {
  checkedLinks.push(url);
  return { ok: true, detail: "reachable", title: "" };
};

function makeInspector(overrides: CopInspectorOptions = {}): CopInspector {
  return new CopInspector(repo, { linkChecker, clock: () => NOW, ...overrides });
}

function inspect(
  draft: ApplicationDraft,
  using: { job?: JobOpportunity; profile?: CandidateProfile; inspector?: CopInspector } = {},
): Promise<InspectionResult> {
  return (using.inspector ?? inspector).inspectApplicationDraft(draft, using.job ?? job, using.profile ?? profile);
}

function expectPassed(result: InspectionResult): void {
  expect(result.violations).toEqual([]);
  expect(result.verdict).toBe(Verdict.GREENLIT);
  expect(result.passed).toBe(true);
}

function expectQuarantined(result: InspectionResult, rule: CopRule, fragment?: string): void {
  expect(result.verdict).toBe(Verdict.QUARANTINED);
  expect(result.passed).toBe(false);
  const messages = result.violations.filter((v) => v.rule === rule).map((v) => v.message);
  expect(messages, `expected a ${rule} violation, got ${JSON.stringify(result.violations)}`).not.toEqual([]);
  if (fragment) expect(messages.join("\n")).toContain(fragment);
  expect(repo.listQuarantined().map((item) => item.violationRule)).toContain(rule);
}

function expectOnlyRule(result: InspectionResult, rule: CopRule, fragment?: string): void {
  expectQuarantined(result, rule, fragment);
  expect([...new Set(result.violations.map((v) => v.rule))], JSON.stringify(result.violations)).toEqual([rule]);
}

beforeEach(() => {
  repo = new Repository(":memory:");
  profile = makeProfile();
  job = makeJob();
  repo.insertJob(job);
  checkedLinks = [];
  inspector = makeInspector();
});

afterEach(() => {
  repo.close();
});

// ---------- Greenlight ----------

describe("greenlight", () => {
  it("passes a grounded draft through all nine checks", async () => {
    const result = await inspect(makeDraft(job));
    expect(result.violations).toEqual([]);
    expect(result.verdict).toBe(Verdict.GREENLIT);
    expect(result.passed).toBe(true);
    expect(result.retries).toBe(0);
    expect(result.quarantineIds).toEqual([]);
    expect(repo.listQuarantined()).toEqual([]);
    expect(repo.getJob(job.id)?.stage).toBe(PipelineStage.DISCOVERED);
  });

  it("has exactly nine invariants", () => {
    expect(Object.values(CopRule).map((rule) => rule[0])).toEqual([..."123456789"]);
  });
});

// ---------- 1. Fact grounding ----------

describe("fact grounding", () => {
  it("catches an ungrounded metric in a CV bullet", async () => {
    const draft = makeDraft(job, {
      cvBullets: [bullet("Built a LangGraph agent runtime, cutting workflow latency by 60%.", "ach_agents")],
    });
    expectOnlyRule(await inspect(draft), CopRule.FACT_GROUNDING, "60%");
  });

  it("catches an ungrounded metric in the pitch", async () => {
    const draft = makeDraft(job, { pitch: "I scaled a platform to 300k users with Python." });
    expectOnlyRule(await inspect(draft), CopRule.FACT_GROUNDING, "300k");
  });

  it("catches a metric borrowed from another achievement", async () => {
    // 4M is a verified number, but it belongs to the search achievement, not this bullet's.
    const draft = makeDraft(job, {
      cvBullets: [bullet("Built a LangGraph agent runtime handling 4M documents.", "ach_agents")],
    });
    expectOnlyRule(await inspect(draft), CopRule.FACT_GROUNDING, "4M");
  });

  it.each([
    "roughly doubled throughput", "cut costs by sixty percent", "served millions of users", "a tenfold speed-up",
  ])("catches a metric written out in words: %s", async (claim) => {
    const draft = makeDraft(job, { pitch: `I build agent runtimes in Python and ${claim}.` });
    expectOnlyRule(await inspect(draft), CopRule.FACT_GROUNDING, "is not in");
  });

  it("accepts a worded metric that the bank backs", async () => {
    const doubled = makeProfile();
    doubled.achievements[1].impactMetric = "Doubled recall; sub-80ms retrieval at p95";
    expectPassed(
      await inspect(makeDraft(job, { pitch: "My retrieval work in Python doubled recall." }), { profile: doubled }),
    );
    const tripled = makeDraft(job, { pitch: "My retrieval work in Python tripled recall." });
    expectOnlyRule(await inspect(tripled, { profile: doubled }), CopRule.FACT_GROUNDING, "tripled");
  });

  it("accepts equivalent number formats", async () => {
    const draft = makeDraft(job, { pitch: "Search over 4,000,000 documents; latency down 45 percent." });
    expectPassed(await inspect(draft));
  });

  it("lets an unverified achievement ground nothing", async () => {
    const draft = makeDraft(job, {
      cvBullets: [bullet("Scaled a SaaS product to 300k monthly users.", "ach_unverified")],
    });
    const result = await inspect(draft);
    expectOnlyRule(result, CopRule.FACT_GROUNDING, "not in the verified bank");
    expect(result.violations[0].fixable).toBe(false);
  });

  it("catches a bullet citing an unknown achievement", async () => {
    const draft = makeDraft(job, { cvBullets: [bullet("Built a thing.", "ach_made_up")] });
    expectOnlyRule(await inspect(draft), CopRule.FACT_GROUNDING, "ach_made_up");
  });

  it("catches a claim to the job's stack without evidence", async () => {
    const draft = makeDraft(job, { pitch: "I have run Temporal workflows in production with Python." });
    expectOnlyRule(await inspect(draft), CopRule.FACT_GROUNDING, "temporal");
  });

  it("catches an unverified technology and understands aliases", async () => {
    const draft = makeDraft(job, { pitch: "Postgres and Python daily; Kubernetes on the side." });
    const result = await inspect(draft);
    expectOnlyRule(result, CopRule.FACT_GROUNDING, "kubernetes");
    expect(result.violations.some((v) => v.message.includes("postgres"))).toBe(false);
  });

  it("catches a technology outside the cited achievement", async () => {
    const draft = makeDraft(job, {
      cvBullets: [bullet("Built a LangGraph agent runtime on Qdrant.", "ach_agents")],
    });
    expectOnlyRule(await inspect(draft), CopRule.FACT_GROUNDING, "qdrant");
  });

  it("catches an unverified employer", async () => {
    const draft = makeDraft(job, { pitch: "Previously at Globex I built agent runtimes in Python." });
    expectOnlyRule(await inspect(draft), CopRule.FACT_GROUNDING, "Globex");
  });

  it("allows naming the target company", async () => {
    const draft = makeDraft(job, { pitch: "The agent work at Acme Robotics is close to what I built in Python." });
    expectPassed(await inspect(draft));
  });

  it("does not mistake links and rates for metrics", async () => {
    const draft = makeDraft(job, { pitch: `Code: ${REPO_URL}. My rate is $60/hr.` });
    expectPassed(await inspect(draft));
  });

  describe("with the candidate's own notes (extraFacts)", () => {
    const NOTES = "Led a team of 12 engineers at Globex, running Kubernetes.";
    const informed = (): CopInspector => makeInspector({ extraFacts: NOTES });

    it("grounds a figure from the notes in the pitch and in a prose answer", async () => {
      const pitch = makeDraft(job, { pitch: "I build agent runtimes in Python and have led 12 engineers." });
      expectOnlyRule(await inspect(pitch), CopRule.FACT_GROUNDING, "figure '12' is not in the verified fact bank");
      expectPassed(await inspect(pitch, { inspector: informed() }));
      const spoken = makeDraft(job, {
        screeningAnswers: [answer("What interests you about this role?", "Having led 12 engineers, I like small teams.")],
      });
      expectOnlyRule(await inspect(spoken), CopRule.FACT_GROUNDING, "12");
      expectPassed(await inspect(spoken, { inspector: informed() }));
    });

    it("grounds no other figure", async () => {
      const draft = makeDraft(job, { pitch: "I build agent runtimes in Python and have led 15 engineers." });
      expectOnlyRule(await inspect(draft, { inspector: informed() }), CopRule.FACT_GROUNDING, "15");
    });

    it("adds no technologies or employers", async () => {
      const tech = makeDraft(job, { pitch: "I ran Kubernetes for 12 engineers in Python." });
      const technology = await inspect(tech, { inspector: informed() });
      expectOnlyRule(technology, CopRule.FACT_GROUNDING, "kubernetes");
      expect(technology.violations).toHaveLength(1);
      const employer = makeDraft(job, { pitch: "At Globex I led 12 engineers in Python." });
      const organisation = await inspect(employer, { inspector: informed() });
      expectOnlyRule(organisation, CopRule.FACT_GROUNDING, "Globex");
      expect(organisation.violations).toHaveLength(1);
    });

    it("does not ground a CV bullet, which restates its own achievement", async () => {
      const draft = makeDraft(job, {
        cvBullets: [bullet("Built a LangGraph agent runtime with 12 engineers.", "ach_agents")],
      });
      expectOnlyRule(
        await inspect(draft, { inspector: informed() }), CopRule.FACT_GROUNDING,
        "figure '12' is not in verified achievement 'ach_agents'",
      );
    });
  });
});

// ---------- 2. Screening answers ----------

/** A stand-in for the decision model that records every question it is asked. */
function verifier(verdict: Partial<AnswerVerdict> | Error = { supported: true, confidence: 0.99 }) {
  const calls: Array<{ question: string; answer: string; options: string[] }> = [];
  const verifyAnswer = async (question: string, text: string, options: string[]): Promise<AnswerVerdict> => {
    calls.push({ question, answer: text, options });
    if (verdict instanceof Error) throw verdict;
    return verdict as AnswerVerdict;
  };
  return { calls, verifyAnswer };
}

const remembered = (answers: Record<string, string>) => (question: string): string | null =>
  Object.hasOwn(answers, question) ? answers[question] : null;

describe("screening answers", () => {
  const withAnswer = (question: string, text: string, extra: Partial<ScreeningAnswer> = {}): ApplicationDraft =>
    makeDraft(job, { screeningAnswers: [answer(question, text, extra)] });

  // Citizenship and a sponsorship label that is not a yes-or-no question are left to the
  // verifier; "Are you authorized to work in the US?" is settled by where the candidate lives (f2).
  const CITIZEN = "Are you a citizen of the United States?";
  const SPONSORSHIP = "Visa sponsorship requirements (now or in the future)";
  const TAX = "What is your tax residency status?";
  const HEARD = "How did you hear about us?";
  const YES_NO = { options: ["Yes", "No"] };

  describe("a. an empty answer", () => {
    it("is held as a to-do for the user and never sent to the verifier", async () => {
      const model = verifier();
      const result = await inspect(withAnswer(CITIZEN, "  ", YES_NO), {
        inspector: makeInspector({ verifyAnswer: model.verifyAnswer }),
      });
      expectQuarantined(
        result, CopRule.SCREENING_SANITY,
        `'${CITIZEN}' could not be answered from your data — answer it once and Reygent will remember it`,
      );
      expect(result.violations.find((v) => v.rule === CopRule.SCREENING_SANITY)?.fixable).toBe(false);
      expect(model.calls).toEqual([]);
    });
  });

  describe("b. an answer outside the offered options", () => {
    it("is caught", async () => {
      const draft = withAnswer("Where are you located?", "Cameroon (UTC+1)", {
        options: ["Africa", "Europe"], factKey: "location",
      });
      expectOnlyRule(await inspect(draft), CopRule.SCREENING_SANITY, "not one of the offered options");
    });

    it("is caught even when it is the remembered answer, and is not sent to the verifier", async () => {
      const model = verifier();
      const result = await inspect(withAnswer(CITIZEN, "Yes, as a contractor", YES_NO), {
        inspector: makeInspector({
          standingAnswer: remembered({ [CITIZEN]: "Yes, as a contractor" }), verifyAnswer: model.verifyAnswer,
        }),
      });
      expectOnlyRule(result, CopRule.SCREENING_SANITY, "not one of the offered options");
      expect(model.calls).toEqual([]);
    });
  });

  describe("c. a remembered answer", () => {
    it("passes a sensitive multiple-choice question that is otherwise held", async () => {
      const draft = withAnswer(CITIZEN, "Yes", YES_NO);
      expectOnlyRule(await inspect(draft), CopRule.SCREENING_SANITY, "needs an answer from you");
      const informed = makeInspector({ standingAnswer: remembered({ [CITIZEN]: "Yes" }) });
      expectPassed(await inspect(draft, { inspector: informed }));
    });

    it("is matched to the exact question, ignoring case and spacing in the answer", async () => {
      const asked: string[] = [];
      const standingAnswer = (question: string): string | null => {
        asked.push(question);
        return question === CITIZEN ? "  yes " : null;
      };
      expectPassed(await inspect(withAnswer(CITIZEN, "Yes", YES_NO), { inspector: makeInspector({ standingAnswer }) }));
      expect(asked).toEqual([CITIZEN]);
      const other = withAnswer("Are you a citizen of Canada?", "Yes", YES_NO);
      expectOnlyRule(await inspect(other, { inspector: makeInspector({ standingAnswer }) }), CopRule.SCREENING_SANITY);
    });

    it("does not bind a form that does not offer it: the option chosen there is verified instead", async () => {
      const options = ["I am a US citizen", "I am not a US citizen"];
      const draft = withAnswer(CITIZEN, options[0], { options });
      const standingAnswer = remembered({ [CITIZEN]: "Yes" });
      // With nothing to verify it the chosen option is held, but not as a contradiction of "Yes".
      const unverified = await inspect(draft, { inspector: makeInspector({ standingAnswer }) });
      expectOnlyRule(unverified, CopRule.SCREENING_SANITY, "needs an answer from you");
      const backed = verifier();
      expectPassed(
        await inspect(draft, { inspector: makeInspector({ standingAnswer, verifyAnswer: backed.verifyAnswer }) }),
      );
      expect(backed.calls).toEqual([{ question: CITIZEN, answer: options[0], options }]);
      const refuted = makeInspector({
        standingAnswer, verifyAnswer: verifier({ supported: false, confidence: 0.99 }).verifyAnswer,
      });
      expectOnlyRule(await inspect(draft, { inspector: refuted }), CopRule.SCREENING_SANITY, "is not supported by your data");
    });

    it("binds a form that offers it under another spelling", async () => {
      const model = verifier();
      const informed = makeInspector({
        standingAnswer: remembered({ [CITIZEN]: "yes" }), verifyAnswer: model.verifyAnswer,
      });
      const options = ["YES ", "NO"];
      expectPassed(await inspect(withAnswer(CITIZEN, "YES ", { options }), { inspector: informed }));
      const contrary = await inspect(withAnswer(CITIZEN, "NO", { options }), { inspector: informed });
      expectOnlyRule(contrary, CopRule.SCREENING_SANITY, "differs from your remembered answer");
      expect(model.calls).toEqual([]);
    });

    it("counts for nothing when it is blank", async () => {
      const model = verifier();
      const blank = makeInspector({ standingAnswer: () => "  ", verifyAnswer: model.verifyAnswer });
      expectPassed(await inspect(withAnswer(CITIZEN, "Yes", YES_NO), { inspector: blank }));
      expect(model.calls).toHaveLength(1); // judged as an attestation, as if never answered before
    });

    it("catches a draft that answers differently", async () => {
      const model = verifier();
      const result = await inspect(withAnswer(CITIZEN, "Yes", YES_NO), {
        inspector: makeInspector({ standingAnswer: remembered({ [CITIZEN]: "No" }), verifyAnswer: model.verifyAnswer }),
      });
      expectOnlyRule(result, CopRule.SCREENING_SANITY, `answer to '${CITIZEN}' differs from your remembered answer`);
      expect(result.violations[0].fixable).toBe(false);
      expect(model.calls).toEqual([]);
    });

    it("is the user's own statement, so fact grounding does not apply to it", async () => {
      const text = "No, I do not require sponsorship in 2026";
      const model = verifier();
      const informed = makeInspector({
        standingAnswer: remembered({ [SPONSORSHIP]: text }), verifyAnswer: model.verifyAnswer,
      });
      expectPassed(await inspect(withAnswer(SPONSORSHIP, text), { inspector: informed }));
      expect(model.calls).toEqual([]);
      // The same sentence as free prose is a claim like any other: 2026 is not in the fact bank.
      const prose = withAnswer("Anything else we should know?", text);
      expectOnlyRule(await inspect(prose, { inspector: informed }), CopRule.FACT_GROUNDING, "2026");
    });

    it.each([
      ["tone", "I am thrilled to say I spent 9 years at Globex.", CopRule.TONE, "thrilled"],
      ["commitments", "Happy to relocate, and I spent 9 years at Globex.", CopRule.COMMITMENT_GUARD, "on-site presence"],
    ])("is still free text Reygent sends: %s applies, and no rewrite may touch it", async (_label, text, rule, fragment) => {
      const ask = "Anything else we should know?";
      const rewrites: string[] = [];
      const informed = makeInspector({
        standingAnswer: remembered({ [ask]: text }),
        rewriter: (flawed) => {
          rewrites.push(flawed);
          return "Nothing to add.";
        },
      });
      const result = await inspect(withAnswer(ask, text), { inspector: informed });
      // Only that rule: "9 years at Globex" is the user's to state, so rule 1 stays out of it.
      expectOnlyRule(result, rule, fragment);
      expect(result.violations.map((v) => v.fixable)).toEqual([false]);
      expect(result.retries).toBe(0);
      expect(rewrites).toEqual([]);
      expect(result.draft.screeningAnswers[0].answer).toBe(text);
    });

    it("is still subject to the link, asset and rate rules, which cover every field", async () => {
      const text = "See https://github.com/someone-else/cool-agent";
      const informed = makeInspector({ standingAnswer: remembered({ [HEARD]: text }) });
      const result = await inspect(withAnswer(HEARD, text), { inspector: informed });
      expectOnlyRule(result, CopRule.LINK_VERIFICATION, "someone-else");
      expect(result.violations[0].fixable).toBe(false);
    });
  });

  describe("d. a verbatim profile fact", () => {
    it("answers a work-status question", async () => {
      const model = verifier();
      const draft = withAnswer("Describe your work authorization.", WORK_STATUS, { factKey: "work_authorization" });
      expectPassed(await inspect(draft, { inspector: makeInspector({ verifyAnswer: model.verifyAnswer }) }));
      expect(model.calls).toEqual([]);
    });

    it("answers a multiple-choice work-status question without the verifier", async () => {
      // The Python reference held this one; the profile fact now settles it before verification.
      const model = verifier({ supported: false, confidence: 1 });
      const draft = withAnswer("What is your work authorization status?", WORK_STATUS, {
        options: [WORK_STATUS, "US citizen"], factKey: "work_authorization",
      });
      expectPassed(await inspect(draft));
      expectPassed(await inspect(draft, { inspector: makeInspector({ verifyAnswer: model.verifyAnswer }) }));
      expect(model.calls).toEqual([]);
    });

    it("catches an answer that drifts from the fact", async () => {
      const draft = withAnswer("Describe your work authorization.", "Authorized to work in the US.", {
        factKey: "work_authorization",
      });
      expectOnlyRule(await inspect(draft), CopRule.SCREENING_SANITY, "differs from the verified");
    });

    it("backs a dropdown", async () => {
      const draft = withAnswer("Where are you located?", "Cameroon (UTC+1)", {
        options: ["Cameroon (UTC+1)", "Elsewhere"], factKey: "location",
      });
      expectPassed(await inspect(draft));
    });

    it("cannot be cited when the profile does not hold it", async () => {
      const unset = makeProfile({ noticePeriod: "CHANGE_ME" });
      const draft = makeDraft(job, {
        pitch: "I build agent runtimes in Python.",
        screeningAnswers: [answer("What is your notice period?", "CHANGE_ME", { factKey: "notice_period" })],
      });
      expectQuarantined(await inspect(draft, { profile: unset }), CopRule.SCREENING_SANITY, "does not hold");
    });

    it("cannot be conjured from a key that only exists on Object.prototype", async () => {
      const draft = withAnswer("Where are you based?", "Cameroon (UTC+1)", { factKey: "constructor" });
      expectOnlyRule(
        await inspect(draft), CopRule.SCREENING_SANITY,
        "answer to 'Where are you based?' cites fact 'constructor', which the profile does not hold",
      );
    });
  });

  describe("e. declining a demographic question", () => {
    it.each([
      ["Gender", "Decline to self-identify", ["Male", "Female", "Decline to self-identify"]],
      ["What is your race / ethnicity?", "I prefer not to say", ["Asian", "Black", "White", "I prefer not to say"]],
      ["Veteran status", "I don’t wish to answer", ["I am a veteran", "I am not a veteran", "I don’t wish to answer"]],
      ["Do you have a disability?", "I do not wish to answer", []],
      ["Pronouns", "Choose not to disclose", []],
      ["What is your sex?", "Prefer not to say", ["Male", "Female", "Prefer not to say"]],
      ["Racial background", "I choose not to identify", []],
      ["Are you Hispanic or Latino?", "Decline to answer", ["Yes", "No", "Decline to answer"]],
      ["Have you served in the armed forces?", "I prefer not to say", []],
      ["Military service", "Decline to self-identify", ["Yes", "No", "Decline to self-identify"]],
      ["Sexual orientation", "I do not wish to disclose", []],
    ])("passes without verification: %s -> %s", async (question, text, options) => {
      const model = verifier({ supported: false, confidence: 1 });
      const result = await inspect(withAnswer(question, text, { options }), {
        inspector: makeInspector({ verifyAnswer: model.verifyAnswer }),
      });
      expectPassed(result);
      expect(model.calls).toEqual([]);
    });

    it("does not cover an actual answer to a demographic question", async () => {
      const options = ["Male", "Female", "Decline to self-identify"];
      const draft = withAnswer("Gender", "Male", { options });
      expectOnlyRule(await inspect(draft), CopRule.SCREENING_SANITY, "needs an answer from you");
      const model = verifier();
      expectPassed(await inspect(draft, { inspector: makeInspector({ verifyAnswer: model.verifyAnswer }) }));
      expect(model.calls).toEqual([{ question: "Gender", answer: "Male", options }]);
    });

    it("does not cover declining a citizenship question", async () => {
      const draft = withAnswer(CITIZEN, "Prefer not to say", { options: ["Yes", "No", "Prefer not to say"] });
      expectOnlyRule(await inspect(draft), CopRule.SCREENING_SANITY, "needs an answer from you");
    });

    it.each([
      ["What is your race?", "Asian"],
      ["What are your pronouns?", "he/him"],
      ["What is your sex?", "Male"],
      ["Sexual orientation", "Straight"],
      ["Have you completed military service?", "Yes"],
      ["Have you served in the armed forces?", "No"],
      ["Are you Hispanic or Latino?", "No"],
    ])("makes a statement on any self-identification question an attestation: %s", async (question, text) => {
      const draft = withAnswer(question, text);
      expectOnlyRule(await inspect(draft), CopRule.SCREENING_SANITY, "needs an answer from you");
      const model = verifier();
      expectPassed(await inspect(draft, { inspector: makeInspector({ verifyAnswer: model.verifyAnswer }) }));
      expect(model.calls).toEqual([{ question, answer: text, options: [] }]);
    });

    it("covers a free-text decline of up to eight words, and nothing longer", async () => {
      expectPassed(await inspect(withAnswer("Pronouns", "I would really prefer not to say that")));
      const nine = withAnswer("Pronouns", "I would really prefer not to say that here");
      expectOnlyRule(await inspect(nine), CopRule.SCREENING_SANITY, "needs an answer from you");
    });

    it("does not cover prose that merely contains a decline phrase", async () => {
      const text = "I would prefer not to be put in a box, though I do identify as a man.";
      const model = verifier({ supported: false, confidence: 0.99 });
      const result = await inspect(withAnswer("Gender", text), {
        inspector: makeInspector({ verifyAnswer: model.verifyAnswer }),
      });
      expectOnlyRule(result, CopRule.SCREENING_SANITY, "is not supported by your data");
      expect(model.calls).toHaveLength(1);
    });

    it("does not cover picking an option that is not the decline", async () => {
      const options = ["I am a veteran", "I am not a veteran", "I prefer not to say"];
      const draft = withAnswer("Veteran status", "I am not a veteran", { options });
      expectOnlyRule(await inspect(draft), CopRule.SCREENING_SANITY, "needs an answer from you");
    });

    it.each([
      "Tell us about a race condition you fixed.", "How do you debug race conditions?",
    ])("reads a race condition as a concurrency bug, not a demographic: %s", async (question) => {
      const model = verifier({ supported: false, confidence: 1 });
      const judged = makeInspector({ verifyAnswer: model.verifyAnswer });
      // Not sensitive: the answer is prose, which no one has to verify ...
      const plain = withAnswer(question, "I serialised checkpoint writes behind a lock in Python.");
      expectPassed(await inspect(plain, { inspector: judged }));
      // ... and not demographic: "prefer not to say" earns no exemption from the prose rules.
      const evasive = withAnswer(question, "I prefer not to say, but it took 300k retries.");
      expectOnlyRule(await inspect(evasive, { inspector: judged }), CopRule.FACT_GROUNDING, "300k");
      expect(model.calls).toEqual([]);
    });
  });

  describe("f. an attestation", () => {
    it("on a multiple-choice citizenship question is quarantined at once when nothing can verify it", async () => {
      const rewrites: string[] = [];
      const cautious = makeInspector({
        rewriter: (text) => {
          rewrites.push(text);
          return text;
        },
      });
      const result = await inspect(withAnswer(CITIZEN, "Yes", YES_NO), { inspector: cautious });
      expectOnlyRule(
        result, CopRule.SCREENING_SANITY,
        `'${CITIZEN}' needs an answer from you: no decision model is configured to verify one`,
      );
      expect(result.violations[0].fixable).toBe(false);
      expect(result.retries).toBe(0);
      expect(rewrites).toEqual([]);
      expect(repo.getJob(job.id)?.stage).toBe(PipelineStage.QUARANTINED);
    });

    it("on a multiple-choice citizenship question passes only when the verifier supports it", async () => {
      const draft = withAnswer(CITIZEN, "Yes", YES_NO);
      const backed = verifier({ supported: true, confidence: 0.93 });
      expectPassed(await inspect(draft, { inspector: makeInspector({ verifyAnswer: backed.verifyAnswer }) }));
      expect(backed.calls).toEqual([{ question: CITIZEN, answer: "Yes", options: ["Yes", "No"] }]);

      const rewrites: string[] = [];
      const refuted = makeInspector({
        verifyAnswer: verifier({ supported: false, confidence: 0.97 }).verifyAnswer,
        rewriter: (text) => {
          rewrites.push(text);
          return text;
        },
      });
      const result = await inspect(draft, { inspector: refuted });
      expectOnlyRule(
        result, CopRule.SCREENING_SANITY,
        `answer to '${CITIZEN}' ("Yes") is not supported by your data — answer it once and Reygent will remember it`,
      );
      expect(result.violations[0].fixable).toBe(false);
      expect(result.retries).toBe(0);
      expect(rewrites).toEqual([]);
    });

    it.each([
      ["a novel tax question", TAX, "Non-US tax resident.", [] as string[]],
      ["a sponsorship question", SPONSORSHIP, "No", [] as string[]],
      ["a dropdown without a backing fact", HEARD, "LinkedIn", ["LinkedIn", "Referral", "Other"]],
    ])("is not guessed: %s", async (_label, question, text, options) => {
      const draft = withAnswer(question, text, { options });
      expectOnlyRule(await inspect(draft), CopRule.SCREENING_SANITY, "needs an answer from you");
      const refuted = makeInspector({ verifyAnswer: verifier({ supported: false, confidence: 0.99 }).verifyAnswer });
      expectOnlyRule(await inspect(draft, { inspector: refuted }), CopRule.SCREENING_SANITY, "is not supported by your data");
      const unsure = makeInspector({ verifyAnswer: verifier({ supported: true, confidence: 0.5 }).verifyAnswer });
      expectOnlyRule(await inspect(draft, { inspector: unsure }), CopRule.SCREENING_SANITY, "is not supported by your data");
      const backed = verifier({ supported: true, confidence: 0.9 });
      expectPassed(await inspect(draft, { inspector: makeInspector({ verifyAnswer: backed.verifyAnswer }) }));
      expect(backed.calls).toEqual([{ question, answer: text, options }]);
    });

    it("where the listing was found is a fact about the listing: it needs no verifier, and only the truth passes", async () => {
      const options = ["LinkedIn", "Company website", "Job board", "We Work Remotely", "Other"];
      // The job is on a company board: its careers page is where it was found.
      expectPassed(await inspect(withAnswer(HEARD, "Company website", { options })));
      expectOnlyRule(await inspect(withAnswer(HEARD, "Job board", { options })), CopRule.SCREENING_SANITY, "needs an answer from you");

      const onJobSite = makeJob({ source: "weworkremotely", applyUrl: "https://weworkremotely.com/remote-jobs/acme-senior-agent-engineer" });
      expectPassed(await inspect(withAnswer(HEARD, "We Work Remotely", { options }), { job: onJobSite }));
      expectPassed(await inspect(withAnswer(HEARD, "Job board", { options }), { job: onJobSite }));
      expectOnlyRule(
        await inspect(withAnswer(HEARD, "Company website", { options }), { job: onJobSite }),
        CopRule.SCREENING_SANITY, "needs an answer from you",
      );
    });

    it.each([
      [0.85, true], [0.84, false], [1, true], [0, false],
    ])("needs confidence of at least 0.85: %f -> %s", async (confidence, passes) => {
      const model = verifier({ supported: true, confidence });
      const result = await inspect(withAnswer(SPONSORSHIP, "No"), {
        inspector: makeInspector({ verifyAnswer: model.verifyAnswer }),
      });
      expect(result.passed).toBe(passes);
      if (!passes) expectOnlyRule(result, CopRule.SCREENING_SANITY, "is not supported by your data");
    });

    it("honours a configured confidence threshold", async () => {
      const draft = withAnswer(SPONSORSHIP, "No");
      const { verifyAnswer } = verifier({ supported: true, confidence: 0.9 });
      expectPassed(await inspect(draft, { inspector: makeInspector({ verifyAnswer, answerConfidence: 0.9 }) }));
      const strict = makeInspector({ verifyAnswer, answerConfidence: 0.95 });
      expectOnlyRule(await inspect(draft, { inspector: strict }), CopRule.SCREENING_SANITY);
    });

    it.each([
      ["no confidence", { supported: true }],
      ["a confidence that is not a number", { supported: true, confidence: Number.NaN }],
      ["a truthy value that is not true", { supported: "false" as unknown as boolean, confidence: 1 }],
    ])("is not verified by a malformed verdict: %s", async (_label, verdict) => {
      const result = await inspect(withAnswer(SPONSORSHIP, "No"), {
        inspector: makeInspector({ verifyAnswer: verifier(verdict).verifyAnswer }),
      });
      expectOnlyRule(result, CopRule.SCREENING_SANITY, "is not supported by your data");
    });

    it("is not verified when the verifier fails", async () => {
      const model = verifier(new Error("decision model unavailable"));
      const result = await inspect(withAnswer(SPONSORSHIP, "No"), {
        inspector: makeInspector({ verifyAnswer: model.verifyAnswer }),
      });
      expectOnlyRule(result, CopRule.SCREENING_SANITY, "is not supported by your data");
      expect(model.calls).toHaveLength(1);
    });

    it("lets the spend cap propagate from the verifier", async () => {
      const capped = makeInspector({ verifyAnswer: verifier(new CircuitBreakerError(1.5, 1.5)).verifyAnswer });
      await expect(inspect(withAnswer(SPONSORSHIP, "No"), { inspector: capped })).rejects.toThrow(CircuitBreakerError);
      expect(repo.listQuarantined()).toEqual([]);
    });

    const LOOSE = "No sponsorship needed through 2030!! Happy to relocate.";

    it("as free text is still prose once verified: fact grounding, commitments and tone apply", async () => {
      const backed = makeInspector({ verifyAnswer: verifier().verifyAnswer });
      expectPassed(await inspect(withAnswer(SPONSORSHIP, "No"), { inspector: backed }));
      const result = await inspect(withAnswer(SPONSORSHIP, LOOSE), { inspector: backed });
      expectQuarantined(result, CopRule.FACT_GROUNDING, "2030");
      expectQuarantined(result, CopRule.COMMITMENT_GUARD, "relocate");
      expectQuarantined(result, CopRule.TONE, "exclamation");
      expect(result.violations.map((v) => v.rule)).not.toContain(CopRule.SCREENING_SANITY);
      expect(result.violations.every((v) => v.fixable && v.field === "screeningAnswers[0]")).toBe(true);
    });

    it("as a choice is exempt from the prose rules, whether verified or remembered", async () => {
      const draft = withAnswer(SPONSORSHIP, LOOSE, { options: [LOOSE, "Yes"] });
      expectPassed(await inspect(draft, { inspector: makeInspector({ verifyAnswer: verifier().verifyAnswer }) }));
      const informed = makeInspector({ standingAnswer: remembered({ [SPONSORSHIP]: LOOSE }) });
      expectPassed(await inspect(draft, { inspector: informed }));
    });

    it("is verified again when a rewrite changes it", async () => {
      const model = verifier();
      const fixing = makeInspector({ verifyAnswer: model.verifyAnswer, rewriter: () => "No sponsorship is needed." });
      const flawed = "I am thrilled to say no sponsorship is needed.";
      const result = await inspect(withAnswer(SPONSORSHIP, flawed), { inspector: fixing });
      expectPassed(result);
      expect(result.retries).toBe(1);
      expect(result.draft.screeningAnswers[0].answer).toBe("No sponsorship is needed.");
      expect(model.calls.map((call) => call.answer)).toEqual([flawed, "No sponsorship is needed."]);
    });

    describe("and the quoted rate, in answer to what the candidate expects to be paid", () => {
      const PAY = "What is your expected hourly rate? (1099 / B2B contractors only, before tax)";
      const QUOTED = "$60/hour as an independent B2B contractor";

      it("is not one, even though the question mentions tax and a 1099", async () => {
        expectPassed(await inspect(withAnswer(PAY, QUOTED)));
        const model = verifier({ supported: false, confidence: 1 });
        expectPassed(await inspect(withAnswer(PAY, QUOTED), { inspector: makeInspector({ verifyAnswer: model.verifyAnswer }) }));
        expect(model.calls).toEqual([]);
      });

      it("is judged as prose instead", async () => {
        const result = await inspect(withAnswer(PAY, "$60/hour, and I am thrilled!!"));
        expectOnlyRule(result, CopRule.TONE);
        expect(result.violations.every((v) => v.fixable)).toBe(true);
      });

      it.each([
        ["another rate", PAY, "$75/hour as an independent B2B contractor"],
        ["another period", PAY, "$60/day as an independent B2B contractor"],
        ["a second rate", PAY, "$60/hour, or $60/hour on weekends"],
        ["a second figure", PAY, "$60/hour for 40 hours a week"],
        ["a worded quantity", PAY, "$60/hour, double at weekends"],
        ["a statement about status", PAY, "$60/hour; I am a US citizen"],
        ["a question about current pay", "What is your current salary before tax?", QUOTED],
        ["a question that is not about pay", CITIZEN, QUOTED],
      ])("is one after all with %s", async (_label, question, text) => {
        const result = await inspect(withAnswer(question, text));
        expectQuarantined(result, CopRule.SCREENING_SANITY, "needs an answer from you");
      });

      it("is one when the draft quotes no rate, or the answer is a choice", async () => {
        const unquoted = makeDraft(job, { quotedRateUsd: null, screeningAnswers: [answer(PAY, QUOTED)] });
        expectOnlyRule(await inspect(unquoted), CopRule.SCREENING_SANITY, "needs an answer from you");
        const choice = withAnswer(PAY, QUOTED, { options: [QUOTED, "Other"] });
        expectOnlyRule(await inspect(choice), CopRule.SCREENING_SANITY, "needs an answer from you");
      });
    });

    it("is verified once per inspection, however many rewrite passes follow", async () => {
      const model = verifier();
      const fixing = makeInspector({
        verifyAnswer: model.verifyAnswer,
        rewriter: (text) => text.replace("I hope this email finds you well. ", ""),
      });
      const draft = makeDraft(job, {
        pitch: "I hope this email finds you well. I build agent runtimes in Python and LangGraph.",
        screeningAnswers: [answer(SPONSORSHIP, "No")],
      });
      const result = await inspect(draft, { inspector: fixing });
      expectPassed(result);
      expect(result.retries).toBe(1);
      expect(model.calls).toHaveLength(1);
    });
  });

  describe("f2. settled without a verifier: work status, a notice confirmed, a technology denied", () => {
    // The test candidate lives in Cameroon.
    it.each([
      ["Are you legally authorized to work in the United States?", "No", "Yes"],
      ["Are you legally entitled to work in Canada?", "No", "Yes"],
      ["Are you authorized to work in Cameroon?", "Yes", "No"],
      ["Are you legally authorized to work in the US (or country of your residence)?", "Yes", "No"],
      ["Do you now or at a future date require visa sponsorship to work in the United States?", "Yes", "No"],
      ["Will you now or in the future require sponsorship for employment?", "No", "Yes"],
      ["Are you willing to relocate?", "No", "Yes"],
      // The test candidate's work authorization says they are a B2B contractor.
      ["Are you happy working with us under a B2B or B2C arrangement?", "Yes", "No"],
    ])("work status follows where the candidate lives: %s", async (question, right, wrong) => {
      const model = verifier();
      const judged = makeInspector({ verifyAnswer: model.verifyAnswer });
      expectPassed(await inspect(withAnswer(question, right, YES_NO), { inspector: judged }));
      expectOnlyRule(
        await inspect(withAnswer(question, wrong, YES_NO), { inspector: judged }),
        CopRule.SCREENING_SANITY, `says ${wrong.toLowerCase()}, but where the candidate lives and this listing say`,
      );
      expect(model.calls).toEqual([]);
    });

    it("a question about the role's own country follows the listing, whatever was remembered for another", async () => {
      const question = "Are you authorized to work lawfully in the country to which you are applying?";
      const informed = makeInspector({ standingAnswer: remembered({ [question]: "No" }) });
      // The test job is "Remote (Worldwide)": open to someone working from Cameroon.
      expectPassed(await inspect(withAnswer(question, "Yes", YES_NO), { inspector: informed }));
      const inCanada = makeJob({ sourceId: "ca", location: "Remote, Canada", description: "Build agents." });
      expectPassed(await inspect(withAnswer(question, "No", YES_NO), { job: inCanada, inspector: informed }));
      expectOnlyRule(
        await inspect(withAnswer(question, "Yes", YES_NO), { job: inCanada, inspector: informed }),
        CopRule.SCREENING_SANITY, "says yes",
      );
    });

    it("a remembered answer still binds a question that does not depend on the listing", async () => {
      const question = "Will you now or in the future require sponsorship for employment?";
      const informed = makeInspector({ standingAnswer: remembered({ [question]: "Yes" }) });
      expectPassed(await inspect(withAnswer(question, "Yes", YES_NO), { inspector: informed }));
    });

    it.each([
      ["Applicant Privacy Notice", "Yes", ["Yes"]],
      ["GDPR Acknowledgement", "Acknowledge/Confirm", ["Acknowledge/Confirm"]],
      ["I agree", "I agree", ["I agree"]],
      ["I confirm I have read OysterHR's Privacy Notice", "I confirm I have read OysterHR's Privacy Notice",
        ["I confirm I have read OysterHR's Privacy Notice"]],
    ])("a notice confirmed with the form's own option needs no verifier: %s", async (question, text, options) => {
      expectPassed(await inspect(withAnswer(question, text, { options })));
    });

    it("asking for no accommodation needs no verifier; asking for one does", async () => {
      const question = "Do you require any reasonable accommodations or additional support during the process?";
      const options = ["Yes", "No", "Prefer not to say"];
      expectPassed(await inspect(withAnswer(question, "No", { options })));
      expectPassed(await inspect(withAnswer(question, "Prefer not to say", { options })));
      expectOnlyRule(await inspect(withAnswer(question, "Yes", { options })), CopRule.SCREENING_SANITY, "needs an answer from you");
    });

    it("a notice about AI is not one of those: it may ask the applicant not to use it", async () => {
      const question = "AI Policy for Application: we value authenticity. Do you agree?";
      expectOnlyRule(
        await inspect(withAnswer(question, "Yes", { options: ["Yes"] })), CopRule.SCREENING_SANITY, "needs an answer from you",
      );
    });

    it("'No' to a technology the verified bank lacks needs no verifier; to one it holds, it does", async () => {
      expectPassed(await inspect(withAnswer("Do you have production experience with React Native?", "No", YES_NO)));
      const held = await inspect(withAnswer("Do you have production experience with Python?", "No", YES_NO));
      expectOnlyRule(held, CopRule.SCREENING_SANITY, "needs an answer from you");
      const claimed = await inspect(withAnswer("Do you have production experience with React Native?", "Yes", YES_NO));
      expectOnlyRule(claimed, CopRule.SCREENING_SANITY, "needs an answer from you");
    });

    it.each([
      ["How many years have you spent with CI/CD, releases, or engineering automation as a primary responsibility?", "< 1 year", ["3+ years", "1-2 years", "< 1 year"]],
      ["What is your level of knowledge of the Java programming language?", "Beginner", ["Beginner", "Intermediate", "Advanced"]],
      ["Which best describes your experience with workflow automation or BPMN?", "No experience with BPMN or workflow automation.",
        ["I have configured BPMN workflows", "I have worked with workflow tools conceptually", "No experience with BPMN or workflow automation."]],
      ["Do you have experience working at an early stage startup?", "No", ["Yes", "No"]],
      ["By selecting YES, I consent to receive recruiting SMS messages at the phone number provided.", "No", ["Yes", "No"]],
      ["Do you consent to BrightHire's Interview Integrity feature analyzing your interview for potential fraud signals?", "No", ["Yes", "No"]],
      ["When you apply to this site, the personal information made available to EnterpriseDB will be handled consistent with the EDB Recrui…",
        "Acknowledge", ["Acknowledge"]],
    ])("the option claiming the least needs no verifier: %s", async (question, text, options) => {
      expectPassed(await inspect(withAnswer(question, text, { options })));
    });

    it("'Other' for where the role was found, when no option names that place, needs no verifier", async () => {
      const options = ["Phantom User", "LinkedIn - Company Page", "Other"];
      const board = { ...job, source: "ashby" };
      expectPassed(await inspect(makeDraft(board, { screeningAnswers: [answer("What platform encouraged you to apply to Phantom?", "Other", { options })] }), { job: board }));
      const named = ["LinkedIn", "Company careers page", "Other"];
      expectOnlyRule(
        await inspect(makeDraft(board, { screeningAnswers: [answer("How did you hear about us?", "Other", { options: named })] }), { job: board }),
        CopRule.SCREENING_SANITY, "needs an answer from you",
      );
    });

    it("anything above the least still goes to the verifier, and so does 'No' to a spoken language", async () => {
      const years = ["3+ years", "1-2 years", "< 1 year"];
      const question = "How many years have you spent with CI/CD as a primary responsibility?";
      expectOnlyRule(await inspect(withAnswer(question, "1-2 years", { options: years })), CopRule.SCREENING_SANITY, "needs an answer from you");
      expectOnlyRule(
        await inspect(withAnswer("Do you have English proficiency?", "No", YES_NO)), CopRule.SCREENING_SANITY, "needs an answer from you",
      );
      // Consent given is a statement the data has to back.
      expectOnlyRule(
        await inspect(withAnswer("Do you consent to receive recruiting SMS messages?", "Yes", YES_NO)), CopRule.SCREENING_SANITY,
        "needs an answer from you",
      );
    });
  });

  describe("g. free text for an open question", () => {
    it("is prose: judged by the prose rules and never sent to the verifier", async () => {
      const model = verifier({ supported: false, confidence: 1 });
      const judged = makeInspector({ verifyAnswer: model.verifyAnswer });
      const fine = withAnswer("What interests you about this role?", "The eval-driven approach matches how I work.");
      expectPassed(await inspect(fine, { inspector: judged }));
      const fluffy = withAnswer("What interests you about this role?", "I am thrilled by 300k users.");
      const result = await inspect(fluffy, { inspector: judged });
      expectQuarantined(result, CopRule.FACT_GROUNDING, "300k");
      expectQuarantined(result, CopRule.TONE, "thrilled");
      expect(result.violations.every((v) => v.fixable)).toBe(true);
      expect(model.calls).toEqual([]);
    });
  });
});

// ---------- 3. Links ----------

describe("links", () => {
  it("checks verified links live", async () => {
    expectPassed(await inspect(makeDraft(job)));
    expect(checkedLinks).toEqual([REPO_URL]);
  });

  it("catches a link outside the fact bank and never fetches it", async () => {
    const draft = makeDraft(job, { pitch: "Python demo: https://github.com/someone-else/cool-agent" });
    expectOnlyRule(await inspect(draft), CopRule.LINK_VERIFICATION, "someone-else");
    expect(checkedLinks).toEqual([]);
  });

  it("catches a dead verified link", async () => {
    const dead = makeInspector({ linkChecker: async () => ({ ok: false, detail: "returned HTTP 404", title: "" }) });
    expectOnlyRule(await inspect(makeDraft(job), { inspector: dead }), CopRule.LINK_VERIFICATION, "HTTP 404");
  });

  it("catches a foreign email address", async () => {
    const draft = makeDraft(job, { pitch: "Reach me at someone.else@example.org about Python work." });
    expectOnlyRule(await inspect(draft), CopRule.LINK_VERIFICATION, "someone.else@example.org");
  });

  it("accepts the candidate's own email address", async () => {
    const draft = makeDraft(job, { pitch: "Reach me at candidate@example.com about Python work." });
    expectPassed(await inspect(draft));
  });
});

describe("HttpLinkChecker", () => {
  const API = "https://api.github.com/repos/test-candidate/agent-runtime";

  function checker(responses: Record<string, [status: number, body: string]>) {
    const fetched: string[] = [];
    const http = new HttpLinkChecker({
      fetch: async (url) => {
        fetched.push(url);
        if (!Object.hasOwn(responses, url)) throw new Error(`unexpected request: ${url}`);
        const [status, body] = responses[url];
        return { status, body };
      },
    });
    return { http, fetched };
  }

  const repoResponse = (fields: Record<string, unknown> = {}): Record<string, [number, string]> => ({
    [API]: [200, JSON.stringify({ full_name: "test-candidate/agent-runtime", private: false, size: 420, ...fields })],
  });

  it("passes a public, non-empty repository and caches it", async () => {
    const { http, fetched } = checker(repoResponse());
    expect((await http.check(REPO_URL)).ok).toBe(true);
    expect((await http.check(`${REPO_URL}/`)).ok).toBe(true);
    expect(fetched).toEqual([API]);
  });

  it("fails empty, private, missing and moved repositories", async () => {
    expect((await checker(repoResponse({ size: 0 })).http.check(REPO_URL)).detail).toContain("empty");
    expect((await checker(repoResponse({ private: true })).http.check(REPO_URL)).detail).toContain("private");
    const moved = checker(repoResponse({ full_name: "other/agent-runtime" }));
    expect((await moved.http.check(REPO_URL)).detail).toContain("moved");
    const missing = await checker({ [API]: [404, ""] }).http.check(REPO_URL);
    expect(missing.ok).toBe(false);
    expect(missing.detail).toContain("HTTP 404");
  });

  it("requires a GitHub profile to exist", async () => {
    const url = "https://github.com/test-candidate";
    const api = "https://api.github.com/users/test-candidate";
    const found = await checker({ [api]: [200, '{"login": "test-candidate"}'] }).http.check(url);
    expect(found).toEqual({ ok: true, detail: "GitHub profile exists", title: "test-candidate" });
    const missing = await checker({ [api]: [404, ""] }).http.check(url);
    expect(missing.ok).toBe(false);
    expect(missing.detail).toContain("HTTP 404");
  });

  it("requires a real page title", async () => {
    const url = "https://candidate.example.com";
    const page = (status: number, body: string) => checker({ [url]: [status, body] }).http.check(url);
    const ok = await page(200, "<html><title>Test Candidate | Engineer</title></html>");
    expect(ok.ok).toBe(true);
    expect(ok.title).toBe("Test Candidate | Engineer");
    expect(await page(200, "<html><title>404 Not Found</title></html>")).toMatchObject({
      ok: false, detail: "page title looks like an error page: '404 Not Found'",
    });
    expect(await page(200, "<html><body>no title</body></html>")).toMatchObject({ ok: false, detail: "page has no title" });
    expect(await page(500, "")).toMatchObject({ ok: false, detail: "returned HTTP 500" });
  });

  it("fails closed on an unreachable host and does not cache the failure", async () => {
    let attempts = 0;
    const http = new HttpLinkChecker({
      fetch: async () => {
        attempts += 1;
        throw new Error("name resolution failed");
      },
    });
    const status = await http.check("https://candidate.example.com");
    expect(status).toEqual({ ok: false, detail: "could not be reached (name resolution failed)", title: "" });
    expect((await http.check("https://candidate.example.com")).ok).toBe(false);
    expect(attempts).toBe(2);
  });

  it("fails closed on a response it cannot parse", async () => {
    expect((await checker({ [API]: [200, "<html>rate limited</html>"] }).http.check(REPO_URL)).ok).toBe(false);
    expect((await checker({ [API]: [200, "[]"] }).http.check(REPO_URL)).ok).toBe(false);
  });

  it("re-checks a link once its cached result expires", async () => {
    const fetched: string[] = [];
    const http = new HttpLinkChecker({
      ttlSeconds: 0,
      fetch: async (url) => {
        fetched.push(url);
        return { status: 200, body: "<title>Portfolio</title>" };
      },
    });
    await http.check("https://candidate.example.com");
    await http.check("https://candidate.example.com");
    expect(fetched).toHaveLength(2);
  });
});

describe("normalizeUrl", () => {
  it("ignores scheme, case, www, query, fragment and trailing punctuation", () => {
    const canonical = "github.com/test-candidate/agent-runtime";
    expect(normalizeUrl("https://GitHub.com/Test-Candidate/Agent-Runtime/")).toBe(canonical);
    expect(normalizeUrl("www.github.com/test-candidate/agent-runtime.")).toBe(canonical);
    expect(normalizeUrl("github.com/test-candidate/agent-runtime?tab=readme#top")).toBe(canonical);
    expect(normalizeUrl("https://user@Example.com:8080/A/")).toBe("user@example.com:8080/a");
  });

  it("never throws, and never matches a sound link, on a host it cannot parse", () => {
    for (const url of ["https://[::1", "https://a]b/c", "http://℀.com/x"]) {
      expect(normalizeUrl(url)).toBe(url);
    }
  });
});

// ---------- 4. Assets ----------

describe("asset integrity", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "reygent-cop-"));
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  function writePdf(data: Buffer, name = "resume.pdf"): string {
    const file = path.join(tmp, name);
    fs.writeFileSync(file, data);
    return file;
  }

  it.each([
    "Hi {{first_name}}, I build agent runtimes in Python.",
    "Hi [Hiring Manager], I build agent runtimes in Python.",
    "I build agent runtimes in Python for {% company %}.",
    "I build agent runtimes in Python. TODO add closing line.",
  ])("catches a template variable: %s", async (pitch) => {
    expectOnlyRule(await inspect(makeDraft(job, { pitch })), CopRule.ASSET_INTEGRITY, "template token");
  });

  it("catches a template variable in a CV bullet", async () => {
    const draft = makeDraft(job, { cvBullets: [bullet("Built {{project}} in LangGraph.", "ach_agents")] });
    expectOnlyRule(await inspect(draft), CopRule.ASSET_INTEGRITY, "{{project}}");
  });

  it("blocks dispatch while the candidate profile is incomplete", async () => {
    const result = await inspect(makeDraft(job), { profile: makeProfile({ name: "CHANGE_ME" }) });
    expectQuarantined(result, CopRule.ASSET_INTEGRITY, "placeholders");
  });

  it("catches an empty draft", async () => {
    const draft = makeDraft(job, { pitch: "", cvBullets: [], screeningAnswers: [] });
    expectOnlyRule(await inspect(draft), CopRule.ASSET_INTEGRITY, "no content");
  });

  it.each([false, true])("passes a sound resume PDF (compressed: %s)", async (compress) => {
    const file = writePdf(makePdf({ pages: 2, compress }));
    expect(inspectPdf(file)).toEqual([]);
    expectPassed(await inspect(makeDraft(job, { resumePdfPath: file })));
  });

  it("catches a missing resume file", async () => {
    const draft = makeDraft(job, { resumePdfPath: path.join(tmp, "nope.pdf") });
    const result = await inspect(draft);
    expectOnlyRule(result, CopRule.ASSET_INTEGRITY, "not found");
    expect(result.violations[0].field).toBe("resumePdf");
  });

  it("catches an undersized resume", async () => {
    const file = writePdf(makePdf({ padding: 100 }));
    expectOnlyRule(await inspect(makeDraft(job, { resumePdfPath: file })), CopRule.ASSET_INTEGRITY, "bytes");
  });

  it("catches a file that is not a PDF", () => {
    const html = writePdf(latin1(`<html>${"x".repeat(20_000)}</html>`));
    expect(inspectPdf(html)[0]).toContain("not a complete PDF");
    const truncated = writePdf(replaceBytes(makePdf(), "%%EOF", ""), "truncated.pdf");
    expect(inspectPdf(truncated)[0]).toContain("not a complete PDF");
  });

  it("catches a wrong page count", async () => {
    const file = writePdf(makePdf({ pages: 3 }));
    expectOnlyRule(await inspect(makeDraft(job, { resumePdfPath: file })), CopRule.ASSET_INTEGRITY, "3 pages");
  });

  it("catches overlapping text layers", async () => {
    const overlapping =
      "BT /F1 11 Tf 1 0 0 1 72 720 Tm (Senior Engineer) Tj ET\n" +
      "BT /F1 11 Tf 1 0 0 1 72 720 Tm (python aws kubernetes rust) Tj ET";
    let file = "";
    for (const compress of [false, true]) {
      file = writePdf(makePdf({ content: overlapping, compress }));
      expect(inspectPdf(file)[0], `compressed: ${compress}`).toContain("over other text");
    }
    const result = await inspect(makeDraft(job, { resumePdfPath: file }));
    expectOnlyRule(result, CopRule.ASSET_INTEGRITY, "over other text");
  });

  it("does not flag ordinary multi-line text as overlap", () => {
    const flowing =
      "q 1 0 0 1 0 0 cm BT /F1 11 Tf 14 TL 72 720 Td (Line one) Tj T* (Line two) Tj" +
      " ( continues) Tj 0 -14 Td [(Line) -20 (three)] TJ ET Q\n" +
      "BT /F1 11 Tf 1 0 0 1 72 600 Tm (Next block) Tj ET";
    expect(inspectPdf(writePdf(makePdf({ content: flowing })))).toEqual([]);
  });

  it("cannot verify an encrypted PDF", () => {
    const file = writePdf(replaceBytes(makePdf(), "/Root 1 0 R", "/Root 1 0 R /Encrypt 9 0 R"));
    expect(inspectPdf(file)[0]).toContain("encrypted");
  });

  // Outputs below were taken from the Python reference for the same bytes.
  it.each([
    ["an exact rounding tie goes to the even neighbour, so 72.25 and 72.21 coincide",
      "BT 1 0 0 1 72 72.25 Tm (a) Tj ET BT 1 0 0 1 72 72.21 Tm (b) Tj ET", 1],
    ["...and 72.25 and 72.34 do not", "BT 1 0 0 1 72 72.25 Tm (a) Tj ET BT 1 0 0 1 72 72.34 Tm (b) Tj ET", 0],
    ["a blank run does not count", "BT 1 0 0 1 72 720 Tm ( ) Tj ET BT 1 0 0 1 72 720 Tm (b) Tj ET", 0],
    ["the graphics matrix moves the origin",
      "q 1 0 0 1 10 10 cm BT 1 0 0 1 62 710 Tm (a) Tj ET Q BT 1 0 0 1 72 720 Tm (b) Tj ET", 1],
    ["byte 0xA0 is not whitespace", "BT 1 0 0 1 72 720 Tm (a) Tj\xa0ET BT 1 0 0 1 72 720 Tm (b) Tj ET", 1],
  ])("interprets text positions like the reference: %s", (_label, content, overlaps) => {
    const issues = inspectPdf(writePdf(makePdf({ content })));
    expect(issues).toEqual(overlaps ? [`resume PDF draws text over other text at ${overlaps} position(s)`] : []);
  });

  it("reports a content stream it cannot parse rather than waving it through", () => {
    const file = writePdf(makePdf({ content: "BT 1 0 0 1 72 Tm (a) Tj ET" }));
    expect(inspectPdf(file)).toEqual(["resume PDF text layout could not be parsed, so overlap cannot be ruled out"]);
  });
});

// ---------- 5. Commitments ----------

describe("commitments", () => {
  const pitch = (sentence: string): ApplicationDraft =>
    makeDraft(job, { pitch: `I build agent runtimes in Python. ${sentence}` });

  it.each([
    "I am happy to relocate for the right team.",
    "I can work on-site whenever needed.",
    "I can come in to the office weekly.",
    "A hybrid schedule works for me.",
  ])("catches a promise of on-site presence: %s", async (sentence) => {
    expectOnlyRule(await inspect(pitch(sentence)), CopRule.COMMITMENT_GUARD, "on-site presence");
  });

  it.each([
    "I work remotely from Cameroon and am not able to relocate.",
    "I can’t relocate, and I don’t do on-site work.",
    "This would be fully remote, with no on-site presence.",
    "I have built hybrid search before.",
  ])("accepts declining on-site work: %s", async (sentence) => {
    expectPassed(await inspect(pitch(sentence)));
  });

  it.each([
    ["I am available immediately.", "immediately"],
    ["I can start tomorrow.", "immediately"],
    ["My notice period is 1 week.", "1 week"],
  ])("catches unverified availability: %s", async (sentence, term) => {
    expectQuarantined(await inspect(pitch(sentence)), CopRule.COMMITMENT_GUARD, term);
  });

  it("allows the verified notice period to be stated", async () => {
    expectPassed(await inspect(pitch("I can start within 2 weeks.")));
    const immediate = makeProfile({ noticePeriod: "Immediately" });
    expectPassed(await inspect(pitch("I am available immediately."), { profile: immediate }));
  });

  it("fails any availability claim while the notice period is unset", async () => {
    const unset = makeProfile({ noticePeriod: "CHANGE_ME" });
    const result = await inspect(pitch("I am available immediately."), { profile: unset });
    expectQuarantined(result, CopRule.COMMITMENT_GUARD, "none on file");
  });
});

// ---------- 6. Rate floor ----------

describe("rate floor", () => {
  it("catches a quoted rate below the floor", async () => {
    const hourly = makeDraft(job, { quotedRateUsd: 35, quotedRatePeriod: "hour" });
    expectOnlyRule(await inspect(hourly), CopRule.RATE_FLOOR, "$40/hr floor");
    const monthly = makeDraft(job, { quotedRateUsd: 2000, quotedRatePeriod: "month" });
    expectOnlyRule(await inspect(monthly), CopRule.RATE_FLOOR, "$2,500/mo floor");
  });

  it("passes rates at the floor", async () => {
    expectPassed(await inspect(makeDraft(job, { quotedRateUsd: 40, quotedRatePeriod: "hour" })));
    expectPassed(await inspect(makeDraft(job, { quotedRateUsd: 2500, quotedRatePeriod: "month" })));
  });

  it.each([
    "Python work at $30/hr.", "Python work at $1,800 per month.", "Python work at $20k a year.",
  ])("checks a rate written into the text: %s", async (pitch) => {
    const draft = makeDraft(job, { pitch, quotedRateUsd: null });
    expectOnlyRule(await inspect(draft), CopRule.RATE_FLOOR, "floor");
  });

  it("catches a text rate that contradicts the quote", async () => {
    const draft = makeDraft(job, { pitch: "Python work at $75/hr.", quotedRateUsd: 60, quotedRatePeriod: "hour" });
    expectOnlyRule(await inspect(draft), CopRule.RATE_FLOOR, "contradicts");
  });

  it("checks a bare number answering a compensation question", async () => {
    const draft = makeDraft(job, {
      quotedRateUsd: null, screeningAnswers: [answer("What is your expected hourly rate (USD)?", "32")],
    });
    expectQuarantined(await inspect(draft), CopRule.RATE_FLOOR, "$40/hr floor");
  });

  it("catches a quote without a period", async () => {
    const draft = makeDraft(job, { quotedRateUsd: 60, quotedRatePeriod: "" });
    const result = await inspect(draft);
    expectOnlyRule(result, CopRule.RATE_FLOOR, "period");
    expect(result.violations[0].field).toBe("quotedRate");
  });

  // The reference prints amounts with Python's f"{amount:,.0f}", which rounds half to even.
  it.each([
    [32.5, "quoted rate $32/hour is below the $40/hr floor"],
    [33.5, "quoted rate $34/hour is below the $40/hr floor"],
  ])("words a shortfall like the reference: $%f", async (quotedRateUsd, message) => {
    const result = await inspect(makeDraft(job, { quotedRateUsd, quotedRatePeriod: "hour" }));
    expect(result.violations.map((v) => v.message)).toEqual([message]);
  });
});

// ---------- 7. Scam filter ----------

describe("scam filter", () => {
  function inspectJob(fields: Partial<JobInput>): Promise<InspectionResult> {
    const listing = makeJob({ sourceId: "scam", ...fields });
    repo.insertJob(listing);
    return inspect(makeDraft(listing), { job: listing });
  }

  it("catches a pay-to-work scheme", async () => {
    const result = await inspectJob({ description: "Python role. A $50 registration fee applies before onboarding." });
    expectOnlyRule(result, CopRule.SCAM_FILTER, "pay-to-work");
  });

  it("catches a recruiter on an anonymous chat app", async () => {
    const result = await inspectJob({
      description: "Python role. Contact our HR on Telegram to schedule an interview.",
    });
    expectOnlyRule(result, CopRule.SCAM_FILTER, "anonymous chat app");
  });

  it("catches a too-good-to-be-true offer", async () => {
    const result = await inspectJob({ description: "Python role. No experience required, earn up to $900 per day." });
    expectOnlyRule(result, CopRule.SCAM_FILTER, "too-good-to-be-true");
  });

  it.each([
    ["https://bit.ly/3xyzjob", "URL shortener"],
    ["http://boards.greenhouse.io/acme/jobs/1", "HTTPS"],
    ["https://203.0.113.9/apply", "raw IP"],
    ["https://xn--acm-9la.com/careers", "look-alike"],
    ["https://acme-robotics-careers.work/apply", "neither a known hiring platform"],
    // The reference crashes on these two (urlsplit raises); the port holds them instead.
    ["https://[boards.greenhouse.io/acme/jobs/1", "not a valid HTTPS URL"],
    ["https://greenhouse.io／jobs.evil.example/1", "not a valid HTTPS URL"],
  ])("catches an unverified apply domain: %s", async (applyUrl, fragment) => {
    // A listing from a thread or a job site, where anyone can write the link.
    expectOnlyRule(await inspectJob({ applyUrl, source: "hn" }), CopRule.SCAM_FILTER, fragment);
  });

  it.each([
    "https://jobs.ashbyhq.com/acme/1", "https://jobs.lever.co/acme/1", "https://careers.acme-robotics.com/roles/1", "",
  ])("passes known platforms and the company's own domain: '%s'", async (applyUrl) => {
    expectPassed(await inspectJob({ applyUrl }));
  });

  it("trusts the link a company's own board gives, even on a domain of the company's that the listing does not name", async () => {
    // Recruitee serves Tether's forms from careers.tether.io; the board itself said so.
    const custom = { applyUrl: "https://careers.acme-works.io/o/agent-engineer/c/new", companyDomain: "" };
    for (const source of ["recruitee", "workable", "greenhouse"]) expectPassed(await inspectJob({ ...custom, source }));
    // The same link in a job site's listing or a forum post is still unverified…
    for (const source of ["himalayas", "hn", "manual"]) {
      expectOnlyRule(await inspectJob({ ...custom, source }), CopRule.SCAM_FILTER, "neither a known hiring platform");
    }
    // …and even a board's link is refused when it is not a link one should follow at all.
    expectOnlyRule(await inspectJob({ applyUrl: "https://bit.ly/3xyzjob", source: "recruitee" }), CopRule.SCAM_FILTER, "URL shortener");
  });

  it.each([
    "https://himalayas.app/companies/acme/jobs/agent-engineer", "https://jobicy.com/jobs/1-agent-engineer",
    "https://www.workingnomads.com/job/go/1/", "https://www.realworkfromanywhere.com/jobs/agent-engineer-acme-1",
    "https://weworkremotely.com/remote-jobs/acme-agent-engineer", "https://remoteok.com/remote-jobs/1",
  ])("passes the page of a job site discovery reads: %s", async (applyUrl) => {
    expectPassed(await inspectJob({ applyUrl, source: "himalayas", companyDomain: "" }));
  });
});

// ---------- 8. De-duplication ----------

describe("de-duplication", () => {
  function dispatch(daysAgo: number, sent: { job?: JobOpportunity; draft?: Partial<ApplicationDraft> } = {}): void {
    const target = sent.job ?? job;
    const sender = makeInspector({ clock: () => new Date(NOW.getTime() - daysAgo * DAY_MS) });
    sender.recordDispatch(makeDraft(target, sent.draft), target);
  }

  it("blocks the same company within 30 days", async () => {
    dispatch(5);
    const result = await inspect(makeDraft(job));
    expectOnlyRule(result, CopRule.DEDUPLICATION, "2026-10-07");
    expect(result.violations[0].message).toBe(
      `Acme Robotics was already contacted on 2026-10-07 (job ${job.id}); next contact allowed from 2026-11-06`,
    );
  });

  it("blocks another role at the same company too", async () => {
    dispatch(29);
    const other = makeJob({
      sourceId: "456", title: "Staff Agent Engineer", company: "ACME Robotics, Inc.", companyDomain: "",
    });
    repo.insertJob(other);
    expectOnlyRule(await inspect(makeDraft(other), { job: other }), CopRule.DEDUPLICATION);
  });

  it("allows contact again after the window", async () => {
    dispatch(31);
    expectPassed(await inspect(makeDraft(job)));
  });

  it("blocks the same domain under another company name", async () => {
    dispatch(3);
    const alias = makeJob({ sourceId: "789", company: "Acme AI Labs", title: "ML Engineer" });
    repo.insertJob(alias);
    expectOnlyRule(await inspect(makeDraft(alias), { job: alias }), CopRule.DEDUPLICATION);
  });

  it("blocks the same person at a different company", async () => {
    const founder = { source: "x", companyDomain: "", applyUrl: "", channel: Channel.FOUNDER_DIRECT };
    const first = makeJob({ ...founder, sourceId: "f1", company: "Northwind" });
    const second = makeJob({ ...founder, sourceId: "f2", company: "Southwind", title: "Agent Engineer II" });
    repo.insertJob(first);
    repo.insertJob(second);
    dispatch(2, { job: first, draft: { contact: "Founder@gmail.com" } });
    const result = await inspect(makeDraft(second, { contact: "founder@gmail.com" }), { job: second });
    expectOnlyRule(result, CopRule.DEDUPLICATION);
  });

  it("does not link unrelated people through a shared free-mail domain", async () => {
    const first = makeJob({ source: "x", sourceId: "f1", company: "Northwind", companyDomain: "", applyUrl: "" });
    const second = makeJob({
      source: "x", sourceId: "f2", company: "Southwind", companyDomain: "", applyUrl: "", title: "Agent Engineer II",
    });
    repo.insertJob(first);
    repo.insertJob(second);
    dispatch(2, { job: first, draft: { contact: "alice@gmail.com" } });
    expectPassed(await inspect(makeDraft(second, { contact: "bob@gmail.com" }), { job: second }));
  });

  it("exposes the keys a dispatch is de-duplicated on", () => {
    const direct = makeJob({ company: "ACME Robotics, Inc.", companyDomain: "" });
    expect(dedupKeys(makeDraft(direct, { contact: " Founder@Startup.io " }), direct)).toEqual({
      companyKey: "acme robotics", domain: "startup.io", contact: "founder@startup.io",
    });
    const listed = makeJob({ companyDomain: "WWW.Acme-Robotics.com" });
    expect(dedupKeys(makeDraft(listed, { contact: "bob@gmail.com" }), listed)).toEqual({
      companyKey: "acme robotics", domain: "acme-robotics.com", contact: "bob@gmail.com",
    });
    const freeMail = makeJob({ companyDomain: "" });
    expect(dedupKeys(makeDraft(freeMail, { contact: "bob@gmail.com" }), freeMail).domain).toBe("");
  });
});

// ---------- 9. Tone ----------

describe("tone", () => {
  it.each([
    "I hope this email finds you well. I build agent runtimes in Python.",
    "I am thrilled to apply. I build agent runtimes in Python.",
    "I am a passionate, results-driven Python engineer.",
    "I leverage cutting-edge Python to build agents.",
    "Python agents!! Let's talk!",
  ])("catches sycophantic filler and AI clichés: %s", async (pitch) => {
    expectOnlyRule(await inspect(makeDraft(job, { pitch })), CopRule.TONE);
  });

  it("catches an overlong pitch", async () => {
    const pitch = Array(40).fill("I build agent runtimes in Python.").join(" ");
    expectOnlyRule(await inspect(makeDraft(job, { pitch })), CopRule.TONE, "words");
  });

  it("catches emoji", async () => {
    const pitch = "I build agent runtimes in Python \u{1F680}";
    expectOnlyRule(await inspect(makeDraft(job, { pitch })), CopRule.TONE, "emoji");
  });
});

// ---------- Auto-fix loop ----------

describe("auto-fix", () => {
  const FLUFFY = "I hope this email finds you well. I build agent runtimes in Python and LangGraph.";
  const CLEAN = "I build agent runtimes in Python and LangGraph.";

  it("rewrites a fixable flaw and greenlights the draft", async () => {
    const calls: Array<[text: string, critiques: string[]]> = [];
    const rewriter: Rewriter = (text, critiques) => {
      calls.push([text, critiques]);
      return text.replace("I hope this email finds you well. ", "");
    };
    const result = await inspect(makeDraft(job, { pitch: FLUFFY }), { inspector: makeInspector({ rewriter }) });
    expect(result.verdict).toBe(Verdict.GREENLIT);
    expect(result.retries).toBe(1);
    expect(result.draft.pitch).toBe(CLEAN);
    expect(calls).toHaveLength(1);
    expect(calls[0][0]).toBe(FLUFFY);
    expect(calls[0][1][0]).toContain("finds you");
    expect(repo.listQuarantined()).toEqual([]);
  });

  it("quarantines the draft after two failed rewrites", async () => {
    const calls: string[] = [];
    const stubborn = makeInspector({
      rewriter: (text) => {
        calls.push(text);
        return text;
      },
    });
    const result = await inspect(makeDraft(job, { pitch: FLUFFY }), { inspector: stubborn });
    expectOnlyRule(result, CopRule.TONE);
    expect(result.retries).toBe(2);
    expect(calls).toHaveLength(2);
    const items = repo.listQuarantined();
    expect(items).toHaveLength(1);
    expect(result.quarantineIds).toEqual([items[0].id]);
    expect(items[0].retryCount).toBe(2);
    expect(items[0].jobId).toBe(job.id);
    expect(items[0].violationRule).toBe(CopRule.TONE);
    expect(items[0].critique).toBe("[pitch] filler or cliché: 'i hope this email finds you'");
    expect(JSON.parse(items[0].originalContent).pitch).toBe(FLUFFY);
    expect(repo.getJob(job.id)?.stage).toBe(PipelineStage.QUARANTINED);
  });

  it("lets a second rewrite still succeed", async () => {
    const attempts = [FLUFFY, CLEAN];
    const result = await inspect(makeDraft(job, { pitch: FLUFFY }), {
      inspector: makeInspector({ rewriter: () => attempts.shift() ?? "" }),
    });
    expectPassed(result);
    expect(result.retries).toBe(2);
  });

  it("does not pass a rewrite that introduces a new violation", async () => {
    const careless = makeInspector({ rewriter: () => "I build agent runtimes in Python for 300k users." });
    const result = await inspect(makeDraft(job, { pitch: FLUFFY }), { inspector: careless });
    expectOnlyRule(result, CopRule.FACT_GROUNDING, "300k");
    expect(result.retries).toBe(2);
  });

  it("repairs an ungrounded metric with a rewrite", async () => {
    const draft = makeDraft(job, {
      cvBullets: [bullet("Built a LangGraph agent runtime, cutting workflow latency by 60%.", "ach_agents")],
    });
    const result = await inspect(draft, {
      inspector: makeInspector({ rewriter: (text) => text.replace("60%", "45%") }),
    });
    expectPassed(result);
    expect(result.draft.cvBullets[0].achievementId).toBe("ach_agents");
    expect(result.draft.cvBullets[0].text).toContain("45%");
  });

  it("sends fixable flaws straight to quarantine when there is no rewriter", async () => {
    const result = await inspect(makeDraft(job, { pitch: FLUFFY }));
    expectOnlyRule(result, CopRule.TONE);
    expect(result.retries).toBe(0);
  });

  it("does not spend a rewrite when a non-fixable flaw is present", async () => {
    const calls: string[] = [];
    const rewriting = makeInspector({
      rewriter: (text) => {
        calls.push(text);
        return text;
      },
    });
    const draft = makeDraft(job, { pitch: FLUFFY, quotedRateUsd: 20 });
    const result = await inspect(draft, { inspector: rewriting });
    expectQuarantined(result, CopRule.RATE_FLOOR);
    expectQuarantined(result, CopRule.TONE);
    expect(calls).toEqual([]);
    expect(repo.listQuarantined()).toHaveLength(2); // one row per violated rule
  });

  it.each<[string, Rewriter]>([
    ["is blank", () => "   "],
    ["throws", () => {
      throw new Error("provider unavailable");
    }],
    ["rejects", async () => {
      throw new TypeError("fetch failed");
    }],
  ])("leaves the text untouched when the rewrite %s", async (_label, rewriter) => {
    const result = await inspect(makeDraft(job, { pitch: FLUFFY }), { inspector: makeInspector({ rewriter }) });
    expect(result.verdict).toBe(Verdict.QUARANTINED);
    expect(result.draft.pitch).toBe(FLUFFY);
    expect(result.retries).toBe(2); // a failed rewrite is still a spent retry
  });

  it("lets the spend cap propagate out of auto-fix", async () => {
    const overBudget = makeInspector({
      rewriter: () => {
        throw new CircuitBreakerError(1.5, 1.5);
      },
    });
    await expect(inspect(makeDraft(job, { pitch: FLUFFY }), { inspector: overBudget })).rejects.toThrow(
      CircuitBreakerError,
    );
    expect(repo.listQuarantined()).toEqual([]);
  });

  it("does not mutate the caller's draft", async () => {
    const draft = makeDraft(job, { pitch: FLUFFY });
    const original = structuredClone(draft);
    const rewriting = makeInspector({ rewriter: () => "I build agent runtimes in Python." });
    const result = await inspect(draft, { inspector: rewriting });
    expectPassed(result);
    expect(draft).toEqual(original);
    expect(result.draft).not.toBe(draft);
    expect(result.draft.pitch).toBe("I build agent runtimes in Python.");
  });

  it("accepts an asynchronous rewriter", async () => {
    const result = await inspect(makeDraft(job, { pitch: FLUFFY }), {
      inspector: makeInspector({ rewriter: async () => `  ${CLEAN}\n` }),
    });
    expectPassed(result);
    expect(result.draft.pitch).toBe(CLEAN);
  });

  it("has the Fireworks rewriter send the critiques and verified facts only", async () => {
    const requests: Array<{ prompt: string; options: { taskType: string; system?: string } }> = [];
    const client = {
      generate: async (prompt: string, options: { taskType: string; system?: string }) => {
        requests.push({ prompt, options });
        return { text: CLEAN };
      },
    };
    const result = await inspect(makeDraft(job, { pitch: FLUFFY }), {
      inspector: makeInspector({ rewriter: fireworksRewriter(client, profile) }),
    });
    expectPassed(result);
    expect(result.retries).toBe(1);
    expect(requests).toHaveLength(1);
    const { prompt, options } = requests[0];
    expect(prompt).toContain("finds you");
    expect(prompt).toContain("Cut workflow latency by 45%");
    expect(prompt).not.toContain("300k"); // the unverified achievement is never offered as a fact
    expect(prompt).toBe(
      "Verified facts:\n" +
        "- Built a LangGraph agent runtime with checkpoint recovery: Cut workflow latency by 45% and raised eval" +
        " accuracy from 71% to 94% [Python, LangGraph, PostgreSQL]\n" +
        "- Shipped semantic search over 4M documents: Sub-80ms retrieval at p95 [Python, Qdrant, pgvector]\n\n" +
        "Problems to fix:\n- filler or cliché: 'i hope this email finds you'\n\n" +
        `Text:\n${FLUFFY}`,
    );
    expect(options.taskType).toBe("cop_autofix");
    expect(options.system).toContain("Never introduce a number, technology, employer, link, rate or availability");
  });
});

// ---------- Port fidelity ----------

// Python's \w, \d, \s and \b are Unicode-aware and JavaScript's are not. Each expectation
// here was produced by the Python reference for the same input.
describe("unicode text is read the way the reference reads it", () => {
  it("reads an accented employer name whole", async () => {
    const french = makeProfile({ employers: ["Crédit Agricole"] });
    const own = makeDraft(job, { pitch: "At Crédit Agricole I built agent runtimes in Python." });
    expectPassed(await inspect(own, { profile: french }));
    const other = makeDraft(job, { pitch: "At Crédit Suisse I built agent runtimes in Python." });
    const result = await inspect(other, { profile: french });
    expectOnlyRule(result, CopRule.FACT_GROUNDING);
    expect(result.violations.map((v) => v.message)).toEqual([
      "organisation 'Crédit Suisse' is not a verified employer or client",
    ]);
  });

  it("sees a metric written in full-width digits", async () => {
    const draft = makeDraft(job, { pitch: "I build agent runtimes in Python, ６０% faster." });
    const result = await inspect(draft);
    expectOnlyRule(result, CopRule.FACT_GROUNDING);
    expect(result.violations.map((v) => v.message)).toEqual([
      "figure '６０%' is not in the verified fact bank",
    ]);
  });

  it("reads a rate written in Arabic-Indic digits", async () => {
    const draft = makeDraft(job, { pitch: "Python work at $٣٠/hr.", quotedRateUsd: null });
    const result = await inspect(draft);
    expect(result.violations.map((v) => v.message)).toEqual(["rate in text $30/hour is below the $40/hr floor"]);
  });

  it("treats no-break and em spaces as whitespace", async () => {
    const draft = makeDraft(job, {
      pitch: "I build agent runtimes in Python. I can start in 3 weeks.",
    });
    const result = await inspect(draft);
    expect(result.violations.map((v) => [v.rule, v.message])).toEqual([
      [CopRule.FACT_GROUNDING, "figure '3' is not in the verified fact bank"],
      [CopRule.COMMITMENT_GUARD, "availability '3 week' is not backed by the verified notice period (2 weeks)"],
    ]);
  });
});

// ---------- A CV tuned to the listing ----------

describe("a tuned CV", () => {
  const GROUNDED_SUMMARY = "Agent engineer working in Python and LangGraph, who cut workflow latency by 45% at Initech.";
  const cvMatch = (problems: string[]) => ({ headline: "Senior Agent Engineer", asked: [], matched: [], missing: [], pages: 1, problems });

  it("holds a written CV summary to the verified bank, as it does the pitch", async () => {
    const result = await inspect(makeDraft(job, { cvSummary: GROUNDED_SUMMARY.replace("LangGraph", "Rust").replace("45%", "60%") }));
    expectOnlyRule(result, CopRule.FACT_GROUNDING);
    expect(result.violations.map((flaw) => [flaw.field, flaw.message, flaw.fixable])).toEqual([
      ["cvSummary", "figure '60%' is not in the verified fact bank", true],
      ["cvSummary", "technology 'rust' is not in the verified fact bank", true],
    ]);
  });

  it("passes a grounded summary, and a draft with none has nothing more to inspect", async () => {
    expectPassed(await inspect(makeDraft(job, { cvSummary: GROUNDED_SUMMARY })));
    expectPassed(await inspect(makeDraft(job, { cvSummary: "   " })));
    expectPassed(await inspect(makeDraft(job)));
  });

  it("reads the summary for tone and commitments too", async () => {
    const result = await inspect(makeDraft(job, { cvSummary: `Passionate ${GROUNDED_SUMMARY} Happy to relocate.` }));
    expect(result.violations.map((flaw) => [flaw.rule, flaw.field])).toEqual([
      [CopRule.COMMITMENT_GUARD, "cvSummary"], [CopRule.TONE, "cvSummary"],
    ]);
  });

  it("repairs a flawed summary in place with a rewrite", async () => {
    const rewriter: Rewriter = (text, critiques) => {
      expect(critiques).toEqual(["figure '60%' is not in the verified fact bank"]);
      return text.replace("60%", "45%");
    };
    const result = await inspect(makeDraft(job, { cvSummary: GROUNDED_SUMMARY.replace("45%", "60%") }), { inspector: makeInspector({ rewriter }) });
    expectPassed(result);
    expect(result.retries).toBe(1);
    expect(result.draft.cvSummary).toBe(GROUNDED_SUMMARY);
  });

  it("holds a draft whose tuned CV did not read back whole, without spending a rewrite on it", async () => {
    const rewriter: Rewriter = () => {
      throw new Error("no rewrite can repair a file");
    };
    const draft = makeDraft(job, { cvMatch: cvMatch(["Keywords: not read back: LangGraph", "Characters: 1 glyph a search cannot match (U+FB02)"]) });
    const result = await inspect(draft, { inspector: makeInspector({ rewriter }) });
    expectOnlyRule(result, CopRule.ASSET_INTEGRITY, "the tuned CV does not read back whole: Keywords: not read back: LangGraph");
    expect(result.violations.map((flaw) => [flaw.field, flaw.fixable])).toEqual([["resumePdf", false], ["resumePdf", false]]);
    expect(result.retries).toBe(0);
    // One that read back whole is no obstacle.
    const other = makeJob({ sourceId: "124", company: "Beta Robotics" });
    repo.insertJob(other);
    expectPassed(await inspect(makeDraft(other, { cvMatch: cvMatch([]) }), { job: other }));
  });

  it("answers for one piece of text, before any draft exists", () => {
    const line = "Built a LangGraph agent runtime, cutting workflow latency by 45%.";
    // A CV line is held to its own achievement; other text to the whole bank.
    expect(groundingProblems(line, job, profile, { achievementId: "ach_agents" })).toEqual([]);
    expect(groundingProblems(line.replace("LangGraph", "Qdrant"), job, profile, { achievementId: "ach_agents" })).toEqual([
      "technology 'qdrant' is not in verified achievement 'ach_agents'",
    ]);
    expect(groundingProblems(line.replace("LangGraph", "Qdrant"), job, profile)).toEqual([]);
    expect(groundingProblems(line, job, profile, { achievementId: "ach_unverified" })).toEqual([
      "cites achievement 'ach_unverified', which is not in the verified bank",
    ]);
    expect(groundingProblems("Sent 12 invoices.", job, profile)).toEqual(["figure '12' is not in the verified fact bank"]);
    expect(groundingProblems("Sent 12 invoices.", job, profile, { extraFacts: "I sent 12 invoices last year." })).toEqual([]);

    expect(toneProblems(line)).toEqual([]);
    expect(toneProblems("Passionate about seamless delivery!! \u{1F680}")).toEqual([
      "filler or cliché: 'passionate'", "filler or cliché: 'seamless'", "more than one exclamation mark", "contains emoji",
    ]);
  });
});
