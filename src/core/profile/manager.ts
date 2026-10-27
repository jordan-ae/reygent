/**
 * Candidate fact bank and profile engine.
 *
 * Identity facts and achievements come from config.yaml and are synced into SQLite,
 * which is what the Cop Tool grounds every claim against. Nothing here invents facts:
 * achievements stay unusable until the user marks each one `verified: true`.
 */

import { type Config, ConfigError } from "@/core/config";
import { DEFAULT_CANDIDATE_ID, type Repository } from "@/core/db/repository";
import {
  type Achievement,
  type CandidateProfile,
  type JobOpportunity,
  PLACEHOLDER,
  type PositioningProfile,
  verifiedAchievements,
} from "@/core/models";

export interface ReadinessIssue {
  /** Which setup page fixes it. */
  area: "profile" | "fact_bank";
  message: string;
}

/** The four positioning profile ids, in display order. */
export const POSITIONING_IDS = ["ai_platform_agent", "fullstack_product", "applied_ai_llm", "frontend_systems"] as const;

type PositioningId = (typeof POSITIONING_IDS)[number];

interface PositioningSpec {
  title: string;
  coreSkills: readonly string[];
  targetSummary: string;
  pitchAngle: string;
  /** Lower-case phrases in a listing that route it to this variant. */
  keywords: readonly string[];
}

const POSITIONING: Record<PositioningId, PositioningSpec> = {
  ai_platform_agent: {
    title: "AI Platform / Agent Engineer",
    coreSkills: ["LangGraph", "MCP", "Evals", "Tool Calling"],
    targetSummary:
      "Senior software and AI engineer building agent platforms: LangGraph orchestration," +
      " MCP servers, tool calling and the eval harnesses that keep them honest.",
    pitchAngle: "Agent infrastructure that does real work reliably, measured by evals rather than demos.",
    keywords: [
      "agent", "agentic", "langgraph", "mcp", "tool calling", "tool use", "evals", "ai platform",
      "orchestration", "llm infrastructure",
    ],
  },
  fullstack_product: {
    title: "Senior Full-Stack Product Engineer",
    coreSkills: ["TypeScript", "Next.js", "Python", "PostgreSQL"],
    targetSummary:
      "Senior full-stack product engineer shipping end to end across TypeScript, Next.js," +
      " Python and PostgreSQL.",
    pitchAngle: "One engineer who owns a feature from schema to shipped UI.",
    keywords: [
      "full-stack", "full stack", "fullstack", "product engineer", "typescript", "next.js",
      "postgresql", "postgres", "backend", "software engineer",
    ],
  },
  applied_ai_llm: {
    title: "Applied AI / LLM Engineer",
    coreSkills: ["RAG", "pgvector", "Qdrant", "Semantic Search"],
    targetSummary:
      "Applied AI engineer building retrieval systems: RAG pipelines and semantic search" +
      " on pgvector and Qdrant.",
    pitchAngle: "LLM features grounded in retrieval that holds up on real data.",
    keywords: [
      "rag", "retrieval", "llm", "applied ai", "semantic search", "vector", "pgvector", "qdrant",
      "embeddings", "machine learning", "nlp",
    ],
  },
  frontend_systems: {
    title: "Frontend Systems Engineer",
    coreSkills: ["React", "Web Performance", "Design Systems"],
    targetSummary:
      "Frontend systems engineer focused on React architecture, web performance and" +
      " design systems.",
    pitchAngle: "Fast, consistent interfaces built on a design system that scales with the team.",
    keywords: [
      "frontend", "front-end", "front end", "react", "design system", "web performance", "ui engineer",
      "core web vitals",
    ],
  },
};
const DEFAULT_POSITIONING: PositioningId = "fullstack_product";
const TITLE_WEIGHT = 3;

// A keyword counts only as a whole term: "rag" must not match inside "storage".
const KEYWORD_PATTERNS: ReadonlyArray<readonly [PositioningId, RegExp[]]> = POSITIONING_IDS.map((id) => [
  id,
  POSITIONING[id].keywords.map(
    (keyword) => new RegExp(`(?<![a-z0-9])${keyword.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![a-z0-9])`, "g"),
  ),
]);

/** The profile facts a draft cannot do without: [profile field, how the message names it]. */
const REQUIRED_FACTS = [
  ["name", "name"],
  ["email", "email"],
  ["phone", "phone"],
  ["githubUrl", "GitHub link"],
  ["linkedinUrl", "LinkedIn link"],
  ["portfolioUrl", "portfolio link"],
  ["noticePeriod", "notice period"],
] as const satisfies ReadonlyArray<readonly [keyof CandidateProfile, string]>;

/** ['a', 'b'] — how a list of ids is shown in error messages. */
const quoted = (items: readonly string[]): string => `[${items.map((item) => `'${item}'`).join(", ")}]`;

/** An optional scalar from a fact-bank record; a missing or null value is empty text. */
const text = (value: unknown): string => (value === undefined || value === null ? "" : String(value));

/** Not filled in: missing, null, "", 0, false, [] or {} — what YAML gives for a field left empty. */
const isBlank = (value: unknown): boolean => !value || (typeof value === "object" && Object.keys(value).length === 0);

/** An optional list from a fact-bank record. A lone scalar is rejected rather than guessed at. */
function strings(record: Record<string, unknown>, key: string): string[] {
  const value = record[key];
  if (isBlank(value)) return [];
  if (!Array.isArray(value)) throw new ConfigError(`Achievement '${text(record.id)}': ${key} must be a list`);
  return value.map(String);
}

