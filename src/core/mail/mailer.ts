/**
 * Email from the candidate's own mailbox: applications sent where an employer asks for
 * them by email, and the note telling the candidate what needs them after a run.
 *
 * Sending goes through the mailbox's SMTP server (Gmail's by default) with an app
 * password the candidate stores once in the console. Nothing here decides what is sent:
 * the pipeline does, after the Cop Tool has passed it.
 */

import fs from "node:fs";
import path from "node:path";

import nodemailer from "nodemailer";

import { type Config, expandHome } from "@/core/config";
import type { ApplicationDraft, CandidateProfile, JobOpportunity } from "@/core/models";
import { PLACEHOLDER } from "@/core/models";
import { resolveApiKey } from "@/core/secrets";

export interface OutgoingMail {
  to: string;
  subject: string;
  text: string;
  html?: string;
  replyTo?: string;
  attachments?: Array<{ filename: string; path: string }>;
}

export interface Mailer {
  /** The address mail goes out as. */
  readonly address: string;
  /** Send one message; throws when the server refuses it. Returns the server's message id. */
  send(mail: OutgoingMail): Promise<string>;
  /** Log in and out again without sending anything: is the password right? */
  verify(): Promise<void>;
}

/** An address on its own, with nothing a header could be built from. */
export const EMAIL_ADDRESS_RX = /^[\w.+-]+@[\w-]+(?:\.[\w-]+)+$/;

const usable = (value: string): boolean => value.trim() !== "" && !value.includes(PLACEHOLDER);

/** The account that signs in to the mail server: the configured one, or the candidate's own address. */
export function signInAccount(config: Config): string {
  return (config.email.smtp_user.trim() || config.candidate.email.trim()).toLowerCase();
}

/** The address mail goes out as: the configured one, or the account that signs in. */
export function sendingAddress(config: Config): string {
  return (config.email.from_address.trim() || signInAccount(config)).toLowerCase();
}

/** Where the notes about the run go: the configured address, or the candidate's own. */
export function notifyAddress(config: Config): string {
  return config.email.notify_to.trim() || config.candidate.email.trim();
}

