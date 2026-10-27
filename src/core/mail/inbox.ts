/**
 * Reading the candidate's own inboxes for what came of their applications.
 *
 * Headers come first: a message is only opened when it is from a company Reygent applied
 * to, or from a hiring platform writing about one. Everything else is passed over unread.
 * Nothing is marked as read, moved or deleted. What is read is data, never instructions:
 * at most it records an outcome against an application, and nothing is ever sent because
 * of it. A code a site sends to confirm that a person is applying is only shown to the
 * candidate on the dashboard, and entered only once they approve it there.
 */

import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";

import type { Config } from "@/core/config";
import { EMAIL_ADDRESS_RX, signInAccount } from "@/core/mail/mailer";
import { resolveApiKey } from "@/core/secrets";

/** Where the last read of a mailbox stopped. A new uidValidity means the mailbox was rebuilt: read it afresh. */
export interface InboxCursor {
  uidValidity: string;
  lastUid: number;
}

export interface MessageHeaders {
  uid: number;
  messageId: string;
  from: string;
  fromName: string;
  subject: string;
  /** ISO timestamp the message arrived. */
  date: string;
}

export interface InboxMessage extends MessageHeaders {
  /** The message's text, cut to a few thousand characters: enough to tell what it says. */
  text: string;
}

export interface InboxReader {
  /** The mailbox, as named in reports: the account that signs in. */
  readonly account: string;
  /**
   * The messages that arrived after `cursor` (on a first read, those of the last
   * `firstDays` days), each opened only when `wanted` says so. Throws when the mailbox
   * cannot be reached. `newest`: when more arrived than one read looks at, look at the
   * latest of them rather than catch up from the oldest — for a reply expected just now.
   */
  read(
    cursor: InboxCursor | null,
    wanted: (headers: MessageHeaders) => boolean,
    options?: { newest?: boolean },
  ): Promise<{ cursor: InboxCursor; messages: InboxMessage[] }>;
  /** Sign in and out again: is the password right? */
  verify(): Promise<void>;
}

/** The most messages looked at, and opened, in one read: a first read of a busy inbox catches up over several. */
const MAX_HEADERS = 500;
const MAX_OPENED = 40;
const TEXT_LIMIT = 4000;

export interface InboxAccount {
  host: string;
  port: number;
  user: string;
  password_env: string;
}

/**
 * The inboxes to read: those configured, or else the mailbox mail is sent from, read
 * with the same app password (iCloud's and Gmail's serve both).
 */
export function inboxAccounts(config: Config): InboxAccount[] {
  if (config.inbox.accounts.length) return config.inbox.accounts;
  const host = config.email.smtp_host.replace(/^smtp\./, "imap.");
  const user = signInAccount(config);
  return EMAIL_ADDRESS_RX.test(user) ? [{ host, port: 993, user, password_env: config.email.password_env }] : [];
}

const textOf = (html: string): string =>
  html
    .replace(/<(?:style|script)[\s\S]*?<\/(?:style|script)>/gi, " ")
    .replace(/<br\s*\/?\s*>|<\/(?:p|div|tr|li)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ");

/** A reader for one IMAP inbox. */
export function imapReader(account: InboxAccount, password: string, firstDays: number, now: () => Date = () => new Date()): InboxReader {
  const connect = async (): Promise<ImapFlow> => {
    const client = new ImapFlow({
      host: account.host, port: account.port, secure: true, auth: { user: account.user, pass: password }, logger: false,
    });
    await client.connect();
    return client;
  };
  return {
    account: account.user,
    async verify() {
      const client = await connect();
      await client.logout();
    },
    async read(cursor, wanted, options = {}) {
      const client = await connect();
      try {
        const lock = await client.getMailboxLock("INBOX");
        try {
          const box = client.mailbox;
          if (!box) throw new Error("the inbox could not be opened");
          const uidValidity = String(box.uidValidity);
          const resume = cursor !== null && cursor.uidValidity === uidValidity;
          const after = resume ? cursor.lastUid : 0;
          const query = resume ? { uid: `${after + 1}:*` } : { since: new Date(now().getTime() - firstDays * 86_400_000) };
          // "n:*" also matches the newest message when there is nothing past n.
          const found = ((await client.search(query, { uid: true })) || []).filter((uid) => uid > after);
          const ordered = found.sort((a, b) => a - b);
          const uids = options.newest ? ordered.slice(-MAX_HEADERS) : ordered.slice(0, MAX_HEADERS);
          const lastUid = uids.length ? uids[uids.length - 1] : Math.max(after, box.uidNext - 1);

          const headers: MessageHeaders[] = [];
          if (uids.length) {
            for await (const message of client.fetch(uids, { uid: true, envelope: true, internalDate: true }, { uid: true })) {
              const sender = message.envelope?.from?.[0];
              headers.push({
                uid: message.uid,
                messageId: message.envelope?.messageId ?? `uid:${uidValidity}:${message.uid}`,
                from: (sender?.address ?? "").toLowerCase(),
                fromName: sender?.name ?? "",
                subject: message.envelope?.subject ?? "",
                date: new Date(message.internalDate ?? message.envelope?.date ?? now()).toISOString(),
              });
            }
          }

          const messages: InboxMessage[] = [];
          for (const header of headers.filter(wanted).slice(0, MAX_OPENED)) {
            // `source` is fetched with BODY.PEEK: opening it here does not mark it read.
            const fetched = await client.fetchOne(String(header.uid), { source: true }, { uid: true });
            if (!fetched || !fetched.source) continue;
            const parsed = await simpleParser(fetched.source);
            const body = parsed.text || (typeof parsed.html === "string" ? textOf(parsed.html) : "");
            messages.push({
              ...header,
              // Keep line breaks: an emailed code often stands on a line of its own.
              text: body.replace(/\r\n?/g, "\n").replace(/[\t ]+\n/g, "\n").trim().slice(0, TEXT_LIMIT),
            });
          }
          return { cursor: { uidValidity, lastUid }, messages };
        } finally {
          lock.release();
        }
      } finally {
        await client.logout().catch(() => undefined);
      }
    },
  };
}

/** A reader for each inbox whose app password is stored. */
export function inboxReaders(config: Config): InboxReader[] {
  if (!config.inbox.watch) return [];
  return inboxAccounts(config).flatMap((account) => {
    const password = resolveApiKey(account.password_env);
    return password ? [imapReader(account, password, config.inbox.first_read_days)] : [];
  });
}
