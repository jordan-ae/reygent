/**
 * Cameroon-specific 3-tier remote eligibility scorer (Tier 0: deterministic, $0.00).
 *
 * A listing that says "Remote" is often restricted by payroll law or geography. For a
 * contractor based in Cameroon (UTC+1) every job is sorted into one of three tiers:
 *
 *     Tier 1  CONFIRMED_ELIGIBLE    worldwide / EMEA / Africa scope, or global contractor rails
 *     Tier 2  POTENTIALLY_ELIGIBLE  remote with no stated geographic scope -> B2B investigation
 *     Tier 3  INELIGIBLE            explicit legal, geographic, on-site or rate disqualifier
 *
 * Tier 3 needs explicit restrictive language. Anything merely ambiguous lands in Tier 2
 * and is investigated, never discarded.
 */

import { type CompensationConfig, defaultConfig } from "@/core/config";
import type { Repository } from "@/core/db/repository";
import {
  B2B_INVESTIGATION,
  type EligibilityReport,
  EligibilityTier,
  type JobOpportunity,
  PipelineStage,
} from "@/core/models";
import { cleanText, isNegated, snippet } from "@/core/text";

// The patterns are assembled from shared fragments, so they are built from strings
// rather than written as literals. `(?-i:...)` switches case-insensitivity off for
// the abbreviations inside it. Note that `\b` and `\w` only know ASCII letters here:
// a keyword glued to an accented or CJK character still counts as a whole word.
const raw = String.raw;

/** A case-insensitive pattern that is scanned for every occurrence (`matchAll`). */
const scan = (source: string): RegExp => new RegExp(source, "gi");
/** A case-insensitive pattern that is only ever asked "does it occur?" (`test`). */
const probe = (source: string): RegExp => new RegExp(source, "i");

// Places whose mention in a restriction excludes Cameroon. Abbreviations are matched
// case-sensitively so the pronoun "us" is never read as the United States.
const REGION =
  raw`(?:(?-i:U\.S\.A\.|U\.S\.|U\.K\.|E\.U\.)` +
  raw`|(?:(?-i:USA?|UK|EU|EEA)|united states(?: of america)?|north america|canada|mexico` +
  raw`|united kingdom|great britain|england|ireland|european union|europe|schengen` +
  raw`|germany|france|spain|portugal|netherlands|poland` +
  raw`|latam|latin america|south america|brazil|argentina` +
  raw`|apac|asia(?:[- ]pacific)?|india|australia|new zealand|japan|singapore` +
  raw`|south africa|nigeria|kenya|egypt|ghana)\b)`;
const AFRICA =
  raw`(?:(?-i:EMEA)\b|(?<!south )\bafrica\b|\bcameroon\b|\bsub[- ]saharan\b|(?-i:\bWAT\b)` +
  raw`|\bwest africa(?:n)? time\b)`;
const HIRING_CONTEXT = raw`(?:remote(?:ly)?|based|located|hir\w+|candidates?|applicants?|time[- ]?zones?|open to|work from)`;

const HARD_DISQUALIFIERS: ReadonlyArray<readonly [code: string, pattern: RegExp]> = [
  [
    "SECURITY_CLEARANCE",
    scan(
      raw`\b(?:security|secret|top[- ]secret|dod|government|public trust|sc|dv)\s+clearance\b` +
        raw`|(?-i:\bTS/SCI\b)|\bclearance\s+(?:is\s+)?required\b|\b(?:active|current)\s+clearance\b` +
        raw`|\b(?:obtain|maintain|hold)\s+(?:an?\s+)?(?:\w+\s+){0,2}clearance\b`,
    ),
  ],
  [
    "CITIZENSHIP_REQUIRED",
    scan(
      raw`\b(?:${REGION}|american|european|british|canadian)\s+citizen(?:ship|s)?\b` +
        raw`|\bcitizenship\s+(?:is\s+)?required\b|\bgreen[- ]card\b` +
        raw`|\b(?:lawful\s+)?permanent\s+residen(?:ts?|cy|ce)\b` +
        raw`|(?-i:\bU\.?S\.?)\s+persons?\b|(?-i:\bITAR\b)`,
    ),
  ],
  [
    "WORK_AUTHORIZATION_REQUIRED",
    scan(
      raw`\b(?:authori[sz]ed|authori[sz]ation|eligible|eligibility|permitted|permission|right|entitled` +
        raw`|legally\s+able)\s+to\s+work\s+in\s+(?:the\s+)?${REGION}` +
        raw`|\bwork\s+(?:authori[sz]ation|permit|visa)\s+(?:in|for)\s+(?:the\s+)?${REGION}` +
        raw`|\b${REGION}\s+work\s+(?:authori[sz]ation|permit)\b`,
    ),
  ],
  [
    "LOCAL_PAYROLL_ONLY",
    scan(
      raw`\bPAYE\b|\bW-?2\s+(?:only|employee|employment|position|role|basis)\b` +
        raw`|\bno\s+(?:c2c|corp[- ]?to[- ]?corp|1099|b2b|contractors?|freelancers?)\b` +
        raw`|\b(?:cannot|can't|can not|unable to|do not|don't)\s+(?:hire|engage|work with|accept)\s+` +
        raw`(?:independent\s+)?contractors\b`,
    ),
  ],
];

