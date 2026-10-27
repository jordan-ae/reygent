/**
 * Himalayas (himalayas.app), read through its public search API.
 *
 * The whole feed is over a hundred thousand listings, twenty to a page, most of them tied
 * to one country. Only the search for worldwide-friendly jobs is read, newest first, a
 * bounded number of pages at a time. Himalayas asks for a link back to the listing and to
 * be named as the source, forbids re-posting the jobs elsewhere, and says its data "is
 * cached every 24 hours, so polling more than once per day provides no benefit".
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

const PageSchema = z.object({ jobs: z.array(z.unknown()), totalCount: z.number().nullish() });

/** Only the fields read below. */
const JobSchema = z.object({
  /** The listing's URL on Himalayas, which is also its identity. */
  guid: z.string().min(1),
  title: z.string().min(1),
  companyName: z.string().min(1),
  /** "Full Time", "Part Time", "Contractor", "Temporary", "Intern", ... */
  employmentType: z.string().nullish(),
  minSalary: z.number().nullish().catch(null),
  maxSalary: z.number().nullish().catch(null),
  currency: z.string().nullish(),
  /** "annual", "monthly", "hourly", ... */
  salaryPeriod: z.string().nullish(),
  /** Country names; empty when the hire may be anywhere. */
  locationRestrictions: z.array(z.string()).nullish().catch(null),
  /** Every UTC offset the role accepts, in hours. */
  timezoneRestrictions: z.array(z.number()).nullish().catch(null),
  description: z.string().nullish(),
  excerpt: z.string().nullish(),
  /** Epoch seconds. */
  pubDate: z.number().nullish(),
  applicationLink: z.string().nullish(),
});
type HimalayasJob = z.infer<typeof JobSchema>;

const PERIODS = new Map<string, CompPeriod>([
  ["annual", "year"],
  ["monthly", "month"],
  ["hourly", "hour"],
]);

export interface HimalayasOptions {
  /** Upper bound on the pages read in one go, twenty listings each. */
  maxPages?: number;
}

/** One page of the worldwide-friendly listings, newest first. Pages count from 1. */
export function himalayasUrl(page: number): string {
  return `https://himalayas.app/jobs/api/search?worldwide=true&sort=recent&page=${page}`;
}

const utcOffset = (hours: number): string => `UTC${hours < 0 ? "-" : "+"}${Math.abs(hours)}`;

/**
 * Where the hire may be, in words the eligibility scorer reads.
 *
 * Himalayas states this as data. A listing in this search with no country restriction is
 * what its site labels "Worldwide", unless it accepts only some time zones: then those
 * are named instead, because a role limited to American hours is not open to everyone.
 * A list that goes all the way round the clock restricts nothing.
 */
function location(job: HimalayasJob): string {
  const countries = job.locationRestrictions ?? [];
  if (countries.length > 0) return countries.join(", ");
  const zones = job.timezoneRestrictions ?? [];
  if (zones.length === 0 || zones.length >= 24) return "Worldwide";
  return `Time zones: ${zones.map(utcOffset).join(", ")}`;
}

function salary(job: HimalayasJob): Compensation | null {
  const compPeriod = PERIODS.get((job.salaryPeriod ?? "").toLowerCase());
  const compMin = positiveAmount(job.minSalary);
  const compMax = positiveAmount(job.maxSalary);
  if (!compPeriod || !job.currency || (compMin === null && compMax === null)) return null;
  return { compMin, compMax, compPeriod, compCurrency: job.currency.toUpperCase() };
}

/** The newest worldwide-friendly listings, normalised. Throws if a page cannot be read. */
export async function fetchHimalayas(fetchJson: FetchJson, options: HimalayasOptions = {}): Promise<JobOpportunity[]> {
  const { maxPages = 10 } = options;
  const jobs: JobOpportunity[] = [];
  let seen = 0;
  for (let page = 1; page <= maxPages; page += 1) {
    const result = readEnvelope(PageSchema, await fetchJson(himalayasUrl(page)));
    for (const job of readListings(JobSchema, result.jobs)) {
      const employmentType = mapEmploymentType(job.employmentType);
      jobs.push(
        createJob({
          source: "himalayas",
          sourceId: job.guid.replace(/^https?:\/\/himalayas\.app\//i, ""),
          company: job.companyName.trim(),
          title: job.title.trim(),
          location: location(job),
          description: job.description || job.excerpt || "",
          applyUrl: job.applicationLink || job.guid,
          channel: boardChannel(employmentType),
          // The board lists remote work only.
          isRemote: true,
          employmentType,
          ...salary(job),
          postedAt: toIsoTimestamp(typeof job.pubDate === "number" ? job.pubDate * 1000 : null),
        }),
      );
    }
    seen += result.jobs.length;
    if (result.jobs.length === 0 || seen >= (result.totalCount ?? Infinity)) break;
  }
  return jobs;
}
