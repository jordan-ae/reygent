/**
 * Applications held for a code the site emailed the candidate, finished from the dashboard.
 *
 * Greenhouse, when it suspects automation, does not take an application at Submit: it
 * emails the applicant a code "to confirm you are not a robot" and waits for it. A
 * hands-free run never waits there. The application is held — nothing went out — and it
 * keeps its company. On the dashboard the candidate presses "I'm ready": the running loop
 * fills the form in again and presses Submit, the site emails a fresh code, and an Approve
 * card shows it, read from their inbox when Reygent can read that mailbox, or pasted by
 * them. The code is typed only once they press Approve, for that one application: the
 * site asked for a person, and the person is the one who says yes. Nothing approves
 * itself, and nothing approves several at once.
 *
 * The console and the loop are separate processes on one database, so each writes only
 * its own keys: the console `code.ready.<job>` and `code.answer.<job>`, the loop
 * `code.session.<job>`.
 */

import type { FillReport } from "@/core/browser/types";
import type { Config } from "@/core/config";
import { type Repository, toIso } from "@/core/db/repository";
import { findEmployerCode, type FoundCode } from "@/core/mail/codeRequest";
import type { InboxCursor, InboxReader } from "@/core/mail/inbox";
import { DraftStatus, type JobOpportunity, NEEDS_CODE, isCodeHold } from "@/core/models";
import { type Applier, INTERRUPTED, dispatchKeys, recordSubmission } from "@/core/orchestrator/pipeline";
import { ProfileManager } from "@/core/profile/manager";

const READY = "code.ready.";
const ANSWER = "code.answer.";
const SESSION = "code.session.";

/** How often the loop looks for the candidate's Approve, and in their inbox for the code. */
const ANSWER_POLL_MS = 1_500;
const INBOX_POLL_MS = 10_000;
/** How often a waiting session says it is still alive. */
const BEAT_MS = 15_000;
/** A session not heard from for this long belongs to a loop that stopped. */
const STALE_MS = 10 * 60_000;

/** What the loop is doing with an application the candidate said they were ready for. */
export interface CodeSession {
  /**
   * filling  — the form is being filled in and submitted.
   * waiting  — the site emailed its code; the Approve card is up until `until`.
   * entering — an approved code is being typed and checked.
   * done     — over; `submitted` and `message` say how it went.
   */
  status: "filling" | "waiting" | "entering" | "done";
  startedAt: string;
  updatedAt: string;
  until?: string;
  /** Until when the inbox is searched before the candidate is asked to paste the code. */
  lookUntil?: string;
  /** The address the code went to, when Reygent cannot read that inbox. */
  unreadable?: string;
  /** The code found in the candidate's inbox, with the email it came in. */
  found?: FoundCode;
  /** The code last typed, and codes the site turned down (never offered again). */
  entered?: string;
  rejected?: string[];
  submitted?: boolean;
  message?: string;
}

interface CodeAnswer {
  /** The code the candidate approved, as found or as they typed it. */
  code?: string;
  /** "Not now": stop waiting for this one. */
  skip?: boolean;
  at: string;
}

/** What the dashboard shows for an application held for a code. */
export interface CodeHoldView {
  /**
   * held    — waiting for "I'm ready".
   * queued  — "I'm ready" was pressed; the loop has not picked it up yet.
   * filling, waiting, entering — as in CodeSession.
   */
  state: "held" | "queued" | "filling" | "waiting" | "entering";
  /** Why it is held, or what the last try came to. */
  note: string;
  since?: string;
  until?: string;
  lookUntil?: string;
  unreadable?: string;
  found?: FoundCode;
  message?: string;
}

const drop = (repo: Repository, key: string): void => {
  repo.run("DELETE FROM system_state WHERE key = ?", [key]);
};

/** The session the loop is running for `jobId`, if one is: a stale one is no session. */
function liveSession(repo: Repository, jobId: string, now: Date): CodeSession | null {
  const session = repo.getState<CodeSession>(SESSION + jobId);
  if (!session || session.status === "done") return null;
  return now.getTime() - Date.parse(session.updatedAt) > STALE_MS ? null : session;
}

// ---------- The console's side ----------

/** Where the application of `jobId` stands with its emailed code; null when it is not held for one. */
export function codeHoldView(repo: Repository, jobId: string, now: Date): CodeHoldView | null {
  const stored = repo.latestDraftForJob(jobId);
  const session = liveSession(repo, jobId, now);
  if (session) {
    return {
      state: session.status === "done" ? "held" : session.status,
      note: stored?.note ?? "",
      since: session.startedAt,
      until: session.until,
      lookUntil: session.lookUntil,
      unreadable: session.unreadable,
      found: session.found,
      message: session.message,
    };
  }
  if (!isCodeHold(stored)) return null;
  const ready = repo.getState<{ at: string }>(READY + jobId);
  if (ready) return { state: "queued", note: stored!.note, since: ready.at };
  const last = repo.getState<CodeSession>(SESSION + jobId);
  return { state: "held", note: stored!.note, message: last?.status === "done" ? last.message : undefined };
}

