/**
 * The candidate's whole CV as data, and the page it prints as.
 *
 * Everything on it is the candidate's: identity facts that are filled in, their own
 * summary, the roles they list (`candidate.experience`), verified achievements under the
 * employer each names, and lines of their CV they have written out themselves
 * (`highlights`). Nothing is generated here.
 *
 * The page is laid out for a parser first: one column of flowing text, the headings every
 * applicant tracking system looks for, links spelled out, no ligatures and no word broken
 * at a hyphen, so that what a parser reads back is what the page says.
 */

import type { Config } from "@/core/config";
import {
  type Achievement,
  type CandidateProfile,
  screeningFacts,
  verifiedAchievements,
} from "@/core/models";

export interface CvLine {
  text: string;
  /** The verified achievement this line states, when it is one. */
  achievementId?: string;
}

export interface CvRole {
  title: string;
  employer: string;
  location: string;
  /** As the candidate writes them: "Jan 2025", "Present". */
  start: string;
  end: string;
  lines: CvLine[];
}

export interface CvProject {
  name: string;
  lines: CvLine[];
}

export interface CvDocument {
  name: string;
  /** The line under the name: the role this CV is put forward for. */
  headline: string;
  /** Location, email, phone: whichever are filled in. */
  contact: string[];
  /** The candidate's verified http(s) links. */
  links: string[];
  summary: string;
  skills: string[];
  /** Most recent first, as the candidate lists them. */
  experience: CvRole[];
  projects: CvProject[];
  /** Verified work that belongs to no listed role or project. */
  other: CvLine[];
  education: string[];
}

/** The section headings, as parsers know them. */
export const HEADINGS = {
  summary: "Summary", skills: "Skills", experience: "Experience", projects: "Projects", other: "Selected Work",
  education: "Education",
} as const;

/** `text` as a sentence: trimmed, with closing punctuation. */
function sentence(text: string): string {
  const trimmed = text.trim();
  return !trimmed || /[.!?]$/.test(trimmed) ? trimmed : `${trimmed}.`;
}

/** An achievement in its own verified words: what was done, then what came of it. */
function achievementLine(achievement: Achievement): CvLine {
  return {
    text: [achievement.headline, achievement.impactMetric].map(sentence).filter(Boolean).join(" "),
    achievementId: achievement.id,
  };
}

/** First spelling of each entry, compared case-insensitively. */
function unique(values: readonly string[]): string[] {
  const first = new Map<string, string>();
  for (const value of values) {
    const spelling = value.trim();
    if (spelling && !first.has(spelling.toLowerCase())) first.set(spelling.toLowerCase(), spelling);
  }
  return [...first.values()];
}

const sameName = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();
const written = (lines: readonly string[]): CvLine[] => lines.map((text) => ({ text: text.trim() })).filter((line) => line.text);

/** Whether the candidate has written out their work history, which is what a whole CV is built on. */
export function hasWorkHistory(config: Config): boolean {
  return config.candidate.experience.some((role) => role.employer.trim() && role.title.trim());
}

/**
 * The CV as the candidate has it, before any listing is considered. `fallbackHeadline` is
 * used when no role gives a title of the candidate's own.
 */
export function baseCv(config: Config, profile: CandidateProfile, fallbackHeadline = ""): CvDocument {
  const facts = screeningFacts(profile);
  const verified = verifiedAchievements(profile);
  const placed = new Set<string>();
  const place = (achievements: readonly Achievement[]): CvLine[] =>
    achievements
      .filter((achievement) => !placed.has(achievement.id))
      .map((achievement) => {
        placed.add(achievement.id);
        return achievementLine(achievement);
      });

  // Projects first: an achievement a project names is that project's, whatever employer it gives.
  const projects = config.candidate.projects
    .filter((project) => project.name.trim())
    .map((project) => ({
      name: project.name.trim(),
      lines: [
        ...place(project.achievements.flatMap((id) => verified.filter((achievement) => achievement.id === id))),
        ...written(project.highlights),
      ],
    }))
    .filter((project) => project.lines.length);
  const experience = config.candidate.experience
    .filter((role) => role.employer.trim() && role.title.trim())
    .map((role) => ({
      title: role.title.trim(),
      employer: role.employer.trim(),
      location: role.location.trim(),
      start: role.start.trim(),
      end: role.end.trim(),
      lines: [
        ...place(verified.filter((achievement) => sameName(achievement.employer, role.employer))),
        ...written(role.highlights),
      ],
    }));

  return {
    name: facts.name ?? "",
    headline: experience[0]?.title ?? fallbackHeadline,
    contact: [facts.location, facts.email, facts.phone].filter(Boolean),
    links: [facts.linkedin_url, facts.github_url, facts.portfolio_url].filter(Boolean),
    summary: config.candidate.summary.trim(),
    skills: unique([...profile.skills, ...verified.flatMap((achievement) => achievement.technologies)]),
    experience,
    projects,
    other: place(verified),
    education: config.candidate.education.map((entry) => entry.trim()).filter(Boolean),
  };
}

/** Every line the page prints that a claim can be read from: what a listing's terms are matched against. */
export function cvLines(document: CvDocument): string[] {
  return [
    document.summary,
    ...document.experience.flatMap((role) => [role.title, ...role.lines.map((line) => line.text)]),
    ...document.projects.flatMap((project) => project.lines.map((line) => line.text)),
    ...document.other.map((line) => line.text),
  ].filter((line) => line.trim());
}

