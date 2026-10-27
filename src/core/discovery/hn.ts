/**
 * Hacker News "Ask HN: Who is hiring?", read through the Algolia search API.
 *
 * Each top-level comment on the monthly thread is one listing, usually posted by a
 * founder or an engineer on the team, which is why these go to the founder-direct
 * channel. The first line conventionally reads
 * `Company | Role | Location | REMOTE | Full-time | $150k`, but nothing enforces it:
 * the order varies, parts are missing, and the thread also collects job seekers and
 * recruiters posting in the wrong place.
 *
 * So the header is parsed heuristically, and a comment is skipped unless both a company
 * and a role can be read from it. Nothing is invented: a listing that cannot be parsed
 * is lost, which is cheaper than a pitch addressed to the wrong company. The full
 * comment is kept as the description, so the eligibility scorer still sees every word.
 *
 * The monthly "Freelancer? Seeking freelancer?" thread is read with the same machinery:
 * its "SEEKING FREELANCER" posts are contract gigs.
 */

import { z } from "zod";

import {
  type EmploymentType,
  type FetchJson,
  joinLocations,
  mapEmploymentType,
  readEnvelope,
  readListings,
  toIsoTimestamp,
} from "@/core/discovery/types";
import { type JobOpportunity, Channel, createJob } from "@/core/models";
import { unescapeHtml } from "@/core/text";

const API = "https://hn.algolia.com/api/v1";
/** The same account also posts "Who wants to be hired?" every month; only this title is a hiring thread. */
const THREAD_TITLE_RX = /^Ask HN: Who is hiring\?/i;

/**
 * "Ask HN: Freelancer? Seeking freelancer?" runs on the same monthly cadence for contract
 * work. The `whoishiring` account stopped posting it in late 2025 and members have posted
 * it since, so it is found by its title, whoever the author is.
 */
const FREELANCE_TITLE_RX = /^Ask HN: Freelancer\? Seeking freelancer\?/i;
/** A client's post opens with this; a freelancer's with "SEEKING WORK", and those are not listings. */
const SEEKING_FREELANCER_RX = /^seeking\s+freelancers?\b[\s|:\-–—]*/i;

const PageSchema = z.object({ hits: z.array(z.unknown()), nbPages: z.number().nullish() });
const StorySchema = z.object({ objectID: z.string(), title: z.string().nullish(), num_comments: z.number().nullish() });
const CommentSchema = z.object({
  objectID: z.string(),
  /** The poster's Hacker News handle. */
  author: z.string().nullish(),
  /** HTML: paragraphs open with <p>, links are <a>, punctuation is entity-escaped ("&#x2F;"). */
  comment_text: z.string().nullish(),
  created_at: z.string().nullish(),
  /** Equals the story id for a top-level comment. */
  parent_id: z.number().nullish(),
});
export type HnComment = z.infer<typeof CommentSchema>;

export interface HnOptions {
  /** Comments per request; Algolia allows up to 1000. */
  hitsPerPage?: number;
  /** Upper bound on the pages read from one thread. */
  maxPages?: number;
  /**
   * Called with the HTML of every top-level comment, whether or not it parses into a
   * listing. A post that names no role in its header still links to its company's job
   * board, and discovery follows those links.
   */
  onComment?: (commentHtml: string) => void;
}

export function hnThreadsUrl(): string {
  return `${API}/search_by_date?tags=story,author_whoishiring&hitsPerPage=12`;
}

/** The latest stories that mention the freelancer thread's title, newest first. */
export function hnFreelanceThreadsUrl(): string {
  return `${API}/search_by_date?tags=story&query=${encodeURIComponent('"Seeking freelancer"')}&hitsPerPage=12`;
}

/** One page of the thread's top-level comments, newest first. */
export function hnCommentsUrl(storyId: string, page: number, hitsPerPage: number): string {
  return (
    `${API}/search_by_date?tags=comment,story_${storyId}` +
    `&numericFilters=parent_id=${storyId}&hitsPerPage=${hitsPerPage}&page=${page}`
  );
}

