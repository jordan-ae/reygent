/**
 * Remote OK (remoteok.com).
 *
 * One request returns the latest hundred listings as a bare array whose first element is
 * the API's terms: link back to the listing on Remote OK and name Remote OK as the
 * source. A listing is tracked under its Remote OK URL, which is where the application
 * starts. The feed's `salary_min` / `salary_max` come with no currency and no period, so
 * they are not mapped.
 */

import { z } from "zod";

import { type FetchJson, readEnvelope, readListings, toIsoTimestamp } from "@/core/discovery/types";
import { type JobOpportunity, Channel, createJob } from "@/core/models";

const FeedSchema = z.array(z.unknown());

/** Only the fields read below. The terms element has none of them and is skipped like any unreadable entry. */
const JobSchema = z.object({
  id: z.union([z.number(), z.string()]),
  /** The job title. */
  position: z.string().min(1),
  company: z.string().min(1),
  /** Free text from the poster: "Worldwide", "Remote - US", a city, or nothing. */
  location: z.string().nullish(),
  description: z.string().nullish(),
  date: z.string().nullish(),
  url: z.string().nullish(),
  apply_url: z.string().nullish(),
});

export function remoteOkUrl(): string {
  return "https://remoteok.com/api";
}

/** Every listing in the feed, normalised. Throws if the feed cannot be read. */
export async function fetchRemoteOk(fetchJson: FetchJson): Promise<JobOpportunity[]> {
  const feed = readEnvelope(FeedSchema, await fetchJson(remoteOkUrl()));
  return readListings(JobSchema, feed).map((job) =>
    createJob({
      source: "remoteok",
      sourceId: String(job.id),
      company: job.company.trim(),
      title: job.position.trim(),
      location: job.location?.trim() ?? "",
      description: job.description ?? "",
      applyUrl: job.apply_url || job.url || `https://remoteok.com/remote-jobs/${job.id}`,
      channel: Channel.ATS_INBOUND,
      // The board lists remote work only.
      isRemote: true,
      postedAt: toIsoTimestamp(job.date),
    }),
  );
}