const GEO_RESTRICTED = scan(
  raw`\b${REGION}(?:\s*[-/]\s*|\s+)(?:based\s+)?only\b` +
    raw`|\bonly\s+(?:hir\w+|open|consider\w*|accept\w*|available)\b[^.;\n]{0,40}?\b(?:in|from|within|to)\s+(?:the\s+)?${REGION}` +
    raw`|\b(?:must|needs? to|required to|have to|has to|should)\s+(?:be\s+)?(?:currently\s+)?` +
    raw`(?:based|located|resid\w+|live|living|domiciled)\s+(?:in|within)\s+(?:the\s+)?(?:continental\s+)?${REGION}` +
    raw`|\b(?:candidates?|applicants?)\s+(?:must\s+be\s+|should\s+be\s+)?(?:based|located|residing)\s+` +
    raw`(?:in|within)\s+(?:the\s+)?${REGION}` +
    raw`|\b${REGION}[- ]based\s+(?:candidates?|applicants?|engineers?|developers?)\b` +
    raw`|\b(?:residents?|citizens?)\s+of\s+(?:the\s+)?${REGION}` +
    raw`|\b${REGION}\s+residents?\b` +
    raw`|\banywhere\s+(?:in|within|across)\s+(?:the\s+)?(?:continental\s+)?${REGION}` +
    raw`|\b(?:50|fifty)\s+(?:(?-i:U\.?S\.?)\s+|united\s+)?states\b`,
);

const ONSITE_IN_LOCATION = scan(raw`\bhybrid\b|\bon[- ]?site\b|\bin[- ]office\b|\bin[- ]person\b|\boffice[- ]based\b`);
// In descriptions "hybrid" and "on-site" need work-arrangement context: "hybrid search"
// is a retrieval technique, and remote-first teams still hold the occasional onsite.
const ONSITE_IN_DESCRIPTION = scan(
  raw`\bhybrid\s+(?:role|position|job|work\w*|schedule|arrangement|set-?up|remote|on[- ]?site|in[- ]office|office)\b` +
    raw`|\b(?:remote|on[- ]?site|office)\s*[/,|&]\s*hybrid\b|\((?:hybrid|on[- ]?site)\)` +
    raw`|\b(?:on[- ]?site|in[- ]office|in[- ]person|office[- ]based)\s+(?:role|position|job|only|required|presence|attendance)\b` +
    raw`|\b(?:must|required to|expected to|needs? to|will)\s+(?:work|be|come|commute|report)\s+(?:\w+\s+){0,3}?` +
    raw`(?:on[- ]?site|in[- ](?:the\s+|our\s+)?office|in[- ]person|to (?:the|our) office)\b` +
    raw`|\b\d\s*(?:-\s*\d\s*)?\+?\s*days?\s+(?:a|per|each|every)\s+week\s+(?:\w+\s+){0,2}?` +
    raw`(?:on[- ]?site|in[- ](?:the\s+|our\s+)?office|in[- ]person|from (?:the|our) office)\b` +
    raw`|\brelocat(?:e|ion)\s+(?:is\s+)?(?:required|expected|necessary|mandatory)\b` +
    raw`|\b(?:must|willing(?:ness)?)\s+(?:be\s+willing\s+)?to\s+relocate\b` +
    raw`|\b(?:not|non)[- ]remote\b|\bno\s+remote\b` +
    raw`|\bremote\s+(?:work\s+)?(?:is\s+)?not\s+(?:available|possible|offered|an option)\b`,
);

const ANYWHERE =
  raw`\banywhere\b(?!\s+(?:else|near|from\s+\d|between)\b)` +
  raw`(?!\s+(?:in|within|across)\s+(?:the\s+)?(?:continental\s+)?${REGION})`;
