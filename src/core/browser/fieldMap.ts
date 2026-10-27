/**
 * Decides what to do with each field of an application form.
 *
 * Pure — no browser, no I/O. A field is filled only when its label names a standard
 * identity / contact / link / resume / cover-letter slot and the matching fact is
 * verified, or when the approved draft carries a screening answer written for exactly
 * that question. Everything else is left for the user: a question is never guessed,
 * and a label that merely mentions "email" or "name" inside a longer question does
 * not count as a standard field (every pattern is anchored to the whole label).
 */

import type { FieldPlan, FieldType, FormField } from "@/core/browser/types";
import { type ApplicationDraft, type CandidateProfile, PLACEHOLDER, screeningFacts } from "@/core/models";

/** The only country ever chosen or typed for a country question — and only if the verified location says so. */
export const HOME_COUNTRY = "Cameroon";

export const SENSITIVE_REASON = "sensitive — answered by you";
export const CUSTOM_REASON = "custom question — answered by you";
export const TYPE_AHEAD_REASON = "type-ahead — its choices only appear as you type";
/** `source` of a plan that comes from `draft.screeningAnswers` rather than a profile fact. */
export const SCREENING_SOURCE = "screening_answer";

/** Single-line inputs a contact fact may be typed into. */
const LINE_TYPES: ReadonlySet<FieldType> = new Set(["text", "email", "tel", "url"]);
const CHOICE_TYPES: ReadonlySet<FieldType> = new Set(["select", "radio", "checkbox"]);

/**
 * Lower-case words only, so patterns need not care about punctuation or accents:
 * "E-mail Address (optional) *" → "e mail address", "Résumé/CV" → "resume cv".
 */
export function normalizeLabel(label: string): string {
  return label
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/\((?:optional|required|if applicable|if any)\)/g, " ")
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/**
 * How a screening answer's question is compared with a form label, and its answer with
 * a choice: case-insensitive, whitespace collapsed, trailing required-markers and
 * colons dropped. Deliberately much stricter than normalizeLabel — the words and the
 * punctuation inside the question must be the same.
 */
export function questionKey(text: string): string {
  return text.replace(/\s+/g, " ").trim().replace(/[\s*✱:]+$/u, "").toLowerCase();
}

// Questions whose answer has legal or personal weight. They are matched anywhere in the
// label and checked before everything else, so "Country of citizenship" is never treated
// as a country list and "Gender" is never treated as anything at all.
const SENSITIVE = new RegExp(
  "\\b(?:" +
    [
      "work(?:ing)? (?:authori[sz]ation|permit|eligibility|status|rights?)",
      "authori[sz]ed to work|eligible to work|permitted to work|entitled to work|right to work",
      "(?:legally|lawfully) (?:authori[sz]ed|eligible|permitted|entitled|able)",
      "employment eligibility|visa|visas|sponsor\\w*|immigration",
      "citizen\\w*|nationalit\\w*|permanent resident|residency status|residence permit|green card|passport",
      "tax\\w*|ssn|social security|national insurance|national id\\w*",
      "criminal\\w*|convict\\w*|felon\\w*|misdemeanou?rs?|arrest\\w*|background check",
      "disabilit\\w*|disabled|veteran\\w*|military (?:service|status)",
      "gender\\w*|sex|sexual orientation|transgender|lgbt\\w*|pronouns?",
      "race|racial|ethnic\\w*|hispanic|latino|latina|latinx",
      "date of birth|birth ?date|marital status|religio\\w*",
    ].join("|") +
    ")\\b",
);

// Lead-ins a label may carry before the thing it asks for: "Please enter your …",
// "What is your …" (Greenhouse's "What is your current country of residence?").
const ASK =
  "(?:please )?(?:what (?:is|s) )?(?:(?:enter|provide|share|add|type|list|paste|include|select|choose|link to) )?" +
  "(?:(?:your|my|the|a|candidate|applicant) )?";
const exact = (body: string): RegExp => new RegExp(`^${ASK}(?:${body})$`);

