/**
 * Work-status questions on an application form — may the candidate work there, will they
 * need sponsorship, do they live there or will they move — answered from where the
 * candidate lives and from the listing's own eligibility verdict. Deterministic, $0.00.
 *
 * The candidate works remotely, as an independent contractor, from the country of their
 * verified location. So:
 *
 *   authorized to work in X     yes only when X is that country
 *   sponsorship to work in X    no for that country, yes for any other
 *   sponsorship, no place named no: they work from where they are
 *   willing to relocate         no
 *   happy to work as a contractor (B2B)  yes, when that is how they work
 *
 * A question about the role's own country ("the country to which you are applying", "the
 * job's location") is answered from the listing, through the remote-eligibility scorer:
 * a role open to someone working from the candidate's country is one they may take, and a
 * role listed for another country is not. Such an answer belongs to that listing alone.
 *
 * Citizenship, export control and anything else is left to the candidate's data.
 */

import { type CandidateProfile, EligibilityTier, type JobOpportunity } from "@/core/models";
import { evaluateRemoteEligibility } from "@/core/qualification/eligibility";
import { cleanText, normalizePunctuation } from "@/core/text";

export interface WorkStatusAnswer {
  yes: boolean;
  /** Read from this listing, not from the candidate alone: another listing can need the other answer. */
  perJob: boolean;
}

// ---------- Places ----------

const REGION_NAMES = new Intl.DisplayNames(["en"], { type: "region" });
/** Region codes that name no country: groupings, placeholders, pseudo-locales. */
const NOT_COUNTRIES = new Set(["EU", "EZ", "UN", "QO", "UM", "XA", "XB", "ZZ"]);
/** Other ways forms name a country, lower case, mapped to the name Intl gives it. */
const ALIASES: Readonly<Record<string, string>> = {
  "united states of america": "United States", "u.s.a.": "United States", "u.s.": "United States",
  "america": "United States", "the states": "United States",
  "great britain": "United Kingdom", "britain": "United Kingdom", "england": "United Kingdom",
  "scotland": "United Kingdom", "wales": "United Kingdom", "northern ireland": "United Kingdom", "u.k.": "United Kingdom",
  "holland": "Netherlands", "turkey": "Türkiye", "czech republic": "Czechia", "ivory coast": "Côte d’Ivoire",
  "korea": "South Korea", "republic of korea": "South Korea", "drc": "Congo - Kinshasa",
};
/** Written in capitals only: "US" is a country, "us" is a pronoun. */
const ABBREVIATIONS: Readonly<Record<string, string>> = {
  US: "United States", USA: "United States", UK: "United Kingdom", UAE: "United Arab Emirates",
};
/** Places bigger than a country, none of them one where a single permit lets you work. */
const REGIONS = ["european union", "eea", "europe", "schengen", "north america", "latin america", "latam", "apac", "apj"];
const REGION_ABBREVIATIONS = ["EU", "EEA", "EMEA", "APAC", "APJ", "LATAM", "AMER"];

const COUNTRY_NAMES: ReadonlyMap<string, string> = (() => {
  const names = new Map<string, string>();
  for (let first = 65; first <= 90; first += 1) {
    for (let second = 65; second <= 90; second += 1) {
      const code = String.fromCharCode(first, second);
      if (NOT_COUNTRIES.has(code)) continue;
      const name = REGION_NAMES.of(code);
      if (name && name !== code) names.set(name.toLowerCase(), name);
    }
  }
  for (const [alias, name] of Object.entries(ALIASES)) names.set(alias, name);
  return names;
})();

const escaped = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const longestFirst = (names: Iterable<string>) => [...names].sort((a, b) => b.length - a.length).map(escaped);
// Letters on either side mean a longer word: "Oman" is not in "Romania", "Niger" not in "Nigeria".
const PLACE_RX = new RegExp(
  `(?<![\\p{L}])(?:${longestFirst([...COUNTRY_NAMES.keys(), ...REGIONS]).join("|")})(?![\\p{L}])`,
  "giu",
);
const ABBREVIATION_RX = new RegExp(
  `(?<![\\p{L}.])(?:${longestFirst([...Object.keys(ABBREVIATIONS), ...REGION_ABBREVIATIONS]).join("|")})(?![\\p{L}])`,
  "gu",
);

/** The countries `text` names, by Intl's name, and "region" for anywhere bigger than one. */
function placesIn(text: string): string[] {
  const places = new Set<string>();
  for (const [match] of text.matchAll(PLACE_RX)) {
    const lower = match.toLowerCase();
    // "North America" and "Latin America" are regions, not the United States.
    places.add(REGIONS.includes(lower) ? "region" : (COUNTRY_NAMES.get(lower) ?? "region"));
  }
  for (const [match] of text.matchAll(ABBREVIATION_RX)) places.add(ABBREVIATIONS[match] ?? "region");
  return [...places];
}