const WORLDWIDE_IN_LOCATION = scan(raw`\bglobal(?:ly)?\b|\bworld(?:[- ]?wide)?\b|\binternational\b|${ANYWHERE}`);
const WORLDWIDE_IN_DESCRIPTION = scan(
  raw`\bworld[- ]?wide\b|${ANYWHERE}` +
    raw`|\bany\s+(?:country|location|time[- ]?zone)\b|\ball\s+(?:countries|time[- ]?zones)\b` +
    raw`|\bglobal(?:ly)?[- ]remote\b|\bremote\s*[-(,:/|]\s*\(?\s*global(?:ly)?\b|\bglobally\s+distributed\b` +
    raw`|\bhir(?:e|es|ing)\s+(?:globally|internationally|in any country)\b` +
    raw`|\blocation[- ](?:agnostic|independent)\b`,
);
const AFRICA_IN_LOCATION = scan(AFRICA);
const AFRICA_IN_DESCRIPTION = scan(
  raw`\b${HIRING_CONTEXT}\b[^.;\n]{0,40}?${AFRICA}|${AFRICA}[^.;\n]{0,25}?\b${HIRING_CONTEXT}\b`,
);
const AFRICA_INCLUSIVE = probe(raw`${AFRICA}|\bworld[- ]?wide\b|\bglobal(?:ly)?\b`);
const CONTRACTOR_RAILS = scan(
  raw`\bdeel\b|\bremote\.com\b|\boyster(?:\s?hr)?\b|\bemployer[- ]of[- ]record\b|(?-i:\bEOR\b)` +
    raw`|\binternational\s+contractors?\b|\bglobal\s+(?:contractors?|payroll)\b` +
    raw`|\bcontractors?\s+(?:world[- ]?wide|globally|anywhere|(?:from|in)\s+any\s+country)\b`,
);
const CONTRACTOR_FRIENDLY = scan(
  raw`\bindependent\s+contractor\b|\bcontract(?:or)?\s+(?:role|position|basis|engagement|opportunity)\b` +
    raw`|\bb2b\s+(?:contract\w*|invoic\w*|basis|engagement)\b|\bfreelance\b|\b1099\b|\bc2c\b` +
    raw`|\bcorp[- ]?to[- ]?corp\b|\binvoic(?:e|ing)\b|\bfractional\b`,
);
const REMOTE = scan(
  raw`\bremote(?:ly)?\b|\bwork(?:ing)?\s+from\s+(?:home|anywhere)\b|(?-i:\bWFH\b)|\bfully\s+distributed\b` +
    raw`|\bdistributed\s+team\b|\btelecommut\w*`,
);
// Words in a location field that say how the work is done rather than where the hire must be.
const LOCATION_FILLER = scan(
  raw`\b(?:remote(?:ly)?|fully|first|friendly|home[- ]?based|work(?:ing)?\s+from\s+home|(?-i:WFH)|distributed` +
    raw`|anywhere|world[- ]?wide|global(?:ly)?|international|location|flexible|time[- ]?zones?|any|all|or|and)\b`,
);
const SENTENCE_BREAKS = ".;!?\n";

/**
 * True when the location field names a specific place that is not Cameroon's region.
 *
 * On an applicant-tracking board "Remote, Canada" or "United Kingdom (Remote)" means the
 * hire must be there, whatever the description's boilerplate says about a "globally
 * distributed team". So a scoped location is never confirmed from the description alone.
 */
function namesAPlaceElsewhere(location: string): boolean {
  if (firstMatch(AFRICA_IN_LOCATION, location) || firstMatch(WORLDWIDE_IN_LOCATION, location)) return false;
  return /[a-z]/i.test(location.replace(LOCATION_FILLER, " "));
}

/** Signals that confirm eligibility on their own: [code, pattern for the location, pattern for the description]. */
const CONFIRMING_SIGNALS: ReadonlyArray<readonly [code: string, inLocation: RegExp, inDescription: RegExp]> = [
  ["WORLDWIDE", WORLDWIDE_IN_LOCATION, WORLDWIDE_IN_DESCRIPTION],
  ["AFRICA_EMEA", AFRICA_IN_LOCATION, AFRICA_IN_DESCRIPTION],
  ["CONTRACTOR_RAILS", CONTRACTOR_RAILS, CONTRACTOR_RAILS],
];
const CONTRACT_EMPLOYMENT_TYPES = ["contract", "fractional", "freelance"];

const STAGE_FOR_TIER: Record<EligibilityTier, PipelineStage> = {
  [EligibilityTier.CONFIRMED_ELIGIBLE]: PipelineStage.QUALIFIED,
  [EligibilityTier.POTENTIALLY_ELIGIBLE]: PipelineStage.INVESTIGATING,
  [EligibilityTier.INELIGIBLE]: PipelineStage.DISQUALIFIED,
};

