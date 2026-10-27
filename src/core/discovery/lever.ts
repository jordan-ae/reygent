/**
 * Lever job boards (jobs.lever.co/{company}).
 *
 * One request returns every posting as a bare JSON array. Lever states the workplace
 * type and, on some boards, a numeric salary range. The payload does not name the
 * company, so the display name is derived from the slug.
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

const BoardSchema = z.array(z.unknown());

/** Only the fields read below. */
const PostingSchema = z.object({
  id: z.string(),
  /** The job title. */
  text: z.string(),
  categories: z
    .object({
      /** Free text chosen by the employer: "Full-time", "Contractor", "Employee India", ... */
      commitment: z.string().nullish(),
      location: z.string().nullish(),
      allLocations: z.array(z.string()).nullish(),
    })
    .nullish()
    .catch(null),
  /** Epoch milliseconds. */
  createdAt: z.number().nullish(),
  /** The opening paragraphs as HTML; the requirement lists and the closing section are separate fields. */
  description: z.string().nullish(),
  descriptionPlain: z.string().nullish(),
  lists: z
    .array(z.object({ text: z.string().nullish(), content: z.string().nullish() }))
    .nullish()
    .catch(null),
  additional: z.string().nullish(),
  salaryDescription: z.string().nullish(),
  salaryRange: z
    .object({
      min: z.number().nullish(),
      max: z.number().nullish(),
      currency: z.string().nullish(),
      /** "per-year-salary", "per-month-salary", "per-hour-wage", ... */
      interval: z.string().nullish(),
    })
    .nullish()
    .catch(null),
  /** "remote", "hybrid", "onsite" or "unspecified". */
  workplaceType: z.string().nullish(),
  hostedUrl: z.string().nullish(),
  applyUrl: z.string().nullish(),
});
type LeverPosting = z.infer<typeof PostingSchema>;

// Other intervals ("semi-month-salary", "bi-weekly-salary", "one-time") have no
// counterpart in JobOpportunity.compPeriod, so a range quoted in them is left unmapped.
const PERIODS = new Map<string, CompPeriod>([
  ["per-year-salary", "year"],
  ["per-month-salary", "month"],
  ["per-hour-wage", "hour"],
]);

export function leverUrl(company: string): string {
  return `https://api.lever.co/v0/postings/${encodeURIComponent(company.trim())}?mode=json`;
}

/**
 * The whole posting as one HTML document.
 *
 * Lever splits a posting into an opening, titled bullet lists and a closing section.
 * Requirements live in the lists, and work-authorisation or location conditions are
 * usually in the closing section, so the eligibility scorer needs all of them.
 */
function fullDescription(posting: LeverPosting): string {
  const lists = (posting.lists ?? []).map((list) => `<h3>${list.text ?? ""}</h3><ul>${list.content ?? ""}</ul>`);
  const html = [posting.description, ...lists, posting.additional, posting.salaryDescription].filter(Boolean);
  return html.length ? html.join("\n") : (posting.descriptionPlain ?? "");
}

function salary(posting: LeverPosting): Compensation | null {
  const range = posting.salaryRange;
  if (!range) return null;
  const compPeriod = PERIODS.get(range.interval ?? "");
  const compMin = positiveAmount(range.min);
  const compMax = positiveAmount(range.max);
  if (!compPeriod || !range.currency || (compMin === null && compMax === null)) return null;
  return { compMin, compMax, compPeriod, compCurrency: range.currency.toUpperCase() };
}

/** Every posting on the board `company`, normalised. Throws if the board cannot be read. */
export async function fetchLever(company: string, fetchJson: FetchJson): Promise<JobOpportunity[]> {
  const slug = normalizeToken(company);
  const board = readEnvelope(BoardSchema, await fetchJson(leverUrl(company)));
  return readListings(PostingSchema, board).map((posting) =>
    createJob({
      source: "lever",
      sourceId: `${slug}:${posting.id}`,
      company: companyFromSlug(slug),
      title: posting.text.trim(),
      // allLocations repeats the primary location, which joinLocations folds away.
      location: joinLocations([posting.categories?.location, ...(posting.categories?.allLocations ?? [])]),
      description: fullDescription(posting),
      applyUrl:
        posting.applyUrl || posting.hostedUrl || `https://jobs.lever.co/${encodeURIComponent(company.trim())}/${posting.id}`,
      channel: Channel.ATS_INBOUND,
      isRemote: remoteFromWorkplaceType(posting.workplaceType),
      employmentType: mapEmploymentType(posting.categories?.commitment),
      ...salary(posting),
      postedAt: toIsoTimestamp(posting.createdAt),
    }),
  );
}
