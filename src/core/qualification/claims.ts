/**
 * Answers that claim the least, for the questions where such an answer is always open to
 * the candidate. Deterministic, $0.00.
 *
 *   experience   "Do you have production experience with React Native?", "How many years
 *                have you spent with CI/CD?": the option saying they have none, or the least
 *   consent      "Do you consent to receive recruiting SMS messages?": the option declining
 *   notice       "When you apply, your personal information will be handled …" with one
 *                option, "Acknowledge": that option, the only answer the form takes
 *
 * The CV is the record of what the candidate has done, so an answer that claims nothing
 * beyond it is never a false claim about them: at worst it undersells. Declining a consent
 * is always theirs to do. The drafting step falls back on these when nothing better can be
 * settled, and the Cop Tool lets them through without asking the decision model.
 */

import { saysYes } from "@/core/qualification/workStatus";
import { normalizePunctuation } from "@/core/text";

// Asks what the candidate has done, or how much of it.
const EXPERIENCE_RX = new RegExp(
  String.raw`\bexperience[sd]?\b|\bworked\s+(?:with|on|in|at)\b|\bused\b|\bfamiliar\w*|\bproficien\w*|\bknowledge\b` +
    String.raw`|\bwritten\b|\bshipped\b|\bbuilt\b|\bhands[- ]on\b|\bhow\s+(?:many\s+years|long)\b|\byears\b`,
  "i",
);
// A spoken language is not something the CV records: "No" to English would be false, not modest.
const LANGUAGE_RX =
  /\benglish\b|\bfrench\b|\bgerman\b|\bspanish\b|\bportuguese\b|\bitalian\b|\bdutch\b|(?<!programming\s|query\s|scripting\s)\blanguages?\b|\bfluen\w*/i;
// Asks the applicant to agree to something they may refuse: texts, marketing, a tool watching an interview.
const CONSENT_RX =
  /\bconsent\w*|\bopt[- ]?in\b|\bsubscribe\b|\bsign\s+(?:me\s+)?up\b|\breceive\s+(?:\w+\s+){0,3}(?:sms|texts?|messages|emails|updates|newsletters?)\b/i;
// A notice the applicant confirms having read.
const NOTICE_RX = new RegExp(
  String.raw`\backnowledg\w*|\bprivacy\b|\bgdpr\b|\bpersonal\s+(?:information|data)\b|\bdata\s+(?:protection|processing|retention)\b` +
    String.raw`|\b(?:terms|policy|notice|statement)\b|^\W*(?:I\s+)?(?:agree|confirm|accept)\W*$`,
  "i",
);
// One that mentions AI may be asking the applicant not to use it.
const MENTIONS_AI_RX = /\bA\.?I\b|\bartificial\s+intelligence\b|\bgenerat(?:ed|ive)\b|\bChatGPT\b|\bLLMs?\b/i;
const CONFIRMING_RX =
  /^\W*(?:I\s+)?(?:acknowledge[sd]?|agree[sd]?|confirm(?:ed)?|accept(?:ed)?|yes|ok(?:ay)?|understood)\W*$|^\W*I\s+(?:have\s+read|understand)\b/i;

// "No", "None", "Neither", "No experience with BPMN", "I have no direct experience with these",
// "No, I have not written Rust code for a project".
const DENIAL_RX =
  /^\W*(?:no|none|neither|never|not\s+yet)\b|\bno\s+(?:\w+\s+){0,3}experience\b|^\W*I\s+(?:have\s+not|haven't|have\s+never|do\s+not|don't)\b/i;
// The bottom of a named scale.
const BOTTOM_RX = /^\W*(?:beginner|basic|novice|entry[- ]level|elementary|minimal)\b/i;
// "No", "I do not consent", "Decline".
const DECLINING_RX = /^\W*no\b|\bdo\s+not\b|\bdon't\b|\bdecline\w*|\bopt\s+out\b/i;

/** Where an option stands on a scale of years or levels: "< 1 year" just below 1, "3+ years" at 3. NaN when it names no number. */
function rung(option: string): number {
  const text = normalizePunctuation(option).toLowerCase();
  const number = /\d+(?:\.\d+)?/.exec(text);
  if (!number) return Number.NaN;
  const value = Number(number[0]);
  return /^\W*(?:<|less\s+than|under|fewer\s+than|below|up\s+to)/.test(text) ? value - 0.5 : value;
}

