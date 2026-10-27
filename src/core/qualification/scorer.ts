/**
 * Fit scorer and gap analyser.
 *
 * Matched and missing skills are always worked out deterministically (Tier 0) from the
 * verified fact bank. The 0–100 score is Jev's judgement when a decider is available and
 * a skills-and-title heuristic otherwise, so the pipeline keeps moving at $0.
 */

import { CircuitBreakerError } from "@/core/llm/ledger";
import type { Decider, DecisionLike } from "@/core/llm/types";
import {
  type CandidateProfile,
  type FitEvaluation,
  type JobOpportunity,
  verifiedAchievements,
  verifiedTechnologies,
} from "@/core/models";
import { ProfileManager } from "@/core/profile/manager";
import { cleanText } from "@/core/text";

const FIT_TASK_TYPE = "fit_score";

const FIT_INSTRUCTIONS =
  "Rate how well the candidate fits this role. Judge only from the verified skills and achievements" +
  " listed in the state; do not assume experience that is not there.";

/** The ordered scale Jev rates on. Its answer is a position on it: 0 is the first level, 4 the last. */
const FIT_LEVELS = [
  "No fit: a different profession, or none of the candidate's verified skills are relevant",
  "Weak fit: an adjacent role that mostly needs skills the candidate has not verified",
  "Partial fit: the candidate covers some core requirements but lacks others the role depends on",
  "Strong fit: the candidate covers most core requirements; the gaps are minor",
  "Exact fit: the core requirements match the candidate's verified skills and achievements",
];

/** Requirements come first in a listing; past this point it is mostly benefits and boilerplate. */
const DESCRIPTION_EXCERPT_CHARS = 1500;

// ---------- Skill matching ----------

/**
 * Spellings that name the same technology; the first of each group is its key.
 * Kept to spellings that cannot mean anything else: "go" for Golang or "ts" for
 * TypeScript would match ordinary words (and "TS/SCI") in listing prose.
 */
const ALIAS_GROUPS: ReadonlyArray<readonly string[]> = [
  ["postgresql", "postgres"],
  ["next.js", "nextjs", "next js"],
  ["node.js", "nodejs", "node js"],
  ["kubernetes", "k8s"],
  ["react", "react.js", "reactjs", "react js"],
  ["vue", "vue.js", "vuejs", "vue js"],
];
const KEY_OF_ALIAS = new Map(
  ALIAS_GROUPS.flatMap((group) => group.map((alias): [string, string] => [alias, group[0]])),
);
const SPELLINGS_OF_KEY = new Map(ALIAS_GROUPS.map((group): [string, readonly string[]] => [group[0], group]));

/** Identity of a skill name: case, spacing, hyphenation and known aliases do not matter. */
function skillKey(name: string): string {
  const folded = name.toLowerCase().replace(/[\s_-]+/g, " ").trim();
  return KEY_OF_ALIAS.get(folded) ?? folded;
}

/**
 * Matches `spelling` as a whole term, with its words separated by spaces or hyphens.
 * "java" is not found in "javascript", nor "c" in "c++" or "c#".
 */
function termPattern(spelling: string): RegExp {
  const body = spelling
    .split(" ")
    .map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("[\\s_-]+");
  return new RegExp(`(?<![a-z0-9])${body}(?![a-z0-9#]|\\+\\+)`, "i");
}

interface SkillGap {
  /** Verified technologies the listing asks for, in the candidate's own spelling. */
  matched: string[];
  /** Structured listing skills the candidate cannot verify, in the listing's spelling. */
  missing: string[];
  /** How many distinct skills the listing's structured list names. */
  listed: number;
}

function analyseSkills(job: JobOpportunity, profile: CandidateProfile): SkillGap {
  const listed = new Map<string, string>(); // key -> the listing's spelling
  for (const skill of job.skills) {
    const key = skillKey(skill);
    if (key && !listed.has(key)) listed.set(key, skill.trim());
  }
  const text = cleanText(`${job.title}\n${job.description}`);

  const verified = new Set<string>();
  const matched: string[] = [];
  for (const technology of verifiedTechnologies(profile)) {
    const key = skillKey(technology);
    // The fact bank can hold "Postgres" and "PostgreSQL"; the first spelling speaks for both.
    if (!key || verified.has(key)) continue;
    verified.add(key);
    const spellings = SPELLINGS_OF_KEY.get(key) ?? [key];
    if (listed.has(key) || spellings.some((spelling) => termPattern(spelling).test(text))) {
      matched.push(technology.trim());
    }
  }
  const missing = [...listed].filter(([key]) => !verified.has(key)).map(([, spelling]) => spelling);
  return { matched, missing, listed: listed.size };
}

// ---------- Deterministic fallback ----------

const SKILL_WEIGHT = 0.7;
const TITLE_WEIGHT = 0.3;
/** With no structured skill list, this many verified technologies named in the text is full coverage. */
const FULL_COVERAGE_MENTIONS = 4;
/** Title words shared with a positioning title that count as full alignment ("frontend engineer"). */
const FULL_ALIGNMENT_WORDS = 2;

