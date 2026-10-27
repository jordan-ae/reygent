import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright-core";
import { describe, expect, test } from "vitest";

import { inspectPdf } from "@/core/cop/pdfIntegrity";
import { renderPdf, renderResumeHtml } from "@/core/drafting/resume";
import { type Achievement, type CandidateProfile, type CvBullet, type PositioningProfile, PLACEHOLDER } from "@/core/models";

const achievement = (fields: Partial<Achievement> & Pick<Achievement, "id" | "headline">): Achievement => ({
  category: "ai_systems", impactMetric: "", technologies: [], context: "", employer: "", evidenceUrl: "",
  positioning: ["ai_platform_agent"], verified: true, ...fields,
});

const POSITIONING: PositioningProfile = {
  id: "ai_platform_agent", title: "AI Platform / Agent Engineer",
  targetSummary: "Senior software and AI engineer building agent platforms and the eval harnesses that keep them honest.",
  coreSkills: ["LangGraph", "MCP", "Evals"],
  pitchAngle: "Agent infrastructure that does real work reliably, measured by evals rather than demos.",
  highlightedAchievements: ["ach_agents"],
};

function makeProfile(overrides: Partial<CandidateProfile> = {}): CandidateProfile {
  return {
    id: "default", name: "Test Candidate", email: "candidate@example.com", phone: "+237 600 000 000",
    location: "Cameroon (UTC+1)", timezone: "Africa/Douala (WAT, UTC+1)",
    workAuthorization: "Eligible for Global Independent B2B Contractor & 1099 Engagements.",
    noticePeriod: "2 weeks", githubUrl: "https://github.com/test-candidate",
    linkedinUrl: "https://www.linkedin.com/in/test-candidate/", portfolioUrl: "https://candidate.example.com",
    yearsExperience: 8, employers: ["Initech"], skills: ["Python", "Docker"],
    achievements: [
      achievement({
        id: "ach_agents", headline: "Built a LangGraph agent runtime with checkpoint recovery",
        impactMetric: "Cut workflow latency by 45% and raised eval accuracy from 71% to 94%",
        technologies: ["Python", "LangGraph", "PostgreSQL"], employer: "Initech",
      }),
      achievement({
        id: "ach_search", headline: "Shipped semantic search over 4M documents",
        impactMetric: "Sub-80ms retrieval at p95", technologies: ["Python", "Qdrant", "pgvector"],
      }),
      achievement({
        id: "ach_unverified", headline: "Scaled a SaaS product to 300k monthly users",
        impactMetric: "Held 99.98% uptime", technologies: ["TypeScript", "Next.js"], employer: "Globex",
        verified: false,
      }),
    ],
    positioning: { ai_platform_agent: POSITIONING },
    ...overrides,
  };
}

const BULLETS: CvBullet[] = [
  { text: "Built a LangGraph agent runtime with checkpoint recovery, cutting workflow latency by 45%.", achievementId: "ach_agents" },
  { text: "Shipped semantic search over 4M documents with sub-80ms retrieval at p95.", achievementId: "ach_search" },
];

const skillsLine = (html: string) => /<h2>Skills<\/h2>\n<p>(.*)<\/p>/.exec(html)?.[1] ?? "";