export function hnItemUrl(commentId: string): string {
  return `https://news.ycombinator.com/item?id=${commentId}`;
}

// ---------- Header vocabulary ----------

/** Job-title nouns. A first segment containing one is a role, not a company name. */
const ROLE_RX =
  /\b(?:engineers?|engineering|developers?|programmers?|scientists?|researchers?|designers?|architects?|managers?|leads?|head of|directors?|(?:co-?)?founders?|cto|swe|sre|sdet|devops|analysts?|specialists?|consultants?|recruiters?|marketers?|advocates?|interns?|generalists?|technicians?|member of technical staff|mts|fde|sales|roles|positions)\b/i;
/** Disciplines that mark a header segment as the role even when the title noun is missing or misspelt. */
const DISCIPLINE_RX = /\b(?:machine learning|data science|full[- ]?stack|front[- ]?end|back[- ]?end)\b/i;
/** Stricter than ROLE_RX: in the body a role must name a job, not just say "roles". */
const BODY_ROLE_RX =
  /\b(?:engineers?|developers?|programmers?|scientists?|researchers?|designers?|architects?|managers?|leads?|head of|directors?|cto|swe|sre|sdet|devops|analysts?|specialists?|recruiters?|advocates?|interns?|technicians?|member of technical staff)\b/i;
/** A body line that is a sentence or a pointer ("See all openings: ...") rather than a job title. */
const BODY_PROSE_RX =
  /^(?:we|if|please|apply|see|more|learn|check|read|our|you|i|to|for|all|full|details?|info|website|careers?|jobs?|email|contact|questions?)\b|\b(?:is|are|we|you|your|our)\b/i;