/** The country of the candidate's verified location, or null when it names none. */
export function residenceOf(profile: Pick<CandidateProfile, "location">): string | null {
  return placesIn(profile.location).find((place) => place !== "region") ?? null;
}

// ---------- Questions ----------

const SPONSORSHIP_RX = /\bspons?or\w*/i;
const NEEDS_RX = /\b(?:require[sd]?|requiring|need(?:s|ed)?|needing)\b/i;
const AUTHORIZED_RX = new RegExp(
  [
    String.raw`\b(?:authori[sz]ed|eligible|entitled|permitted|allowed|able|legal\s+right|right)\s+(?:\w+\s+)?to\s+(?:legally\s+|lawfully\s+)?(?:work|be\s+employed|live\s+and\s+work)\b`,
    String.raw`\bwork\s+(?:permit|authori[sz]ation|visa)\b`,
    String.raw`\blegally\s+(?:work|be\s+employed|employable)\b`,
  ].join("|"),
  "i",
);
const RELOCATE_RX = /\brelocat\w*/i;
const LIVES_RX = /\b(?:live|living|reside|residing|based|located)\s+(?:in|near|within)\b/i;
/** The role's own place, named without naming it. */
const ROLE_PLACE_RX = new RegExp(
  [
    String.raw`\b(?:the|this)\s+(?:job|role|position|posting|opening|vacancy)(?:'s)?\s+(?:location|country|countries)\b`,
    String.raw`\b(?:job|role|position)'s\s+location\b`,
    String.raw`\bcountr(?:y|ies)\s+(?:listed|named|specified|stated|mentioned)\b`,
    String.raw`\bcountr(?:y|ies)\s+(?:to|for)\s+which\s+you\s+(?:are\s+)?apply`,
    String.raw`\bcountr(?:y|ies)\s+(?:where|in\s+which)\s+(?:this|the)\s+(?:job|role|position)\b`,
    String.raw`\b(?:location|country)\s+of\s+(?:this|the)\s+(?:job|role|position)\b`,
  ].join("|"),
  "i",
);
/** The candidate's own place, named without naming it: "(or country of your residence)". */
const OWN_PLACE_RX = new RegExp(
  [
    String.raw`\b(?:country|place|location)\s+(?:of|where)\s+(?:your\s+)?(?:current\s+)?residen\w*`,
    String.raw`\bwhere\s+you\s+(?:currently\s+)?(?:live|reside|are\s+based|are\s+located)\b`,
    String.raw`\byour\s+(?:current\s+)?(?:location|country(?!\s+of\s+citizenship))\b`,
    String.raw`\bcountr(?:y|ies)\s+(?:you|where\s+you)\s+(?:currently\s+)?(?:live|reside)\b`,
  ].join("|"),
  "i",
);
/** Asked to be answered yes or no: "Are you…", "Would you be able…", "Please confirm you…". "Describe your work authorization" is not. */
const YES_NO_RX = /\b(?:are|do|does|did|will|would|can|could|have|has|should|may|might)\s+you\b|\bconfirm\s+(?:that\s+)?you\b/i;
/** "Are you happy working with us under a B2B arrangement?", "Would you be open to a contractor role?" */
const ARRANGEMENT_RX = /\bB2B\b|\b(?:independent\s+)?contractors?\b|\bcontract\s+(?:basis|role|arrangement|engagement|position)\b|\bfreelance\b/i;
const WILLING_RX = /\b(?:happy|willing|open|comfortable|ok(?:ay)?|fine|able|prepared)\b/i;
/** Their work authorization says they work as an independent (B2B) contractor. */
const CONTRACTOR_RX = /\bB2B\b|\bcontractor\b/i;
/** Left to the candidate's data: citizenship is not residence, and export control is not a work permit. */
const NOT_WORK_STATUS_RX = /\bcitizen|\bnational(?:ity)?\b|\bpassport\b|\bexport\b|\bclearance\b|\btax\b/i;

/** A location field open to the candidate's region: worldwide, EMEA, Africa. The country itself is added per candidate. */
const OPEN_LOCATION = String.raw`\b(?:world[- ]?wide|global(?:ly)?|anywhere|international|emea)\b|(?<!south\s)\bafrica\b`;
/**
 * The listing says who it hires from anywhere: "we hire globally", "work from anywhere".
 * Stricter than the eligibility scorer, which also counts "millions of users worldwide":
 * for "do you live in the job's location?" only the hiring itself will do.
 */