describe("renderResumeHtml", () => {
  test("prints the candidate's verified facts, the positioning and the bullets", () => {
    const html = renderResumeHtml(makeProfile(), POSITIONING, BULLETS);
    for (const fact of [
      "<h1>Test Candidate</h1>", "Cameroon (UTC+1)", "Africa/Douala (WAT, UTC+1)", "+237 600 000 000",
      '<a href="mailto:candidate@example.com">candidate@example.com</a>',
      '<a href="https://github.com/test-candidate">github.com/test-candidate</a>',
      '<a href="https://www.linkedin.com/in/test-candidate/">linkedin.com/in/test-candidate</a>',
      '<a href="https://candidate.example.com">candidate.example.com</a>',
      "AI Platform / Agent Engineer", "<h2>Selected work</h2>",
      `<li>${BULLETS[0].text}</li>`, `<li>${BULLETS[1].text}</li>`,
    ]) {
      expect(html).toContain(fact);
    }
  });

  test("the summary printed is the candidate's own, never the positioning template's", () => {
    // The template names skills ("eval harnesses") this candidate may never have claimed.
    const without = renderResumeHtml(makeProfile(), POSITIONING, BULLETS);
    expect(without).not.toContain(POSITIONING.targetSummary);
    expect(without).not.toContain("eval harnesses");

    const own = "Full-stack engineer who builds <agents> & ships them.";
    const withOwn = renderResumeHtml(makeProfile(), POSITIONING, BULLETS, `  ${own}  `);
    expect(withOwn).toContain("<p>Full-stack engineer who builds &lt;agents&gt; &amp; ships them.</p>");
    expect(withOwn).not.toContain(POSITIONING.targetSummary);
  });

  test("nothing from an unverified achievement reaches the page, even when a bullet cites it", () => {
    const html = renderResumeHtml(makeProfile(), POSITIONING, [
      ...BULLETS,
      { text: "Scaled a SaaS product to 300k monthly users.", achievementId: "ach_unverified" },
      { text: "Invented a database.", achievementId: "ach_missing" },
    ]);
    for (const claim of ["300k", "99.98", "SaaS", "Globex", "TypeScript", "Next.js", "Invented a database"]) {
      expect(html).not.toContain(claim);
    }
    expect(html.match(/<li>/g)).toHaveLength(2);
  });

  test("unfilled placeholders are left out rather than printed", () => {
    const html = renderResumeHtml(
      makeProfile({ phone: PLACEHOLDER, linkedinUrl: PLACEHOLDER, portfolioUrl: `https://${PLACEHOLDER}.dev`, noticePeriod: PLACEHOLDER }),
      POSITIONING, BULLETS,
    );
    expect(html).not.toContain(PLACEHOLDER);
    expect(html).not.toContain("linkedin");
    expect(html).toContain("github.com/test-candidate");
  });

  test("every value is escaped, so a fact can never inject markup", () => {
    const hostile = makeProfile({
      name: 'A <b> & "C"',
      location: "<img src=x onerror=alert(1)>",
      skills: ["C<T>", "R&D"],
      achievements: [
        achievement({
          id: "ach_x", headline: "Built it", technologies: ["<script>alert(2)</script>"], employer: "R&D <Labs>",
        }),
      ],
    });
    const html = renderResumeHtml(
      hostile,
      { ...POSITIONING, title: "Engineer <i>italic</i>", targetSummary: "Ships </p><script>alert(3)</script>" },
      [{ text: "Cut <latency> by 'half' & more</li><script>alert(4)</script>", achievementId: "ach_x" }],
    );
    expect(html).toContain("<h1>A &lt;b&gt; &amp; &quot;C&quot;</h1>");
    expect(html).toContain("<title>A &lt;b&gt; &amp; &quot;C&quot; - Resume</title>");
    expect(html).toContain("<h3>R&amp;D &lt;Labs&gt;</h3>");
    expect(html).toContain("<li>Cut &lt;latency&gt; by &#39;half&#39; &amp; more&lt;/li&gt;&lt;script&gt;alert(4)&lt;/script&gt;</li>");
    expect(html).toContain("Engineer &lt;i&gt;italic&lt;/i&gt;");
    expect(skillsLine(html)).toContain("C&lt;T&gt;");
    for (const injected of ["<b>", "<i>", "<img", "<script", "onerror=alert(1)>"]) expect(html).not.toContain(injected);
  });

  test("a link that is not http(s) is printed as text, never as an href", () => {
    const html = renderResumeHtml(makeProfile({ githubUrl: 'javascript:alert("x")' }), POSITIONING, BULLETS);
    expect(html).not.toContain('href="javascript:');
    expect(html).toContain("javascript:alert(&quot;x&quot;)");
  });

  test("the page is self-contained: no scripts and nothing fetched", () => {
    const html = renderResumeHtml(makeProfile(), POSITIONING, BULLETS);
    for (const external of ["<script", "<link", "<img", "<iframe", "src=", "url(", "@import", "@font-face"]) {
      expect(html).not.toContain(external);
    }
    const hrefs = Array.from(html.matchAll(/href="([^"]*)"/g), ([, href]) => href);
    expect(hrefs).toEqual([
      "mailto:candidate@example.com", "https://github.com/test-candidate",
      "https://www.linkedin.com/in/test-candidate/", "https://candidate.example.com",
    ]);
    // One text layer: nothing hidden, layered or drawn twice for the Cop Tool to reject.
    expect(html).not.toMatch(/display:\s*none|visibility|opacity|position:\s*(?:absolute|fixed)|text-shadow|z-index/);
  });

  test("bullets sit under their achievement's employer; work with no named employer comes first", () => {
    const profile = makeProfile();
    profile.achievements.push(
      achievement({ id: "ach_evals", headline: "Built an eval harness", technologies: ["Pytest"], employer: "Initech" }),
    );
    const html = renderResumeHtml(profile, POSITIONING, [
      BULLETS[0], BULLETS[1], { text: "Built an eval harness for agent runs.", achievementId: "ach_evals" },
    ]);
    const order = [BULLETS[1].text, "<h3>Initech</h3>", BULLETS[0].text, "Built an eval harness for agent runs."].map(
      (part) => html.indexOf(part),
    );
    expect(order.every((index) => index >= 0)).toBe(true);
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(html.match(/<h3>/g)).toHaveLength(1);
  });

  test("the skills line holds only skills the candidate vouched for; core skills just set the order", () => {
    const skills = skillsLine(renderResumeHtml(makeProfile(), POSITIONING, BULLETS)).split(" &#183; ");
    expect(skills).toEqual(["LangGraph", "Python", "PostgreSQL", "Qdrant", "pgvector", "Docker"]);
    // "MCP" and "Evals" are the positioning template's words, not a skill anyone confirmed.
  });

  test("sections with nothing verified to show are omitted", () => {
    const html = renderResumeHtml(makeProfile({ name: PLACEHOLDER, skills: [], achievements: [] }), POSITIONING, BULLETS);
    expect(html).not.toContain("<h1>");
    expect(html).not.toContain("Selected work");
    expect(html).not.toContain("<h2>Skills</h2>");
    expect(html).toContain("<title>Resume</title>");
  });
});

