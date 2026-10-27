/**
 * Breezy HR career portals ({company}.breezy.hr).
 *
 * One request returns every open position as a bare JSON array; `verbose=true` adds the
 * descriptions. Each location says whether it is remote and, in the employer's chosen
 * wording, how remote ("Fully remote, no location restrictions"). Pay is free text and
 * is not mapped.
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

const BoardSchema = z.array(z.unknown());

const PlaceSchema = z.object({
  /** "Austin, TX". */
  name: z.string().nullish(),
  country: z.object({ name: z.string().nullish() }).nullish(),
  is_remote: z.boolean().nullish(),
  remote_details: z.object({ label: z.string().nullish() }).nullish(),
});

/** Only the fields read below. */
const PositionSchema = z.object({
  id: z.string().min(1),
  /** The job title. */
  name: z.string().min(1),
  url: z.string().min(1),
  published_date: z.string().nullish(),
  /** { name: "Full-Time" | "Part-Time" | "Contract" | ... }. */
  type: z.object({ name: z.string().nullish() }).nullish().catch(null),
  location: PlaceSchema.nullish().catch(null),
  locations: z.array(PlaceSchema).nullish().catch(null),
  company: z.object({ name: z.string().nullish() }).nullish().catch(null),
  description: z.string().nullish(),
});

export function breezyUrl(company: string): string {
  return `https://${encodeURIComponent(company.trim())}.breezy.hr/json?verbose=true`;
}

/** Every open position of `company`, normalised. Throws if the portal cannot be read. */
export async function fetchBreezy(company: string, fetchJson: FetchJson): Promise<JobOpportunity[]> {
  const slug = normalizeToken(company);
  const board = readEnvelope(BoardSchema, await fetchJson(breezyUrl(company)));
  return readListings(PositionSchema, board).map((position) => {
    const places = position.locations?.length ? position.locations : position.location ? [position.location] : [];
    return createJob({
      source: "breezy",
      sourceId: `${slug}:${position.id}`,
      company: position.company?.name?.trim() || companyFromSlug(slug),
      title: position.name.trim(),
      // The place, its country and the employer's remote wording: the scorer reads all three.
      location: joinLocations(places.flatMap((place) => [place.name, place.country?.name, place.remote_details?.label])),
      description: position.description ?? "",
      applyUrl: position.url,
      channel: Channel.ATS_INBOUND,
      isRemote: places.some((place) => place.is_remote === true) ? true : null,
      employmentType: mapEmploymentType(position.type?.name),
      postedAt: toIsoTimestamp(position.published_date),
    });
  });
}
