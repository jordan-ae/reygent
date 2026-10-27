/**
 * The tailored resume: one A4 page of HTML, printed to PDF by the installed Chrome.
 *
 * Everything on the page is a verified fact (identity facts that are filled in, the
 * chosen positioning, bullets tied to verified achievements) or text the Cop Tool
 * inspects (the bullets themselves). The page is plain flowing text in fonts that ship
 * a real bold face, so the PDF carries one selectable text layer and nothing is drawn
 * twice — the Cop Tool rejects resumes with overlapping text.
 */

import fs from "node:fs";
import path from "node:path";

import {
  type Achievement,
  type CandidateProfile,
  type CvBullet,
  type PositioningProfile,
  screeningFacts,
  verifiedAchievements,
} from "@/core/models";

const HTML_ESCAPES: Record<string, string> = {
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
};

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => HTML_ESCAPES[char]);
}

/** "https://www.github.com/someone/" as it reads on paper: "github.com/someone". */
function displayUrl(url: string): string {
  return url.replace(/^https?:\/\/(?:www\.)?/i, "").replace(/\/+$/, "");
}

/** A clickable link for http(s) URLs; anything else is printed as text, never as an href. */
function link(url: string): string {
  if (!/^https?:\/\//i.test(url)) return escapeHtml(url);
  return `<a href="${escapeHtml(url)}">${escapeHtml(displayUrl(url))}</a>`;
}

/** First spelling of each entry, compared case-insensitively. */
function unique(values: readonly string[]): string[] {
  const first = new Map<string, string>();
  for (const value of values) {
    const spelling = value.trim();
    const key = spelling.toLowerCase();
    if (spelling && !first.has(key)) first.set(key, spelling);
  }
  return [...first.values()];
}

/**
 * Skills the candidate has vouched for: technologies of verified achievements and the
 * profile's own skill list. The positioning's core skills only decide the order — they
 * are a template, so one the candidate has not backed is not printed as a skill.
 */
function skillLine(profile: CandidateProfile, positioning: PositioningProfile, shown: readonly Achievement[]): string[] {
  const vouched = unique([
    ...shown.flatMap((achievement) => achievement.technologies),
    ...verifiedAchievements(profile).flatMap((achievement) => achievement.technologies),
    ...profile.skills,
  ]);
  const core = new Set(positioning.coreSkills.map((skill) => skill.trim().toLowerCase()));
  const isCore = (skill: string) => core.has(skill.toLowerCase());
  return [...vouched.filter(isCore), ...vouched.filter((skill) => !isCore(skill))];
}

const STYLE = `
@page { size: A4; margin: 16mm 17mm; }
* { box-sizing: border-box; }
html { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
body {
  margin: 0; color: #1c1c1c; font-size: 10.5pt; line-height: 1.45;
  font-family: "Helvetica Neue", Helvetica, Arial, "Liberation Sans", sans-serif;
}
h1 { margin: 0 0 2pt; font-size: 23pt; font-weight: 700; line-height: 1.15; }
h2 {
  margin: 16pt 0 5pt; padding-bottom: 3pt; border-bottom: 0.75pt solid #9a9a9a;
  font-size: 11.5pt; font-weight: 700;
}
h3 { margin: 8pt 0 2pt; font-size: 10.5pt; font-weight: 700; }
p { margin: 0; }
a { color: inherit; text-decoration: none; }
ul { margin: 2pt 0 0; padding-left: 14pt; }
li { margin: 0 0 4pt; }
.contact { margin-top: 2pt; color: #444444; }
.role { margin: 14pt 0 3pt; font-size: 13pt; font-weight: 700; }
`;

/**
 * The resume as a self-contained HTML document: inline CSS, system fonts, no scripts
 * and no external resources. Every value is escaped. Identity facts come from
 * `screeningFacts`, so an unfilled placeholder never reaches the page, and a bullet is
 * printed only when it cites a verified achievement. `summary` is the candidate's own
 * (config `candidate.summary`); the positioning's built-in summary is a template that
 * names skills the candidate may not have, so it is never printed.
 */
export function renderResumeHtml(
  profile: CandidateProfile,
  positioning: PositioningProfile,
  bullets: CvBullet[],
  summary = "",
): string {
  const facts = screeningFacts(profile);
  const verified = new Map(verifiedAchievements(profile).map((achievement) => [achievement.id, achievement]));

  // Bullets grouped under the employer of their achievement, each group in the order given.
  const unattributed: string[] = [];
  const byEmployer = new Map<string, string[]>();
  const shown: Achievement[] = [];
  for (const bullet of bullets) {
    const achievement = verified.get(bullet.achievementId);
    const text = bullet.text.trim();
    if (!achievement || !text) continue;
    shown.push(achievement);
    const employer = achievement.employer.trim();
    if (employer) byEmployer.set(employer, [...(byEmployer.get(employer) ?? []), text]);
    else unattributed.push(text);
  }
  const bulletList = (texts: readonly string[]) =>
    ["<ul>", ...texts.map((text) => `<li>${escapeHtml(text)}</li>`), "</ul>"].join("\n");
  // Work with no named employer is listed first: placed after an employer's heading
  // it would read as work done there, which the fact bank does not say.
  const work = [
    unattributed.length ? bulletList(unattributed) : "",
    ...[...byEmployer].map(([employer, texts]) => `<h3>${escapeHtml(employer)}</h3>\n${bulletList(texts)}`),
  ].filter(Boolean);

  const separator = " &#183; ";
  const line = (className: string, items: readonly string[]) =>
    items.length ? `<p class="${className}">${items.join(separator)}</p>` : "";
  const email = facts.email ? `<a href="mailto:${escapeHtml(facts.email)}">${escapeHtml(facts.email)}</a>` : "";
  const skills = skillLine(profile, positioning, shown).map(escapeHtml);

  const body = [
    "<header>",
    facts.name ? `<h1>${escapeHtml(facts.name)}</h1>` : "",
    line("contact", [facts.location, facts.timezone].filter(Boolean).map(escapeHtml)),
    line("contact", [email, facts.phone ? escapeHtml(facts.phone) : ""].filter(Boolean)),
    line("contact", [facts.github_url, facts.linkedin_url, facts.portfolio_url].filter(Boolean).map(link)),
    "</header>",
    "<section>",
    `<p class="role">${escapeHtml(positioning.title)}</p>`,
    summary.trim() ? `<p>${escapeHtml(summary.trim())}</p>` : "",
    "</section>",
    work.length ? `<section>\n<h2>Selected work</h2>\n${work.join("\n")}\n</section>` : "",
    skills.length ? `<section>\n<h2>Skills</h2>\n<p>${skills.join(separator)}</p>\n</section>` : "",
  ].filter(Boolean).join("\n");

  return [
    "<!doctype html>",
    '<html lang="en">',
    "<head>",
    '<meta charset="utf-8">',
    `<title>${escapeHtml([facts.name, "Resume"].filter(Boolean).join(" - "))}</title>`,
    `<style>${STYLE}</style>`,
    "</head>",
    "<body>",
    body,
    "</body>",
    "</html>",
    "",
  ].join("\n");
}

/**
 * Print `html` to an A4 PDF at `outputPath` with the installed Google Chrome (no
 * browser download). The output directory is created if needed and the browser is
 * always closed, even when printing fails.
 */
export async function renderPdf(html: string, outputPath: string): Promise<void> {
  await fs.promises.mkdir(path.dirname(outputPath), { recursive: true });
  // Loaded on demand: the web console imports this module and must not load a browser driver.
  const { chromium } = await import("playwright-core");
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  try {
    // The page is static text: no scripts run and nothing is fetched while it prints.
    const context = await browser.newContext({ javaScriptEnabled: false, offline: true });
    const page = await context.newPage();
    await page.setContent(html, { waitUntil: "load" });
    await page.pdf({ path: outputPath, format: "A4", printBackground: true });
  } finally {
    await browser.close();
  }
}