/** Why the candidate cannot do `action` now, or null when they can — then it is done. */
export function actOnCodeHold(
  repo: Repository,
  jobId: string,
  action: "ready" | "approve" | "skip",
  code: string,
  now: Date,
): string | null {
  return repo.transaction(() => {
    const view = codeHoldView(repo, jobId, now);
    if (!view) return "This application is not waiting for a code";
    switch (action) {
      case "ready":
        if (view.state !== "held") return "Reygent is already on it";
        repo.setState(READY + jobId, { at: toIso(now) });
        return null;
      case "approve": {
        if (view.state !== "waiting") return "There is no code to approve right now";
        const typed = code.replace(/\s/g, "");
        if (!/^[A-Za-z0-9]{4,12}$/.test(typed)) return "A code is 4 to 12 letters or digits";
        repo.setState(ANSWER + jobId, { code: typed, at: toIso(now) } satisfies CodeAnswer);
        return null;
      }
      case "skip":
        if (view.state === "queued") {
          drop(repo, READY + jobId);
          return null;
        }
        if (view.state !== "waiting") return "There is nothing to stop right now";
        repo.setState(ANSWER + jobId, { skip: true, at: toIso(now) } satisfies CodeAnswer);
        return null;
    }
  });
}

// ---------- The loop's side ----------

/** The applications the candidate said they are ready for, in the order they said so. */
export function readyJobs(repo: Repository): string[] {
  return repo
    .query<{ key: string }>("SELECT key FROM system_state WHERE substr(key, 1, ?) = ? ORDER BY updated_at", [READY.length, READY])
    .map((row) => row.key.slice(READY.length));
}

/** Close what a loop that stopped half-way left open, so its cards do not hang. */
export function closeLeftoverSessions(repo: Repository, now: Date): void {
  const rows = repo.query<{ key: string }>("SELECT key FROM system_state WHERE substr(key, 1, ?) = ?", [SESSION.length, SESSION]);
  for (const { key } of rows) {
    const session = repo.getState<CodeSession>(key);
    if (session && session.status !== "done") {
      repo.setState(key, { ...session, status: "done", submitted: false, updatedAt: toIso(now), message: "Reygent stopped while this was open" });
    }
  }
}

export interface ApproverOptions {
  /** The candidate's inboxes Reygent can read; the code is looked for there. */
  readers: readonly InboxReader[];
  /** The address the site sends its code to: the one given on the form. */
  codeMailbox: string;
  /** How long the inbox is searched before the candidate is asked to paste the code. */
  lookMinutes: number;
  /** How long the Approve card stays up. */
  waitMinutes: number;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
}

const pause = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The operator's `askForCode` for a run the candidate started from the dashboard. It puts
 * the Approve card up, shows any code it finds in their inbox, and returns only a code
 * they approved or typed there; null when they said not now or the card timed out.
 * Outside such a run it returns null at once.
 */
export function codeApprover(repo: Repository, options: ApproverOptions): (job: JobOpportunity, retry: boolean) => Promise<string | null> {
  const now = options.now ?? (() => new Date());
  const wait = options.sleep ?? pause;
  return async (job, retry) => {
    const key = SESSION + job.id;
    const started = repo.getState<CodeSession>(key);
    if (!started || started.status === "done") return null;
    const rejected = retry && started.entered ? [...(started.rejected ?? []), started.entered] : (started.rejected ?? []);
    const until = now().getTime() + Math.max(options.waitMinutes, options.lookMinutes) * 60_000;
    // The code can only be found where it was sent: when that inbox cannot be read, say so at once.
    const mailbox = options.codeMailbox.trim().toLowerCase();
    const readable = options.readers.some((reader) => reader.account.toLowerCase() === mailbox);
    let session: CodeSession = {
      ...started,
      status: "waiting",
      until: toIso(new Date(until)),
      lookUntil: readable ? toIso(new Date(now().getTime() + options.lookMinutes * 60_000)) : undefined,
      unreadable: readable || !mailbox ? undefined : mailbox,
      found: undefined,
      entered: undefined,
      rejected,
      message: retry ? "The site turned that code down. Approve a newer one, or paste the newest it sent you." : undefined,
      updatedAt: toIso(now()),
    };
    repo.setState(key, session);
    // This is the ordinary inbox pass's cursor, read here but never written back.
    const cursors = repo.getState<Record<string, InboxCursor>>("inbox.cursors") ?? {};
    let looked = -Infinity;
    let beat = now().getTime();
    while (now().getTime() < until) {
      const answer = repo.getState<CodeAnswer>(ANSWER + job.id);
      if (answer) {
        drop(repo, ANSWER + job.id);
        if (answer.skip || !answer.code) return null;
        session = { ...session, status: "entering", entered: answer.code, updatedAt: toIso(now()) };
        repo.setState(key, session);
        return answer.code;
      }
      const at = now().getTime();
      if (options.readers.length && at - looked >= INBOX_POLL_MS) {
        looked = at;
        const found = await findEmployerCode(options.readers, cursors, {
          since: Date.parse(started.startedAt), company: job.company, skip: rejected,
        });
        if (found && found.code !== session.found?.code) {
          session = { ...session, found, updatedAt: toIso(now()) };
          repo.setState(key, session);
          beat = now().getTime();
        }
      }
      if (now().getTime() - beat >= BEAT_MS) {
        beat = now().getTime();
        session = { ...session, updatedAt: toIso(now()) };
        repo.setState(key, session);
      }
      await wait(Math.min(ANSWER_POLL_MS, Math.max(0, until - now().getTime())));
    }
    return null;
  };
}

