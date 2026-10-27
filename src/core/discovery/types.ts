/**
 * Shared plumbing for the job-discovery sources.
 *
 * Discovery only fetches public listings and normalises them into JobOpportunity
 * records. It stores no listing and never calls an LLM: deciding whether a listing is
 * eligible, and persisting it, belong to the qualification module. That
 * module reads the wording of `location` and `description`, so the sources pass the
 * provider's text through untouched and only fill the structured fields (remote flag,
 * employment type, compensation) from what the provider states as data.
 */

import { z } from "zod";

import { Channel } from "@/core/models";

/** GET `url` and return the decoded JSON body. Injected in tests so they never touch the network. */
export type FetchJson = (url: string) => Promise<unknown>;

/** GET `url` and return the body as text: the RSS and XML feeds. Injected in tests like FetchJson. */
export type FetchText = (url: string) => Promise<string>;

/** JobOpportunity.employmentType values a source may set. */
export type EmploymentType = "" | "full_time" | "contract" | "fractional";

/** JobOpportunity.compPeriod values a source may set. */
export type CompPeriod = "hour" | "month" | "year";

/** Structured pay as stated by the provider; never parsed out of prose. */
export interface Compensation {
  compMin: number | null;
  compMax: number | null;
  compPeriod: CompPeriod;
  compCurrency: string;
}

/**
 * Says what is asking and why, so a feed's operator can tell Reygent from a crawler and
 * can block it by name. It carries nothing that identifies the user.
 */
export const USER_AGENT = "reygent/0.2 (personal job-search tool; reads public job feeds)";

/** The provider answered with an error status (unknown board, rate limit, outage). */
export class FetchError extends Error {
  constructor(
    readonly status: number,
    readonly url: string,
    readonly body: string,
  ) {
    super(`HTTP ${status} from ${url}${body ? `: ${body}` : ""}`);
    this.name = "FetchError";
  }
}

export interface FetchJsonOptions {
  timeoutMs?: number;
  /** Minimum gap between two requests to the same host. */
  minHostIntervalMs?: number;
  /** The fetch implementation; replaced in tests. */
  fetchImpl?: typeof fetch;
}