/** The render test needs the installed Chrome; where it cannot start, the test is skipped, not failed. */
async function chromeLaunches(): Promise<boolean> {
  try {
    const browser = await chromium.launch({ channel: "chrome", headless: true });
    await browser.close();
    return true;
  } catch {
    return false;
  }
}
const chromeAvailable = await chromeLaunches();

describe("renderPdf", () => {
  test.skipIf(!chromeAvailable)("prints a sound one-page PDF that the Cop Tool's integrity check accepts", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "reygent-resume-"));
    try {
      const file = path.join(dir, "not", "yet", "created", "resume.pdf");
      await renderPdf(renderResumeHtml(makeProfile(), POSITIONING, BULLETS), file);
      const pdf = fs.readFileSync(file);
      expect(pdf.subarray(0, 5).toString("latin1")).toBe("%PDF-");
      expect(pdf.length).toBeGreaterThan(10 * 1024);
      expect(inspectPdf(file)).toEqual([]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);

  test.skipIf(!chromeAvailable)("even the barest resume clears the size floor and stays on one page", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "reygent-resume-"));
    try {
      const file = path.join(dir, "bare.pdf");
      const bare = makeProfile({ phone: PLACEHOLDER, linkedinUrl: PLACEHOLDER, portfolioUrl: PLACEHOLDER, skills: [] });
      await renderPdf(renderResumeHtml(bare, POSITIONING, [{ text: "Built a runtime.", achievementId: "ach_agents" }]), file);
      expect(fs.statSync(file).size).toBeGreaterThan(10 * 1024);
      expect(inspectPdf(file, 10 * 1024, 1)).toEqual([]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);
});
