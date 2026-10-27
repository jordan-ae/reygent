import { describe, expect, test } from "vitest";

import { CircuitBreakerError } from "@/core/llm/ledger";
import type { Decider, DecisionLike } from "@/core/llm/types";
import {
  type Achievement,
  type CandidateProfile,
  type JobInput,
  type JobOpportunity,
  type PositioningProfile,
  createJob,
} from "@/core/models";
import { ProfileManager } from "@/core/profile/manager";
import { scoreFit } from "@/core/qualification/scorer";

// ---------- Fixtures ----------

const positioning = (id: string, title: string, coreSkills: string[]): PositioningProfile => ({
  id, title, coreSkills, targetSummary: "", pitchAngle: "", highlightedAchievements: [],
});

const achievement = (fields: Partial<Achievement> & Pick<Achievement, "id" | "verified">): Achievement => ({
  category: "", headline: "", impactMetric: "", technologies: [], context: "", employer: "", evidenceUrl: "",
  positioning: [], ...fields,
});

const VERIFIED = achievement({
  id: "ach_agents", verified: true,
  headline: "Built an agent platform used by 40 internal teams",
  impactMetric: "cut manual triage time by 62%",
  technologies: ["Python", "LangGraph", "Tool Calling"],
});
const UNVERIFIED = achievement({
  id: "ach_billing", verified: false,
  headline: "Rewrote the billing core in Rust",
  impactMetric: "reduced p99 latency by 83%",
  technologies: ["Rust", "Kafka"],
});

function candidate(overrides: Partial<CandidateProfile> = {}): CandidateProfile {
  return {
    id: "default", name: "Test Candidate", email: "test@example.com", phone: "", location: "Cameroon (UTC+1)",
    timezone: "Africa/Douala", workAuthorization: "", noticePeriod: "", githubUrl: "", linkedinUrl: "",
    portfolioUrl: "", yearsExperience: 8, employers: [],
    // What the candidate vouches for. The positioning profiles below repeat some of these
    // as core skills, but a core skill alone counts for nothing (see the test for that).
    skills: [
      "Docker", "Kubernetes", "Node.js", "TypeScript", "Next.js", "PostgreSQL", "MCP", "RAG", "pgvector", "React",
      "Design Systems",
    ],
    achievements: [VERIFIED, UNVERIFIED],
    positioning: {
      ai_platform_agent: positioning("ai_platform_agent", "AI Platform / Agent Engineer", ["LangGraph", "MCP"]),
      fullstack_product: positioning("fullstack_product", "Senior Full-Stack Product Engineer", [
        "TypeScript", "Next.js", "Python", "PostgreSQL",
      ]),
      applied_ai_llm: positioning("applied_ai_llm", "Applied AI / LLM Engineer", ["RAG", "pgvector"]),
      frontend_systems: positioning("frontend_systems", "Frontend Systems Engineer", ["React", "Design Systems"]),
    },
    ...overrides,
  };
}

/** A candidate whose only verified technologies are `skills`. */
const candidateWith = (...skills: string[]): CandidateProfile =>
  candidate({ skills, achievements: [], positioning: {} });

const listing = (fields: Partial<JobInput> = {}): JobOpportunity =>
  createJob({ source: "test", sourceId: "1", company: "Acme", title: "Software Engineer", ...fields });

const sorted = (items: string[]): string[] => [...items].sort();

interface ScoreCall {
  state: unknown;
  instructions: string;
  levels: string[];
  taskType: string;
}

/** A Decider whose score answer (or failure) is produced by `answer`. */
function scoreDecider(answer: () => DecisionLike | Promise<DecisionLike>): { decider: Decider; calls: ScoreCall[] } {
  const calls: ScoreCall[] = [];
  const decider: Decider = {
    decideBool: async () => {
      throw new Error("the scorer must not ask a yes/no question");
    },
    decideEnum: async () => {
      throw new Error("the scorer must not ask a choice question");
    },
    decideScore: async (state, instructions, levels, taskType) => {
      calls.push({ state, instructions, levels, taskType });
      return answer();
    },
  };
  return { decider, calls };
}

const level = (value: DecisionLike["value"]): DecisionLike => ({ value, confidence: 0.9, probabilities: {} });

const STRONG = listing({
  title: "Senior Full-Stack Engineer",
  description: "Own features end to end across our TypeScript, Next.js and PostgreSQL stack.",
  skills: ["TypeScript", "Next.js", "PostgreSQL"],
});
const PARTIAL = listing({
  title: "Backend Engineer",
  description: "Build Django services on AWS.",
  skills: ["Python", "Django", "AWS", "PostgreSQL"],
});
const UNRELATED = listing({
  title: "Sales Associate",
  description: "Close inbound deals and manage the pipeline in Salesforce.",
  skills: ["Salesforce", "Cold calling"],
});

