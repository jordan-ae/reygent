/** Tier-0 ($0.00) text helpers shared by the eligibility scorer and the Cop Tool. */

import { HTML5_ENTITIES, LEGACY_ENTITIES } from "@/core/htmlEntities";

const TAG_RX = /<\/?[a-zA-Z][^<>]*>/g;
const SPACE_RX = /[ \t\r\f\v]+/g;
const PUNCTUATION: Record<string, string> = {
  "‘": "'", "’": "'", "“": '"', "”": '"',
  "–": "-", "—": "-", "−": "-", "\u00a0": " ",
};
const PUNCTUATION_RX = /[‘’“”–—−\u00a0]/g;
// Word boundaries are spelled out as lookarounds because JavaScript's \b only knows ASCII
// letters: it would read the "No" of "Noël" or the "Not" of "Notícias" as a negation.
// (Python's \b, which these patterns were written for, counts every letter and digit.)
const NEGATION_BEFORE_RX =
  /(?<![\p{L}\p{N}_])(?:no|not|never|non|without|zero|neither|nor|cannot|can't|won't|don't|doesn't|isn't|aren't|unable)(?![\p{L}\p{N}_])[^.;!?\n]*$/iu;
// The "u" flag also makes {0,25} count whole characters, so an emoji is one, not two.
const NEGATION_AFTER_RX =
  /^[^.;!?\n]{0,25}?(?<![\p{L}\p{N}_])not\s+(?:be\s+)?(?:required|needed|necessary|mandatory|a requirement|expected)(?![\p{L}\p{N}_])/iu;

/**
 * A character reference as Python's html.unescape recognises one: a decimal number, a hex
 * number, or a name of up to 32 characters, each with or without its closing ";".
 * The "u" flag makes {1,32} count whole characters, as Python does.
 */
