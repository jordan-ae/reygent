/** Live verification of the links a draft sends to an employer (no dependencies). */

import { unescapeHtml } from "@/core/text";

const TITLE_RX = /<title[^>]*>(.*?)<\/title>/is;
const ERROR_TITLE_RX =
  /\b(?:404|not found|page (?:not|no longer) (?:found|available)|access denied|forbidden|domain (?:for sale|parked)|coming soon)\b/i;
const GITHUB_RESERVED = new Set([
  "orgs", "features", "topics", "settings", "marketplace", "sponsors", "about", "pricing", "login",
]);
const HEADERS = { "User-Agent": "reygent-link-check/0.1", Accept: "text/html,application/json" };
const FETCH_TIMEOUT_MS = 10_000;
/** A page title sits in the first few KB; nothing past this is ever needed. */
const MAX_BODY_BYTES = 200_000;

export interface LinkStatus {
  ok: boolean;
  detail: string;
  title: string;
}

export type LinkChecker = (url: string) => Promise<LinkStatus>;
/** url -> status code and body text. */
export type Fetcher = (url: string) => Promise<{ status: number; body: string }>;

const passed = (detail: string, title = ""): LinkStatus => ({ ok: true, detail, title });
const failed = (detail: string, title = ""): LinkStatus => ({ ok: false, detail, title });

// ---------- URL splitting ----------

export interface UrlParts {
  scheme: string;
  /** "user@host:port", exactly as written. */
  netloc: string;
  path: string;
  /** Lower-cased host without userinfo, port or IPv6 brackets; "" when there is none. */
  hostname: string;
}

function hostnameOf(netloc: string): string {
  const hostinfo = netloc.slice(netloc.lastIndexOf("@") + 1);
  let hostname: string;
  const open = hostinfo.indexOf("[");
  if (open !== -1) {
    const bracketed = hostinfo.slice(open + 1);
    const close = bracketed.indexOf("]");
    hostname = close === -1 ? bracketed : bracketed.slice(0, close);
  } else {
    const colon = hostinfo.indexOf(":");
    hostname = colon === -1 ? hostinfo : hostinfo.slice(0, colon);
  }
  // An IPv6 zone id (after %) is case-sensitive and must survive untouched.
  const percent = hostname.indexOf("%");
  return percent === -1 ? hostname.toLowerCase() : hostname.slice(0, percent).toLowerCase() + hostname.slice(percent);
}

/**
 * Split a URL the way Python's `urllib.parse.urlsplit` does.
 *
 * The WHATWG `URL` class is deliberately not used: it rewrites what it parses (punycode
 * hosts, dropped default ports, resolved dot segments, percent-encoding), and both the
 * fact-bank comparison and the scam filter must judge a link exactly as it was written.
 * Throws on a host that cannot be trusted to mean what it says: unbalanced IPv6
 * brackets, or characters that turn into URL delimiters under NFKC (e.g. "℀" -> "a/c").
 */
