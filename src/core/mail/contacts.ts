/**
 * Where an employer takes applications by email, when it does.
 *
 * Only an address the employer has published is used: one a founder's post gives, one a
 * listing asks applications to be sent to ("send your CV to jobs@acme.com"), or a hiring
 * address (jobs@, careers@, hiring@ ...) on the company's own website. An address is never
 * made up from a pattern: a guessed one bounces, or reaches someone who never asked.
 */

import { type JobOpportunity, Channel } from "@/core/models";
import { cleanText, companyKey, unescapeHtml } from "@/core/text";

export interface FoundContact {
  email: string;
  /** "listing" when the post or listing gives it, "website" when the company's own site does. */
  source: "listing" | "website";
}

/** Find the address `job`'s employer takes applications at. Never throws; "unreachable" means try again later. */
export type ContactFinder = (job: JobOpportunity) => Promise<FoundContact | null | "unreachable">;

const EMAIL_RX = /[\w.+-]+@[\w-]+(?:\.[\w-]+)*\.[a-z]{2,24}\b/gi;
/** Addresses whose name says they take applications. */
const HIRING_NAME =
  /^(?:jobs?|careers?|hiring|hire|recruit(?:ing|ment|ers?)?|talent|people|hr|join|joinus|join-us|work|workwithus|apply|applications?|cv|resumes?)$/i;
/** Addresses that are for something else, whatever the text around them says. */
const NOT_FOR_APPLICATIONS =
  /^(?:privacy|legal|security|abuse|support|help|press|media|sales|billing|accessibility|accommodations?|no-?reply|donotreply|dpo|gdpr|compliance|feedback|admin|webmaster|postmaster|unsubscribe)$/i;
/** The words before an address that ask for applications to be sent to it. */
const ASKS_FOR_IT = /\b(?:send|email|e-mail|mail|write|reach|apply|submit|forward|cv|resume|résumé|application)\b[^\n]{0,80}$/i;
const FILE_LIKE = /\.(?:png|jpe?g|gif|svg|webp|css|js)$/i;

const domainOf = (email: string): string => email.slice(email.lastIndexOf("@") + 1).toLowerCase();
const localOf = (email: string): string => email.slice(0, email.lastIndexOf("@")).toLowerCase();

/**
 * The address in `text` that applications go to. A hiring name (jobs@) counts anywhere;
 * any other name only where the words just before it ask for applications, and never one
 * that is plainly for something else (privacy@, accommodations@).
 */
export function applicationAddressIn(text: string): string {
  const plain = unescapeHtml(unescapeHtml(text)).replace(/mailto:/gi, " ");
  for (const match of plain.matchAll(EMAIL_RX)) {
    const email = match[0].replace(/[.]+$/, "").toLowerCase();
    if (FILE_LIKE.test(email)) continue;
    const local = localOf(email);
    if (NOT_FOR_APPLICATIONS.test(local)) continue;
    const before = cleanText(plain.slice(Math.max(0, (match.index ?? 0) - 120), match.index ?? 0));
    if (HIRING_NAME.test(local) || ASKS_FOR_IT.test(before)) return email;
  }
  return "";
}

/**
 * The address a listing itself gives. A founder's post on a hiring thread is a personal
 * invitation, so any address in it is the one to write to; anything else needs an
 * address that applications are asked to go to.
 */
export function postedAddress(job: JobOpportunity): string {
  const text = `${/^mailto:/i.test(job.applyUrl) ? job.applyUrl : ""}\n${job.description}\n${job.title}`;
  if (job.channel !== Channel.FOUNDER_DIRECT) return applicationAddressIn(text);
  const plain = unescapeHtml(unescapeHtml(text)).replace(/mailto:/gi, " ");
  for (const match of plain.matchAll(EMAIL_RX)) {
    const email = match[0].replace(/[.]+$/, "").toLowerCase();
    if (!FILE_LIKE.test(email) && !NOT_FOR_APPLICATIONS.test(localOf(email))) return email;
  }
  return "";
}