const WORKPLACE_RX = /\b(?:remote(?:ly)?|on-?site|hybrid|in[- ]office|in[- ]person|wfh|work from home)\b/i;
const COMPENSATION_RX = /[$€£]\s?\d|\b\d{2,3}\s?k\b/i;
const URL_ONLY_RX = /^(?:https?:\/\/)?(?:[a-z0-9-]+\.)+[a-z]{2,}(?:[/?#]\S*)?$/i;
const URL_IN_TEXT_RX = /(?:https?:\/\/)?(?:[a-z0-9-]+\.)+[a-z]{2,}(?:\/[^\s)|,]*)?/gi;

const PLACE_NAMES = [
  "anywhere", "worldwide", "world-wide", "global", "globally", "international",
  "united states", "united kingdom", "north america", "south america", "latin america", "europe", "european",
  "americas?", "africa", "asia", "canada", "germany", "france", "netherlands", "spain", "portugal", "poland",
  "ireland", "switzerland", "sweden", "denmark", "norway", "finland", "belgium", "austria", "italy", "india",
  "japan", "singapore", "australia", "brazil", "mexico", "israel",
  "bay area", "san francisco", "new york", "los angeles", "seattle", "boston", "austin", "chicago", "denver",
  "london", "berlin", "paris", "amsterdam", "zurich", "dublin", "toronto", "vancouver", "montreal",
  "bangalore", "bengaluru", "tokyo", "hong kong", "sydney", "tel aviv", "munich", "stockholm", "copenhagen",
  "barcelona", "madrid", "lisbon", "warsaw", "time ?zones?",
];
const PLACE_NAME_RX = new RegExp(`\\b(?:${PLACE_NAMES.join("|")})\\b`, "i");
// Case-sensitive: "US" is a country, "us" is a pronoun.
const PLACE_CODE_RX = /\b(?:USA?|UK|EU|EMEA|APAC|LATAM|NYC|SF|UTC|GMT|CET|CEST|EST|PST)\b/;
// "Austin, TX" or "Utrecht, NL": a two-letter state or country code after a comma.
const REGION_CODE_RX =
  /,\s?(?:AL|AK|AZ|AR|CA|CO|CT|DC|DE|FL|GA|HI|ID|IL|IN|IA|KS|KY|LA|ME|MD|MA|MI|MN|MS|MO|MT|NE|NV|NH|NJ|NM|NY|NC|ND|OH|OK|OR|PA|RI|SC|SD|TN|TX|UT|VT|VA|WA|WV|WI|WY|NL|FR|ES|IT|PT|PL|IE|CH|SE|DK|NO|FI|BE|AT|JP|SG|AU|BR|MX|GB)\b/;

/** Job seekers answering the wrong thread with the "Who wants to be hired?" template. */
const SEEKER_RX = /^(?:location|remote|willing to relocate|technologies|r[ée]sum[ée]|email|seeking)\b/i;
/** A first segment that reads as a sentence or a condition is not a company name. */
const NOT_A_NAME_RX =
  /\b(?:we|we're|i|i'm|our|is|are|hiring|looking|join|apply|hello)\b|^(?:fully\s+)?(?:remote|on-?site|hybrid|full[\s-]?time|part[\s-]?time|contract|freelance|internship)\b/i;
/** Posters who do not name the employer ("Stealth startup", "Small prop-trading firm"). */
const ANONYMOUS_RX =
  /\b(?:stealth|start-?up)\b|^(?:a|an|small|early[- ]stage|seed[- ]stage|well[- ]funded|fast[- ]growing|(?:vc|yc)[- ]backed)\b/i;
/** Subdomains that host a careers page rather than naming the company. */
const GENERIC_SUBDOMAIN_RX = /^(?:www|careers?|jobs?|apply|join|work|hire|boards?|about)\./;
/** Hosted ATS pages and profiles: "acme.applytojob.com" carries the company's name but is not its domain. */
const HOSTED_ELSEWHERE_RX =
  /(?:^|\.)(?:applytojob\.com|greenhouse\.io|lever\.co|ashbyhq\.com|workable\.com|breezy\.hr|bamboohr\.com|recruitee\.com|teamtailor\.com|personio\.(?:com|de)|smartrecruiters\.com|myworkdayjobs\.com|rippling\.com|jobvite\.com|icims\.com|pinpointhq\.com|notion\.site|linkedin\.com|github\.com|wellfound\.com|ycombinator\.com|workatastartup\.com|substack\.com|medium\.com|typeform\.com|google\.com)$/;

// ---------- Text helpers ----------

/**
 * One line of comment HTML as plain text: tags dropped, entities decoded, whitespace collapsed.
 * Lines are already split at paragraphs, so what is left is inline markup (links, italics)
 * and removing it leaves the words exactly as they render.
 */
function plainText(html: string): string {
  return unescapeHtml(html.replace(/<[^>]*>/g, "")).replace(/\s+/g, " ").trim();
}

/** The comment as raw HTML lines; a new paragraph and a single line break both start a line. */
function htmlLines(commentHtml: string): string[] {
  return commentHtml
    .split(/<p>|\n/i)
    .map((line) => line.trim())
    .filter(Boolean);
}

/** The comment's first line as plain text. The listing header, when there is one. */
export function hnFirstLine(commentHtml: string): string {
  const [first = ""] = htmlLines(commentHtml);
  return plainText(first);
}

const alphanumeric = (text: string) => text.toLowerCase().replace(/[^a-z0-9]/g, "");
const trimPunctuation = (text: string) => text.replace(/^[\s\-–—:*•·>]+|[\s\-–—:,|>]+$/g, "");

/** Split the header on pipes, or on spaced dashes when the poster used those instead. */
function headerSegments(header: string): string[] {
  for (const separator of [/\|/, /\s[—–]\s/]) {
    const parts = header.split(separator).map(trimPunctuation).filter(Boolean);
    if (parts.length >= 2) return parts;
  }
  return [];
}

function isUrlOnly(segment: string): boolean {
  return URL_ONLY_RX.test(segment);
}

function isRole(segment: string): boolean {
  return segment.length <= 140 && !isUrlOnly(segment) && (ROLE_RX.test(segment) || DISCIPLINE_RX.test(segment));
}

function isLocation(segment: string): boolean {
  if (isUrlOnly(segment)) return false;
  if (WORKPLACE_RX.test(segment)) return true;
  if (COMPENSATION_RX.test(segment)) return false;
  return PLACE_NAME_RX.test(segment) || PLACE_CODE_RX.test(segment) || REGION_CODE_RX.test(segment);
}

/**
 * The company name from the header's first segment, or null if that segment is not a name.
 *
 * Parenthetical notes are dropped ("Superset (YC P26)", "Chronograph (chronograph.pe)").
 * A segment that reads as a role, a sentence, a condition or a link to a page means the
 * poster did not lead with the company, and the comment is skipped. So is a poster who
 * withholds the name: "Stealth startup" would make unrelated employers look like one.
 */
function companyName(segment: string): string | null {
  const name = trimPunctuation(segment.replace(/\s*[([][^)\]]*[)\]]/g, " ").replace(/\s+/g, " "));
  if (!name || name.length > 60 || name.split(" ").length > 6) return null;
  if (/^https?:\/\//i.test(name) || /[/?#]/.test(name)) return null;
  const notAName = [SEEKER_RX, NOT_A_NAME_RX, ANONYMOUS_RX, ROLE_RX, DISCIPLINE_RX, COMPENSATION_RX];
  return notAName.some((pattern) => pattern.test(name)) ? null : name;
}