/** The mailbox, ready to send from, or null when no app password is stored for it yet. */
export function mailerFor(config: Config): Mailer | null {
  const password = resolveApiKey(config.email.password_env);
  const user = signInAccount(config);
  const address = sendingAddress(config);
  if (!password || ![user, address].every((value) => usable(value) && EMAIL_ADDRESS_RX.test(value))) return null;
  const name = usable(config.candidate.name) ? config.candidate.name.replace(/["<>]/g, "").trim() : "";
  const transport = nodemailer.createTransport({
    host: config.email.smtp_host,
    port: config.email.smtp_port,
    // 465 speaks TLS from the start; any other port (iCloud's 587) upgrades with STARTTLS.
    secure: config.email.smtp_port === 465,
    auth: { user, pass: password },
  });
  const from = name ? { name, address } : address;
  return {
    address,
    async send(mail) {
      const info = await transport.sendMail({ from, ...mail });
      return String(info.messageId ?? "");
    },
    async verify() {
      await transport.verify();
    },
  };
}

/** The lines under the note: who is writing, how to reach them (the address it is sent as), and where to find more of their work. */
function signature(profile: CandidateProfile, address: string): string {
  const contact = [address, profile.phone].filter(usable).join(" · ");
  const links = [profile.githubUrl, profile.linkedinUrl, profile.portfolioUrl].filter(usable);
  return [profile.name, contact, ...links].filter(Boolean).join("\n");
}

/**
 * The email that carries an application: the pitch the Cop Tool passed, greeted and
 * signed, with the CV attached — the one tuned for this listing when the draft has one,
 * otherwise the candidate's own file.
 */
export function applicationEmail(
  draft: ApplicationDraft,
  job: JobOpportunity,
  profile: CandidateProfile,
  config: Config,
): OutgoingMail {
  const attachments: Array<{ filename: string; path: string }> = [];
  const tuned = draft.resumePdfPath.trim();
  const own = expandHome(config.candidate.resume_path.trim());
  const cv = tuned && fs.existsSync(tuned) ? tuned : own && fs.existsSync(own) ? own : "";
  if (cv) attachments.push({ filename: tuned && cv === tuned ? path.basename(tuned) : `${profile.name.replace(/\s+/g, "-")}-CV.pdf`, path: cv });
  const text = [`Hello ${job.company} team,`, "", draft.pitch.trim(), "", signature(profile, sendingAddress(config))].join("\n");
  // No Reply-To: a reply comes back to the address the application was sent as.
  return {
    to: draft.contact.trim(),
    subject: `${job.title} — application from ${profile.name}`,
    text,
    attachments,
  };
}

/**
 * Something for the candidate, as one row of the note.
 *
 *   reply     a company wrote back (an interview, a question, an offer) and waits on them
 *   question  a question only they can answer, once: the applications it holds go out when
 *             they do, and every other form that asks it is answered with it from then on
 */
export interface ActionItem {
  /** Stable across runs: a row is only ever sent once. */
  key: string;
  kind: "reply" | "question";
  /** The company that replied; for a question, the companies whose forms ask it. */
  company: string;
  /** The role applied for; for a question, how many applications it holds. */
  role: string;
  needed: string;
  /** Where to do it: the console page, or the employer's form. */
  link: string;
}

const escapeHtml = (text: string): string =>
  text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

/**
 * The note after a run: only what it has not said before. Replies from companies come
 * first, as the one thing that waits on the candidate; questions follow, marked optional,
 * because Reygent goes on applying everywhere else whether or not they are answered.
 * `open` counts what earlier notes already said and is still open, as one line.
 */
export function actionEmail(items: readonly ActionItem[], open: number, to: string, console: string): OutgoingMail {
  const replies = items.filter((item) => item.kind === "reply");
  const questions = items.filter((item) => item.kind === "question");
  const companies = [...new Set(replies.map((item) => item.company))];
  const subject =
    companies.length === 1 ? `Reygent: ${companies[0]} replied`
    : companies.length > 1 ? `Reygent: ${companies.length} companies replied`
    : `Reygent: ${plural(questions.length, "question", "questions")} you could answer (optional)`;
  const cell = "padding:6px 10px;border-bottom:1px solid #ddd;text-align:left;vertical-align:top";
  const table = (head: readonly string[], rows: readonly ActionItem[], cells: (item: ActionItem) => readonly string[]): string =>
    `<table style="border-collapse:collapse;font-family:sans-serif;font-size:14px">` +
    `<tr>${head.map((name) => `<th style="${cell}">${name}</th>`).join("")}</tr>` +
    rows
      .map(
        (item) =>
          `<tr>${cells(item).map((text) => `<td style="${cell}">${escapeHtml(text)}</td>`).join("")}` +
          `<td style="${cell}"><a href="${escapeHtml(item.link)}">Open</a></td></tr>`,
      )
      .join("") +
    `</table>`;
  const later = open > 0 ? `Still open from earlier notes: ${open}. ` : "";
  const html = [
    replies.length
      ? `<p>${replies.length === 1 ? "A company replied and is" : "Companies replied and are"} waiting for you:</p>` +
        table(["Company", "Role", "What they said", ""], replies, (item) => [item.company, item.role, item.needed])
      : "",
    questions.length
      ? `<p>Optional: Reygent kept applying everywhere else. Only you can answer ${questions.length === 1 ? "this question" : "these questions"}. ` +
        `Answer once on the console's Held page and the applications ` +
        `${questions.length === 1 ? "it holds go" : "they hold go"} out on the next run; the answer is reused on every form that asks the same.</p>` +
        table(["Question", "Asked by", "Holds", ""], questions, (item) => [item.needed, item.company, item.role])
      : "",
    `<p>${later}Console: <a href="${escapeHtml(console)}">${escapeHtml(console)}</a></p>`,
  ].join("");
  const text = [
    ...replies.map((item) => `${item.company} — ${item.role}: ${item.needed} (${item.link})`),
    ...(replies.length && questions.length ? [""] : []),
    ...(questions.length ? ["Optional, answer once (Reygent kept applying everywhere else):"] : []),
    ...questions.map((item) => `- ${item.needed} — asked by ${item.company} (${item.role}) (${item.link})`),
    "",
    `${later}Console: ${console}`,
  ].join("\n");
  return { to, subject, text, html };
}