/** Hosts that are never a company's own site: job sites, hiring platforms, social networks, code hosts. */
const NOT_A_COMPANY_SITE =
  /(?:^|\.)(?:himalayas\.app|remoteok\.(?:com|io)|weworkremotely\.com|remotive\.(?:com|io)|jobicy\.com|workingnomads\.com|realworkfromanywhere\.com|golangprojects\.com|python\.org|ycombinator\.com|greenhouse\.io|lever\.co|ashbyhq\.com|workable\.com|recruitee\.com|teamtailor\.com|breezy\.hr|linkedin\.com|twitter\.com|x\.com|facebook\.com|instagram\.com|youtube\.com|github\.com|gitlab\.com|medium\.com|notion\.so|google\.com|glassdoor\.com|indeed\.com|wellfound\.com|angel\.co|bit\.ly|t\.co|calendly\.com|typeform\.com|forms\.gle)$/i;

const squash = (text: string): string => text.toLowerCase().replace(/[^a-z0-9]+/g, "");

/**
 * The company's own website, when the listing names one that is plainly the company's:
 * its stated domain, or a link whose name is the company's ("stickermule.com" for "Sticker Mule").
 */
export function companySite(job: JobOpportunity): string {
  const name = squash(companyKey(job.company.replace(/\s*[([].*$/, "")));
  if (name.length < 3) return "";
  const looksLikeTheCompany = (host: string): boolean => {
    const label = squash(host.replace(/^www\./, "").split(".").slice(0, -1).join(""));
    return label.length >= 3 && (label.startsWith(name) || name.startsWith(label));
  };
  const stated = job.companyDomain.trim().toLowerCase().replace(/^www\./, "");
  if (stated && !NOT_A_COMPANY_SITE.test(stated) && looksLikeTheCompany(stated)) return stated;
  const text = unescapeHtml(unescapeHtml(`${job.applyUrl}\n${job.description}`));
  for (const match of text.matchAll(/https?:\/\/([a-z0-9.-]+\.[a-z]{2,24})/gi)) {
    const host = match[1].toLowerCase().replace(/^www\./, "");
    if (!NOT_A_COMPANY_SITE.test(host) && looksLikeTheCompany(host)) return host;
  }
  return "";
}

/** The pages of a company's site where a hiring address is published, most likely first. */
const PAGES = ["/careers", "/jobs", "/contact", "/"];
const PAGE_TIMEOUT_MS = 10_000;
const PAGE_LIMIT = 2_000_000;

export interface ContactFinderOptions {
  /** GET a page and return its HTML; throw when it cannot be had. Tests pass a fake. */
  fetchHtml?: (url: string) => Promise<string>;
}

async function defaultFetchHtml(url: string): Promise<string> {
  const response = await fetch(url, {
    headers: { Accept: "text/html", "User-Agent": "reygent/0.2 (personal job-search tool; looks for a published hiring address)" },
    redirect: "follow",
    signal: AbortSignal.timeout(PAGE_TIMEOUT_MS),
  });
  if (!response.ok) throw Object.assign(new Error(`HTTP ${response.status}`), { status: response.status });
  return (await response.text()).slice(0, PAGE_LIMIT);
}

/**
 * Build the finder: the listing's own address first, then the company's site, read for a
 * hiring address on its own domain. Each site is read at most once while the finder lives.
 */
export function createContactFinder(options: ContactFinderOptions = {}): ContactFinder {
  const fetchHtml = options.fetchHtml ?? defaultFetchHtml;
  const sites = new Map<string, Promise<string | null | "unreachable">>();

  const readSite = (domain: string): Promise<string | null | "unreachable"> => {
    let found = sites.get(domain);
    if (!found) {
      found = (async () => {
        let answered = false;
        for (const page of PAGES) {
          let html: string;
          try {
            html = await fetchHtml(`https://${domain}${page}`);
            answered = true;
          } catch {
            continue;
          }
          for (const match of unescapeHtml(html).replace(/mailto:/gi, " ").matchAll(EMAIL_RX)) {
            const email = match[0].toLowerCase();
            const own = domainOf(email) === domain || domainOf(email).endsWith(`.${domain}`) || domain.endsWith(`.${domainOf(email)}`);
            if (own && HIRING_NAME.test(localOf(email))) return email;
          }
        }
        return answered ? null : "unreachable";
      })();
      sites.set(domain, found);
    }
    return found;
  };

  return async (job) => {
    const posted = postedAddress(job);
    if (posted) return { email: posted, source: "listing" };
    const domain = companySite(job);
    if (!domain) return null;
    const found = await readSite(domain).catch(() => "unreachable" as const);
    if (found === "unreachable") return "unreachable";
    return found ? { email: found, source: "website" } : null;
  };
}