/** Validate one raw fact-bank record (snake_case, as written in config.yaml). */
function toAchievement(raw: unknown): Achievement {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new ConfigError(`fact_bank.achievements entries must be mappings, got ${JSON.stringify(raw)}`);
  }
  const record = raw as Record<string, unknown>;
  const missing = ["id", "headline", "impact_metric"].filter((key) => isBlank(record[key]));
  if (missing.length > 0) {
    throw new ConfigError(`Achievement '${isBlank(record.id) ? "?" : text(record.id)}' is missing ${quoted(missing)}`);
  }
  return {
    id: String(record.id),
    category: text(record.category),
    headline: String(record.headline),
    impactMetric: String(record.impact_metric),
    technologies: strings(record, "technologies"),
    context: text(record.context),
    employer: text(record.employer),
    evidenceUrl: text(record.evidence_url),
    positioning: strings(record, "positioning"),
    // Only the boolean counts: "yes", "true" or 1 must never make a claim usable.
    verified: record.verified === true,
  };
}

export class ProfileManager {
  constructor(
    private readonly repo: Repository,
    private readonly config: Config,
  ) {}

  /**
   * Validate the config's fact bank and return the profile it describes, unsaved.
   * Throws ConfigError on invalid entries.
   */
  build(): CandidateProfile {
    const { candidate, fact_bank: factBank } = this.config;
    const achievements = factBank.achievements.map(toAchievement);
    if (new Set(achievements.map((achievement) => achievement.id)).size !== achievements.length) {
      throw new ConfigError("fact_bank.achievements contains duplicate ids");
    }
    const positioning: Record<string, PositioningProfile> = {};
    for (const id of POSITIONING_IDS) {
      const spec = POSITIONING[id];
      positioning[id] = {
        id,
        title: spec.title,
        targetSummary: spec.targetSummary,
        coreSkills: [...spec.coreSkills],
        pitchAngle: spec.pitchAngle,
        highlightedAchievements: achievements
          .filter((achievement) => achievement.verified && achievement.positioning.includes(id))
          .map((achievement) => achievement.id),
      };
    }
    const known: ReadonlySet<string> = new Set(POSITIONING_IDS);
    for (const achievement of achievements) {
      const unknown = [...new Set(achievement.positioning)].filter((id) => !known.has(id));
      if (unknown.length > 0) {
        throw new ConfigError(
          `Achievement '${achievement.id}' references unknown positioning ${quoted(unknown.sort())};` +
            ` valid ids: ${quoted([...POSITIONING_IDS].sort())}`,
        );
      }
    }
    return {
      id: DEFAULT_CANDIDATE_ID,
      name: candidate.name,
      email: candidate.email,
      phone: candidate.phone,
      location: candidate.location,
      timezone: candidate.timezone,
      workAuthorization: candidate.work_authorization,
      noticePeriod: candidate.notice_period,
      githubUrl: candidate.github_url,
      linkedinUrl: candidate.linkedin_url,
      portfolioUrl: candidate.portfolio_url,
      yearsExperience: candidate.years_experience,
      employers: [...candidate.employers],
      skills: [...candidate.skills],
      achievements,
      positioning,
    };
  }

  /** Build the profile from config and store it. Safe to re-run after editing config. */
  initialize(): CandidateProfile {
    const profile = this.build();
    this.repo.saveProfile(profile);
    return profile;
  }

  /** The stored profile; throws if `initialize` has never run. */
  load(): CandidateProfile {
    const profile = this.repo.getProfile();
    if (!profile) throw new Error("No candidate profile yet: run `npm run reygent -- init`");
    return profile;
  }

  /** What still blocks real submissions. The Cop Tool enforces each of these. */
  static readinessIssues(profile: CandidateProfile): ReadinessIssue[] {
    const issues: ReadinessIssue[] = [];
    const unfilled = REQUIRED_FACTS.filter(([field]) => profile[field].includes(PLACEHOLDER)).map(([, label]) => label);
    if (unfilled.length > 0) {
      issues.push({ area: "profile", message: `Profile is missing your ${unfilled.join(", ")}` });
    }
    const pending = profile.achievements
      .filter((achievement) => !achievement.verified)
      .map((achievement) => `"${achievement.headline}"`);
    if (pending.length > 0) {
      issues.push({
        area: "fact_bank",
        message:
          `${pending.length} achievement${pending.length === 1 ? "" : "s"} not verified yet, so unusable:` +
          ` ${pending.join(", ")}`,
      });
    }
    if (verifiedAchievements(profile).length === 0) {
      issues.push({ area: "fact_bank", message: "No verified achievement yet, so no CV bullet can be written" });
    } else {
      const bare = Object.values(profile.positioning)
        .filter((variant) => variant.highlightedAchievements.length === 0)
        .map((variant) => variant.title);
      if (bare.length > 0) {
        issues.push({ area: "fact_bank", message: `No verified achievement backs: ${bare.join("; ")}` });
      }
    }
    return issues;
  }

  /** Pick the positioning profile id whose keywords best match the listing (Tier 0). */
  static selectPositioning(job: Pick<JobOpportunity, "title" | "description">): string {
    const title = job.title.toLowerCase();
    const body = job.description.toLowerCase();
    const occurrences = (pattern: RegExp, haystack: string): number => haystack.match(pattern)?.length ?? 0;
    let best: string = DEFAULT_POSITIONING;
    let bestScore = 0;
    for (const [id, patterns] of KEYWORD_PATTERNS) {
      let total = 0;
      for (const pattern of patterns) {
        total += TITLE_WEIGHT * occurrences(pattern, title) + occurrences(pattern, body);
      }
      // Strictly greater: on a tie the earlier variant in display order wins.
      if (total > bestScore) [best, bestScore] = [id, total];
    }
    return best;
  }
}
