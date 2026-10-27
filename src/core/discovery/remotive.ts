/**
 * Remotive (remotive.com), a curated board of remote jobs.
 *
 * One request returns the public feed, which is small and a day behind the site. Its
 * terms come with every response: link back to the Remotive URL and name Remotive as the
 * source, do not re-post the jobs elsewhere, and ask "a couple of times a day (we advise
 * max. 4 times a day)". A listing is tracked here under its Remotive URL, which is also
 * where the application starts, and nothing is published anywhere.
 */

import { z } from "zod";

import {
  type FetchJson,
  boardChannel,
  mapEmploymentType,
  readEnvelope,
  readListings,
  toIsoTimestamp,
} from "@/core/discovery/types";
import { type JobOpportunity, createJob } from "@/core/models";

const FeedSchema = z.object({ jobs: z.array(z.unknown()) });

/** Only the fields read below. `salary` is free text ("OTE $25k - $35k") and is left to the description. */
const JobSchema = z.object({
  id: z.union([z.number(), z.string()]),
  url: z.string(),
  title: z.string().min(1),
  company_name: z.string().min(1),
  /** "full_time", "contract", "part_time", "freelance", "internship", "other". */
  job_type: z.string().nullish(),
  /** A date and time with no zone: "2026-10-08T21:47:32". */
  publication_date: z.string().nullish(),
  /** Where the hire may be: "Worldwide", "USA Only", "Europe, UK", ... */
  candidate_required_location: z.string().nullish(),
  description: z.string().nullish(),
});

export function remotiveUrl(): string {
  return "https://remotive.com/api/remote-jobs";
}

/** Every listing in the public feed, normalised. Throws if the feed cannot be read. */
export async function fetchRemotive(fetchJson: FetchJson): Promise<JobOpportunity[]> {
  const feed = readEnvelope(FeedSchema, await fetchJson(remotiveUrl()));
  return readListings(JobSchema, feed.jobs).map((job) => {
    const employmentType = mapEmploymentType(job.job_type?.replace(/_/g, " "));
    const published = job.publication_date ?? "";
    return createJob({
      source: "remotive",
      sourceId: String(job.id),
      company: job.company_name.trim(),
      title: job.title.trim(),
      location: job.candidate_required_location?.trim() ?? "",
      description: job.description ?? "",
      applyUrl: job.url,
      channel: boardChannel(employmentType),
      // The board lists remote work only.
      isRemote: true,
      employmentType,
      // Read as UTC, so the result does not depend on the time zone Reygent runs in.
      postedAt: toIsoTimestamp(/(?:Z|[+-]\d\d:?\d\d)$/.test(published) ? published : `${published}Z`),
    });
  });
}