/** Title words that say nothing about the kind of work, so sharing them is not alignment. */
const TITLE_FILLER = new Set([
  "senior", "sr", "staff", "principal", "lead", "junior", "jr", "mid", "level",
  "a", "an", "and", "at", "for", "in", "of", "or", "the", "to", "with",
]);

function titleWords(title: string): Set<string> {
  const words = cleanText(title).toLowerCase().split(/[^a-z0-9]+/);
  return new Set(
    // Listings say "developer" where the positioning titles say "engineer": the same role.
    words.map((word) => (word === "developer" ? "engineer" : word)).filter((word) => word && !TITLE_FILLER.has(word)),
  );
}

/** 0–1: how many words the job title shares with the closest of the candidate's positioning titles. */
function titleAlignment(job: JobOpportunity, profile: CandidateProfile): number {
  const wanted = titleWords(job.title);
  let mostShared = 0;
  for (const positioning of Object.values(profile.positioning)) {
    const offered = titleWords(positioning.title);
    mostShared = Math.max(mostShared, [...wanted].filter((word) => offered.has(word)).length);
  }
  return Math.min(mostShared, FULL_ALIGNMENT_WORDS) / FULL_ALIGNMENT_WORDS;
}

/**
 * The $0 score: 70% skill coverage + 30% title alignment, as a whole number 0–100.
 *
 * Coverage is the share of the listing's structured skills the candidate can verify. A
 * listing with no structured skills is judged on its text instead: each verified
 * technology it names adds a quarter, reaching full coverage at four. Alignment is the
 * number of words the job title shares with the closest positioning title, full at two.
 * Neither part can fall as overlap grows, and a role that shares no skill and no title
 * word ("Sales Associate") scores 0.
 */
function fallbackScore(job: JobOpportunity, profile: CandidateProfile, gap: SkillGap): number {
  const coverage =
    gap.listed > 0
      ? (gap.listed - gap.missing.length) / gap.listed
      : Math.min(gap.matched.length, FULL_COVERAGE_MENTIONS) / FULL_COVERAGE_MENTIONS;
  return Math.round(100 * (SKILL_WEIGHT * coverage + TITLE_WEIGHT * titleAlignment(job, profile)));
}

// ---------- Decider ----------

function excerpt(text: string, limit: number): string {
  if (text.length <= limit) return text;
  const lastSpace = text.lastIndexOf(" ", limit);
  return text.slice(0, lastSpace > 0 ? lastSpace : limit);
}

/**
 * What Jev judges. Only verified facts go in: an unverified achievement (or a technology
 * known only from one) must not earn a score the drafts could never back up.
 */
function fitState(job: JobOpportunity, profile: CandidateProfile, positioningId: string): unknown {
  return {
    role: {
      title: job.title,
      company: job.company,
      description: excerpt(cleanText(job.description), DESCRIPTION_EXCERPT_CHARS),
      skills: job.skills,
    },
    candidate: {
      positioning: profile.positioning[positioningId]?.title ?? positioningId,
      verifiedSkills: [...verifiedTechnologies(profile)],
      achievements: verifiedAchievements(profile).map(({ headline, impactMetric }) => ({ headline, impactMetric })),
    },
  };
}

/** Jev's position on the scale as 0–100, or null when the answer is not a usable number. */
function judgedScore(decision: DecisionLike): number | null {
  const { value } = decision;
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  const score = Math.round((value / (FIT_LEVELS.length - 1)) * 100);
  return Math.min(100, Math.max(0, score));
}

/**
 * Score how well the candidate fits `job` (0–100) and name the positioning profile to lead with.
 *
 * With a `decider` the score is Jev's calibrated judgement. Without one — or when the
 * call fails (HTTP error, timeout, unusable answer) — it is the deterministic
 * skills-and-title overlap of `fallbackScore`, so one bad response never stalls the
 * pipeline. Matched and missing skills are always computed deterministically from the
 * verified fact bank. Writes nothing: the caller saves the result.
 * Throws CircuitBreakerError through.
 *
 * `fallback: false` refuses the overlap score: with no decider, or when its call fails,
 * the error is thrown instead. The hands-free pipeline asks for this — an overlap score
 * is good enough to sort a list a person will read, not to send applications on.
 */
export async function scoreFit(
  job: JobOpportunity,
  profile: CandidateProfile,
  decider?: Decider | null,
  options: { fallback?: boolean } = {},
): Promise<FitEvaluation> {
  const bestPositioningProfile = ProfileManager.selectPositioning(job);
  const gap = analyseSkills(job, profile);
  const strict = options.fallback === false;

  let fitScore: number | null = null;
  if (decider) {
    try {
      const state = fitState(job, profile, bestPositioningProfile);
      fitScore = judgedScore(await decider.decideScore(state, FIT_INSTRUCTIONS, FIT_LEVELS, FIT_TASK_TYPE));
    } catch (error) {
      // The spend cap is the one failure the caller must see: it has to stop paying.
      if (error instanceof CircuitBreakerError || strict) throw error;
    }
  }
  if (fitScore === null && strict) throw new Error("the decision model gave no usable fit score");
  return {
    jobId: job.id,
    fitScore: fitScore ?? fallbackScore(job, profile, gap),
    bestPositioningProfile,
    matchedSkills: gap.matched,
    missingSkills: gap.missing,
  };
}