// Ashby titles its name field "Legal Name" on many boards; it is the same field. A
// "preferred" name is a different question and stays with the user.
const FIRST_NAME = exact("(?:legal )?(?:first|given) name");
const LAST_NAME = exact("(?:legal )?(?:last|family) name|surname");
const FULL_NAME = exact("(?:full )?(?:legal )?name|legal full name|first and last name|name first and last");
const EMAIL = exact("(?:(?:contact|primary|personal) )?e ?mail(?: address)?");
const PHONE = exact(
  "(?:(?:contact|primary|personal|mobile|cell) )?(?:phone|telephone|mobile|cell)(?: phone)?(?: number| no)?",
);
const LOCATION = exact(
  "(?:current )?(?:location|city)(?: city)?" +
    "|(?:current )?city(?: and| or)?(?: state)?(?: and| or)? country" +
    "|(?:current )?(?:location|city) of residence",
);
const WHERE_BASED = /^where (?:are you (?:currently )?(?:based|located|living)|do you (?:currently )?live)(?: now)?$/;
const COUNTRY = exact(
  "(?:current )?country(?: (?:of|in which|where) .*\\b(?:residence|residency|reside|live|living|located|location|based)\\b.*)?",
);
const WHICH_COUNTRY =
  /^(?:in )?(?:which|what) country (?:do|are) you (?:currently )?(?:live|living|reside|residing|based|located)(?: in)?$/;

const LINK_TAIL = "(?: (?:profile|page|account))?(?: (?:url|link|address))?";
const LINKEDIN = exact(`linked ?in${LINK_TAIL}`);
const GITHUB = exact(`git ?hub${LINK_TAIL}`);
const PORTFOLIO = exact(
  "(?:(?:personal|portfolio|other) )?(?:website|web site|site|portfolio|homepage|home page)" +
    "(?: (?:or |and )?(?:portfolio|website))?(?: (?:url|link|address))?",
);
/** The kinds of link a box may name, and the fact that is one. A blog or an X profile has no fact of its own. */
const LINK_KINDS: ReadonlyArray<[string, string | null]> = [
  ["git ?hub", "github_url"],
  ["linked ?in", "linkedin_url"],
  ["(?:(?:personal|portfolio|other) )?(?:website|web site|site|portfolio|homepage|home page)", "portfolio_url"],
  ["blog|twitter|x", null],
];
const ANY_KIND = `(?:${LINK_KINDS.map(([kind]) => kind).join("|")})`;
/** A box that takes any one of several links: "Github, Personal Website or Blog", "LinkedIn or GitHub URL". */
const ANY_LINK = exact(`${ANY_KIND}(?: (?:or |and )?${ANY_KIND})+${LINK_TAIL}`);

const RESUME = /\b(?:resume|cv|c v|curriculum vitae)\b/;
const COVER_LETTER = /\bcover (?:letter|note)\b/;
// Ashby puts an "Autofill from resume" drop zone above the form. Feeding it would let
// the site's parser overwrite the verified values typed next to it.
const AUTOFILL = /\b(?:auto ?fill\w*|auto ?complete|import|parse)\b/;
const PITCH_COVER = exact("cover (?:letter|note)(?: text)?");
const PITCH_EXTRA = exact("additional (?:information|info)");

// A country option may carry its dial code ("Cameroon +237", "Cameroon (+237)") and
// still name only the country. Anything with more words in it is a different option.
const HOME_COUNTRY_OPTION = new RegExp(`^${HOME_COUNTRY}[\\s()+\\d:,.-]*$`, "i");

const leave = (field: FormField, reason: string): FieldPlan => ({ field, action: "leave", reason });

/** A value that may be typed: present, and not an unfilled template placeholder. */
const usable = (value: string | undefined): value is string =>
  Boolean(value && value.trim() && !value.includes(PLACEHOLDER));

/**
 * The place in a location as the profile words it: "Douala, Cameroon (UTC+1)" is the
 * place "Douala, Cameroon" with a note about its timezone, and a location search knows
 * only the place.
 */