const DEFAULT_COMPENSATION: CompensationConfig = defaultConfig().compensation;

// "$1,234": whole dollars with thousands separators. Ties round to even, as in the
// Python implementation, so both produce the same audit text for the same listing.
const WHOLE_DOLLARS = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0, roundingMode: "halfEven" });

/** A reason code with the text that triggered it. */
interface Signal {
  code: string;
  evidence: string;
}

const labelled = (signal: Signal): string => `${signal.code}: ${signal.evidence}`;

/** Evidence for the first non-negated match of `pattern` in `text`. */
function firstMatch(pattern: RegExp, text: string): string | null {
  for (const match of text.matchAll(pattern)) {
    const end = match.index + match[0].length;
    if (!isNegated(text, match.index, end)) return snippet(text, match.index, end);
  }
  return null;
}

/** Evidence of a restriction to a region that excludes Cameroon. */
function geoRestriction(text: string): string | null {
  for (const match of text.matchAll(GEO_RESTRICTED)) {
    const start = match.index;
    const end = start + match[0].length;
    if (isNegated(text, start, end)) continue;
    // The sentence around the match: back to the previous break, on to the next one.
    let sentenceStart = start;
    while (sentenceStart > 0 && !SENTENCE_BREAKS.includes(text[sentenceStart - 1])) sentenceStart -= 1;
    let sentenceEnd = end;
    while (sentenceEnd < text.length && !SENTENCE_BREAKS.includes(text[sentenceEnd])) sentenceEnd += 1;
    // "must be based in Europe or Africa" still includes the candidate.
    if (!AFRICA_INCLUSIVE.test(text.slice(sentenceStart, sentenceEnd))) return snippet(text, start, end);
  }
  return null;
}

/** Describe a stated USD rate whose top end is under the candidate's floor. */
function rateBelowFloor(job: JobOpportunity, comp: CompensationConfig): string | null {
  const top = job.compMax ?? job.compMin;
  if (top === null || job.compCurrency.toUpperCase() !== "USD") return null;
  const hourly = job.compPeriod === "hour";
  if (!hourly && job.compPeriod !== "month" && job.compPeriod !== "year") return null;
  const floor = hourly ? comp.hourly_floor_usd : comp.monthly_floor_usd;
  // An annual figure is compared month by month, but reported as the listing states it.
  const comparable = job.compPeriod === "year" ? top / 12 : top;
  if (comparable >= floor) return null;
  const unit = hourly ? "hr" : "mo";
  return `$${WHOLE_DOLLARS.format(top)}/${job.compPeriod} is below the $${WHOLE_DOLLARS.format(floor)}/${unit} floor`;
}

// "Unpaid" or "pro bono" anywhere in the title; "volunteer" only where it describes the
// role itself — leading the title ("Volunteer Software Engineer") or closing a part of it
// ("Developer - Volunteer", "(Volunteer, unpaid)"). An engineer on a "Volunteer Management
// Platform" is paid.
const UNPAID_TITLE = new RegExp(
  String.raw`\bunpaid\b|\bpro[- ]bono\b` +
    String.raw`|^\W*volunteer\s+(?!management|engagement|program|platform|services?|experience|operations)` +
    String.raw`|\bvolunteer\s*(?:$|[)\],;]|(?:role|position|opportunity|basis)\b)`,
  "i",
);
const UNPAID_EMPLOYMENT = /^(?:volunteer|unpaid|pro[- ]bono)$/i;

/**
 * Evidence that the role pays nothing. Read from the title and the employment type only:
 * a description mentions "volunteer days" as a benefit of a paid job.
 */
function unpaidRole(job: JobOpportunity): string | null {
  const title = cleanText(job.title);
  const match = UNPAID_TITLE.exec(title);
  if (match) return snippet(title, match.index, match.index + match[0].length);
  return UNPAID_EMPLOYMENT.test(job.employmentType.trim()) ? `employment type: ${job.employmentType.trim()}` : null;
}

