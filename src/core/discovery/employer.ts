/**
 * Finding a role on its employer's own board.
 *
 * A job site re-lists other companies' openings and links to its own page; the application
 * itself is on the employer's board, which Reygent can often read and apply through. The
 * employer's listing is also the one that says where the role can really be done: a job
 * site's "Anywhere in the World" is frequently "Remote - United States" at the source.
 *
 * Nothing here crawls. A board is asked for by name through the same public endpoint
 * discovery reads, under the names the company is likely to have there, and a listing is
 * only taken as the same role when its title is the same and its text says the same thing.
 */

import { type BoardProvider, type BoardRef, fetchBoard } from "@/core/discovery/boards";
import { type HttpClient, FetchError, createHttpClient, normalizeToken } from "@/core/discovery/types";
import type { JobOpportunity } from "@/core/models";
import { cleanText, companyKey, titleKey } from "@/core/text";

/** The providers whose application forms the operator reads. */
export const FORM_PROVIDERS = ["greenhouse", "ashby", "lever", "workable", "recruitee"] as const satisfies readonly BoardProvider[];

export interface EmployerListings {
  /**
   * The employer's own listings of the role, under the company name the job site gave so
   * that both copies count as one company's. Several when the role is open in several regions.
   */
  listings: JobOpportunity[];
  /** False when a board could not be asked (a timeout, an outage): worth asking again later. */
  settled: boolean;
}

/** Look a job-site listing up on its employer's own board. Never throws. */
export type EmployerLookup = (job: JobOpportunity) => Promise<EmployerListings>;

/**
 * Find a company's own boards by its name, given the titles of roles it is known to have
 * advertised. Never throws. `settled` is false when a board could not be asked.
 */
export type BoardFinder = (company: string, titles: readonly string[]) => Promise<{ boards: BoardRef[]; settled: boolean }>;

export interface EmployerLookupOptions {
  /** The HTTP client; tests pass a fake. The real one gives a slow board 15 seconds. */
  http?: HttpClient;
  /** Boards already known, configured or found through listings: their names are tried first. */
  known?: readonly BoardRef[];
}

/** A lookup is a handful of small requests; a board that does not answer quickly is asked again next time. */
const LOOKUP_TIMEOUT_MS = 15_000;
/** A job site's text this short says too little to compare. */
const WORDS_TO_COMPARE = 60;
/** The share of the job site's words that the employer's own text must contain. Copies run above 0.9, other roles below 0.3. */
const SHARED_WORDS = 0.5;

const squash = (text: string): string => text.toLowerCase().replace(/[^a-z0-9]+/g, "");

/**
 * The names `company` may have on a provider, most likely first: the one a known board
 * already goes by, then the name run together and hyphenated ("stickermule", "sticker-mule").
 */
export function boardTokens(company: string, provider: BoardProvider, known: readonly BoardRef[] = []): string[] {
  // "NextAlpha (Nu Dawn)": the name is what comes before the aside.
  const name = company.replace(/\s*[([].*$/, "").trim() || company;
  const words = companyKey(name).split(" ").filter(Boolean);
  const compact = words.join("");
  if (compact.length < 2) return [];
  const learned = known
    .filter((board) => board.provider === provider && squash(board.token) === compact)
    .map((board) => normalizeToken(board.token));
  // The full name too: "The Agile Monkeys" may be listed with its article.
  return [...new Set([...learned, compact, words.join("-"), squash(name)])];
}

const wordsOf = (text: string): Set<string> => new Set(cleanText(text).toLowerCase().match(/[a-z][a-z0-9+#.-]{3,}/g) ?? []);

/**
 * True unless the two descriptions are plainly of different roles. A job site copies the
 * employer's text, so nearly every word of its copy is in the original; the same title at
 * another company shares only the common vocabulary of job postings.
 */
export function describesSameRole(copy: string, original: string): boolean {
  const copied = wordsOf(copy);
  if (copied.size < WORDS_TO_COMPARE) return true;
  const source = wordsOf(original);
  let shared = 0;
  for (const word of copied) if (source.has(word)) shared += 1;
  return shared / copied.size >= SHARED_WORDS;
}

type BoardRead = JobOpportunity[] | null | "unreachable";

/**
 * Read boards by name, each at most once for as long as the reader lives: the listings,
 * null when there is no such board, "unreachable" when it could not be asked.
 */
function boardReader(http: HttpClient): (provider: BoardProvider, token: string) => Promise<BoardRead> {
  const boards = new Map<string, Promise<BoardRead>>();
  return (provider, token) => {
    const key = `${provider}:${token}`;
    let board = boards.get(key);
    if (!board) {
      board = fetchBoard(provider, token, http).catch((error: unknown) =>
        error instanceof FetchError && error.status === 404 ? null : ("unreachable" as const),
      );
      boards.set(key, board);
    }
    return board;
  };
}

/**
 * Build the boards finder. A board under the company's name is taken as its own only when
 * it lists one of the titles the company has advertised elsewhere: a name alone could be
 * another company's.
 */
export function createBoardFinder(options: EmployerLookupOptions = {}): BoardFinder {
  const read = boardReader(options.http ?? createHttpClient({ timeoutMs: LOOKUP_TIMEOUT_MS }));
  const known = options.known ?? [];
  return async (company, titles) => {
    const advertised = new Set(titles.map(titleKey).filter(Boolean));
    let settled = true;
    const found = await Promise.all(
      FORM_PROVIDERS.map(async (provider): Promise<BoardRef[]> => {
        for (const token of boardTokens(company, provider, known)) {
          const board = await read(provider, token);
          if (board === "unreachable") settled = false;
          if (!board || board === "unreachable") continue;
          if (board.some((listing) => advertised.has(titleKey(listing.title)))) return [{ provider, token }];
        }
        return [];
      }),
    );
    return { boards: found.flat(), settled };
  };
}

/**
 * Build the lookup. Every board it reads is remembered for as long as the lookup lives,
 * so two roles at one company cost one read of its board.
 */
export function createEmployerLookup(options: EmployerLookupOptions = {}): EmployerLookup {
  const read = boardReader(options.http ?? createHttpClient({ timeoutMs: LOOKUP_TIMEOUT_MS }));
  const known = options.known ?? [];

  return async (job) => {
    const title = titleKey(job.title);
    let settled = true;
    const found = await Promise.all(
      FORM_PROVIDERS.map(async (provider): Promise<JobOpportunity[]> => {
        for (const token of boardTokens(job.company, provider, known)) {
          const board = await read(provider, token);
          if (board === "unreachable") settled = false;
          if (!board || board === "unreachable") continue;
          const same = board.filter(
            (listing) => titleKey(listing.title) === title && describesSameRole(job.description, listing.description),
          );
          if (same.length) return same.map((listing) => ({ ...listing, company: job.company }));
        }
        return [];
      }),
    );
    return { listings: found.flat(), settled };
  };
}
