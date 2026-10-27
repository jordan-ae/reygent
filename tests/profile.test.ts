/** The candidate fact bank / profile engine. */

import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { type Config, ConfigError, defaultConfig } from "@/core/config";
import { Repository } from "@/core/db/repository";
import { screeningFacts, verifiedAchievements, verifiedLinks, verifiedTechnologies } from "@/core/models";
import { POSITIONING_IDS, ProfileManager } from "@/core/profile/manager";

describe("ProfileManager", () => {
  let repo: Repository;
  let config: Config;
  let manager: ProfileManager;

  beforeEach(() => {
    repo = new Repository(":memory:");
    config = defaultConfig();
    config.candidate.name = "Test Candidate";
    config.candidate.email = "candidate@example.com";
    config.fact_bank.achievements = [
      {
        id: "ach_agents", category: "ai_systems", positioning: ["ai_platform_agent"],
        headline: "Built a LangGraph agent runtime",
        impact_metric: "Cut workflow latency by 45%", technologies: ["Python", "LangGraph"],
        verified: true,
      },
      {
        id: "ach_draft", positioning: ["fullstack_product"],
        headline: "Not yet confirmed", impact_metric: "Some number", technologies: ["Elixir"],
        verified: false,
      },
    ];
    manager = new ProfileManager(repo, config);
  });
  afterEach(() => {
    repo.close();
  });

  test("profile carries the Cameroon B2B context", () => {
    const profile = manager.initialize();
    expect(profile.location).toBe("Cameroon (UTC+1)");
    expect(profile.workAuthorization).toBe(
      "Eligible for Global Independent B2B Contractor & 1099 Engagements." +
        " Invoices via direct wire / Deel / Remote / Wise.",
    );
  });

  test("four positioning variants", () => {
    const profile = manager.initialize();
    expect(
      Object.fromEntries(Object.values(profile.positioning).map((variant) => [variant.title, variant.coreSkills])),
    ).toEqual({
      "AI Platform / Agent Engineer": ["LangGraph", "MCP", "Evals", "Tool Calling"],
      "Senior Full-Stack Product Engineer": ["TypeScript", "Next.js", "Python", "PostgreSQL"],
      "Applied AI / LLM Engineer": ["RAG", "pgvector", "Qdrant", "Semantic Search"],
      "Frontend Systems Engineer": ["React", "Web Performance", "Design Systems"],
    });
    expect(Object.keys(profile.positioning)).toEqual([...POSITIONING_IDS]);
  });

  test("only verified achievements are usable", () => {
    const profile = manager.initialize();
    expect(verifiedAchievements(profile).map((achievement) => achievement.id)).toEqual(["ach_agents"]);
    expect(profile.positioning.ai_platform_agent.highlightedAchievements).toEqual(["ach_agents"]);
    expect(profile.positioning.fullstack_product.highlightedAchievements).toEqual([]);
    expect(verifiedTechnologies(profile).has("Elixir")).toBe(false);
    expect(verifiedTechnologies(profile).has("LangGraph")).toBe(true);
  });

  test("verified must be an explicit true", () => {
    config.fact_bank.achievements[1].verified = "yes";
    const profile = manager.initialize();
    expect(verifiedAchievements(profile).map((achievement) => achievement.id)).toEqual(["ach_agents"]);
  });

  test("fact-bank records are read in the config file's snake_case", () => {
    config.fact_bank.achievements[0].evidence_url = "https://github.com/test-candidate/agents";
    config.fact_bank.achievements[0].employer = "Acme";
    const [achievement] = manager.initialize().achievements;
    expect(achievement).toEqual({
      id: "ach_agents", category: "ai_systems", headline: "Built a LangGraph agent runtime",
      impactMetric: "Cut workflow latency by 45%", technologies: ["Python", "LangGraph"], context: "",
      employer: "Acme", evidenceUrl: "https://github.com/test-candidate/agents",
      positioning: ["ai_platform_agent"], verified: true,
    });
  });

  test("placeholders never count as facts", () => {
    const profile = manager.initialize();
    const facts = screeningFacts(profile);
    expect(facts.name).toBe("Test Candidate");
    expect(facts).not.toHaveProperty("phone");
    expect(facts).not.toHaveProperty("notice_period");
    expect(verifiedLinks(profile)).toEqual(new Set());
  });

  test("initialize persists and can be re-run", () => {
    manager.initialize();
    config.candidate.notice_period = "2 weeks";
    manager.initialize();
    const stored = manager.load();
    expect(stored.noticePeriod).toBe("2 weeks");
    expect(stored.achievements).toHaveLength(2);
  });

  test("build validates without storing anything", () => {
    expect(manager.build().name).toBe("Test Candidate");
    expect(repo.getProfile()).toBeNull();
  });

  test("load before init explains what to do", () => {
    expect(() => manager.load()).toThrow(/init/);
  });

  test("readiness issues name what is missing", () => {
    const found = ProfileManager.readinessIssues(manager.initialize());
    expect(new Set(found.map((issue) => issue.area))).toEqual(new Set(["profile", "fact_bank"]));
    const messages = found.map((issue) => issue.message);
    const issues = messages.join(" | ");
    expect(issues).toContain("phone");
    expect(issues).toContain("notice period");
    expect(messages[0]).not.toContain("name"); // the name and email were filled in
    expect(issues).toContain('1 achievement not verified yet, so unusable: "Not yet confirmed"');
    expect(issues).toContain("Frontend Systems Engineer");
    expect(issues).not.toContain("AI Platform / Agent Engineer"); // backed by the verified achievement
    expect(issues).not.toContain("no CV bullet");
    expect(found).toEqual([
      { area: "profile", message: "Profile is missing your phone, GitHub link, LinkedIn link, portfolio link, notice period" },
      { area: "fact_bank", message: '1 achievement not verified yet, so unusable: "Not yet confirmed"' },
      {
        area: "fact_bank",
        message:
          "No verified achievement backs: Senior Full-Stack Product Engineer; Applied AI / LLM Engineer;" +
          " Frontend Systems Engineer",
      },
    ]);
  });

  test("readiness with nothing verified says so once", () => {
    config.fact_bank.achievements[0].verified = false;
    const messages = ProfileManager.readinessIssues(manager.initialize()).map((issue) => issue.message);
    expect(messages.some((message) => message.includes("no CV bullet can be written"))).toBe(true);
    expect(messages.some((message) => message.includes("backs:"))).toBe(false);
    expect(messages).toContain(
      '2 achievements not verified yet, so unusable: "Built a LangGraph agent runtime", "Not yet confirmed"',
    );
  });

  test("complete profile has no readiness issues", () => {
    const { candidate } = config;
    candidate.phone = "+237 600 000 000";
    candidate.notice_period = "2 weeks";
    candidate.github_url = "https://github.com/test-candidate";
    candidate.linkedin_url = "https://www.linkedin.com/in/test-candidate";
    candidate.portfolio_url = "https://candidate.example.com";
    config.fact_bank.achievements = [
      {
        ...config.fact_bank.achievements[0],
        positioning: ["ai_platform_agent", "fullstack_product", "applied_ai_llm", "frontend_systems"],
      },
    ];
    expect(ProfileManager.readinessIssues(manager.initialize())).toEqual([]);
  });

  test("invalid fact-bank entries are rejected", () => {
    const { achievements } = config.fact_bank;
    achievements.push({ id: "ach_agents", headline: "x", impact_metric: "y" });
    expect(() => manager.initialize()).toThrow(/duplicate/);
    achievements[achievements.length - 1] = { id: "ach_new", headline: "x" };
    expect(() => manager.initialize()).toThrow(/impact_metric/);
    expect(() => manager.initialize()).toThrow("Achievement 'ach_new' is missing ['impact_metric']");
    achievements[achievements.length - 1] = {
      id: "ach_new", headline: "x", impact_metric: "y", positioning: ["data_scientist"],
    };
    expect(() => manager.initialize()).toThrow(/data_scientist/);
    expect(() => manager.initialize()).toThrow(
      "Achievement 'ach_new' references unknown positioning ['data_scientist'];" +
        " valid ids: ['ai_platform_agent', 'applied_ai_llm', 'frontend_systems', 'fullstack_product']",
    );
    // All of these are mistakes in config.yaml, and nothing was stored along the way.
    expect(() => manager.initialize()).toThrow(ConfigError);
    expect(repo.getProfile()).toBeNull();
  });

  test("malformed records are rejected, not guessed at", () => {
    config.fact_bank.achievements[0].technologies = "Python";
    expect(() => manager.build()).toThrow("Achievement 'ach_agents': technologies must be a list");
    // The config schema already refuses this; the manager does not rely on it.
    config.fact_bank.achievements[0] = "ach_agents" as unknown as Record<string, unknown>;
    expect(() => manager.build()).toThrow('fact_bank.achievements entries must be mappings, got "ach_agents"');
    config.fact_bank.achievements[0] = { headline: "x" };
    expect(() => manager.build()).toThrow("Achievement '?' is missing ['id', 'impact_metric']");
    // A field left empty in YAML is missing, whatever empty value it parsed to.
    config.fact_bank.achievements[0] = { id: "ach_empty", headline: [], impact_metric: null };
    expect(() => manager.build()).toThrow("Achievement 'ach_empty' is missing ['headline', 'impact_metric']");
  });

  const pick = (title: string, description = ""): string => ProfileManager.selectPositioning({ title, description });

  test("positioning selection", () => {
    expect(pick("AI Agent Platform Engineer", "LangGraph, MCP, tool calling")).toBe("ai_platform_agent");
    expect(pick("Applied AI Engineer", "RAG pipelines, embeddings and semantic search")).toBe("applied_ai_llm");
    expect(pick("Senior Frontend Engineer", "React and our design system")).toBe("frontend_systems");
    expect(pick("Senior Full-Stack Engineer", "TypeScript, Next.js, PostgreSQL")).toBe("fullstack_product");
    expect(pick("Operations Associate")).toBe("fullstack_product");
  });

  test("positioning keywords are whole terms, and a title hit outweighs body hits", () => {
    // "rag" inside "storage" and "agent" inside "reagents" are not keyword hits.
    expect(pick("Storage Engineer", "fragments, reagents")).toBe("fullstack_product");
    // The dot in "next.js" is literal.
    expect(pick("Engineer", "nextxjs and RAG")).toBe("applied_ai_llm");
    expect(pick("React Engineer", "RAG and LLM")).toBe("frontend_systems");
    // On a tie the earlier variant in display order wins.
    expect(pick("React Engineer", "RAG, LLM and embeddings")).toBe("applied_ai_llm");
  });
});