export interface ReadyRun {
  repo: Repository;
  config: Config;
  /** An operator that submits on its own and asks `codeApprover` for codes. */
  applier: Applier;
  clock?: () => Date;
}

/**
 * Apply again for one application the candidate is ready to finish. Whatever happens, it
 * ends with the session closed and the application where it belongs: submitted, held for
 * its code again, or — when Submit may have gone through — waiting for them to check.
 */
export async function runWhenReady(env: ReadyRun, jobId: string): Promise<CodeSession> {
  const { repo, config, applier } = env;
  const clock = env.clock ?? (() => new Date());
  drop(repo, READY + jobId);
  // An answer left from an earlier card is not this card's.
  drop(repo, ANSWER + jobId);
  const startedAt = toIso(clock());
  let session: CodeSession = { status: "filling", startedAt, updatedAt: startedAt };
  const finish = (submitted: boolean, message: string): CodeSession => {
    const current = repo.getState<CodeSession>(SESSION + jobId) ?? session;
    session = { ...current, status: "done", until: undefined, submitted, message, updatedAt: toIso(clock()) };
    repo.setState(SESSION + jobId, session);
    return session;
  };

  const job = repo.getJob(jobId);
  const stored = repo.latestDraftForJob(jobId);
  if (!job || !stored || !isCodeHold(stored)) return finish(false, "This application is no longer waiting for a code");
  const dedupSince = toIso(new Date(clock().getTime() - config.cop.dedup_window_days * 86_400_000));
  const earlier = repo.lastDispatch(dedupSince, dispatchKeys(stored.draft, job));
  if (earlier) {
    repo.setDraftStatus(stored.id, DraftStatus.NEEDS_ATTENTION, `Already contacted on ${earlier.dispatchedAt.slice(0, 10)}`);
    return finish(false, `Already contacted on ${earlier.dispatchedAt.slice(0, 10)}`);
  }

  repo.setState(SESSION + jobId, session);
  // As in the cycle: marked before the form is touched, so a process that dies half-way
  // never leaves it looking unsent.
  repo.setDraftStatus(stored.id, DraftStatus.NEEDS_ATTENTION, INTERRUPTED);
  let result: FillReport;
  try {
    result = await applier.apply(job, stored.draft, new ProfileManager(repo, config).initialize());
  } catch (error) {
    const reason = error instanceof Error ? error.message.split("\n")[0] : String(error);
    result = { status: "failed", reason, filled: [], unfilled: [], blockers: [], requiredUnfilled: [] };
  }
  if (result.status === "submitted") {
    recordSubmission(repo, stored, job, clock());
    return finish(true, "Submitted");
  }
  const why = result.reason || "Not completed";
  if (result.pressed) {
    // It may well have gone through: it stands for its company until someone checks.
    repo.setDraftStatus(stored.id, DraftStatus.NEEDS_ATTENTION, `${why}.`);
    return finish(false, why);
  }
  if (result.emailedCode || result.status === "failed") {
    // Nothing went out: it waits for the next "I'm ready".
    repo.setDraftStatus(stored.id, DraftStatus.NEEDS_ATTENTION, `${NEEDS_CODE}: ${why}`);
    return finish(false, why);
  }
  // Something other than the code stood in the way this time; it is no longer the code's to settle.
  repo.setDraftStatus(stored.id, DraftStatus.NEEDS_ATTENTION, `${why}.`);
  return finish(false, why);
}
