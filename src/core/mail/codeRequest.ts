/**
 * Finding a code a hiring platform emailed the candidate, for the dashboard's Approve card.
 *
 * Nothing here enters a code. What is found is only shown to the candidate, next to the
 * subject of the email it came in; the operator types a code once they approve it there
 * (see `@/core/orchestrator/codeHold`).
 */

import type { InboxCursor, InboxReader } from "@/core/mail/inbox";

/** Senders whose emails may contain an application code. Keep this list short. */
export const EMPLOYER_SENDERS = ["greenhouse.io", "greenhouse-mail.io"];

/** A code worth showing: digits, or letters in mixed or upper case — never an ordinary (capitalised) word. */
const codeLike = (token: string): boolean =>
  /^[A-Za-z0-9]{4,12}$/.test(token) && (/\d/.test(token) || (/[a-z]/.test(token) && /.[A-Z]/.test(token)) || /^[A-Z]{6,}$/.test(token));

/** Pulls the security code out of an employer (Greenhouse) email body, or null. */
export function codeFromEmployerEmail(text: string): string | null {
  const lines = text.replace(/\r\n?/g, "\n").split("\n").map((line) => line.trim()).filter(Boolean);
  const mention = lines.findIndex((line) => /\b(?:code|verification|verify)\b/i.test(line));
  if (mention < 0) return null;
  // Most often the code stands on a line of its own, just after the line that mentions it.
  const alone = lines.slice(mention, mention + 6).find(codeLike);
  if (alone) return alone;
  const flat = lines.slice(mention).join(" ").replace(/\s+/g, " ");
  const after =
    flat.match(/security code[^:]{0,80}:\s*([A-Za-z0-9]{4,12})\b/i) ??
    flat.match(/\bcode\b(?:\s+is)?\s*[:\-–]?\s*([A-Za-z0-9]{4,12})\b/i);
  return after && codeLike(after[1]) ? after[1] : null;
}

/** Whether `from` is one of the hiring platforms' own addresses. */
export function fromEmployer(from: string): boolean {
  const domain = from.trim().toLowerCase().split("@")[1] ?? "";
  return EMPLOYER_SENDERS.some((allowed) => domain === allowed || domain.endsWith(`.${allowed}`));
}

export interface FoundCode {
  code: string;
  /** The subject of the email it came in: what the candidate checks before approving. */
  subject: string;
  /** ISO timestamp the email arrived. */
  receivedAt: string;
}

const squash = (text: string): string => text.toLowerCase().replace(/[^a-z0-9]/g, "");

/**
 * The newest code a hiring platform emailed after `since`, preferring an email that names
 * `company`; codes in `skip` (already turned down by the site) are passed over. Reads with
 * the ordinary inbox pass's cursor and never writes it back.
 */
export async function findEmployerCode(
  readers: readonly InboxReader[],
  cursorBook: Readonly<Record<string, InboxCursor>>,
  look: { since: number; company: string; skip?: readonly string[] },
): Promise<FoundCode | null> {
  const skip = new Set(look.skip ?? []);
  const company = squash(look.company);
  const found: Array<FoundCode & { forCompany: boolean }> = [];
  for (const reader of readers) {
    try {
      const read = await reader.read(cursorBook[reader.account] ?? null, (header) =>
        fromEmployer(header.from) && Date.parse(header.date) > look.since,
      { newest: true });
      for (const message of read.messages) {
        if (!fromEmployer(message.from) || Date.parse(message.date) <= look.since) continue;
        const code = codeFromEmployerEmail(message.text);
        if (!code || skip.has(code)) continue;
        const forCompany = company !== "" && squash(`${message.subject} ${message.fromName} ${message.text}`).includes(company);
        found.push({ code, subject: message.subject, receivedAt: message.date, forCompany });
      }
    } catch {
      // A mailbox that cannot be reached right now is looked in again on the next pass.
    }
  }
  found.sort((a, b) => Number(b.forCompany) - Number(a.forCompany) || b.receivedAt.localeCompare(a.receivedAt));
  const [best] = found;
  return best ? { code: best.code, subject: best.subject, receivedAt: best.receivedAt } : null;
}