// "How many years of professional software engineering experience do you have?": experience
// in all, not with one thing. Answered from the years the profile states.
const TOTAL_YEARS_RX =
  /^\W*how\s+many\s+years\s+of\s+(?:total\s+|overall\s+)?(?:professional\s+)?(?:(?:software\s+)?(?:engineering|development)\s+|work\s+)?experience\s+do\s+you\s+have\W*$/i;

/** The span of years an option covers: "3–4 years" [3, 4], "Less than 3 years" [0, 3), "8+ years" [8, ∞). Null when it names none. */
function span(option: string): { from: number; to: number } | null {
  const text = normalizePunctuation(option).toLowerCase();
  const numbers = (text.match(/\d+(?:\.\d+)?/g) ?? []).map(Number);
  if (!numbers.length || numbers.length > 2) return null;
  if (/^\W*(?:<|less\s+than|under|fewer\s+than|below)/.test(text)) return { from: 0, to: numbers[0] - 1e-9 };
  if (numbers.length === 2) return { from: numbers[0], to: numbers[1] };
  if (/\+|\bor\s+more\b|\bplus\b|\bover\b|\bmore\s+than\b/.test(text)) return { from: numbers[0] + (/\bover\b|\bmore\s+than\b/.test(text) ? 1e-9 : 0), to: Infinity };
  return { from: numbers[0], to: numbers[0] };
}

/**
 * The option holding `years`, for a question about the candidate's experience in all ("How
 * many years of professional software engineering experience do you have?"). Null for any
 * other question, for no years on file, or when not exactly one option holds them.
 */
export function totalYearsOption(question: string, options: readonly string[], years: number | null): string | null {
  if (years === null || !(years > 0) || !TOTAL_YEARS_RX.test(normalizePunctuation(question))) return null;
  const holding = options.filter((option) => {
    const covered = span(option);
    return covered !== null && years >= covered.from && years <= covered.to;
  });
  return holding.length === 1 ? holding[0] : null;
}

/** True when `question` asks about the candidate's experience or skill, which the CV records (a spoken language aside). */
export function asksAboutExperience(question: string): boolean {
  return EXPERIENCE_RX.test(question) && !LANGUAGE_RX.test(question);
}

/** True when `question` asks for a consent the applicant may refuse. */
export function asksForConsent(question: string): boolean {
  return CONSENT_RX.test(question);
}

/**
 * The option that claims the least: the one denial among the options ("No", "No experience
 * with BPMN"), else the bottom of a named scale ("Beginner"), else the smallest of a scale
 * of numbers ("< 1 year"). Null when the options name no single such bottom.
 */
export function leastClaimingOption(options: readonly string[]): string | null {
  const offered = options.filter((option) => option.trim());
  if (offered.length < 2) return null;
  const denials = offered.filter((option) => DENIAL_RX.test(normalizePunctuation(option)));
  if (denials.length) return denials.length === 1 ? denials[0] : null;
  const bottoms = offered.filter((option) => BOTTOM_RX.test(option));
  if (bottoms.length === 1) return bottoms[0];
  const rungs = offered.map(rung);
  if (rungs.some(Number.isNaN)) return null;
  const least = Math.min(...rungs);
  return rungs.filter((value) => value === least).length === 1 ? offered[rungs.indexOf(least)] : null;
}

/** The option that declines a consent ("No", "I do not consent"), when there is exactly one. */
export function decliningOption(options: readonly string[]): string | null {
  const declining = options.filter((option) => option.trim() && !saysYes(option) && DECLINING_RX.test(normalizePunctuation(option)));
  return declining.length === 1 ? declining[0] : null;
}

/**
 * The one option a notice offers ("Acknowledge", "I agree") when it is the only answer the
 * form takes. Null when there is more than one option, when the question reads as no notice,
 * or when it mentions AI.
 */
export function soleConfirmation(question: string, options: readonly string[]): string | null {
  const offered = options.filter((option) => option.trim());
  if (offered.length !== 1 || MENTIONS_AI_RX.test(question) || !NOTICE_RX.test(question)) return null;
  return CONFIRMING_RX.test(normalizePunctuation(offered[0])) ? offered[0] : null;
}

/**
 * The answer that claims the least for a choice question, when it has one: the bottom of the
 * scale for a question about experience, the declining option for a consent, the only option
 * of a notice. Null for anything else. Sensitive questions (work status, self-identification)
 * are settled by their own rules and are the caller's to leave out.
 */
export function modestOption(question: string, options: readonly string[]): string | null {
  return (
    soleConfirmation(question, options) ??
    (asksForConsent(question) ? decliningOption(options) : null) ??
    (asksAboutExperience(question) ? leastClaimingOption(options) : null)
  );
}