export const placeName = (location: string): string => location.replace(/\s*\([^()]*\)\s*$/, "").trim();

/**
 * What to type into a location search to find `place`, most promising first: the city
 * alone, then the whole place, then the country alone.
 *
 * The city comes first because of Greenhouse: its box only shows a result whose text
 * contains what was typed, and "Douala, Cameroon" is not contained in the result it
 * should find, "Douala, Littoral Province, Cameroon". A person types the city too. The
 * country comes last for a search that knows no city there: Ashby's offers nothing for
 * "Yaounde", and only "Cameroon" for "Yaounde, Cameroon".
 */
export function searchTerms(place: string): string[] {
  const whole = place.replace(/\s+/g, " ").trim();
  const parts = whole.split(",").map((part) => part.trim()).filter(Boolean);
  const country = parts.length > 1 ? parts[parts.length - 1] : "";
  return [...new Set([parts[0] ?? "", whole, country].filter(Boolean))];
}

/**
 * Which of a type-ahead's suggestions names the place `wanted`, or -1.
 *
 * Either the suggestion is `wanted` itself, or it is the only place offered that
 * starts with the same city and ends with the same country ("Douala, Littoral,
 * Cameroon" for "Douala, Cameroon"). Two different such places are ambiguous and none
 * is taken; nothing is ever picked for being merely the first or the closest. The same
 * text offered twice is one place — Greenhouse's geocoder lists Douala twice, under
 * two record ids — and its first occurrence is the one returned.
 *
 * When no such place is offered at all, the country itself is: less precise, and just
 * as true. Some searches (Ashby's) know no city in the candidate's country.
 */
export function pickSuggestion(wanted: string, suggestions: string[]): number {
  // Accents are not part of a place's identity here: a profile says "Yaounde" and a
  // geocoder answers "Yaoundé" for the same city.
  const fold = (text: string): string => text.normalize("NFKD").replace(/\p{M}+/gu, "");
  const parts = (text: string): string[] =>
    fold(text).split(",").map((part) => part.replace(/\s+/g, " ").trim().toLowerCase()).filter(Boolean);
  const target = parts(wanted);
  if (target.length === 0) return -1;
  const offered = suggestions.map(parts);
  const same = offered.findIndex((found) => found.join(",") === target.join(","));
  if (same >= 0 || target.length < 2) return same;
  const alike = offered
    .map((found, index) => ({ index, found }))
    .filter(({ found }) => found.length > target.length && found[0] === target[0] && found.at(-1) === target.at(-1));
  const places = new Set(alike.map(({ found }) => found.join(",")));
  if (places.size === 1) return alike[0].index;
  if (places.size > 1) return -1;
  return offered.findIndex((found) => found.length === 1 && found[0] === target[target.length - 1]);
}

/**
 * The textarea that receives the cover note: one labelled as the cover letter if the
 * form has it, otherwise one labelled "additional information". Only ever one, so the
 * same note is not pasted twice.
 */
function pitchSlot(fields: FormField[]): string | null {
  const textareas = fields.filter((field) => field.type === "textarea");
  const labelled = (pattern: RegExp) =>
    textareas.find((field) => {
      const label = normalizeLabel(field.label);
      return pattern.test(label) && !SENSITIVE.test(label);
    });
  return (labelled(PITCH_COVER) ?? labelled(PITCH_EXTRA))?.id ?? null;
}

/** The first usable answer per question; later duplicates are ignored. */
function answerIndex(draft: ApplicationDraft): Map<string, string> {
  const index = new Map<string, string>();
  for (const { question, answer } of draft.screeningAnswers) {
    const key = questionKey(question);
    if (key && usable(answer) && !index.has(key)) index.set(key, answer);
  }
  return index;
}

/**
 * A screening answer written for exactly this question, if the draft has one. The Cop
 * Tool has already vetted those answers, so this is the one way a custom — even a
 * sensitive — question gets answered. A choice field is only answered with one of its
 * own options; a near miss is left for the user rather than rounded to the nearest.
 */
