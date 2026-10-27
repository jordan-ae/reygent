/**
 * The company job boards Reygent can read, and how to recognise a link to one.
 *
 * A board is a provider plus the company's token on it ("greenhouse" + "gitlab"). The
 * user lists boards in the config; discovery also learns them from the listings it reads,
 * because a posting on a job board or a hiring thread often links to the employer's own
 * board (see `boardLinks`).
 */

import type { DiscoveryConfig } from "@/core/config";
import { fetchAshby } from "@/core/discovery/ashby";
import { fetchBreezy } from "@/core/discovery/breezy";
import { fetchGreenhouse } from "@/core/discovery/greenhouse";
import { fetchLever } from "@/core/discovery/lever";
import { fetchRecruitee } from "@/core/discovery/recruitee";
import { fetchTeamtailor } from "@/core/discovery/teamtailor";
import { type HttpClient, normalizeToken } from "@/core/discovery/types";
import { fetchWorkable } from "@/core/discovery/workable";
import type { JobOpportunity } from "@/core/models";
import { unescapeHtml } from "@/core/text";

export const BOARD_PROVIDERS = ["greenhouse", "ashby", "lever", "workable", "recruitee", "teamtailor", "breezy"] as const;
export type BoardProvider = (typeof BOARD_PROVIDERS)[number];

type BoardSetting = {
  [Key in keyof DiscoveryConfig]: DiscoveryConfig[Key] extends string[] ? Key : never;
}[keyof DiscoveryConfig];

/** The discovery setting that lists each provider's boards. */
export const BOARD_SETTINGS: Record<BoardProvider, BoardSetting> = {
  greenhouse: "greenhouse_boards",
  ashby: "ashby_orgs",
  lever: "lever_companies",
  workable: "workable_accounts",
  recruitee: "recruitee_companies",
  teamtailor: "teamtailor_companies",
  breezy: "breezy_companies",
};

const READERS: Record<BoardProvider, (token: string, http: HttpClient) => Promise<JobOpportunity[]>> = {
  greenhouse: (token, http) => fetchGreenhouse(token, http.fetchJson),
  ashby: (token, http) => fetchAshby(token, http.fetchJson),
  lever: (token, http) => fetchLever(token, http.fetchJson),
  workable: (token, http) => fetchWorkable(token, http.fetchJson),
  recruitee: (token, http) => fetchRecruitee(token, http.fetchJson),
  // Teamtailor's public feed is RSS; its JSON API needs a key.
  teamtailor: (token, http) => fetchTeamtailor(token, http.fetchText),
  breezy: (token, http) => fetchBreezy(token, http.fetchJson),
};

/** Every open listing on one board, normalised. Throws if the board cannot be read. */
export function fetchBoard(provider: BoardProvider, token: string, http: HttpClient): Promise<JobOpportunity[]> {
  return READERS[provider](token, http);
}

export interface BoardRef {
  provider: BoardProvider;
  /** As it appears in the link; ids and lookups use its lower-cased form. */
  token: string;
}

/** "greenhouse:gitlab": how a board is named in logs, errors and discovery's memory. */
export function boardKey(board: BoardRef): string {
  return `${board.provider}:${normalizeToken(board.token)}`;
}

/** A token as the providers allow one: no path, no query, nothing to escape. */
const TOKEN_RX = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
/** Hosts of the providers, with whatever path follows, wherever they occur in text. */
const LINK_RX =
  /\b((?:[a-z0-9-]+\.)*(?:greenhouse\.io|ashbyhq\.com|lever\.co|workable\.com|recruitee\.com|teamtailor\.com|breezy\.hr))((?:\/[^\s"'<>()[\]]*)?)/gi;
/** Subdomains and path segments that belong to the provider itself, not to a customer. */
const NOT_A_COMPANY = new Set([
  "www", "app", "apply", "api", "jobs", "job", "careers", "career", "help", "support", "docs", "developers", "developer",
  "blog", "status", "embed", "j", "o", "p", "boards", "job-boards", "info", "go", "hire", "try", "get", "resources",
  "assets", "assets-cdn", "cdn", "gallery-cdn", "static", "images", "media", "files", "attachments", "uploads",
]);

/** The board a provider host and path point at, or null when the link is to something else. */
function boardFor(host: string, path: string): BoardRef | null {
  const segments = path.split(/[/?#]/).filter(Boolean);
  const subdomain = host.split(".")[0];
  switch (host) {
    case "boards.greenhouse.io":
    case "job-boards.greenhouse.io": {
      // An embedded board names the company in the query: /embed/job_board?for=acme.
      const embedded = /[?&]for=([^&#]+)/.exec(path)?.[1];
      return { provider: "greenhouse", token: embedded ?? segments[0] ?? "" };
    }
    case "jobs.ashbyhq.com":
      return { provider: "ashby", token: segments[0] ?? "" };
    case "jobs.lever.co":
      return { provider: "lever", token: segments[0] ?? "" };
    case "apply.workable.com":
      // /j/SHORTCODE links to one job without naming the account.
      return { provider: "workable", token: segments[0] ?? "" };
    default:
      if (host.endsWith(".workable.com")) return { provider: "workable", token: subdomain };
      if (host.endsWith(".recruitee.com")) return { provider: "recruitee", token: subdomain };
      if (host.endsWith(".teamtailor.com")) return { provider: "teamtailor", token: subdomain };
      if (host.endsWith(".breezy.hr")) return { provider: "breezy", token: subdomain };
      return null;
  }
}

/**
 * Every company board that `text` links to: an apply URL, or a description or comment as
 * HTML. Each board is returned once.
 *
 * Only links to a provider's own hosts count ("jobs.ashbyhq.com/acme", "acme.recruitee.com").
 * A careers page on the employer's domain says nothing about which provider is behind it,
 * and nothing is fetched to find out.
 */
export function boardLinks(text: string): BoardRef[] {
  if (!/greenhouse\.io|ashbyhq\.com|lever\.co|workable\.com|recruitee\.com|teamtailor\.com|breezy\.hr/i.test(text)) return [];
  const found = new Map<string, BoardRef>();
  // Feeds escape their HTML once or twice, and Hacker News writes "/" as "&#x2F;".
  for (const match of unescapeHtml(unescapeHtml(text)).matchAll(LINK_RX)) {
    const board = boardFor(match[1].toLowerCase(), match[2]);
    if (!board) continue;
    // A link at the end of a sentence drags the full stop along.
    let token = board.token.replace(/[.,;:!]+$/, "");
    try {
      token = decodeURIComponent(token);
    } catch {
      continue;
    }
    if (!TOKEN_RX.test(token) || NOT_A_COMPANY.has(token.toLowerCase())) continue;
    const ref = { provider: board.provider, token };
    if (!found.has(boardKey(ref))) found.set(boardKey(ref), ref);
  }
  return [...found.values()];
}