/**
 * The company's own domain, when the header states it.
 *
 * Posters put their site next to the name ("Coder | https://coder.com/") but headers
 * also carry links to ATS pages and URL shorteners. A link is only accepted when its
 * host shares a name with the company ("coastpay.com" for "Coast"), so an application
 * link is never mistaken for the employer's domain.
 */
function statedDomain(company: string, segments: readonly string[]): string {
  const key = alphanumeric(company);
  const candidates = [...(segments[0].match(URL_IN_TEXT_RX) ?? []), ...segments.slice(1).filter(isUrlOnly)];
  for (const candidate of candidates) {
    let host: string;
    try {
      host = new URL(/^https?:\/\//i.test(candidate) ? candidate : `https://${candidate}`).host.toLowerCase();
    } catch {
      continue;
    }
    if (HOSTED_ELSEWHERE_RX.test(host)) continue;
    const domain = host.replace(GENERIC_SUBDOMAIN_RX, "");
    const labels = domain.split(".").slice(0, -1);
    const sharesName = (label: string) => label.length >= 3 && (key.includes(label) || (key.length >= 3 && label.includes(key)));
    if (labels.some(sharesName)) return domain;
  }
  return "";
}

/**
 * Roles listed in the body as "Title: link" lines, the usual shape when the header
 * names only the company ("Roles: - Flight Software Engineer: https://...").
 */
function rolesFromBody(lines: readonly string[]): string {
  const roles: string[] = [];
  for (const line of lines) {
    if (!/<a\s/i.test(line)) continue;
    const beforeLink = plainText(line).split(/https?:\/\//i)[0];
    const label = beforeLink
      .replace(/^[\s\-*•·–—>]+/, "")
      .replace(/^(?:roles?|positions?|openings?)\s*:\s*/i, "")
      // Cut trailing detail after a spaced dash, unless the dash sits inside parentheses ("($148K – $255K)").
      .split(/\s[—–|]\s(?![^()]*\))/)[0]
      .replace(/(?:\bapply(?:\s+here)?)?[\s\-–—=>:|]*$/i, "")
      .trim();
    if (label.length < 3 || label.length > 90 || label.split(/\s+/).length > 10) continue;
    if (!BODY_ROLE_RX.test(label) || BODY_PROSE_RX.test(label)) continue;
    // The same title is often listed once per office.
    if (roles.some((role) => role.toLowerCase() === label.toLowerCase())) continue;
    roles.push(label);
    if (roles.length === 3) break;
  }
  return roles.join(", ");
}

/** What a hiring comment states about the job, read from its header line. */
export interface HnListing {
  company: string;
  /** The role, or up to three roles when the comment lists several. */
  title: string;
  location: string;
  employmentType: EmploymentType;
  companyDomain: string;
}

/** Parse one comment's HTML. Null when no company or no role can be read from it. */
export function parseHnListing(commentHtml: string): HnListing | null {
  const lines = htmlLines(commentHtml);
  if (lines.length === 0) return null;
  const segments = headerSegments(plainText(lines[0]));
  if (segments.length < 2) return null;

  const company = companyName(segments[0]);
  if (!company) return null;
  const rest = segments.slice(1);

  // A role segment can open with a condition ("Remote Senior Engineer"); prefer one that does not.
  const roleSegment = rest.find((part) => isRole(part) && !NOT_A_NAME_RX.test(part)) ?? rest.find(isRole);
  const title = roleSegment
    ? trimPunctuation(roleSegment.replace(/https?:\/\/\S+/gi, " ").replace(/\s+/g, " "))
    : rolesFromBody(lines.slice(1));
  if (!title) return null;

  // A place noted beside the company name ("Flowstate (London, UK)") is part of the location too.
  const besideCompany = [...segments[0].matchAll(/[([]([^)\]]*)[)\]]/g)].map((match) => match[1]);
  const location = joinLocations([...besideCompany, ...rest.filter((part) => part !== roleSegment)].filter(isLocation));

  return {
    company,
    title,
    location,
    employmentType: mapEmploymentType(rest.join(" | ")),
    companyDomain: statedDomain(company, segments),
  };
}