export function splitUrl(raw: string): UrlParts {
  let url = raw.replace(/[\t\r\n]/g, "");
  let scheme = "";
  let netloc = "";
  const colon = url.indexOf(":");
  if (colon > 0 && /^[A-Za-z][A-Za-z0-9+.-]*$/.test(url.slice(0, colon))) {
    scheme = url.slice(0, colon).toLowerCase();
    url = url.slice(colon + 1);
  }
  if (url.startsWith("//")) {
    const delimiter = url.slice(2).search(/[/?#]/);
    const end = delimiter === -1 ? url.length : delimiter + 2;
    netloc = url.slice(2, end);
    url = url.slice(end);
    if (netloc.includes("[") !== netloc.includes("]")) throw new Error("Invalid IPv6 URL");
  }
  const fragment = url.indexOf("#");
  if (fragment !== -1) url = url.slice(0, fragment);
  const query = url.indexOf("?");
  if (query !== -1) url = url.slice(0, query);
  if (/[^\x00-\x7f]/.test(netloc)) {
    const bare = netloc.replace(/[@:#?]/g, "");
    const folded = bare.normalize("NFKC");
    if (folded !== bare && /[/?#@:]/.test(folded)) {
      throw new Error(`netloc '${netloc}' contains invalid characters under NFKC normalization`);
    }
  }
  return { scheme, netloc, path: url, hostname: hostnameOf(netloc) };
}

const withScheme = (url: string): string => (url.includes("://") ? url : `https://${url}`);
const withoutWww = (host: string): string => (host.startsWith("www.") ? host.slice(4) : host);

/**
 * Canonical form for comparing a URL against the fact bank: host and path, lower-cased,
 * without scheme, "www.", query, fragment or trailing slash.
 *
 * Never throws. A URL whose host cannot be parsed (see `splitUrl`) keeps its raw text,
 * which still carries its scheme and so cannot equal the canonical form of a sound link.
 */
export function normalizeUrl(url: string): string {
  const cleaned = url.trim().replace(/[.,;:!?)]+$/, "");
  try {
    const parts = splitUrl(withScheme(cleaned));
    return `${withoutWww(parts.netloc.toLowerCase())}${parts.path.replace(/\/+$/, "")}`.toLowerCase();
  } catch {
    return cleaned.toLowerCase();
  }
}

// ---------- Fetching ----------

/** GET `url`, following redirects; an HTTP error status is returned with an empty body. */
async function fetchPage(url: string): Promise<{ status: number; body: string }> {
  const response = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  const reader = response.ok ? response.body?.getReader() : undefined;
  if (!reader) {
    await response.body?.cancel();
    return { status: response.status, body: "" };
  }
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (size < MAX_BODY_BYTES) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    size += value.byteLength;
  }
  await reader.cancel().catch(() => undefined);
  const bytes = Buffer.concat(chunks).subarray(0, MAX_BODY_BYTES);
  return { status: response.status, body: new TextDecoder("utf-8", { ignoreBOM: true }).decode(bytes) };
}

/** fetch() reports "fetch failed" and keeps the reason (ENOTFOUND, a TLS error, ...) in `cause`. */
function describeError(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  return error.cause instanceof Error ? `${error.message}: ${error.cause.message}` : error.message;
}

function parseJsonObject(body: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(body);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("GitHub API response is not a JSON object");
  }
  return parsed as Record<string, unknown>;
}

/** Python truthiness of a parsed JSON value: empty arrays and objects count as false. */
function truthy(value: unknown): boolean {
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "object" && value !== null) return Object.keys(value).length > 0;
  return Boolean(value);
}

/**
 * Checks that a link resolves to what it claims to be.
 *
 * GitHub repositories must exist, be public and be non-empty; GitHub profiles must
 * exist; other pages must load with a real (non-error) title. Successful checks are
 * cached for `ttlSeconds` so repeated drafts do not re-fetch the same links. Failures
 * are never cached, and anything that goes wrong while checking — DNS failure, timeout,
 * TLS error, unparseable response — fails closed as "could not be reached".
 */
export class HttpLinkChecker {
  private readonly fetch: Fetcher;
  private readonly ttlMs: number;
  private readonly cache = new Map<string, { at: number; status: LinkStatus }>();

  constructor(options: { fetch?: Fetcher; ttlSeconds?: number } = {}) {
    this.fetch = options.fetch ?? fetchPage;
    this.ttlMs = (options.ttlSeconds ?? 3600) * 1000;
  }

  async check(url: string): Promise<LinkStatus> {
    const key = normalizeUrl(url);
    const cached = this.cache.get(key);
    if (cached && performance.now() - cached.at < this.ttlMs) return cached.status;
    let status: LinkStatus;
    try {
      status = await this.inspect(withScheme(url));
    } catch (error) {
      status = failed(`could not be reached (${describeError(error)})`);
    }
    if (status.ok) this.cache.set(key, { at: performance.now(), status });
    return status;
  }

  private async inspect(url: string): Promise<LinkStatus> {
    const parts = splitUrl(url);
    const host = withoutWww(parts.netloc.toLowerCase());
    const segments = parts.path.split("/").filter(Boolean);
    if (host === "github.com" && segments.length > 0 && !GITHUB_RESERVED.has(segments[0])) {
      return this.inspectGithub(segments);
    }
    if (host.endsWith("linkedin.com")) {
      // LinkedIn rejects automated requests, so the fact-bank match is the check.
      return passed("matches the fact bank (LinkedIn cannot be fetched automatically)");
    }
    const { status, body } = await this.fetch(url);
    if (status !== 200) return failed(`returned HTTP ${status}`);
    const match = TITLE_RX.exec(body);
    const title = match ? unescapeHtml(match[1]).split(/\s+/).filter(Boolean).join(" ") : "";
    if (!title) return failed("page has no title");
    if (ERROR_TITLE_RX.test(title)) return failed(`page title looks like an error page: '${title}'`, title);
    return passed("reachable", title);
  }

  private async inspectGithub(segments: string[]): Promise<LinkStatus> {
    if (segments.length === 1) {
      const { status, body } = await this.fetch(`https://api.github.com/users/${segments[0]}`);
      if (status !== 200) return failed(`GitHub profile '${segments[0]}' not found (HTTP ${status})`);
      const { login } = parseJsonObject(body);
      return passed("GitHub profile exists", typeof login === "string" ? login : "");
    }
    const [owner, name] = segments;
    const { status, body } = await this.fetch(`https://api.github.com/repos/${owner}/${name}`);
    if (status !== 200) {
      return failed(`GitHub repository '${owner}/${name}' not found or not public (HTTP ${status})`);
    }
    const repo = parseJsonObject(body);
    const fullName = repo.full_name === undefined ? "" : String(repo.full_name);
    if (truthy(repo.private)) return failed(`GitHub repository '${fullName}' is private`, fullName);
    if (fullName.toLowerCase() !== `${owner}/${name}`.toLowerCase()) {
      return failed(`GitHub repository moved to '${fullName}'`, fullName);
    }
    if (!truthy(repo.size)) return failed(`GitHub repository '${fullName}' is empty`, fullName);
    return passed("public, non-empty GitHub repository", fullName);
  }
}
