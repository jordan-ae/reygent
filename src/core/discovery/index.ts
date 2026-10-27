/**
 * Job discovery: read every source that is due and return normalised listings.
 *
 * `discover` is the only entry point the pipeline needs. It reads company job boards
 * (Greenhouse, Ashby, Lever, Workable, Recruitee, Teamtailor, Breezy), remote-job boards
 * with a public API or RSS feed, and the Hacker News hiring and freelancer threads. It
 * keeps the listings whose title matches the configured keywords, removes duplicates and
 * caps the result. One source failing never stops the others: the failure is returned
 * alongside the jobs.
 *
 * Every source has a minimum time between two reads, taken from its own terms, and a
 * source that is not due is skipped. Listings that link to their employer's own board
 * add that board to the ones read from then on.
 *
 * Nothing here calls an LLM, and nothing is written but discovery's own memory (when each
 * source was read, which boards it has found), through the store it is handed.
 */

import type { DiscoveryConfig } from "@/core/config";
import {
  type BoardProvider,
  type BoardRef,
  BOARD_PROVIDERS,
  BOARD_SETTINGS,
  boardKey,
  boardLinks,
  fetchBoard,
} from "@/core/discovery/boards";
import { fetchFeed } from "@/core/discovery/feeds";
import { fetchHimalayas } from "@/core/discovery/himalayas";
import { fetchHnFreelance, fetchHnWhoIsHiring, hnFirstLine } from "@/core/discovery/hn";
import { fetchJobicy } from "@/core/discovery/jobicy";
import { fetchRemoteOk } from "@/core/discovery/remoteok";
import { fetchRemotive } from "@/core/discovery/remotive";
import {
  type DiscoveryState,
  boardsToRead,
  createMemoryState,
  isDue,
  loadMemory,
  markRead,
  recordBoardRead,
  rememberBoard,
  saveBoards,
} from "@/core/discovery/state";
import {
  type FetchJson,
  type FetchText,
  type HttpClient,
  defaultFetchJson,
  defaultFetchText,
  normalizeToken,
} from "@/core/discovery/types";
import { fetchWorkingNomads } from "@/core/discovery/workingnomads";
import { type JobBoard, type JobOpportunity, AGGREGATOR_SOURCES } from "@/core/models";
import { cleanText, roleKey } from "@/core/text";

export { fetchAshby } from "@/core/discovery/ashby";
export { type BoardProvider, type BoardRef, BOARD_PROVIDERS, boardLinks, fetchBoard } from "@/core/discovery/boards";
export { fetchBreezy } from "@/core/discovery/breezy";
export { fetchFeed } from "@/core/discovery/feeds";
export { fetchGreenhouse } from "@/core/discovery/greenhouse";
export { fetchHimalayas } from "@/core/discovery/himalayas";
export { type HnOptions, fetchHnFreelance, fetchHnWhoIsHiring } from "@/core/discovery/hn";
export { fetchJobicy } from "@/core/discovery/jobicy";
export { fetchLever } from "@/core/discovery/lever";
export { fetchRecruitee } from "@/core/discovery/recruitee";
export { fetchRemoteOk } from "@/core/discovery/remoteok";
export { fetchRemotive } from "@/core/discovery/remotive";
export { type DiscoveryState, type FoundBoard, BOARDS_KEY, READS_KEY, createMemoryState } from "@/core/discovery/state";
export { fetchTeamtailor } from "@/core/discovery/teamtailor";
export {
  type FetchJson,
  type FetchText,
  FetchError,
  createFetchJson,
  createHttpClient,
  defaultFetchJson,
  defaultFetchText,
} from "@/core/discovery/types";
export { fetchWorkable } from "@/core/discovery/workable";
export { fetchWorkingNomads } from "@/core/discovery/workingnomads";

/**
 * Sources read at the same time. The real client asks one host for one thing at a time,
 * so this is how many hosts are being asked at once.
 */
const MAX_CONCURRENT_SOURCES = 4;

/**
 * The least time between two reads of a source, in minutes.
 *
 * A job board's figure follows what its terms ask (see each connector): Remotive advises
 * at most four requests a day, Jobicy "a few times per day" and never more than hourly,
 * Himalayas says its data changes once a day. The others state no figure and get "a few
 * times a day". A company board is one small request and is read once an hour at most.
 */
