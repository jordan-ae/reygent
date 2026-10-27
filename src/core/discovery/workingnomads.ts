/**
 * Working Nomads (workingnomads.com), which curates remote jobs from around the web.
 *
 * One request returns the latest fifty listings; the site links this endpoint from its
 * footer as its API and states no conditions for it. Each listing's URL is a Working
 * Nomads link that forwards to the employer; it is kept as it is and never resolved here.
 */

import { z } from "zod";

import { type FetchJson, readEnvelope, readListings, toIsoTimestamp } from "@/core/discovery/types";
import { type JobOpportunity, Channel, createJob } from "@/core/models";

const FeedSchema = z.array(z.unknown());

/** Only the fields read below. */
const JobSchema = z.object({
  /** "https://www.workingnomads.com/job/go/1936318/". */
  url: z.string().min(1),
  title: z.string().min(1),
  company_name: z.string().min(1),
  /** Where the hire may be: "Global", "United States", "Time zone: CET (+/- 3 hours)", ... */
  location: z.string().nullish(),
  description: z.string().nullish(),
  pub_date: z.string().nullish(),
});

export function workingNomadsUrl(): string {
  return "https://www.workingnomads.com/api/exposed_jobs/";
}

/** Every listing in the feed, normalised. Throws if the feed cannot be read. */
export async function fetchWorkingNomads(fetchJson: FetchJson): Promise<JobOpportunity[]> {
  const feed = readEnvelope(FeedSchema, await fetchJson(workingNomadsUrl()));
  return readListings(JobSchema, feed).map((job) =>
    createJob({
      source: "workingnomads",
      // The number in the link is the listing's id; the payload has no other.
      sourceId: /\/(\d+)\/?$/.exec(job.url)?.[1] ?? job.url,
      company: job.company_name.trim(),
      title: job.title.trim(),
      location: job.location?.trim() ?? "",
      description: job.description ?? "",
      applyUrl: job.url,
      channel: Channel.ATS_INBOUND,
      // The board lists remote work only.
      isRemote: true,
      postedAt: toIsoTimestamp(job.pub_date),
    }),
  );
}
