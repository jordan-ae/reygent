/**
 * Recruitee careers sites ({company}.recruitee.com).
 *
 * One request to the public Careers Site API returns every offer with its description,
 * its requirements, structured remote / hybrid / on-site flags and, where the employer
 * publishes one, a salary range. Large boards answer with several megabytes.
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
  toIsoTimestamp,
} from "@/core/discovery/types";
import { type JobOpportunity, Channel, createJob } from "@/core/models";

const BoardSchema = z.object({ offers: z.array(z.unknown()) });

/** Amounts arrive as numbers or as numeric strings. */
const Amount = z.union([z.number(), z.string()]).nullish();

/** Only the fields read below. */
const OfferSchema = z.object({
  id: z.union([z.number(), z.string()]),
  title: z.string().min(1),
  /** "published" for an open offer. */
  status: z.string().nullish(),
  company_name: z.string().nullish(),
  /** The headline location as the employer wrote it: "Remote job", "Amsterdam", ... */
  location: z.string().nullish(),
  locations: z.array(z.object({ name: z.string().nullish() })).nullish().catch(null),
  remote: z.boolean().nullish(),
  hybrid: z.boolean().nullish(),
  on_site: z.boolean().nullish(),
  /** "fulltime_permanent", "contract", "freelance", "internship", ... */
  employment_type_code: z.string().nullish(),
  description: z.string().nullish(),
  requirements: z.string().nullish(),
  salary: z.object({ min: Amount, max: Amount, period: z.string().nullish(), currency: z.string().nullish() }).nullish().catch(null),
  /** "2026-10-12 15:01:59 UTC". */
  published_at: z.string().nullish(),
  careers_url: z.string().nullish(),
  careers_apply_url: z.string().nullish(),
});
type Offer = z.infer<typeof OfferSchema>;

export function recruiteeUrl(company: string): string {
  return `https://${encodeURIComponent(company.trim())}.recruitee.com/api/offers/`;
}

/** true only for a remote offer, false only for one that is on-site and nothing else. */
function remoteFlag(offer: Offer): boolean | null {
  if (offer.remote === true) return true;
  return offer.on_site === true && offer.hybrid !== true ? false : null;
}

function salary(offer: Offer): Compensation | null {
  const range = offer.salary;
  if (!range) return null;
  const period = (range.period ?? "").toLowerCase();
  const compPeriod: CompPeriod | null = /year|annual/.test(period) ? "year" : /month/.test(period) ? "month" : /hour/.test(period) ? "hour" : null;
  const compMin = positiveAmount(range.min === null || range.min === undefined ? null : Number(range.min));
  const compMax = positiveAmount(range.max === null || range.max === undefined ? null : Number(range.max));
  if (!compPeriod || !range.currency || (compMin === null && compMax === null)) return null;
  return { compMin, compMax, compPeriod, compCurrency: range.currency.toUpperCase() };
}

/** Every published offer of `company`, normalised. Throws if the board cannot be read. */
export async function fetchRecruitee(company: string, fetchJson: FetchJson): Promise<JobOpportunity[]> {
  const slug = normalizeToken(company);
  const board = readEnvelope(BoardSchema, await fetchJson(recruiteeUrl(company)));
  return readListings(OfferSchema, board.offers)
    .filter((offer) => !offer.status || offer.status === "published")
    .map((offer) =>
      createJob({
        source: "recruitee",
        sourceId: `${slug}:${offer.id}`,
        company: offer.company_name?.trim() || companyFromSlug(slug),
        title: offer.title.trim(),
        location: joinLocations([offer.location, ...(offer.locations ?? []).map((place) => place.name)]),
        // The requirements are a field of their own and carry the conditions the scorer looks for.
        description: [offer.description, offer.requirements].filter(Boolean).join("\n"),
        applyUrl: offer.careers_apply_url || offer.careers_url || `https://${slug}.recruitee.com/`,
        channel: Channel.ATS_INBOUND,
        isRemote: remoteFlag(offer),
        employmentType: mapEmploymentType(offer.employment_type_code?.replace(/_/g, " ")),
        ...salary(offer),
        postedAt: toIsoTimestamp(offer.published_at?.replace(/^(\d{4}-\d\d-\d\d) (\d\d:\d\d:\d\d) UTC$/, "$1T$2Z")),
      }),
    );
}
