/**
 * Jobicy (jobicy.com), a remote-jobs board with a public API.
 *
 * The feed covers the last seven days, two hundred listings to a page, continued with the
 * cursor each response hands back. Jobicy asks to be credited with a link to the listing
 * and that applications go through that link; a listing is tracked under its Jobicy URL.
 * Its guidance on frequency: "a few times per day is normally sufficient and must not
 * exceed once per hour".
 */

import { z } from "zod";

import {
  type CompPeriod,
  type Compensation,
  type FetchJson,
  boardChannel,
  mapEmploymentType,
  positiveAmount,
  readEnvelope,
  readListings,
  toIsoTimestamp,
} from "@/core/discovery/types";
import { type JobOpportunity, createJob } from "@/core/models";
import { unescapeHtml } from "@/core/text";

const PageSchema = z.object({ jobs: z.array(z.unknown()), nextCursor: z.string().nullish() });

/** Only the fields read below. */
const JobSchema = z.object({
  id: z.union([z.number(), z.string()]),
  url: z.string(),
  jobTitle: z.string().min(1),
  companyName: z.string().min(1),
  /** ["Full-Time"], ["Contract"], ... */
  jobType: z.array(z.string()).nullish().catch(null),
  /** Where the hire may be: "Anywhere", "USA", "EMEA,  UK", ... */
  jobGeo: z.string().nullish(),
  jobDescription: z.string().nullish(),
  jobExcerpt: z.string().nullish(),
  pubDate: z.string().nullish(),
  salaryMin: z.number().nullish().catch(null),
  salaryMax: z.number().nullish().catch(null),
  salaryCurrency: z.string().nullish(),
  /** "yearly", "monthly", "hourly", ... */
  salaryPeriod: z.string().nullish(),
});
type JobicyJob = z.infer<typeof JobSchema>;

const PERIODS = new Map<string, CompPeriod>([
  ["yearly", "year"],
  ["monthly", "month"],
  ["hourly", "hour"],
]);

export interface JobicyOptions {
  /** Upper bound on the pages read in one go; a week of listings is five or six. */
  maxPages?: number;
}

/** One page of the feed, newest first. */
export function jobicyUrl(cursor = ""): string {
  return `https://jobicy.com/api/v2/remote-jobs?count=200${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`;
}

function salary(job: JobicyJob): Compensation | null {
  const compPeriod = PERIODS.get((job.salaryPeriod ?? "").toLowerCase());
  const compMin = positiveAmount(job.salaryMin);
  const compMax = positiveAmount(job.salaryMax);
  if (!compPeriod || !job.salaryCurrency || (compMin === null && compMax === null)) return null;
  return { compMin, compMax, compPeriod, compCurrency: job.salaryCurrency.toUpperCase() };
}

/** The week's listings, normalised. Throws if a page cannot be read. */
export async function fetchJobicy(fetchJson: FetchJson, options: JobicyOptions = {}): Promise<JobOpportunity[]> {
  const { maxPages = 6 } = options;
  const jobs: JobOpportunity[] = [];
  let cursor = "";
  for (let page = 0; page < maxPages; page += 1) {
    const result = readEnvelope(PageSchema, await fetchJson(jobicyUrl(cursor)));
    for (const job of readListings(JobSchema, result.jobs)) {
      const employmentType = mapEmploymentType(job.jobType?.join(", "));
      jobs.push(
        createJob({
          source: "jobicy",
          sourceId: String(job.id),
          // Titles and names come entity-escaped ("R&amp;D Engineer").
          company: unescapeHtml(job.companyName).trim(),
          title: unescapeHtml(job.jobTitle).trim(),
          location: (job.jobGeo ?? "").replace(/\s+/g, " ").trim(),
          description: job.jobDescription || job.jobExcerpt || "",
          applyUrl: job.url,
          channel: boardChannel(employmentType),
          // The board lists remote work only.
          isRemote: true,
          employmentType,
          ...salary(job),
          postedAt: toIsoTimestamp(job.pubDate),
        }),
      );
    }
    if (!result.nextCursor || result.jobs.length === 0) break;
    cursor = result.nextCursor;
  }
  return jobs;
}
