/**
 * CV tuning: the candidate's own CV, rebuilt around one listing.
 *
 * What changes from one listing to the next:
 * - the headline names the role applied for, when every word of that title is something
 *   the CV already says, at a level the candidate has held;
 * - the summary is rewritten to open with what the listing is hiring for, and lines that
 *   describe something the listing calls by another name take on the listing's word for it
 *   (see reword.ts for how far that may go, and what checks it);
 * - the skills line leads with the skills the listing asks for, spelled the listing's way
 *   beside the candidate's ("PostgreSQL (Postgres)"), and takes on the listing's wording
 *   for work the CV still describes in other words;
 * - each role's lines are put in order of how much of the listing they speak to.
 *
 * A term the CV does not back is reported as missing and stays off the page. The printed
 * PDF is then read back the way an applicant tracking system reads it. What that finds
 * wrong is repaired and the CV printed again; what cannot be repaired is reported with the
 * CV, which then holds its application. No other CV is ever sent in its place.
 */

import fs from "node:fs";
import path from "node:path";

import type { Config } from "@/core/config";
import { type AtsCheck, auditCv } from "@/core/cv/ats";
import {
  type CvDocument,
  type CvLine,
  DEFAULT_FONT_PT,
  MIN_FONT_PT,
  baseCv,
  cvLines,
  hasWorkHistory,
  renderCvHtml,
  unprintedLines,
} from "@/core/cv/document";
import {
  type KeywordReport,
  type ListingTerm,
  contains,
  lineSays,
  listingKeywords,
  matchKeywords,
  words,
} from "@/core/cv/keywords";
import { extractPdfText, pdfPageCount } from "@/core/cv/pdfText";
import { rewordLines, rewordSummary, withListingVerb } from "@/core/cv/reword";
import type { Decider, Generator } from "@/core/llm/types";
import {
  type CandidateProfile,
  type CvBullet,
  type CvMatch,
  type FitEvaluation,
  type JobOpportunity,
  PLACEHOLDER,
} from "@/core/models";
import { cleanText } from "@/core/text";

/** There is nothing to build a CV from. */
export class CvTuningError extends Error {}

/** Whether applications are to carry a CV tuned to their listing: the setting is on and there is a work history to build from. */
export function tunesCv(config: Config): boolean {
  return config.pipeline.tune_cv && hasWorkHistory(config);
}

// ---------- The headline ----------