// ---------- Tests ----------

describe("positioning", () => {
  test("leads with the profile ProfileManager selects for the listing", async () => {
    const job = listing({ title: "Frontend Engineer", description: "React, design system and web performance work." });
    const fit = await scoreFit(job, candidate());
    expect(fit.jobId).toBe(job.id);
    expect(fit.bestPositioningProfile).toBe(ProfileManager.selectPositioning(job));
    expect(fit.bestPositioningProfile).toBe("frontend_systems");
  });
});

describe("matched and missing skills", () => {
  test("verified technologies are found in the structured skills, the title and the description", async () => {
    const job = listing({
      title: "Senior TypeScript Engineer",
      description: "<p>You will build agents with <strong>LangGraph</strong> and ship them on DOCKER.</p>",
      skills: ["python", "Terraform"],
    });
    const fit = await scoreFit(job, candidate());
    // In the candidate's own spelling, whatever the listing wrote.
    expect(sorted(fit.matchedSkills)).toEqual(["Docker", "LangGraph", "Python", "TypeScript"]);
    expect(fit.missingSkills).toEqual(["Terraform"]);
  });

  test("a positioning profile's core skills are a template, not skills the candidate has", async () => {
    // Only Docker is the candidate's own; the positioning profiles still list TypeScript, MCP, RAG and the rest.
    const profile = candidate({ skills: ["Docker"], achievements: [] });
    const job = listing({ description: "TypeScript, Next.js, PostgreSQL, MCP, RAG and Docker.", skills: ["TypeScript", "MCP", "Docker"] });
    const fit = await scoreFit(job, profile);
    expect(fit.matchedSkills).toEqual(["Docker"]);
    expect(sorted(fit.missingSkills)).toEqual(["MCP", "TypeScript"]);
  });

  test("a skill only counts as a whole word", async () => {
    const job = listing({
      title: "Platform Engineer",
      description: "We write JavaScript and run reactive pipelines on object storage with Reactor.",
    });
    const fit = await scoreFit(job, candidateWith("Java", "Script", "RAG", "React", "Reactor Core"));
    expect(fit.matchedSkills).toEqual([]);
  });

  test("C is not found in C++ or C#, and a single plus is only a separator", async () => {
    expect((await scoreFit(listing({ description: "C++ and C# services" }), candidateWith("C"))).matchedSkills).toEqual([]);
    expect((await scoreFit(listing({ description: "Modern C++, daily." }), candidateWith("C++", "C#"))).matchedSkills).toEqual(["C++"]);
    const stack = await scoreFit(listing({ description: "Stack: React+TypeScript/Python." }), candidateWith("React", "TypeScript", "Python"));
    expect(sorted(stack.matchedSkills)).toEqual(["Python", "React", "TypeScript"]);
  });

  test.each([
    ["PostgreSQL", "Postgres"],
    ["Postgres", "PostgreSQL"],
    ["Next.js", "NextJS"],
    ["nextjs", "Next.js"],
    ["Node.js", "nodejs"],
    ["NodeJS", "Node.js"],
    ["Kubernetes", "k8s"],
    ["K8s", "Kubernetes"],
  ])("the candidate's %s matches a listing that says %s", async (own, theirs) => {
    const profile = candidateWith(own);
    const structured = await scoreFit(listing({ skills: [theirs] }), profile);
    expect(structured.matchedSkills).toEqual([own]);
    expect(structured.missingSkills).toEqual([]);

    const prose = await scoreFit(listing({ description: `Three years of ${theirs} in production.` }), profile);
    expect(prose.matchedSkills).toEqual([own]);
  });

  test("a phrase matches whether the listing hyphenates it or not", async () => {
    const profile = candidateWith("Tool Calling");
    expect((await scoreFit(listing({ description: "Design tool-calling agents." }), profile)).matchedSkills).toEqual(["Tool Calling"]);
    const structured = await scoreFit(listing({ skills: ["tool-calling"] }), profile);
    expect(structured.matchedSkills).toEqual(["Tool Calling"]);
    expect(structured.missingSkills).toEqual([]);
  });

  test("the same technology under two spellings is reported once, first spelling first", async () => {
    const profile = candidate({ skills: ["Postgres", "postgresql", "TYPESCRIPT"] });
    const fit = await scoreFit(listing({ description: "PostgreSQL and TypeScript.", skills: ["PostgreSQL"] }), profile);
    expect(sorted(fit.matchedSkills)).toEqual(["Postgres", "TYPESCRIPT"]);
  });

  test("missing skills are the structured skills the candidate cannot verify, de-duplicated", async () => {
    const job = listing({ skills: ["TypeScript", "Rust", "rust", " Kafka ", "Go", ""] });
    const fit = await scoreFit(job, candidate());
    // Rust and Kafka appear only on an unverified achievement, so they are not verified.
    expect(fit.missingSkills).toEqual(["Rust", "Kafka", "Go"]);
    expect(fit.matchedSkills).toEqual(["TypeScript"]);
  });

  test("a listing without structured skills has no missing skills", async () => {
    const fit = await scoreFit(listing({ description: "Rust, Kafka and Terraform are required." }), candidate());
    expect(fit.missingSkills).toEqual([]);
    expect(fit.matchedSkills).toEqual([]);
  });

  test("the job and the profile are not modified", async () => {
    const job = listing({ skills: ["python", " Rust "] });
    const profile = candidate();
    const before = structuredClone({ job, profile });
    await scoreFit(job, profile);
    expect({ job, profile }).toEqual(before);
  });
});