/** Turn one top-level comment into a job, or null when it is not a parseable listing. */
export function parseHnComment(comment: HnComment): JobOpportunity | null {
  const text = (comment.comment_text ?? "").trim();
  const listing = parseHnListing(text);
  if (!listing) return null;
  return createJob({
    source: "hn",
    // Comment ids are unique across Hacker News and never change.
    sourceId: comment.objectID,
    ...listing,
    description: text,
    applyUrl: hnItemUrl(comment.objectID),
    channel: Channel.FOUNDER_DIRECT,
    // HN has no structured remote flag or pay; "REMOTE" in the header is wording for the scorer to read.
    isRemote: null,
    postedAt: toIsoTimestamp(comment.created_at),
  });
}

/**
 * Parse one comment of the freelancer thread. Null unless it opens with "SEEKING FREELANCER".
 *
 * These posts are looser than hiring posts: most are one person or a small team asking
 * for help, and the header often says only where the freelancer may be. So a post is
 * kept on what it does state. With no company named, the poster's handle stands in,
 * marked as a Hacker News user; with no role named, the title is the thread's own word,
 * "Freelancer". The whole post is the description, and the reply is the user's to send.
 */
export function parseHnGig(commentHtml: string, author: string): HnListing | null {
  const lines = htmlLines(commentHtml);
  const header = plainText(lines[0] ?? "");
  if (!SEEKING_FREELANCER_RX.test(header)) return null;
  const parts = header
    .replace(SEEKING_FREELANCER_RX, "")
    .split(/\||\s[—–]\s/)
    .map(trimPunctuation)
    .filter(Boolean);

  const places = parts.filter(isLocation);
  const roleSegment = parts.find((part) => !places.includes(part) && isRole(part));
  const named = parts
    .filter((part) => !places.includes(part) && part !== roleSegment)
    .map((part) => ({ part, name: companyName(part) }))
    .find((candidate) => candidate.name !== null);
  const handle = author.trim();
  if (!named && !handle) return null;

  const company = named?.name ?? `${handle} (Hacker News user)`;
  return {
    company,
    title: roleSegment ? trimPunctuation(roleSegment.replace(/https?:\/\/\S+/gi, " ").replace(/\s+/g, " ")) : "Freelancer",
    location: joinLocations(places),
    // The thread is for contract work; nobody posts a salaried job here.
    employmentType: "contract",
    companyDomain: named ? statedDomain(company, [named.part, ...parts.filter((part) => part !== named.part)]) : "",
  };
}

