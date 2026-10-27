/**
 * Workable job boards (apply.workable.com/{account}).
 *
 * One request to the endpoint behind Workable's embeddable careers widget returns the
 * whole board with descriptions. The payload names the company, says whether a role is
 * open to telecommuting and gives the employment type; it carries no pay.
 */

import { z } from "zod";

import {
  type FetchJson,
  companyFromSlug,
  joinLocations,
  mapEmploymentType,
  normalizeToken,
  readEnvelope,
  readListings,
  toIsoTimestamp,
} from "@/core/discovery/types";
import { type JobOpportunity, Channel, createJob } from "@/core/models";

const BoardSchema = z.object({ name: z.string().nullish(), jobs: z.array(z.unknown()) });

const PlaceSchema = z.object({ city: z.string().nullish(), region: z.string().nullish(), country: z.string().nullish() });

/** Only the fields read below. */
const JobSchema = z.object({
  shortcode: z.string().min(1),
  title: z.string().min(1),
  /** "Full-time", "Part-time", "Contract", "Temporary", ... */
  employment_type: z.string().nullish(),
  /** true when the role can be done remotely; false says nothing more than "not flagged". */
  telecommuting: z.boolean().nullish(),
  url: z.string().nullish(),
  application_url: z.string().nullish(),
  /** A date with no time: "2026-05-29". */
  published_on: z.string().nullish(),
  city: z.string().nullish(),
  state: z.string().nullish(),
  country: z.string().nullish(),
  locations: z.array(PlaceSchema).nullish().catch(null),
  description: z.string().nullish(),
});
type WorkableJob = z.infer<typeof JobSchema>;

export function workableUrl(account: string): string {
  return `https://apply.workable.com/api/v1/widget/accounts/${encodeURIComponent(account.trim())}?details=true`;
}

/** Every place the role is listed for, each as "City, Region, Country". */
function location(job: WorkableJob): string {
  const places = job.locations?.length ? job.locations : [{ city: job.city, region: job.state, country: job.country }];
  return joinLocations(places.map((place) => [place.city, place.region, place.country].filter(Boolean).join(", ")));
}

/** Every listing on the board `account`, normalised. Throws if the board cannot be read. */
export async function fetchWorkable(account: string, fetchJson: FetchJson): Promise<JobOpportunity[]> {
  const slug = normalizeToken(account);
  const board = readEnvelope(BoardSchema, await fetchJson(workableUrl(account)));
  return readListings(JobSchema, board.jobs).map((job) =>
    createJob({
      source: "workable",
      sourceId: `${slug}:${job.shortcode}`,
      company: board.name?.trim() || companyFromSlug(slug),
      title: job.title.trim(),
      location: location(job),
      description: job.description ?? "",
      applyUrl: job.application_url || job.url || `https://apply.workable.com/${encodeURIComponent(account.trim())}/j/${job.shortcode}`,
      channel: Channel.ATS_INBOUND,
      isRemote: job.telecommuting === true ? true : null,
      employmentType: mapEmploymentType(job.employment_type),
      postedAt: toIsoTimestamp(job.published_on),
    }),
  );
}