describe("decider score", () => {
  interface FitState {
    role: { title: string; company: string; description: string; skills: string[] };
    candidate: { positioning: string; verifiedSkills: string[]; achievements: Array<{ headline: string; impactMetric: string }> };
  }

  test("asks one fit_score question on a five-level scale", async () => {
    const { decider, calls } = scoreDecider(() => level(3));
    const fit = await scoreFit(STRONG, candidate(), decider);
    expect(fit.fitScore).toBe(75);
    expect(calls).toHaveLength(1);
    expect(calls[0].taskType).toBe("fit_score");
    expect(calls[0].levels).toHaveLength(5);
    expect(calls[0].levels[0]).toMatch(/^No fit/);
    expect(calls[0].levels[4]).toMatch(/^Exact fit/);
    expect(calls[0].instructions).not.toBe("");
  });

  test("the state describes the role and the candidate's verified facts", async () => {
    const { decider, calls } = scoreDecider(() => level(4));
    const profile = candidate();
    const fit = await scoreFit(STRONG, profile, decider);
    const state = calls[0].state as FitState;

    expect(state.role).toEqual({
      title: STRONG.title, company: "Acme", description: STRONG.description, skills: STRONG.skills,
    });
    expect(state.candidate.positioning).toBe(profile.positioning[fit.bestPositioningProfile].title);
    expect(state.candidate.verifiedSkills).toEqual(
      expect.arrayContaining(["Docker", "TypeScript", "RAG", "LangGraph", "Tool Calling"]),
    );
    expect(state.candidate.achievements).toEqual([
      { headline: VERIFIED.headline, impactMetric: VERIFIED.impactMetric },
    ]);
  });

  test("the state never carries an unverified achievement or a technology known only from one", async () => {
    const { decider, calls } = scoreDecider(() => level(2));
    await scoreFit(STRONG, candidate(), decider);
    const sent = JSON.stringify(calls[0].state);
    for (const leaked of [UNVERIFIED.headline, UNVERIFIED.impactMetric, "Rust", "Kafka", "83%", UNVERIFIED.id]) {
      expect(sent).not.toContain(leaked);
    }
    expect(sent).toContain(VERIFIED.headline);
  });

  test("the description is cleaned and capped at about 1,500 characters", async () => {
    const description = `<p>${"Build &amp; ship reliable services. ".repeat(200)}</p>TAILMARKER`;
    const { decider, calls } = scoreDecider(() => level(2));
    await scoreFit(listing({ description }), candidate(), decider);
    const sent = (calls[0].state as FitState).role.description;
    expect(sent.length).toBeLessThanOrEqual(1500);
    expect(sent.length).toBeGreaterThan(1400);
    expect(sent.startsWith("Build & ship reliable services.")).toBe(true);
    expect(sent).not.toContain("TAILMARKER");
    expect(sent).not.toContain("<p>");
  });

  test.each([
    [0, 0], [1, 25], [2, 50], [3, 75], [4, 100],
    [2.6, 65], [3.33, 83], [0.07, 2],
    // Off the scale: clamped, never above 100 or below 0.
    [-1, 0], [-0.2, 0], [4.4, 100], [9, 100],
  ])("level %d becomes a fit score of %d", async (value, expected) => {
    const { decider } = scoreDecider(() => level(value));
    const fit = await scoreFit(STRONG, candidate(), decider);
    expect(fit.fitScore).toBe(expected);
  });

  test("the decider's score replaces the fallback but not the skill analysis", async () => {
    const { decider } = scoreDecider(() => level(0));
    const judged = await scoreFit(STRONG, candidate(), decider);
    const fallback = await scoreFit(STRONG, candidate());
    expect(judged.fitScore).toBe(0);
    expect(fallback.fitScore).toBeGreaterThan(0);
    expect({ ...judged, fitScore: fallback.fitScore }).toEqual(fallback);
  });
});