/** Turn one top-level comment of the freelancer thread into a job, or null when it is not a client's post. */
export function parseHnGigComment(comment: HnComment): JobOpportunity | null {
  const text = (comment.comment_text ?? "").trim();
  const gig = parseHnGig(text, comment.author ?? "");
  if (!gig) return null;
  return createJob({
    source: "hn_freelance",
    sourceId: comment.objectID,
    ...gig,
    description: text,
    applyUrl: hnItemUrl(comment.objectID),
    channel: Channel.CONTRACT_GIGS,
    isRemote: null,
    postedAt: toIsoTimestamp(comment.created_at),
  });
}

/** Every top-level comment of the thread `storyId` that `parse` turns into a job, one page at a time. */
async function threadListings(
  fetchJson: FetchJson,
  storyId: string,
  parse: (comment: HnComment) => JobOpportunity | null,
  options: HnOptions,
): Promise<JobOpportunity[]> {
  const { hitsPerPage = 100, maxPages = 20, onComment } = options;
  const jobs: JobOpportunity[] = [];
  for (let page = 0; page < maxPages; page += 1) {
    const result = readEnvelope(PageSchema, await fetchJson(hnCommentsUrl(storyId, page, hitsPerPage)));
    for (const comment of readListings(CommentSchema, result.hits)) {
      // The query already asks for top-level comments only; this holds if the filter is ever ignored.
      if (typeof comment.parent_id === "number" && String(comment.parent_id) !== storyId) continue;
      onComment?.(comment.comment_text ?? "");
      const job = parse(comment);
      if (job) jobs.push(job);
    }
    if (result.hits.length === 0 || page + 1 >= (result.nbPages ?? 0)) break;
  }
  return jobs;
}

/**
 * Listings from the latest monthly "Who is hiring?" thread.
 *
 * Finds the newest thread posted by the `whoishiring` account, then pages through its
 * top-level comments one request at a time. Throws if the thread cannot be found or a
 * page cannot be read.
 */
export async function fetchHnWhoIsHiring(fetchJson: FetchJson, options: HnOptions = {}): Promise<JobOpportunity[]> {
  const stories = readEnvelope(PageSchema, await fetchJson(hnThreadsUrl()));
  // Results are newest first, so the first matching title is the current month's thread.
  const thread = readListings(StorySchema, stories.hits).find((story) => THREAD_TITLE_RX.test(story.title ?? ""));
  if (!thread) throw new Error('no "Who is hiring?" thread among the latest whoishiring stories');
  return threadListings(fetchJson, thread.objectID, parseHnComment, options);
}

/**
 * Contract gigs from the latest monthly "Freelancer? Seeking freelancer?" thread: the
 * posts that open with "SEEKING FREELANCER". Most months there are one or two.
 *
 * Throws if no such thread is among the latest stories or a page cannot be read.
 */
export async function fetchHnFreelance(fetchJson: FetchJson, options: HnOptions = {}): Promise<JobOpportunity[]> {
  const stories = readEnvelope(PageSchema, await fetchJson(hnFreelanceThreadsUrl()));
  const threads = readListings(StorySchema, stories.hits).filter((story) => FREELANCE_TITLE_RX.test(story.title ?? ""));
  if (threads.length === 0) throw new Error('no "Freelancer? Seeking freelancer?" thread among the latest stories');
  // Results are newest first. Anyone may post the thread and some months two people do:
  // of the newest month's, the one people answered is the thread.
  const thread = threads
    .filter((story) => story.title === threads[0].title)
    .reduce((best, story) => ((story.num_comments ?? 0) > (best.num_comments ?? 0) ? story : best));
  return threadListings(fetchJson, thread.objectID, parseHnGigComment, options);
}