function answerPlan(field: FormField, answers: Map<string, string>): FieldPlan | null {
  const answer = answers.get(questionKey(field.label));
  // A file is never produced from an answer, and a type-ahead offers nothing to match it against.
  if (answer === undefined || field.type === "file" || field.typeAhead) return null;
  if (!CHOICE_TYPES.has(field.type)) return { field, action: "fill", value: answer, source: SCREENING_SOURCE };
  const wanted = questionKey(answer);
  const option = field.options.find((candidate) => questionKey(candidate) === wanted);
  return option === undefined
    ? leave(field, "the prepared answer is not one of the options")
    : { field, action: "select", option, source: SCREENING_SOURCE };
}

export interface PlanOptions {
  /** Feed the "Autofill from resume" box too (`agent.resume_autofill`). Default: left alone. */
  resumeAutofill?: boolean;
}

/** Plan every field of `fields`, in order. */
export function planFields(
  fields: FormField[],
  profile: CandidateProfile,
  draft: ApplicationDraft,
  options: PlanOptions = {},
): FieldPlan[] {
  const facts = screeningFacts(profile);
  const answers = answerIndex(draft);
  const nameParts = (facts.name ?? "").trim().split(/\s+/).filter(Boolean);
  const pitchFieldId = pitchSlot(fields);
  // A country question is never answered from an assumption about where the candidate
  // lives: only when the verified location itself names the country.
  const livesInHomeCountry = new RegExp(`\\b${HOME_COUNTRY}\\b`, "i").test(facts.location ?? "");
  let resumePlaced = false;

  const fact = (field: FormField, key: string, what: string): FieldPlan => {
    const value = facts[key];
    return usable(value) ? { field, action: "fill", value, source: key } : leave(field, `no verified ${what} on file`);
  };

  const country = (field: FormField): FieldPlan => {
    if (!livesInHomeCountry) return leave(field, "no verified country on file");
    const option =
      field.options.find((candidate) => candidate.trim().toLowerCase() === HOME_COUNTRY.toLowerCase()) ??
      field.options.find((candidate) => HOME_COUNTRY_OPTION.test(candidate.trim()));
    if (option === undefined) return leave(field, `no option equals ${HOME_COUNTRY}`);
    // An option with a dial code is the phone's country: it has to agree with the number on file.
    const dialCode = /\+\s*(\d{1,4})/.exec(option)?.[1];
    if (dialCode !== undefined) {
      const digits = (facts.phone ?? "").replace(/\D/g, "").replace(/^00/, "");
      if (!digits) return leave(field, "no verified phone number on file");
      if (!digits.startsWith(dialCode)) return leave(field, `the phone number on file is not a +${dialCode} number`);
    }
    return { field, action: "select", option, source: "location" };
  };

  const file = (field: FormField, label: string): FieldPlan => {
    if (COVER_LETTER.test(label)) return leave(field, "cover letter as a file — attach it yourself");
    if (!RESUME.test(label)) return leave(field, CUSTOM_REASON);
    if (AUTOFILL.test(label)) {
      if (!options.resumeAutofill) return leave(field, "autofill helper — the resume field itself is used");
      // Fed as well as, not instead of, the resume field: the parser fills in the form,
      // and the verified values are typed over what it read.
      return usable(draft.resumePdfPath) ? { field, action: "upload", path: draft.resumePdfPath } : leave(field, "no resume PDF on this draft");
    }
    if (!usable(draft.resumePdfPath)) return leave(field, "no resume PDF on this draft");
    if (resumePlaced) return leave(field, "resume already attached");
    resumePlaced = true;
    return { field, action: "upload", path: draft.resumePdfPath };
  };

  const standard = (field: FormField): FieldPlan => {
    const label = normalizeLabel(field.label);
    if (SENSITIVE.test(label)) return leave(field, SENSITIVE_REASON);
    if (field.type === "file") return file(field, label);

    if (field.type === "textarea") {
      if (field.id !== pitchFieldId) return leave(field, CUSTOM_REASON);
      return usable(draft.pitch)
        ? { field, action: "pitch", value: draft.pitch }
        : leave(field, "no cover note on this draft");
    }

    const located = LOCATION.test(label) || WHERE_BASED.test(label);
    const countryAsked = COUNTRY.test(label) || WHICH_COUNTRY.test(label);
    if (field.typeAhead) {
      // A box that searches for places as you type and only keeps a picked suggestion:
      // Lever's "Current location" (a text input), Greenhouse's "Location (City)" and
      // Ashby's "Location" (dropdowns). The verified place is searched for, and a
      // suggestion is taken only if it is that place. A type-ahead that asks anything
      // else — a preferred office, a university — is not the operator's to search in.
      const searchable = LINE_TYPES.has(field.type) || field.type === "select";
      if (searchable && located && usable(facts.location) && placeName(facts.location)) {
        return { field, action: "pick", query: placeName(facts.location), source: "location" };
      }
      // A country searched for the same way (Ashby's "Country of Residence"): the country
      // the verified location names, and only a suggestion that is that country.
      if (searchable && countryAsked && livesInHomeCountry) return { field, action: "pick", query: HOME_COUNTRY, source: "location" };
      return leave(field, TYPE_AHEAD_REASON);
    }
    if (field.type === "select" || field.type === "radio") {
      return located || countryAsked ? country(field) : leave(field, CUSTOM_REASON);
    }
    if (!LINE_TYPES.has(field.type)) return leave(field, CUSTOM_REASON);

    if (FIRST_NAME.test(label)) {
      return nameParts.length > 0
        ? { field, action: "fill", value: nameParts[0], source: "name" }
        : leave(field, "no verified name on file");
    }
    if (LAST_NAME.test(label)) {
      if (nameParts.length === 0) return leave(field, "no verified name on file");
      return nameParts.length > 1
        ? { field, action: "fill", value: nameParts.slice(1).join(" "), source: "name" }
        : leave(field, "the name on file has no last name");
    }
    if (FULL_NAME.test(label)) return fact(field, "name", "name");
    if (EMAIL.test(label)) return fact(field, "email", "email");
    if (PHONE.test(label)) return fact(field, "phone", "phone number");
    if (located) return fact(field, "location", "location");
    if (countryAsked) {
      // Free text instead of a list (Ashby's "Country of Residence"): the same answer, typed.
      return livesInHomeCountry
        ? { field, action: "fill", value: HOME_COUNTRY, source: "location" }
        : leave(field, "no verified country on file");
    }
    if (LINKEDIN.test(label)) return fact(field, "linkedin_url", "LinkedIn URL");
    if (GITHUB.test(label)) return fact(field, "github_url", "GitHub URL");
    if (PORTFOLIO.test(label)) return fact(field, "portfolio_url", "portfolio URL");
    if (ANY_LINK.test(label)) {
      // Any of them will do: the one the form names first, of those on file.
      const named = LINK_KINDS.flatMap(([kind, key]) => {
        const at = label.search(new RegExp(`\\b(?:${kind})\\b`));
        return key !== null && at >= 0 && usable(facts[key]) ? [{ key, at }] : [];
      }).sort((a, b) => a.at - b.at);
      // With none of them on file it is a question like any other, for the drafting step to answer or hold.
      if (named.length > 0) return fact(field, named[0].key, "link");
    }
    return leave(field, CUSTOM_REASON);
  };

  return fields.map((field) => {
    const plan = standard(field);
    // A verified fact wins; a prepared answer only speaks for what would otherwise be left.
    return plan.action === "leave" ? (answerPlan(field, answers) ?? plan) : plan;
  });
}

/** Labels of required fields a plan leaves for the user — what would stop a hands-free submit. */
export function requiredLeft(plans: FieldPlan[]): string[] {
  return plans.filter((plan) => plan.action === "leave" && plan.field.required).map((plan) => plan.field.label);
}