/** Classify `job` into an eligibility tier for a Cameroon-based B2B contractor. Pure; no I/O. */
export function evaluateRemoteEligibility(job: JobOpportunity, compensation?: CompensationConfig): EligibilityReport {
  const comp = compensation ?? DEFAULT_COMPENSATION;
  const location = cleanText(job.location);
  const body = cleanText(`${job.title}\n${job.description}`);
  const full = `${location}\n${body}`;

  const disqualifiers: Signal[] = [];
  const disqualify = (code: string, evidence: string | null): void => {
    if (evidence) disqualifiers.push({ code, evidence });
  };
  for (const [code, pattern] of HARD_DISQUALIFIERS) disqualify(code, firstMatch(pattern, full));
  disqualify("GEO_RESTRICTED", geoRestriction(full));
  disqualify("ONSITE_REQUIRED", firstMatch(ONSITE_IN_LOCATION, location) || firstMatch(ONSITE_IN_DESCRIPTION, body));
  disqualify("RATE_BELOW_FLOOR", rateBelowFloor(job, comp));
  disqualify("UNPAID", unpaidRole(job));

  // The location field outranks the description: when it names somewhere else, a
  // worldwide-sounding phrase in the description is company boilerplate, not this role's scope.
  const scoped = namesAPlaceElsewhere(location);
  const positives: Signal[] = [];
  for (const [code, inLocation, inDescription] of CONFIRMING_SIGNALS) {
    const evidence = firstMatch(inLocation, location) || (scoped ? null : firstMatch(inDescription, body));
    if (evidence) positives.push({ code, evidence });
  }
  const confirmed = positives.length > 0;
  // Contract work is a good sign but says nothing about geography, so it never confirms.
  let contractEvidence = firstMatch(CONTRACTOR_FRIENDLY, full) || (scoped ? firstMatch(CONTRACTOR_RAILS, body) : null);
  if (!contractEvidence && CONTRACT_EMPLOYMENT_TYPES.includes(job.employmentType)) {
    contractEvidence = `employment type: ${job.employmentType}`;
  }
  if (contractEvidence) positives.push({ code: "CONTRACTOR_FRIENDLY", evidence: contractEvidence });

  const remote = job.isRemote === true || (job.isRemote === null && (confirmed || firstMatch(REMOTE, full) !== null));
  if (!remote) disqualifiers.push({ code: "NOT_REMOTE", evidence: "no remote option stated" });

  const positiveSignals = positives.map(labelled);
  if (disqualifiers.length > 0) {
    return {
      jobId: job.id,
      tier: EligibilityTier.INELIGIBLE,
      reasonCodes: disqualifiers.map((signal) => signal.code),
      positiveSignals,
      disqualifiers: disqualifiers.map(labelled),
      needsB2bInvestigation: false,
      summary: `Ineligible: ${disqualifiers.map((signal) => `${signal.code} (${signal.evidence})`).join("; ")}`,
    };
  }
  if (confirmed) {
    return {
      jobId: job.id,
      tier: EligibilityTier.CONFIRMED_ELIGIBLE,
      reasonCodes: positives.map((signal) => signal.code),
      positiveSignals,
      disqualifiers: [],
      needsB2bInvestigation: false,
      summary: `Confirmed eligible: ${positiveSignals.join("; ")}`,
    };
  }
  const reasonCodes = ["GEO_UNSPECIFIED"];
  if (scoped) reasonCodes.push("SINGLE_COUNTRY_LOCATION");
  reasonCodes.push(...positives.map((signal) => signal.code));
  return {
    jobId: job.id,
    tier: EligibilityTier.POTENTIALLY_ELIGIBLE,
    reasonCodes,
    positiveSignals,
    disqualifiers: [],
    needsB2bInvestigation: true,
    summary: scoped
      ? `Listed for ${location} — confirm the employer can engage a Cameroon-based B2B contractor` +
        " rather than only hiring there (direct invoice, Deel, Remote.com, Wise)."
      : "Remote with no stated geographic scope — confirm the employer can engage a" +
        " Cameroon-based B2B contractor (direct invoice, Deel, Remote.com, Wise).",
  };
}

/**
 * Evaluate `job` and route it, atomically: insert if new, save the evaluation, set the
 * stage (Tier 1 qualified, Tier 2 investigating + queued for B2B investigation,
 * Tier 3 disqualified). Jobs already past discovery (or duplicating a tracked listing)
 * are evaluated but left where they are.
 */
export function qualifyJob(repo: Repository, job: JobOpportunity, compensation?: CompensationConfig): EligibilityReport {
  const report = evaluateRemoteEligibility(job, compensation);
  repo.transaction(() => {
    repo.insertJob(job);
    // A duplicate of a listing tracked under another id is not stored, so there is nothing to route.
    if (repo.getJob(job.id)?.stage !== PipelineStage.DISCOVERED) return;
    repo.saveEvaluation(report);
    repo.setJobStage(job.id, STAGE_FOR_TIER[report.tier]);
    if (report.tier === EligibilityTier.POTENTIALLY_ELIGIBLE) {
      repo.enqueueTask({ taskType: B2B_INVESTIGATION, jobId: job.id, detail: report.summary });
    }
  });
  return report;
}
