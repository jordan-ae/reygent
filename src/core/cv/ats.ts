/**
 * Reading a printed CV back the way an applicant tracking system does.
 *
 * A parser takes the PDF's text layer, top to bottom, and looks for a name, contact
 * details, the section headings it knows, a work history and the terms a recruiter
 * searches for. Each check here is one of those, run on the text actually in the file:
 * a CV that fails one is not sent, however good the page looks.
 */

import { type CvDocument, HEADINGS, displayUrl, roleDates } from "@/core/cv/document";
import { contains } from "@/core/cv/keywords";

export interface AtsCheck {
  /** What a parser needs, in a few words. */
  name: string;
  ok: boolean;
  /** What was found, or what is wrong. */
  detail: string;
  /** For a failed check that looked for particular things: the ones it did not find. */
  unread?: string[];
}

/** Glyphs that stand for several letters, and what a broken font map leaves behind: none can be searched for. */
const UNSEARCHABLE_RX = /[ﬀ-ﬆ�-­]/gu;

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;

/** Where each of `needles` first appears in `text` at or after the one before it; -1 from the first that does not. */
function inOrder(text: string, needles: readonly string[]): number[] {
  let from = 0;
  return needles.map((needle) => {
    const at = from < 0 ? -1 : text.indexOf(needle, from);
    from = at < 0 ? -1 : at + needle.length;
    return at;
  });
}

/**
 * Check the text read back from a printed CV (`text`, null when it could not be read)
 * against what the page was meant to say. `keywords` are the listing's terms the CV
 * backs: each has to be there, as the listing spells it.
 */
export function auditCv(text: string | null, document: CvDocument, keywords: readonly string[]): AtsCheck[] {
  if (text === null || !text.trim()) {
    return [{ name: "Text layer", ok: false, detail: "the PDF has no text a parser can read" }];
  }
  const lines = text.split("\n");
  // A parser does not see line ends inside a paragraph, so neither do the checks that follow.
  const flat = lines.join(" ").replace(/\s+/g, " ");
  const checks: AtsCheck[] = [{ name: "Text layer", ok: true, detail: `${plural(lines.length, "line")} of selectable text` }];
  const check = (name: string, missing: readonly string[], found: string): void => {
    if (missing.length) checks.push({ name, ok: false, detail: `not read back: ${missing.join("; ")}`, unread: [...missing] });
    else checks.push({ name, ok: true, detail: found });
  };

  const unsearchable = [...new Set(text.match(UNSEARCHABLE_RX) ?? [])];
  checks.push({
    name: "Characters",
    ok: unsearchable.length === 0,
    detail: unsearchable.length
      ? `${plural(unsearchable.length, "glyph")} a search cannot match (${unsearchable.map((glyph) => `U+${glyph.codePointAt(0)!.toString(16).toUpperCase()}`).join(", ")})`
      : "every character is plain text",
  });

  checks.push({
    name: "Name",
    ok: Boolean(document.name) && lines[0] === document.name,
    detail: lines[0] === document.name ? "the first line of the file" : `the file opens with "${lines[0]}"`,
  });

  const contact = [...document.contact, ...document.links.map(displayUrl)];
  check("Contact details", contact.filter((item) => !flat.includes(item)), `${plural(contact.length, "item")}, each as text`);

  const headings = [
    document.summary ? HEADINGS.summary : "",
    document.skills.length ? HEADINGS.skills : "",
    document.experience.length ? HEADINGS.experience : "",
    document.projects.length ? HEADINGS.projects : "",
    document.other.length ? HEADINGS.other : "",
    document.education.length ? HEADINGS.education : "",
  ].filter(Boolean);
  // A heading counts only on a line of its own: that is how a parser tells a section from a sentence.
  const headingAt = headings.map((heading) => lines.indexOf(heading));
  const ordered = headingAt.every((at, index) => at >= 0 && (index === 0 || at > headingAt[index - 1]));
  checks.push({
    name: "Section headings",
    ok: ordered,
    detail: ordered
      ? `${headings.join(", ")}, each on its own line and in that order`
      : `expected ${headings.join(", ")} in that order; missing or out of place: ${headings.filter((_, index) => headingAt[index] < 0 || (index > 0 && headingAt[index] <= headingAt[index - 1])).join(", ")}`,
  });

  const roles = document.experience.map((role) => [role.title, role.employer, roleDates(role)].filter(Boolean));
  const positions = inOrder(flat, roles.flat());
  const unread = roles.flat().filter((_, index) => positions[index] < 0);
  check("Work history", unread, `${plural(roles.length, "role")}, each with its title, employer and dates, most recent first`);

  check(
    "Keywords",
    keywords.filter((keyword) => !contains(flat, keyword)),
    keywords.length ? `all ${keywords.length} matched terms, as the listing spells them` : "the listing named no term the CV backs",
  );
  return checks;
}