const BOARD_REFRESH_MINUTES = 60;
const HN_REFRESH_MINUTES = 60;
const HN_FREELANCE_REFRESH_MINUTES = 6 * 60;
const JOB_BOARD_REFRESH_MINUTES: Record<JobBoard, number> = {
  remotive: 6 * 60,
  remoteok: 6 * 60,
  jobicy: 6 * 60,
  himalayas: 24 * 60,
  workingnomads: 6 * 60,
  // The feed's own <ttl> is 60 minutes.
  weworkremotely: 3 * 60,
  realworkfromanywhere: 6 * 60,
  golangprojects: 12 * 60,
  python_org: 12 * 60,
};

const JOB_BOARD_READERS: Record<JobBoard, (http: HttpClient) => Promise<JobOpportunity[]>> = {
  remotive: (http) => fetchRemotive(http.fetchJson),
  remoteok: (http) => fetchRemoteOk(http.fetchJson),
  jobicy: (http) => fetchJobicy(http.fetchJson),
  himalayas: (http) => fetchHimalayas(http.fetchJson),
  workingnomads: (http) => fetchWorkingNomads(http.fetchJson),
  weworkremotely: (http) => fetchFeed("weworkremotely", http.fetchText),
  realworkfromanywhere: (http) => fetchFeed("realworkfromanywhere", http.fetchText),
  golangprojects: (http) => fetchFeed("golangprojects", http.fetchText),
  python_org: (http) => fetchFeed("python_org", http.fetchText),
};

/** What discovery remembers when the caller gives it nowhere to: it lasts as long as the process. */
const processState = createMemoryState();

export interface DiscoverOptions {
  /** The HTTP client for JSON. Tests pass a fake backed by fixtures. */
  fetchJson?: FetchJson;
  /**
   * The HTTP client for RSS and XML feeds. With neither client given, both are the real
   * one; with only one given, sources that need the other fail rather than reach the network.
   */
  fetchText?: FetchText;
  /** Receives one progress line per source and a closing summary. */
  log?: (line: string) => void;
  /**
   * True for a listing the caller already tracks (for the pipeline:
   * `(job) => repo.findTrackedJobId(job) !== null`). Those are dropped before the cap
   * is applied, so `max_new_jobs_per_cycle` counts jobs that are actually new. Without
   * it the same listings fill the cap on every cycle and whatever lies beyond it is
   * never returned.
   */
  isKnown?: (job: JobOpportunity) => boolean;
  /**
   * Where discovery keeps its memory: when each source was last read, and the boards it
   * has found. Pass the Repository to keep it in the database. Null means no memory:
   * every source is read on every call and found boards are forgotten.
   *
   * Left out, the real client remembers for as long as the process runs, so a daemon
   * honours every source's refresh interval even when its caller passes nothing; an
   * injected client (a test) gets no memory.
   */
  state?: DiscoveryState | null;
  /** The clock; replaced in tests. */
  now?: () => Date;
}

export interface DiscoveryError {
  /** "greenhouse:gitlab", "workable:zyte", "remotive", "weworkremotely", "hn" or "hn_freelance". */
  source: string;
  message: string;
}

export interface DiscoveryResult {
  /** Interleaved across sources; within one source, newest first. */
  jobs: JobOpportunity[];
  errors: DiscoveryError[];
}

interface Source {
  label: string;
  /** Sources that share a host; they are spread out so one host does not hold every slot. */
  host: string;
  refreshMinutes: number;
  /** Set for a board discovery found by itself, as opposed to one the user configured. */
  found?: BoardRef;
  /**
   * Read the source. `linked` takes text the source saw that is not a listing but may
   * link to a company board: a hiring post whose header could not be parsed.
   */
  fetch: (linked: (text: string) => void) => Promise<JobOpportunity[]>;
}

type Outcome = { jobs: JobOpportunity[]; texts: string[] } | { error: string };

