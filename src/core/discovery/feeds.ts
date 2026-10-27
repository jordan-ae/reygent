/**
 * Job boards read through the RSS feed each one publishes for the purpose.
 *
 * - We Work Remotely: "Anyone can use the feed, all we ask is that you attribute the
 *   links back to We Work Remotely." Every item states its region ("Anywhere in the
 *   World", "USA Only") in a field of its own.
 * - Real Work From Anywhere: free feeds, "no limits on ... how often you check them".
 *   The feed gives no location; the board's premise is work from anywhere, but that is
 *   left for the description to say.
 * - Golangprojects and the Python.org job board: small feeds for two of the candidate's
 *   languages. Neither is remote-only.
 *
 * A listing is tracked under its page on the board, which is where the application
 * starts. RSS has no standard fields for the company or the location, so each board has
 * its own way of reading an item; an item it cannot read is skipped, never guessed at.
 */

import {
  type EmploymentType,
  type FetchText,
  boardChannel,
  mapEmploymentType,
  toIsoTimestamp,
} from "@/core/discovery/types";
import { rssItems, xmlText } from "@/core/discovery/xml";
import { type JobOpportunity, createJob } from "@/core/models";

/** What one feed item states about a job. */
interface FeedListing {
  company: string;
  title: string;
  location: string;
  description: string;
  employmentType?: EmploymentType;
}

interface Feed {
  /** JobOpportunity.source, and the name the board goes by in the config. */
  source: string;
  url: string;
  /** The board lists remote work only, so every listing on it is remote. */
  remoteOnly: boolean;
  /** The listing's id on the board, from the item's link. */
  id: (link: string) => string;
  /** Null when the item does not name both a company and a role. */
  read: (item: string) => FeedListing | null;
}

/** The last path segment of a URL, without a file extension: the slug a board gives a listing. */
const slug = (link: string): string => link.replace(/[?#].*$/, "").replace(/\/+$/, "").split("/").pop()!.replace(/\.html?$/i, "");

/** Company suffixes that follow a comma ("ActivePrime, Inc."), so the name is not cut at it. */
const SUFFIX_RX = /^(?:inc|llc|ltd|gmbh|corp|co|plc|s\.?a|b\.?v|pty)\.?$/i;

/** `text` split at the last occurrence of `separator`: [before, after], or null if it is absent. */
function splitLast(text: string, separator: string): [string, string] | null {
  const at = text.lastIndexOf(separator);
  return at === -1 ? null : [text.slice(0, at).trim(), text.slice(at + separator.length).trim()];
}

const FEEDS: readonly Feed[] = [
  {
    source: "weworkremotely",
    url: "https://weworkremotely.com/remote-jobs.rss",
    remoteOnly: true,
    id: slug,
    read(item) {
      // "Company: Title". The company comes first, so a colon inside the title is harmless.
      const title = xmlText(item, "title");
      const at = title.indexOf(": ");
      if (at <= 0) return null;
      return {
        company: title.slice(0, at).trim(),
        title: title.slice(at + 2).trim(),
        // <state> is left out: the feed fills it with places unrelated to the listing.
        location: [xmlText(item, "region"), xmlText(item, "country")].filter(Boolean).join("; "),
        description: xmlText(item, "description"),
        employmentType: mapEmploymentType(xmlText(item, "type")),
      };
    },
  },
  {
    source: "realworkfromanywhere",
    url: "https://www.realworkfromanywhere.com/rss.xml",
    remoteOnly: true,
    id: slug,
    read(item) {
      // "Title at Company", with the company again in <author>.
      const company = xmlText(item, "author");
      const title = xmlText(item, "title");
      const ending = ` at ${company}`;
      if (!company || !title.endsWith(ending)) return null;
      return { company, title: title.slice(0, -ending.length).trim(), location: "", description: xmlText(item, "description") };
    },
  },
  {
    source: "golangprojects",
    url: "https://www.golangprojects.com/rss.xml",
    remoteOnly: false,
    id: slug,
    read(item) {
      // "Title @ Company", written with no-break spaces around the "@"; the description
      // opens with the place: "Remote - ...", "Copenhagen, Denmark - ...".
      const parts = splitLast(xmlText(item, "title").replace(/ /g, " "), " @ ");
      if (!parts) return null;
      const description = xmlText(item, "description");
      const at = description.indexOf(" - ");
      return { company: parts[1], title: parts[0], location: at > 0 && at <= 80 ? description.slice(0, at).trim() : "", description };
    },
  },
  {
    source: "python_org",
    url: "https://www.python.org/jobs/feed/rss/",
    remoteOnly: false,
    id: slug,
    read(item) {
      // "Title, Company"; the description opens with the place as "city, region, country" before its first tag.
      const parts = splitLast(xmlText(item, "title"), ", ");
      if (!parts) return null;
      const withSuffix = SUFFIX_RX.test(parts[1]) ? splitLast(parts[0], ", ") : null;
      const [title, company] = withSuffix ? [withSuffix[0], `${withSuffix[1]}, ${parts[1]}`] : parts;
      const description = xmlText(item, "description");
      const tagAt = description.search(/<[a-z]/i);
      const place = (tagAt === -1 ? "" : description.slice(0, tagAt)).split(",").map((part) => part.trim()).filter(Boolean);
      return {
        company,
        title,
        // The three fields often repeat each other ("Remote, Remote, Worldwide").
        location: place.filter((part, index) => place.findIndex((other) => other.toLowerCase() === part.toLowerCase()) === index).join(", "),
        description: tagAt === -1 ? description : description.slice(tagAt),
      };
    },
  },
];

/** The boards read through RSS, by the name each goes by in `discovery.job_boards`. */
export const FEED_SOURCES: readonly string[] = FEEDS.map((feed) => feed.source);

export function feedUrl(source: string): string {
  const feed = FEEDS.find((candidate) => candidate.source === source);
  if (!feed) throw new Error(`no feed is known as ${source}`);
  return feed.url;
}

/** Every listing in the board's feed, normalised. Throws if the feed cannot be read. */
export async function fetchFeed(source: string, fetchText: FetchText): Promise<JobOpportunity[]> {
  const feed = FEEDS.find((candidate) => candidate.source === source);
  if (!feed) throw new Error(`no feed is known as ${source}`);
  const items = rssItems(await fetchText(feed.url));
  const jobs: JobOpportunity[] = [];
  for (const item of items) {
    const link = xmlText(item, "link") || xmlText(item, "guid");
    const listing = /^https?:\/\//i.test(link) ? feed.read(item) : null;
    if (!listing || !listing.company || !listing.title) continue;
    const employmentType = listing.employmentType ?? "";
    jobs.push(
      createJob({
        source: feed.source,
        sourceId: feed.id(link),
        ...listing,
        applyUrl: link,
        channel: boardChannel(employmentType),
        isRemote: feed.remoteOnly ? true : null,
        employmentType,
        postedAt: toIsoTimestamp(xmlText(item, "pubDate") || null),
      }),
    );
  }
  // Same rule as readListings: a feed with items and not one readable has changed its format.
  if (items.length > 0 && jobs.length === 0) throw new Error(`none of the ${items.length} listings matched the expected shape`);
  return jobs;
}