describe("deterministic fallback", () => {
  const score = async (job: JobOpportunity, profile = candidate(), decider?: Decider | null) =>
    (await scoreFit(job, profile, decider)).fitScore;

  test("strong overlap beats partial overlap, which beats an unrelated role", async () => {
    const [strong, partial, unrelated] = [await score(STRONG), await score(PARTIAL), await score(UNRELATED)];
    expect(strong).toBeGreaterThan(partial);
    expect(partial).toBeGreaterThan(unrelated);
    expect(strong).toBe(100);
    expect(partial).toBe(50); // 0.7 x 2/4 skills + 0.3 x 1/2 title words
    expect(unrelated).toBe(0);
  });

  test("an unrelated role stays low even when its text happens to name a skill", async () => {
    const job = listing({ title: "Sales Associate", description: "Demo our Python SDK to prospects." });
    expect(await score(job)).toBeLessThan(25);
  });

  test("rises with every further structured skill the candidate can verify", async () => {
    const skills = ["Elixir", "Phoenix", "Erlang", "Ecto"];
    const job = listing({ title: "Backend Engineer", skills });
    const scores: number[] = [];
    for (let known = 0; known <= skills.length; known += 1) {
      scores.push(await score(job, candidateWith(...skills.slice(0, known))));
    }
    for (let i = 1; i < scores.length; i += 1) expect(scores[i]).toBeGreaterThan(scores[i - 1]);
  });

  test("without structured skills, rises with each technology named in the text and then saturates", async () => {
    const named = ["TypeScript", "Python", "PostgreSQL", "Docker", "React", "Kubernetes"];
    const scores: number[] = [];
    for (let count = 0; count <= named.length; count += 1) {
      scores.push(await score(listing({ description: `We use ${named.slice(0, count).join(", ")}.` })));
    }
    for (let i = 1; i <= 4; i += 1) expect(scores[i]).toBeGreaterThan(scores[i - 1]);
    for (let i = 5; i < scores.length; i += 1) expect(scores[i]).toBe(scores[4]);
  });

  test("a closer title scores higher on the same skills", async () => {
    const skills = ["TypeScript", "Go"];
    const fullStack = await score(listing({ title: "Senior Full-Stack Engineer", skills }));
    const generic = await score(listing({ title: "Software Engineer", skills }));
    const other = await score(listing({ title: "Office Manager", skills }));
    expect(fullStack).toBeGreaterThan(generic);
    expect(generic).toBeGreaterThan(other);
    expect(await score(listing({ title: "Full-Stack Developer", skills }))).toBe(fullStack);
  });

  test("seniority words alone are not title alignment", async () => {
    expect(await score(listing({ title: "Senior Sales Associate" }))).toBe(0);
    expect(await score(listing({ title: "Lead Product Engineer" }))).toBeGreaterThan(0);
  });

  test("is a whole number between 0 and 100", async () => {
    const thirds = listing({ title: "Data Engineer", skills: ["Python", "Spark", "Airflow"] });
    for (const job of [STRONG, PARTIAL, UNRELATED, thirds, listing({ title: "", description: "" })]) {
      const value = await score(job);
      expect(Number.isInteger(value)).toBe(true);
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThanOrEqual(100);
    }
    expect(await score(STRONG, candidateWith())).toBe(0); // a candidate with nothing verified
  });

  test("is used when the decider is null or omitted", async () => {
    expect(await score(PARTIAL, candidate(), null)).toBe(50);
    expect(await score(PARTIAL, candidate(), undefined)).toBe(50);
  });
});

describe("decider failures", () => {
  test.each<[string, () => DecisionLike | Promise<DecisionLike>]>([
    ["an HTTP error", () => { throw new Error("HTTP 503: overloaded"); }],
    ["a timeout", () => Promise.reject(new DOMException("The operation timed out", "TimeoutError"))],
    ["a non-numeric answer", () => level("strong")],
    ["a boolean answer", () => level(true)],
    ["a NaN score", () => level(Number.NaN)],
    ["an infinite score", () => level(Number.POSITIVE_INFINITY)],
    ["no decision at all", () => undefined as unknown as DecisionLike],
  ])("%s falls back to the deterministic score", async (_name, answer) => {
    const { decider, calls } = scoreDecider(answer);
    const fit = await scoreFit(PARTIAL, candidate(), decider);
    expect(calls).toHaveLength(1);
    expect(fit).toEqual(await scoreFit(PARTIAL, candidate()));
    expect(fit.fitScore).toBe(50);
  });

  test("the spend cap is not swallowed", async () => {
    const { decider } = scoreDecider(() => { throw new CircuitBreakerError(1.5, 1.5); });
    await expect(scoreFit(STRONG, candidate(), decider)).rejects.toBeInstanceOf(CircuitBreakerError);
  });
});