const CHARREF_RX = /&(#[0-9]+;?|#[xX][0-9a-fA-F]+;?|[^\t\n\f <&#;]{1,32};?)/gu;
const LONGEST_LEGACY_NAME = Math.max(...[...LEGACY_ENTITIES].map((name) => name.length));

/** What numeric references 0x80–0x9F mean in practice: Windows-1252 text pasted from Word. */
const WINDOWS_1252 =
  "\u20ac\x81\u201a\u0192\u201e\u2026\u2020\u2021\u02c6\u2030\u0160\u2039\u0152\x8d\u017d\x8f" +
  "\x90\u2018\u2019\u201c\u201d\u2022\u2013\u2014\u02dc\u2122\u0161\u203a\u0153\x9d\u017e\u0178";

/** The text a numeric character reference stands for, following the HTML standard. */
function decodeCodePoint(code: number): string {
  if (code === 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return "\ufffd";
  if (code >= 0x80 && code <= 0x9f) return WINDOWS_1252[code - 0x80];
  const control = code < 0x20 ? ![0x09, 0x0a, 0x0c, 0x0d].includes(code) : code === 0x7f;
  const nonCharacter = (code >= 0xfdd0 && code <= 0xfdef) || (code & 0xfffe) === 0xfffe;
  return control || nonCharacter ? "" : String.fromCodePoint(code);
}

/** The text for a numeric reference; `body` is what follows the "&": "#38", "#x26;", ... */
function decodeNumeric(body: string): string {
  const digits = body.endsWith(";") ? body.slice(1, -1) : body.slice(1);
  const hex = digits[0] === "x" || digits[0] === "X";
  return decodeCodePoint(hex ? parseInt(digits.slice(1), 16) : parseInt(digits, 10));
}

/** The text for a named reference; `body` is the name as written, with its ";" if it has one. */
function decodeNamed(body: string): string {
  const name = body.endsWith(";") ? body.slice(0, -1) : body;
  if (name !== body || LEGACY_ENTITIES.has(name)) {
    const text = HTML5_ENTITIES.get(name);
    if (text !== undefined) return text;
  }
  // Not a name: take the longest legacy name the text starts with and keep the rest, so
  // "&nbspmoney" is a no-break space and "money", and "&notit;" is "¬it;".
  for (let length = Math.min(body.length - 1, LONGEST_LEGACY_NAME); length >= 2; length -= 1) {
    const prefix = body.slice(0, length);
    if (LEGACY_ENTITIES.has(prefix)) return HTML5_ENTITIES.get(prefix)! + body.slice(length);
  }
  return `&${body}`;
}

/** Typographic quotes and dashes to their ASCII forms. */
export function normalizePunctuation(text: string): string {
  return text.replace(PUNCTUATION_RX, (char) => PUNCTUATION[char]);
}

/**
 * Decode HTML character references exactly as Python's html.unescape does, which is how a
 * browser reads text: every HTML5 name, decimal and hex numbers, and the forms written
 * without a closing ";" ("&amp", "&#38", "&nbspmoney"). Scam listings use the rarer forms
 * on purpose, to keep a "$" or a "t.me" link out of sight of a filter.
 *
 * Text that is not a reference is left as written.
 */
export function unescapeHtml(text: string): string {
  if (!text.includes("&")) return text;
  return text.replace(CHARREF_RX, (_whole, body: string) =>
    body[0] === "#" ? decodeNumeric(body) : decodeNamed(body),
  );
}

/** Strip HTML, decode entities (ATS feeds double-escape) and normalise typographic punctuation. */
export function cleanText(raw: string | null | undefined): string {
  const text = unescapeHtml(unescapeHtml(raw ?? "")).replace(TAG_RX, " ");
  return normalizePunctuation(text).replace(SPACE_RX, " ").trim();
}

const isHighSurrogate = (unit: number): boolean => unit >= 0xd800 && unit <= 0xdbff;
const isLowSurrogate = (unit: number): boolean => unit >= 0xdc00 && unit <= 0xdfff;

// Half of an emoji: a high surrogate with no low one after it, or a low one with no high one before it.
const LONE_SURROGATE_RX = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

/**
 * `text` with any half of an emoji (a lone UTF-16 surrogate, left by cutting text at a
 * fixed length) replaced by U+FFFD. Such text is not valid Unicode, and an API that
 * checks refuses the whole request ("Request contains invalid Unicode text").
 */
export function wellFormed(text: string): string {
  return text.replace(LONE_SURROGATE_RX, "\uFFFD");
}

/** The first `count` UTF-16 units of `text`, one fewer when the last would be half an emoji. */
export function clipStart(text: string, count: number): string {
  const cut = text.slice(0, Math.max(0, count));
  return cut.length > 0 && isHighSurrogate(cut.charCodeAt(cut.length - 1)) ? cut.slice(0, -1) : cut;
}

/** The last `count` UTF-16 units of `text`, one fewer when the first would be half an emoji. */
export function clipEnd(text: string, count: number): string {
  const cut = count > 0 ? text.slice(-count) : "";
  return cut.length > 0 && isLowSurrogate(cut.charCodeAt(0)) ? cut.slice(1) : cut;
}

/**
 * The index `count` characters before `index`, stopping at `floor`.
 *
 * Windows around a match are measured in characters (code points), as the Python original
 * measured them: an emoji is one character although it is two UTF-16 units, and the
 * returned index never falls between the two halves of one.
 */
function stepBack(text: string, index: number, count: number, floor = 0): number {
  let at = index;
  for (let moved = 0; moved < count && at > floor; moved += 1) {
    const pair = at - 2 >= floor && isLowSurrogate(text.charCodeAt(at - 1)) && isHighSurrogate(text.charCodeAt(at - 2));
    at -= pair ? 2 : 1;
  }
  return at;
}

/** The index `count` characters after `index`, stopping at `ceiling`. See stepBack. */
function stepForward(text: string, index: number, count: number, ceiling = text.length): number {
  let at = index;
  for (let moved = 0; moved < count && at < ceiling; moved += 1) {
    const pair = at + 2 <= ceiling && isHighSurrogate(text.charCodeAt(at)) && isLowSurrogate(text.charCodeAt(at + 1));
    at += pair ? 2 : 1;
  }
  return at;
}

/**
 * True when the phrase at text[start, end) is negated within its own clause.
 * Catches both "no security clearance required" and "citizenship is not required".
 */
export function isNegated(text: string, start: number, end: number, lookback = 30): boolean {
  const before = normalizePunctuation(text.slice(stepBack(text, start, lookback), start));
  const after = normalizePunctuation(text.slice(end, stepForward(text, end, 45)));
  return NEGATION_BEFORE_RX.test(before) || NEGATION_AFTER_RX.test(after);
}

/** The matched phrase with whole words of context from its own line, for audit trails. */
export function snippet(text: string, start: number, end: number, pad = 40): string {
  const lineStart = text.lastIndexOf("\n", start - 1) + 1;
  const nextBreak = text.indexOf("\n", end);
  const lineEnd = nextBreak === -1 ? text.length : nextBreak;
  let left = stepBack(text, start, pad, lineStart);
  let right = stepForward(text, end, pad, lineEnd);
  if (left > lineStart) {
    const space = text.indexOf(" ", left);
    if (space !== -1 && space < start) left = space + 1;
  }
  if (right < lineEnd) {
    const space = text.lastIndexOf(" ", right - 1);
    if (space >= end) right = space;
  }
  return text.slice(left, right).split(/\s+/).filter(Boolean).join(" ");
}

const COMPANY_SUFFIXES = new Set(["inc", "llc", "ltd", "gmbh", "corp", "co", "company", "the"]);
/**
 * Dropped only from the end of a name, where they are a legal form or a job board's
 * decoration ("Proxify AB", "Automattic Careers"); elsewhere the same letters can be
 * part of the name itself.
 */
const COMPANY_TAILS = new Set(["ab", "ag", "bv", "limited", "oy", "plc", "pty", "sa", "sas", "srl", "careers", "jobs"]);

/** Normalised company name: "Acme, Inc." and "ACME" are the same employer. */
export function companyKey(name: string): string {
  const words = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .split(" ")
    .filter((word) => word && !COMPANY_SUFFIXES.has(word));
  // The last word is the name when it is all there is ("Jobs", "SA").
  while (words.length > 1 && COMPANY_TAILS.has(words[words.length - 1])) words.pop();
  return words.join(" ");
}

/**
 * Normalised role title: case and punctuation do not matter, and "Remote" in a title is
 * the board's decoration, not part of the role's name.
 */
export function titleKey(title: string): string {
  const words = normalizePunctuation(title).toLowerCase().replace(/[^a-z0-9]+/g, " ").split(" ");
  return words.filter((word) => word && word !== "remote").join(" ");
}

/**
 * Identity of a role whatever source lists it: the same title at the same company.
 *
 * The location is left out on purpose. A company's own board says "Remote, EMEA" where a
 * job board that re-lists the role says "Europe" or nothing, so the two copies only meet
 * on the company and the title.
 */
export function roleKey(company: string, title: string): string {
  return `${companyKey(company)}|${titleKey(title)}`;
}

/**
 * Identity of a screening question: the same wording asked on two forms is one question.
 * Case, spacing, typographic punctuation and the trailing "*" / ":" that forms add do not
 * matter; the words do, because "authorized to work" and "require sponsorship" look alike
 * and have opposite answers.
 */
export function questionKey(question: string): string {
  return normalizePunctuation(question)
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[\s*:]+$/, "");
}