/** Board tokens as configured, minus blanks and repeats (case-insensitively). */
function uniqueTokens(tokens: readonly string[]): string[] {
  const byKey = new Map<string, string>();
  for (const token of tokens) {
    const key = normalizeToken(token);
    if (key && !byKey.has(key)) byKey.set(key, token.trim());
  }
  return [...byKey.values()];
}

function boardSource(provider: BoardProvider, token: string, http: HttpClient): Source {
  return {
    label: boardKey({ provider, token }),
    host: provider,
    refreshMinutes: BOARD_REFRESH_MINUTES,
    fetch: () => fetchBoard(provider, token, http),
  };
}

function configuredSources(config: DiscoveryConfig, http: HttpClient): Source[] {
  const hn = (label: string, refreshMinutes: number, fetch: Source["fetch"]): Source => ({ label, host: "hn", refreshMinutes, fetch });
  return [
    ...BOARD_PROVIDERS.flatMap((provider) =>
      uniqueTokens(config[BOARD_SETTINGS[provider]]).map((token) => boardSource(provider, token, http)),
    ),
    ...(config.hn_who_is_hiring
      ? [hn("hn", HN_REFRESH_MINUTES, (onComment) => fetchHnWhoIsHiring(http.fetchJson, { onComment }))]
      : []),
    ...(config.hn_freelancer
      ? [hn("hn_freelance", HN_FREELANCE_REFRESH_MINUTES, (onComment) => fetchHnFreelance(http.fetchJson, { onComment }))]
      : []),
    ...[...new Set(config.job_boards)].map((board) => ({
      label: board,
      host: board,
      refreshMinutes: JOB_BOARD_REFRESH_MINUTES[board],
      fetch: () => JOB_BOARD_READERS[board](http),
    })),
  ];
}

/**
 * The order to start sources in: one from each host in turn.
 *
 * Results are still reported in source order. Only the starting order changes, so that
 * twenty boards on one host do not sit in every slot of the pool waiting for each other
 * while the other hosts idle.
 */
function startingOrder(sources: readonly Source[]): number[] {
  const byHost = new Map<string, number[]>();
  sources.forEach((source, index) => byHost.set(source.host, [...(byHost.get(source.host) ?? []), index]));
  return interleave([...byHost.values()], sources.length);
}

/** Run `tasks` with at most `limit` in flight, starting them in `order` and returning results in task order. */
async function runPool<T>(tasks: ReadonlyArray<() => Promise<T>>, order: readonly number[], limit: number): Promise<T[]> {
  const results = new Array<T>(tasks.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < order.length) {
      const index = order[next];
      next += 1;
      results[index] = await tasks[index]();
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, worker));
  return results;
}

/** An error as one line; fetch wraps the real reason (DNS, TLS, reset) in `cause`. */
function describeError(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const cause = error.cause instanceof Error ? error.cause.message : "";
  return cause && !error.message.includes(cause) ? `${error.message} (${cause})` : error.message;
}

/**
 * True when a listing's title contains one of the keywords as a whole term
 * (case-insensitive, singular or plural).
 *
 * Whole terms, not substrings: "ai" must not match "Paid Media Manager", nor "engineer"
 * an "Engineering Director". Hacker News titles are whatever the poster wrote as the
 * role ("Multiple roles"), so those listings also pass when the comment's first line
 * matches; a freelance gig often has no title at all, and passes on its post's wording.
 * An empty keyword list means no filter.
 *
 * `excluded` names what a title must not contain, again as whole terms: "intern" turns
 * away an internship and leaves "Internal Tools Engineer" alone.
 */
function keywordFilter(
  keywords: readonly string[],
  excluded: readonly string[] = [],
): { job: (job: JobOpportunity) => boolean; text: (text: string) => boolean } {
  const wholeTerm = (words: readonly string[]): ((text: string) => boolean) | null => {
    const terms = words.map((word) => word.trim().toLowerCase()).filter(Boolean);
    if (terms.length === 0) return null;
    const pattern = new RegExp(
      `(?<![a-z0-9])(?:${terms.map((term) => term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})s?(?![a-z0-9])`,
      "i",
    );
    return (text) => pattern.test(text);
  };
  const contains = wholeTerm(keywords) ?? (() => true);
  const turnedAway = wholeTerm(excluded) ?? (() => false);
  return {
    job: (job) =>
      !turnedAway(job.title) &&
      (contains(job.title) ||
        (job.source === "hn" && contains(hnFirstLine(job.description))) ||
        (job.source === "hn_freelance" && contains(cleanText(job.description)))),
    text: contains,
  };
}