/** Words that say how senior a role is. A CV may only carry one its holder's own titles carry. */
const LEVELS = new Map([
  ["junior", "junior"], ["jr", "junior"], ["mid", "mid"], ["intermediate", "mid"], ["senior", "senior"], ["sr", "senior"],
  ["staff", "staff"], ["principal", "principal"], ["lead", "lead"], ["head", "head"], ["director", "director"],
  ["manager", "manager"], ["vp", "vp"], ["chief", "chief"], ["founding", "founding"], ["distinguished", "distinguished"],
  ["fellow", "fellow"], ["architect", "architect"],
]);
/** What makes a title a role this CV is about at all. */
const ROLE_NOUNS = new Set(["engineer", "developer", "programmer"]);
/** Words of a title that claim nothing. */
const TITLE_FILLER = new Set(["software", "and", "of", "the", "for", "in", "to", "with", "a", "an", "&"]);
/** Where a title stops being a title: "Backend Engineer - Remote (EMEA)", "Engineer | Platform", "Engineer @ Acme". */
const TITLE_END_RX = /\s+[-–—―⏤|@·•:]\s+|:\s+|\s*[([{]/;
/** A grade after the title ("Software Engineer II", "Engineer L5"): the employer's ladder, not a description. */
const GRADE_RX = /\s+(?:I{1,3}|IV|V|VI|[1-6]|L[1-9])$/;
const MAX_HEADLINE_CHARS = 70;

/**
 * The listing's title as a headline for this CV, or null when it is not one the CV can
 * carry: every word of it has to be a word the CV already says, and any level in it one
 * the candidate has held. A part after a comma is kept when it passes and dropped when
 * not ("Senior Software Engineer, Payments" but not ", Berlin").
 */
export function listingHeadline(title: string, document: CvDocument): string | null {
  const held = document.experience.map((role) => role.title);
  const said = new Set(words([...held, ...document.skills, ...cvLines(document)].join("\n")));
  const levels = new Set(held.flatMap((heldTitle) => words(heldTitle)).map((word) => LEVELS.get(word)).filter(Boolean));
  const carried = (part: string): boolean =>
    words(part).every((word) =>
      LEVELS.has(word) ? levels.has(LEVELS.get(word)) : TITLE_FILLER.has(word) || ROLE_NOUNS.has(word) || said.has(word),
    );

  const [first, ...rest] = cleanText(title).split(TITLE_END_RX)[0].replace(GRADE_RX, "").split(/\s*,\s*/);
  // A title ends at its role: what a job board runs on after it ("... Engineer Build AI Agents") is a tagline.
  const named = first.trim().split(/\s+/);
  const role = named.findLastIndex((word) => words(word).some((part) => ROLE_NOUNS.has(part)));
  const lead = named.slice(0, role + 1).join(" ");
  if (role < 0 || !carried(lead)) return null;
  const headline = [lead, ...rest.filter((part) => part.trim() && carried(part)).map((part) => part.trim())].join(", ");
  return headline.length <= MAX_HEADLINE_CHARS ? headline : null;
}

// ---------- Skills and lines ----------

const capitalised = (term: string): string => (/^[a-z]/.test(term) ? term[0].toUpperCase() + term.slice(1) : term);

/**
 * The skills line for this listing: the candidate's skills the listing asks for, in the
 * listing's order and with its spelling alongside where that differs; then the listing's
 * wording for work the CV describes in other words; then every other skill, in the
 * candidate's own order.
 */
function tunedSkills(skills: readonly string[], report: KeywordReport): string[] {
  /** Each skill the listing asks for, with the spellings the listing uses that the page does not yet print. */
  const asked = new Map<string, string[]>();
  const reworded: string[] = [];
  for (const match of report.matched) {
    if (match.skill) {
      const spellings = asked.get(match.skill) ?? [];
      if (!match.verbatim) spellings.push(match.term);
      asked.set(match.skill, spellings);
    } else if (!match.verbatim) {
      reworded.push(capitalised(match.term));
    }
  }
  // "RESTful APIs" already prints "RESTful": a spelling inside another one is not repeated.
  const distinct = (spellings: readonly string[]) =>
    spellings.filter((spelling) => !spellings.some((other) => other !== spelling && contains(other, spelling)));
  return [
    ...Array.from(asked, ([skill, spellings]) => (spellings.length ? `${skill} (${distinct(spellings).join(", ")})` : skill)),
    ...distinct(reworded),
    ...skills.filter((skill) => !asked.has(skill.trim())),
  ];
}

/**
 * `lines` with those that speak to more of the listing first. A line speaks to a term when
 * it says it, in the listing's spelling or the candidate's own ("Golang" is answered by a
 * line about Go). Earlier terms weigh more; ties keep their order.
 */
function byRelevance(lines: readonly CvLine[], report: KeywordReport): CvLine[] {
  const own = new Map(report.matched.map((match) => [match.term, match.skill]));
  const speaksTo = (line: CvLine, term: string) => {
    const skill = own.get(term);
    return lineSays(line.text, term) || (skill !== undefined && lineSays(line.text, skill));
  };
  const weight = (line: CvLine) =>
    report.asked.reduce((total, term, index) => total + (speaksTo(line, term) ? report.asked.length - index : 0), 0);
  return lines
    .map((line, order) => ({ line, order, weight: weight(line) }))
    .sort((a, b) => b.weight - a.weight || a.order - b.order)
    .map(({ line }) => line);
}

/** `document` with every line passed through `change`, in place and in order. */
function withLines(document: CvDocument, change: (line: CvLine) => CvLine): CvDocument {
  return {
    ...document,
    experience: document.experience.map((role) => ({ ...role, lines: role.lines.map(change) })),
    projects: document.projects.map((project) => ({ ...project, lines: project.lines.map(change) })),
    other: document.other.map(change),
  };
}

/** The lines of a CV that state a verified achievement: the ones that may be reworded, and that the Cop Tool inspects. */
function achievementLines(document: CvDocument): CvLine[] {
  return [
    ...document.experience.flatMap((role) => role.lines),
    ...document.projects.flatMap((project) => project.lines),
    ...document.other,
  ].filter((line) => line.achievementId !== undefined);
}

/** How the listing's terms line up with `document` as it stands. */
function matchAgainst(document: CvDocument, terms: readonly ListingTerm[], profile: CandidateProfile): KeywordReport {
  return matchKeywords(terms.map(({ term }) => term), {
    skills: document.skills, lines: cvLines(document), unprinted: unprintedLines(profile),
  });
}

/** `document` rebuilt around a listing whose terms have been matched against it. Nothing is added to what it says. */
export function tuneCv(document: CvDocument, job: Pick<JobOpportunity, "title">, report: KeywordReport): CvDocument {
  return {
    ...document,
    headline: listingHeadline(job.title, document) ?? document.headline,
    skills: tunedSkills(document.skills, report),
    experience: document.experience.map((role) => ({ ...role, lines: byRelevance(role.lines, report) })),
    projects: document.projects.map((project) => ({ ...project, lines: byRelevance(project.lines, report) })),
    other: byRelevance(document.other, report),
  };
}

// ---------- Working a CV out for a listing ----------

export interface TuningRequest {
  config: Config;
  profile: CandidateProfile;
  job: JobOpportunity;
  fit: Pick<FitEvaluation, "matchedSkills" | "missingSkills">;
  /**
   * Reads the listing for the terms it asks for, and proposes rewordings. Null: only the
   * listing's skill list and the candidate's own skills are looked for, and nothing is reworded.
   */
  generator: Generator | null;
  /** Confirms that a rewording adds nothing. Without it nothing a model wrote is printed. */
  decider?: Decider | null;
  /** The headline when neither the listing's title nor a role of the candidate's gives one. */
  fallbackHeadline?: string;
}

/** A CV worked out for one listing and not yet printed. */
export interface PreparedCv {
  /** The candidate's CV in their own wording, under the headline it will carry. */
  base: CvDocument;
  profile: CandidateProfile;
  job: JobOpportunity;
  terms: ListingTerm[];
  /** The summary written for this listing; "" when the candidate's own is printed. */
  summary: string;
  /** Every achievement line of the CV, worded as it will print. */
  bullets: CvBullet[];
}

/**
 * Work out the CV for `job`: read the listing, choose the headline, and word the summary
 * and the achievement lines its way as far as the checks allow. Nothing is printed.
 * Throws CvTuningError when there is no work history to build from, and
 * CircuitBreakerError through when the spend cap stops a model call.
 */
export async function prepareCv(request: TuningRequest): Promise<PreparedCv> {
  const { config, profile, job, fit, generator } = request;
  if (!hasWorkHistory(config)) {
    throw new CvTuningError("No work history to build a CV from: list your roles under candidate.experience");
  }
  const own = baseCv(config, profile, request.fallbackHeadline);
  const base = { ...own, headline: listingHeadline(job.title, own) ?? own.headline };
  const terms = await listingKeywords(generator, job, fit, base.skills);

  // The listing's verbs first: they cost nothing and claim nothing.
  const listing = cleanText(`${job.title}\n${job.description}`);
  let worded = withLines(base, (line) => (line.achievementId ? { ...line, text: withListingVerb(line.text, listing) } : line));
  let summary = "";
  if (generator && request.decider) {
    const notes = config.candidate.screening_notes.trim();
    const asking = {
      generator, decider: request.decider, confidence: config.pipeline.answer_confidence, job, profile, terms,
      extraFacts: notes.includes(PLACEHOLDER) ? "" : notes,
    };
    const rewordings = await rewordLines({ ...asking, document: worded, report: matchAgainst(worded, terms, profile) });
    worded = withLines(worded, (line) => {
      const text = line.achievementId ? rewordings.get(line.achievementId) : undefined;
      return text ? { ...line, text } : line;
    });
    // The summary is written last, from the CV as it will print.
    const report = matchAgainst(worded, terms, profile);
    summary = await rewordSummary({ ...asking, document: worded, report }, byRelevance(achievementLines(worded), report));
  }
  const bullets = achievementLines(worded).map((line) => ({ text: line.text, achievementId: line.achievementId ?? "" }));
  return { base, profile, job, terms, summary, bullets };
}

/** The wording a prepared CV is printed in. Normally its own; after an inspection, what the inspection left. */
export interface CvWording {
  summary?: string;
  bullets: readonly CvBullet[];
}

/** The page for a prepared CV in the given wording, and how the listing's terms line up with it. */
export function composeCv(prepared: PreparedCv, wording: CvWording = prepared): { document: CvDocument; report: KeywordReport } {
  const text = new Map(wording.bullets.map((bullet) => [bullet.achievementId, bullet.text.trim()]));
  const worded = withLines({ ...prepared.base, summary: wording.summary?.trim() || prepared.base.summary }, (line) => {
    const printed = line.achievementId ? text.get(line.achievementId) : undefined;
    return printed ? { ...line, text: printed } : line;
  });
  const report = matchAgainst(worded, prepared.terms, prepared.profile);
  return { document: tuneCv(worded, prepared.job, report), report };
}

// ---------- Printing and reading back ----------

export interface TunedCv {
  document: CvDocument;
  match: CvMatch;
  /** What was read back from the printed file, check by check. */
  checks: AtsCheck[];
}

/** Characters a font may draw as one glyph, or a parser may not read as typed, put as plain ones. */
function parserSafe(text: string): string {
  return text
    .normalize("NFKC")
    .replace(/[‘’‚′]/g, "'")
    .replace(/[“”„″]/g, '"')
    .replace(/[‐‑‒–—―−]/g, "-")
    .replace(/[­​-‍⁠﻿]/g, "")
    .replace(/ /g, " ");
}

/**
 * `document` with what a failed read-back points at put right: every text in plain
 * characters, and each term that was not read back set on the skills line in its own
 * right, where no layout or line end can come between it and a parser.
 */
function repaired(document: CvDocument, unread: readonly string[]): CvDocument {
  const plain = withLines(
    {
      ...document,
      name: parserSafe(document.name), headline: parserSafe(document.headline), summary: parserSafe(document.summary),
      contact: document.contact.map(parserSafe), skills: document.skills.map(parserSafe),
      education: document.education.map(parserSafe),
      experience: document.experience.map((role) => ({
        ...role, title: parserSafe(role.title), employer: parserSafe(role.employer), location: parserSafe(role.location),
        start: parserSafe(role.start), end: parserSafe(role.end),
      })),
      projects: document.projects.map((project) => ({ ...project, name: parserSafe(project.name) })),
    },
    (line) => ({ ...line, text: parserSafe(line.text) }),
  );
  const listed = plain.skills.join("\n");
  return { ...plain, skills: [...plain.skills, ...unread.filter((term) => !contains(listed, term)).map(capitalised)] };
}

type Printer = (html: string, outputPath: string) => Promise<void>;

/** Print `document` at `outputPath`; if it runs past one page, once more in smaller type, kept only if that fits. */
async function print(document: CvDocument, renderPdf: Printer, outputPath: string): Promise<void> {
  await renderPdf(renderCvHtml(document, DEFAULT_FONT_PT), outputPath);
  if (pdfPageCount(outputPath) <= 1) return;
  const tighter = path.join(path.dirname(outputPath), `.fit-${path.basename(outputPath)}`);
  await renderPdf(renderCvHtml(document, MIN_FONT_PT), tighter);
  if (pdfPageCount(tighter) === 1) await fs.promises.rename(tighter, outputPath);
  else await fs.promises.rm(tighter, { force: true });
}

/**
 * Print a prepared CV to `outputPath` in `wording` and read it back. A print that does not
 * read back whole is repaired and printed once more; whatever is still wrong after that is
 * returned in `match.problems`, with the file left in place for whoever reads that report.
 */
export async function printCv(
  prepared: PreparedCv,
  renderPdf: Printer,
  outputPath: string,
  wording: CvWording = prepared,
): Promise<TunedCv> {
  const composed = composeCv(prepared, wording);
  const matched = composed.report.matched.map((match) => match.term);
  let { document } = composed;
  await print(document, renderPdf, outputPath);
  let checks = auditCv(extractPdfText(outputPath), document, matched);
  if (checks.some((check) => !check.ok)) {
    document = repaired(document, checks.find((check) => check.name === "Keywords")?.unread ?? []);
    await print(document, renderPdf, outputPath);
    checks = auditCv(extractPdfText(outputPath), document, matched);
  }
  return {
    document,
    checks,
    match: {
      headline: document.headline, asked: composed.report.asked, matched, missing: composed.report.missing,
      pages: pdfPageCount(outputPath),
      problems: checks.filter((check) => !check.ok).map((check) => `${check.name}: ${check.detail}`),
    },
  };
}

/** Work out the CV for a listing and print it: `prepareCv`, then `printCv`. */
export async function writeTunedCv(
  request: TuningRequest & { renderPdf: Printer; outputPath: string },
): Promise<TunedCv & { prepared: PreparedCv }> {
  const prepared = await prepareCv(request);
  return { ...(await printCv(prepared, request.renderPdf, request.outputPath)), prepared };
}
