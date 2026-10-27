/**
 * Ashby job boards (jobs.ashbyhq.com/{org}).
 *
 * One request returns the whole board. Ashby is the richest of the three ATS feeds: it
 * states the workplace type, the employment type and, when the employer publishes it,
 * the salary range as numbers. The payload does not name the company, so the display
 * name is derived from the slug.
 */

import { z } from "zod";

import {
  type CompPeriod,
  type Compensation,
  type FetchJson,
  companyFromSlug,
  joinLocations,
  mapEmploymentType,
  normalizeToken,
  positiveAmount,
  readEnvelope,
  readListings,
  remoteFromWorkplaceType,
  toIsoTimestamp,
} from "@/core/discovery/types";
import { type JobOpportunity, Channel, createJob } from "@/core/models";

const BoardSchema = z.object({ jobs: z.array(z.unknown()) });

const ComponentSchema = z.object({
  /** "Salary", "EquityPercentage", "EquityCashValue", "Commission", "Bonus". */
  compensationType: z.string(),
  /** "1 YEAR", "1 MONTH", "1 HOUR", or "NONE" for equity. */
  interval: z.string().nullish(),
  currencyCode: z.string().nullish(),
  minValue: z.number().nullish(),
  maxValue: z.number().nullish(),
});
type Component = z.infer<typeof ComponentSchema>;

/** Only the fields read below. */
const JobSchema = z.object({
  id: z.string(),
  title: z.string(),
  location: z.string().nullish(),
  secondaryLocations: z
    .array(z.object({ location: z.string().nullish() }))
    .nullish()
    .catch(null),
  /** "FullTime", "PartTime", "Intern", "Contract", "Temporary". */
  employmentType: z.string().nullish(),
  /** "Remote", "Hybrid", "OnSite"; null on boards that do not set it. */
  workplaceType: z.string().nullish(),
  isRemote: z.boolean().nullish(),
  isListed: z.boolean().nullish(),
  publishedAt: z.string().nullish(),
  jobUrl: z.string().nullish(),
  applyUrl: z.string().nullish(),
  descriptionHtml: z.string().nullish(),
  descriptionPlain: z.string().nullish(),
  compensation: z
    .object({
      /** The range across every tier, as shown on the posting. */
      summaryComponents: z.array(ComponentSchema).nullish(),
      /** One entry per location band when the employer pays by region. */
      compensationTiers: z.array(z.object({ components: z.array(ComponentSchema).nullish() })).nullish(),
    })
    .nullish()
    .catch(null),
});
type AshbyJob = z.infer<typeof JobSchema>;

const PERIODS = new Map<string, CompPeriod>([
  ["1 YEAR", "year"],
  ["1 MONTH", "month"],
  ["1 HOUR", "hour"],
]);

export function ashbyUrl(org: string): string {
  return `https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(org.trim())}?includeCompensation=true`;
}

/**
 * Whether the role is remote, from Ashby's structured fields.
 *
 * `workplaceType` decides. `isRemote` alone is not usable: Ashby sets it to true for
 * "Hybrid" roles as well, including ones that require set days in an office, so passing
 * it through would mark those as remote. It is only consulted when a board has no
 * workplace type at all.
 */
function remoteFlag(job: AshbyJob): boolean | null {
  if (job.workplaceType) return remoteFromWorkplaceType(job.workplaceType);
  return job.isRemote ?? null;
}

/** The base-salary range, when the employer publishes one with a currency and a period. */
function salary(job: AshbyJob): Compensation | null {
  const components: Component[] = [
    ...(job.compensation?.summaryComponents ?? []),
    ...(job.compensation?.compensationTiers ?? []).flatMap((tier) => tier.components ?? []),
  ];
  for (const part of components) {
    if (part.compensationType !== "Salary") continue;
    const compPeriod = PERIODS.get(part.interval ?? "");
    const compMin = positiveAmount(part.minValue);
    const compMax = positiveAmount(part.maxValue);
    if (!compPeriod || !part.currencyCode || (compMin === null && compMax === null)) continue;
    return { compMin, compMax, compPeriod, compCurrency: part.currencyCode.toUpperCase() };
  }
  return null;
}

/** Every listed posting on the board `org`, normalised. Throws if the board cannot be read. */
export async function fetchAshby(org: string, fetchJson: FetchJson): Promise<JobOpportunity[]> {
  const slug = normalizeToken(org);
  const board = readEnvelope(BoardSchema, await fetchJson(ashbyUrl(org)));
  return readListings(JobSchema, board.jobs)
    .filter((job) => job.isListed !== false)
    .map((job) =>
      createJob({
        source: "ashby",
        sourceId: `${slug}:${job.id}`,
        company: companyFromSlug(slug),
        title: job.title.trim(),
        location: joinLocations([job.location, ...(job.secondaryLocations ?? []).map((entry) => entry.location)]),
        description: job.descriptionHtml || job.descriptionPlain || "",
        applyUrl: job.applyUrl || job.jobUrl || `https://jobs.ashbyhq.com/${encodeURIComponent(org.trim())}/${job.id}`,
        channel: Channel.ATS_INBOUND,
        isRemote: remoteFlag(job),
        employmentType: mapEmploymentType(job.employmentType),
        ...salary(job),
        postedAt: toIsoTimestamp(job.publishedAt),
      }),
    );
}