/** Newest first; undated listings last; ties broken by id so the order is the same on every run. */
function newestFirst(a: JobOpportunity, b: JobOpportunity): number {
  if (a.postedAt !== b.postedAt) {
    if (a.postedAt === null) return 1;
    if (b.postedAt === null) return -1;
    return a.postedAt < b.postedAt ? 1 : -1;
  }
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * Take from each queue in turn until `limit` items are picked.
 *
 * This is how the cap is shared out. Sorting every listing by date instead would not be
 * fair: the providers date their postings differently (Lever gives the day a posting was
 * first created, which can be years ago for a role that is still open), and one large
 * board or a fresh Hacker News thread would fill the cap and hide the small boards.
 */
function interleave<T>(queues: ReadonlyArray<readonly T[]>, limit: number): T[] {
  const picked: T[] = [];
  const longest = Math.max(0, ...queues.map((queue) => queue.length));
  for (let round = 0; round < longest && picked.length < limit; round += 1) {
    for (const queue of queues) {
      if (round < queue.length && picked.length < limit) picked.push(queue[round]);
    }
  }
  return picked;
}

/**
 * Which copy of a role is kept when several sources list it.
 *
 * A job board re-lists openings that also sit on the employer's own board and on other
 * job boards, under the same company and title. Everything that is not a job board's
 * copy stays (a company's board, a hiring thread). A job board's copy stays only when no
 * other source has the role; of several job boards', the first one read keeps it. Two
 * listings from one source are never each other's duplicate: the same title in two
 * regions is two openings.
 */
function roleOwners(listings: ReadonlyArray<readonly JobOpportunity[]>): (job: JobOpportunity) => boolean {
  const owner = new Map<string, string>();
  const claim = (job: JobOpportunity): void => {
    const key = roleKey(job.company, job.title);
    if (!owner.has(key)) owner.set(key, job.source);
  };
  for (const jobs of listings) for (const job of jobs) if (!AGGREGATOR_SOURCES.has(job.source)) claim(job);
  for (const jobs of listings) for (const job of jobs) if (AGGREGATOR_SOURCES.has(job.source)) claim(job);
  return (job) => !AGGREGATOR_SOURCES.has(job.source) || owner.get(roleKey(job.company, job.title)) === job.source;
}

/**
 * Read every source that is due and return the listings worth qualifying.
 *
 * The result is filtered by `title_keywords`, de-duplicated and capped at
 * `max_new_jobs_per_cycle`. Under the cap every source contributes in turn, its newest
 * listings first. Sources that fail are reported in `errors`; the rest are still returned.
 */
export async function discover(config: DiscoveryConfig, options: DiscoverOptions = {}): Promise<DiscoveryResult> {
  const { log = () => {}, isKnown, now = () => new Date() } = options;
  const injected = options.fetchJson !== undefined || options.fetchText !== undefined;
  // A caller that injects one reader gets no real network through the other: a test that
  // fakes the JSON client must not find its feeds quietly fetched for real.
  const missing = (kind: string) => async (): Promise<never> => {
    throw new Error(`no ${kind} reader was given`);
  };
  const http: HttpClient = {
    fetchJson: options.fetchJson ?? (injected ? missing("JSON") : defaultFetchJson),
    fetchText: options.fetchText ?? (injected ? missing("feed") : defaultFetchText),
  };
  const state = options.state !== undefined ? options.state : injected ? null : processState;
  const memory = loadMemory(state);
  const startedAt = now();

  const configured = configuredSources(config, http);
  const configuredBoards = new Set(configured.map((source) => source.label));
  const found = config.follow_board_links
    ? boardsToRead(memory, configuredBoards, config.found_boards_per_cycle, startedAt).map((board): Source => ({
        ...boardSource(board.provider, board.token, http),
        // Its turn was decided above, by its own schedule.
        refreshMinutes: 0,
        found: board,
        // Found by the company's name: its listings go by that name too.
        ...(board.company
          ? { fetch: async () => (await fetchBoard(board.provider, board.token, http)).map((job) => ({ ...job, company: board.company! })) }
          : {}),
      }))
    : [];
  const candidates = [...configured, ...found];
  const sources = candidates.filter((source) => isDue(memory, source.label, source.refreshMinutes, startedAt));

  const outcomes = await runPool(
    sources.map((source) => async (): Promise<Outcome> => {
      markRead(state, memory, source.label, now());
      const texts: string[] = [];
      try {
        return { jobs: await source.fetch((text) => texts.push(text)), texts };
      } catch (error) {
        return { error: describeError(error) };
      }
    }),
    startingOrder(sources),
    MAX_CONCURRENT_SOURCES,
  );

  const { job: matchesKeywords, text: mentionsKeyword } = keywordFilter(config.title_keywords, config.title_exclude_keywords);
  const errors: DiscoveryError[] = [];
  /** The keyword-matching listings of each source that answered, in source order. */
  const relevantBySource: JobOpportunity[][] = [];
  let fetched = 0;
  let matched = 0;
  let boardsFound = 0;
  let boardsDropped = 0;

  outcomes.forEach((outcome, index) => {
    const source = sources[index];
    const relevant = "error" in outcome ? [] : outcome.jobs.filter(matchesKeywords);
    if (source.found) {
      recordBoardRead(memory, source.found, relevant.length > 0, now());
      if (memory.boards[boardKey(source.found)]?.retiredAt) boardsDropped += 1;
    }
    if ("error" in outcome) {
      errors.push({ source: source.label, message: outcome.error });
      log(`${source.label}: failed: ${outcome.error}`);
      return;
    }
    fetched += outcome.jobs.length;
    matched += relevant.length;
    log(`${source.label}: ${outcome.jobs.length} listings, ${relevant.length} match the title keywords`);
    relevantBySource.push(relevant);

    if (!config.follow_board_links) return;
    const follow = (text: string, wanted: boolean): void => {
      for (const board of boardLinks(text)) {
        if (configuredBoards.has(boardKey(board))) continue;
        if (rememberBoard(memory, board, source.label, wanted, now())) boardsFound += 1;
      }
    };
    for (const job of outcome.jobs) follow(`${job.applyUrl}\n${job.description}`, matchesKeywords(job));
    // Posts that did not parse into a listing: judged on their first line, as a listing's would be.
    for (const text of outcome.texts) follow(text, mentionsKeyword(hnFirstLine(text)));
  });
  if (config.follow_board_links && (boardsFound > 0 || found.length > 0)) saveBoards(state, memory);

  const keepsRole = roleOwners(relevantBySource);
  const seen = new Set<string>();
  /** One queue of new listings per source, in source order. */
  const queues: JobOpportunity[][] = [];
  let listedElsewhere = 0;
  let known = 0;
  for (const relevant of relevantBySource) {
    const fresh: JobOpportunity[] = [];
    for (const job of relevant) {
      if (seen.has(job.id)) continue;
      seen.add(job.id);
      if (!keepsRole(job)) listedElsewhere += 1;
      else if (isKnown?.(job)) known += 1;
      else fresh.push(job);
    }
    queues.push(fresh.sort(newestFirst));
  }

  const cap = Math.max(0, config.max_new_jobs_per_cycle);
  const jobs = interleave(queues, cap);
  const waiting = candidates.length - sources.length;
  if (boardsFound > 0 || boardsDropped > 0) {
    const kept = Object.values(memory.boards).filter((board) => !board.retiredAt).length;
    log(`discovery: ${boardsFound} company boards found through listings, ${boardsDropped} dropped for showing nothing; ${kept} are read in turn`);
  }
  log(
    `discovery: ${sources.length} sources${waiting > 0 ? ` (${waiting} more not due yet)` : ""}, ${errors.length} failed; ` +
      `${fetched} listings, ${matched} match the title keywords, ` +
      `${listedElsewhere > 0 ? `${listedElsewhere} also listed by another source, ` : ""}` +
      `${known} already known, ${jobs.length} returned (cap ${cap})`,
  );
  return { jobs, errors };
}