export interface HttpClient {
  fetchJson: FetchJson;
  fetchText: FetchText;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Build the real HTTP client: GET with a timeout, a Reygent User-Agent, and an error on
 * any non-2xx status.
 *
 * A host is asked for one thing at a time, with a short gap before the next. These are
 * free, unauthenticated endpoints, and a cycle can ask one host for dozens of boards or
 * several pages of a feed; queueing keeps Reygent a polite client however many sources
 * are configured, and whichever of the two readers they go through. There are no retries:
 * a source that fails is reported and tried again when it is next due.
 */
export function createHttpClient(options: FetchJsonOptions = {}): HttpClient {
  // The feeds run to a megabyte or two and some hosts are slow to start sending.
  const { timeoutMs = 45_000, minHostIntervalMs = 300, fetchImpl } = options;
  /** Per host, the request the next one must wait for, and when that one started. */
  const lastByHost = new Map<string, { done: Promise<void>; startedAt: number }>();

  const get = async (url: string, accept: string): Promise<Response> => {
    const host = new URL(url).host;
    const previous = lastByHost.get(host);
    let release = () => {};
    const entry = { done: new Promise<void>((resolve) => (release = resolve)), startedAt: 0 };
    lastByHost.set(host, entry);
    if (previous) {
      await previous.done;
      const wait = previous.startedAt + minHostIntervalMs - Date.now();
      if (wait > 0) await sleep(wait);
    }
    entry.startedAt = Date.now();
    try {
      // The global is looked up per request, so a test that stubs `fetch` is honoured.
      const response = await (fetchImpl ?? fetch)(url, {
        headers: { Accept: accept, "User-Agent": USER_AGENT },
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!response.ok) {
        const body = (await response.text()).replace(/\s+/g, " ").trim().slice(0, 200);
        throw new FetchError(response.status, url, body);
      }
      return response;
    } finally {
      release();
    }
  };

  return {
    fetchJson: async (url) => (await get(url, "application/json")).json(),
    fetchText: async (url) => (await get(url, "application/rss+xml, application/xml;q=0.9, text/xml;q=0.8")).text(),
  };
}

/** The JSON half of `createHttpClient`, for callers that read nothing else. */
export function createFetchJson(options: FetchJsonOptions = {}): FetchJson {
  return createHttpClient(options).fetchJson;
}

const defaultClient = createHttpClient();

/** The default client: 45 s timeout, a descriptive User-Agent, one request per host at a time, throws on non-2xx. */
export const defaultFetchJson: FetchJson = defaultClient.fetchJson;
/** The text half of the same client, so JSON and RSS requests to one host share a queue. */
export const defaultFetchText: FetchText = defaultClient.fetchText;

/**
 * Validate the outer shape of a provider response.
 *
 * The messages here do not name the board: `discover` reports every failure next to its
 * source, and a direct caller knows which board it asked for.
 */
export function readEnvelope<T>(schema: z.ZodType<T>, payload: unknown): T {
  const parsed = schema.safeParse(payload);
  if (parsed.success) return parsed.data;
  const issue = parsed.error.issues[0];
  const where = issue.path.length ? issue.path.join(".") : "response";
  throw new Error(`unexpected response shape (${where}: ${issue.message})`);
}

/**
 * Validate each raw listing against `schema`, skipping the ones that do not fit.
 *
 * One malformed listing must not cost the whole board. But if a board has listings and
 * none of them can be read, the provider has changed its payload: that is thrown, so it
 * shows up as a source error instead of looking like an empty board.
 */
export function readListings<T>(schema: z.ZodType<T>, items: readonly unknown[]): T[] {
  const listings: T[] = [];
  for (const item of items) {
    const parsed = schema.safeParse(item);
    if (parsed.success) listings.push(parsed.data);
  }
  if (items.length > 0 && listings.length === 0) {
    throw new Error(`none of the ${items.length} listings matched the expected shape`);
  }
  return listings;
}

/**
 * Map a provider's commitment / employment-type label onto Reygent's vocabulary.
 *
 * The labels are free text chosen by each employer ("Full-time (remote)", "EE Full-Time",
 * "Contractor", "Employee India"), so this matches on the words that matter and returns ""
 * for everything else (internships, part-time, fixed-term, apprenticeships).
 */
export function mapEmploymentType(label: string | null | undefined): EmploymentType {
  // "Full-time, no contractors" is an employee role, not a contract one.
  const text = (label ?? "").toLowerCase().replace(/\b(?:no|not|non)[\s-]+(?:contract|freelance)\w*/g, "");
  if (/\bfractional\b/.test(text)) return "fractional";
  if (/\bcontract(?:or|ors)?\b|\bfreelance\b/.test(text)) return "contract";
  // Ashby spells it "FullTime"; Lever and Greenhouse boards use "Full-time" or "Full time"; HN posters also write "FT".
  if (/\bfull[\s-]?time\b|\bft\b/.test(text)) return "full_time";
  return "";
}

/**
 * Read a provider's structured workplace type.
 *
 * true only for "remote" and false only for "on-site". "Hybrid" is neither: it does not
 * say the role can be done fully remotely, and it does not rule it out, so it stays null
 * and the eligibility scorer decides from the wording, as it does when no flag is given.
 */
export function remoteFromWorkplaceType(workplaceType: string | null | undefined): boolean | null {
  const kind = (workplaceType ?? "").toLowerCase().replace(/[^a-z]/g, "");
  if (kind === "remote") return true;
  if (kind === "onsite") return false;
  return null;
}

/** An ISO-8601 UTC timestamp from a provider date (ISO string or epoch milliseconds); null if unreadable. */
export function toIsoTimestamp(value: string | number | null | undefined): string | null {
  if (value === null || value === undefined || value === "") return null;
  const moment = new Date(value);
  return Number.isNaN(moment.getTime()) ? null : moment.toISOString();
}

/**
 * A display name for a board whose payload does not carry the company's name
 * (Ashby and Lever identify the employer only by the slug in the URL).
 */
export function companyFromSlug(slug: string): string {
  return slug
    .split(/[-_.\s]+/)
    .filter(Boolean)
    .map((word) => word[0].toUpperCase() + word.slice(1))
    .join(" ");
}

/** Join location parts into one string, dropping blanks and repeats. */
export function joinLocations(parts: ReadonlyArray<string | null | undefined>): string {
  const seen = new Set<string>();
  const kept: string[] = [];
  for (const part of parts) {
    const text = (part ?? "").trim();
    const key = text.toLowerCase();
    if (!text || seen.has(key)) continue;
    seen.add(key);
    kept.push(text);
  }
  return kept.join("; ");
}

/** A board token as it appears in ids: trimmed and lower-cased, so re-typing it in another case changes nothing. */
export function normalizeToken(token: string): string {
  return token.trim().toLowerCase();
}

/**
 * The channel for a listing a job board re-publishes. Contract and fractional work is a
 * gig; everything else is an application through the employer's form.
 */
export function boardChannel(employmentType: EmploymentType): Channel {
  return employmentType === "contract" || employmentType === "fractional" ? Channel.CONTRACT_GIGS : Channel.ATS_INBOUND;
}

/** A positive, finite amount; providers use 0 as a placeholder for "not set". */
export function positiveAmount(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}
