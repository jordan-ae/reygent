/**
 * Greenhouse job boards (boards.greenhouse.io/{token}).
 *
 * One request returns the whole board: the list endpoint does not paginate. The payload
 * has no standard remote flag and no standard compensation, so `isRemote` stays null and
 * the pay fields stay empty; the eligibility scorer reads the location and description.
 */

import { z } from "zod";

import {
  type FetchJson,
  companyFromSlug,
  mapEmploymentType,
  normalizeToken,
  readEnvelope,
  readListings,
  toIsoTimestamp,
} from "@/core/discovery/types";
import { type JobOpportunity, Channel, createJob } from "@/core/models";

const BoardSchema = z.object({ jobs: z.array(z.unknown()) });

/** Only the fields read below; the payload carries many more. */
const JobSchema = z.object({
  id: z.union([z.number(), z.string()]),
  title: z.string(),
  /** Points at the employer's own careers site on some boards (stripe.com, jobs.elastic.co). */
  absolute_url: z.string(),
  company_name: z.string().nullish(),
  location: z.object({ name: z.string().nullish() }).nullish(),
  /** The description as HTML with its markup entity-escaped ("&lt;p&gt;"). */
  content: z.string().nullish(),
  first_published: z.string().nullish(),
  updated_at: z.string().nullish(),
  /** Custom fields defined by each employer; null on boards that expose none. */
  metadata: z
    .array(z.object({ name: z.string(), value: z.unknown() }))
    .nullish()
    .catch(null),
});
type GreenhouseJob = z.infer<typeof JobSchema>;

export function greenhouseUrl(token: string): string {
  return `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(token.trim())}/jobs?content=true`;
}

/**
 * The employment type, where the employer publishes it.
 *
 * Greenhouse has no such field of its own. Some boards add a custom "Employment Type"
 * field; that exact name is the only one read, because other custom fields are private
 * to each employer ("Job Type" is "Standard" / "Pipeline" on one board, for example).
 */
function employmentLabel(job: GreenhouseJob): string {
  const entry = job.metadata?.find((field) => field.name.trim().toLowerCase() === "employment type");
  return typeof entry?.value === "string" ? entry.value : "";
}

/** Every open listing on the board `token`, normalised. Throws if the board cannot be read. */
export async function fetchGreenhouse(token: string, fetchJson: FetchJson): Promise<JobOpportunity[]> {
  const slug = normalizeToken(token);
  const board = readEnvelope(BoardSchema, await fetchJson(greenhouseUrl(token)));
  return readListings(JobSchema, board.jobs).map((job) =>
    createJob({
      source: "greenhouse",
      // Greenhouse ids are only unique within one company's account.
      sourceId: `${slug}:${job.id}`,
      company: job.company_name?.trim() || companyFromSlug(slug),
      title: job.title.trim(),
      location: job.location?.name?.trim() ?? "",
      description: job.content ?? "",
      applyUrl: job.absolute_url,
      channel: Channel.ATS_INBOUND,
      employmentType: mapEmploymentType(employmentLabel(job)),
      postedAt: toIsoTimestamp(job.first_published ?? job.updated_at),
    }),
  );
}
