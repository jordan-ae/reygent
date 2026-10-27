/**
 * Teamtailor career sites ({company}.teamtailor.com).
 *
 * Every Teamtailor site publishes its openings as an RSS feed (Teamtailor's JSON API
 * needs a key; the feed does not). The feed names the company in its title and gives
 * each job's locations and whether it is remote in Teamtailor's own elements. It states
 * no employment type and no pay.
 */

import { type FetchText, companyFromSlug, joinLocations, normalizeToken, toIsoTimestamp } from "@/core/discovery/types";
import { rssItems, xmlElements, xmlText } from "@/core/discovery/xml";
import { type JobOpportunity, Channel, createJob } from "@/core/models";

export function teamtailorUrl(company: string): string {
  return `https://${encodeURIComponent(company.trim())}.teamtailor.com/jobs.rss`;
}

/** "fully" is remote and "none" is on-site; "hybrid" and "temporary" are neither. */
function remoteFlag(status: string): boolean | null {
  if (status === "fully") return true;
  return status === "none" ? false : null;
}

/** Every opening of `company`, normalised. Throws if the feed cannot be read. */
export async function fetchTeamtailor(company: string, fetchText: FetchText): Promise<JobOpportunity[]> {
  const slug = normalizeToken(company);
  const xml = await fetchText(teamtailorUrl(company));
  const items = rssItems(xml);
  // The channel's own <title> comes before the first item's.
  const name = xmlText(xml.split(/<item[\s>]/)[0], "title");
  const jobs: JobOpportunity[] = [];
  for (const item of items) {
    const title = xmlText(item, "title");
    const link = xmlText(item, "link");
    const id = xmlText(item, "guid") || link;
    if (!title || !id || !/^https?:\/\//i.test(link)) continue;
    jobs.push(
      createJob({
        source: "teamtailor",
        sourceId: `${slug}:${id}`,
        company: name || companyFromSlug(slug),
        title,
        location: joinLocations(xmlElements(item, "tt:location").map((place) => xmlText(place, "tt:name"))),
        description: xmlText(item, "description"),
        applyUrl: link,
        channel: Channel.ATS_INBOUND,
        isRemote: remoteFlag(xmlText(item, "remoteStatus")),
        postedAt: toIsoTimestamp(xmlText(item, "pubDate") || null),
      }),
    );
  }
  if (items.length > 0 && jobs.length === 0) throw new Error(`none of the ${items.length} listings matched the expected shape`);
  return jobs;
}