/** Verified text the page does not print: an achievement's context backs a term as much as its headline does. */
export function unprintedLines(profile: CandidateProfile): string[] {
  return verifiedAchievements(profile).map((achievement) => achievement.context).filter((line) => line.trim());
}

// ---------- The page ----------

const HTML_ESCAPES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
const escapeHtml = (value: string): string => value.replace(/[&<>"']/g, (char) => HTML_ESCAPES[char]);

/**
 * Text for the page. A word with a hyphen or a slash in it ("event-driven", "CI/CD") is
 * kept on one line: broken across two, a parser reads it as two words or glues it into one.
 */
function prose(text: string): string {
  return text
    .split(/(\s+)/)
    .map((word) => (/\S[-/]\S/.test(word) ? `<span class="whole">${escapeHtml(word)}</span>` : escapeHtml(word)))
    .join("");
}

/** "https://www.github.com/someone/" as it reads on paper: "github.com/someone". */
export function displayUrl(url: string): string {
  return url.replace(/^https?:\/\/(?:www\.)?/i, "").replace(/\/+$/, "");
}

/** A clickable link for http(s) URLs, with its address as the visible text; anything else is plain text. */
function link(url: string): string {
  if (!/^https?:\/\//i.test(url)) return escapeHtml(url);
  return `<a href="${escapeHtml(url)}">${escapeHtml(displayUrl(url))}</a>`;
}

/** The dates of a role as one span: "Jan 2025 - Present". A plain hyphen, which every parser reads. */
export function roleDates(role: Pick<CvRole, "start" | "end">): string {
  return [role.start, role.end].filter(Boolean).join(" - ");
}

/** The smallest type a CV is printed in; below this a reader squints. */
export const MIN_FONT_PT = 9.5;
export const DEFAULT_FONT_PT = 10;

const style = (fontPt: number) => `
@page { size: A4; margin: 13mm 15mm; }
* { box-sizing: border-box; }
html { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
body {
  margin: 0; color: #1c1c1c; font-size: ${fontPt}pt; line-height: 1.38;
  font-family: "Helvetica Neue", Helvetica, Arial, "Liberation Sans", sans-serif;
  font-variant-ligatures: none; font-feature-settings: "liga" 0, "clig" 0, "dlig" 0;
  hyphens: manual; overflow-wrap: normal;
}
h1 { margin: 0 0 1pt; font-size: 2em; font-weight: 700; line-height: 1.15; }
h2 {
  margin: 10pt 0 4pt; padding-bottom: 2pt; border-bottom: 0.75pt solid #9a9a9a;
  font-size: 1.08em; font-weight: 700; break-after: avoid;
}
h3 { margin: 7pt 0 0; font-size: 1em; font-weight: 700; break-after: avoid; }
p { margin: 0; }
a { color: inherit; text-decoration: none; }
ul { margin: 2pt 0 0; padding-left: 13pt; }
li { margin: 0 0 2.5pt; }
.headline { margin: 0 0 2pt; font-size: 1.15em; font-weight: 700; }
.contact, .where { color: #333333; }
.where { break-after: avoid; }
.whole { white-space: nowrap; }
`;

/**
 * The CV as a self-contained HTML document: inline CSS, system fonts, no scripts and no
 * external resources, every value escaped. Sections with nothing in them are left out.
 */
export function renderCvHtml(document: CvDocument, fontPt: number = DEFAULT_FONT_PT): string {
  const separator = " | ";
  const list = (lines: readonly CvLine[]) =>
    lines.length ? ["<ul>", ...lines.map((line) => `<li>${prose(line.text)}</li>`), "</ul>"].join("\n") : "";
  const section = (heading: string, body: string) => (body.trim() ? `<section>\n<h2>${heading}</h2>\n${body}\n</section>` : "");

  const experience = document.experience
    .map((role) =>
      [
        `<h3>${escapeHtml(role.title)}${separator}${escapeHtml(role.employer)}</h3>`,
        `<p class="where">${[role.location, roleDates(role)].filter(Boolean).map(escapeHtml).join(separator)}</p>`,
        list(role.lines),
      ].filter(Boolean).join("\n"),
    )
    .join("\n");
  const projects = document.projects
    .map((project) => [`<h3>${escapeHtml(project.name)}</h3>`, list(project.lines)].join("\n"))
    .join("\n");

  const body = [
    "<header>",
    document.name ? `<h1>${escapeHtml(document.name)}</h1>` : "",
    document.headline ? `<p class="headline">${escapeHtml(document.headline)}</p>` : "",
    document.contact.length ? `<p class="contact">${document.contact.map(escapeHtml).join(separator)}</p>` : "",
    document.links.length ? `<p class="contact">${document.links.map(link).join(separator)}</p>` : "",
    "</header>",
    section(HEADINGS.summary, document.summary ? `<p>${prose(document.summary)}</p>` : ""),
    section(HEADINGS.skills, document.skills.length ? `<p>${document.skills.map(prose).join(", ")}</p>` : ""),
    section(HEADINGS.experience, experience),
    section(HEADINGS.projects, projects),
    section(HEADINGS.other, list(document.other)),
    section(HEADINGS.education, document.education.map((entry) => `<p>${prose(entry)}</p>`).join("\n")),
  ].filter(Boolean).join("\n");

  return [
    "<!doctype html>",
    '<html lang="en">',
    "<head>",
    '<meta charset="utf-8">',
    `<title>${escapeHtml([document.name, "CV"].filter(Boolean).join(" - "))}</title>`,
    `<style>${style(fontPt)}</style>`,
    "</head>",
    "<body>",
    body,
    "</body>",
    "</html>",
    "",
  ].join("\n");
}