const OPEN_HIRING_RX =
  /\b(?:hire|hires|hiring|work|working|remote(?:ly)?|based|located|live|living)\s+(?:\w+\s+){0,3}?(?:anywhere|world[- ]?wide|globally|from\s+any\s+country)\b/i;

/**
 * How the listing stands for someone working from `residence`: open to them, listed for
 * somewhere else (or ruled out by the eligibility scorer), or not saying.
 */
function roleScope(job: JobOpportunity, residence: string): "open" | "unstated" | "elsewhere" {
  const report = evaluateRemoteEligibility(job);
  if (report.tier === EligibilityTier.INELIGIBLE || report.reasonCodes.includes("SINGLE_COUNTRY_LOCATION")) return "elsewhere";
  const location = new RegExp(`${OPEN_LOCATION}|\\b${escaped(residence)}\\b`, "i");
  if (location.test(cleanText(job.location)) || OPEN_HIRING_RX.test(cleanText(job.description))) return "open";
  return "unstated";
}

/**
 * The yes or no that `question` takes for this candidate and `job`, or null when it is not
 * a work-status question this can settle (or the candidate's location names no country).
 */
export function workStatusAnswer(
  question: string,
  job: JobOpportunity,
  profile: Pick<CandidateProfile, "location" | "workAuthorization">,
  options: readonly string[] = [],
): WorkStatusAnswer | null {
  const residence = residenceOf(profile);
  const text = normalizePunctuation(question);
  // "Work authorization in the United States" offered with Yes and No is a yes-or-no question too.
  const yesOrNo = YES_NO_RX.test(text) || (optionSaying(options, true) !== null && optionSaying(options, false) !== null);
  if (!residence || !yesOrNo || NOT_WORK_STATUS_RX.test(text)) return null;
  const places = placesIn(text);
  const ownPlace = OWN_PLACE_RX.test(text) || places.includes(residence);
  const elsewhere = places.some((place) => place !== residence);
  const rolePlace = ROLE_PLACE_RX.test(text);
  const fixed = (yes: boolean): WorkStatusAnswer => ({ yes, perJob: false });

  // Working as a contractor is how this candidate works: no permit or place is asked about.
  if (ARRANGEMENT_RX.test(text) && WILLING_RX.test(text) && !AUTHORIZED_RX.test(text) && !SPONSORSHIP_RX.test(text)) {
    return CONTRACTOR_RX.test(profile.workAuthorization) ? fixed(true) : null;
  }
  // Lives there, or will move there. Moving is never offered: the candidate works remotely.
  if (RELOCATE_RX.test(text) || (LIVES_RX.test(text) && (places.length > 0 || rolePlace))) {
    if (places.length > 0) return fixed(places.includes(residence));
    if (rolePlace) return { yes: roleScope(job, residence) === "open", perJob: true };
    return fixed(false);
  }
  // "Authorized to work in the US without sponsorship" is a question about authorization.
  if (SPONSORSHIP_RX.test(text) && NEEDS_RX.test(text)) {
    if (ownPlace && !elsewhere) return fixed(false);
    if (elsewhere) return fixed(true);
    if (rolePlace) return { yes: roleScope(job, residence) === "elsewhere", perJob: true };
    return fixed(false);
  }
  if (AUTHORIZED_RX.test(text)) {
    // "in the US (or country of your residence)": either place will do.
    if (ownPlace) return fixed(true);
    if (elsewhere) return fixed(false);
    if (rolePlace) return { yes: roleScope(job, residence) !== "elsewhere", perJob: true };
    return fixed(true);
  }
  return null;
}

// ---------- Answers ----------

const NEGATIVE_RX =
  /^\W*no\b|\bnot\b|n't\b|\bnever\b|\bnor\b|\bunable\b|\bcannot\b|\bwithout\s+(?:the\s+)?(?:right|authori[sz]ation|permission)\b/i;

/** Whether an answer or an option says yes: "No", "I am not authorized" and "I don't" say no. */
export function saysYes(answer: string): boolean {
  const text = normalizePunctuation(answer);
  if (/^\W*yes\b/i.test(text)) return true;
  return !NEGATIVE_RX.test(text);
}

/**
 * The option of a form question that says `yes` (or no): a plain "Yes"/"No" first, then
 * the only option that says so. "I am willing to relocate" is never picked to say yes to
 * living somewhere; null when the options do not settle it.
 */
export function optionSaying(options: readonly string[], yes: boolean): string | null {
  const plain = options.find((option) => new RegExp(`^\\W*${yes ? "yes" : "no"}\\b`, "i").test(normalizePunctuation(option)));
  if (plain) return plain;
  const saying = options.filter((option) => saysYes(option) === yes && !(yes && RELOCATE_RX.test(option)));
  return saying[0] ?? null;
}
