import { afterEach, beforeEach, describe, expect, test } from "vitest";

import type { FillReport } from "@/core/browser/types";
import { defaultConfig } from "@/core/config";
import { Repository } from "@/core/db/repository";
import type { InboxMessage, InboxReader } from "@/core/mail/inbox";
import { Channel, DraftStatus, type JobOpportunity, NEEDS_CODE, PipelineStage, createDraft, createJob } from "@/core/models";
import {
  actOnCodeHold,
  closeLeftoverSessions,
  codeApprover,
  codeHoldView,
  readyJobs,
  runWhenReady,
} from "@/core/orchestrator/codeHold";
import type { Applier } from "@/core/orchestrator/pipeline";

const config = defaultConfig();

/** A clock that only moves when told to. */
function manualClock(start = "2026-10-15T12:00:00Z") {
  let now = Date.parse(start);
  return { now: () => new Date(now), advance: (ms: number) => { now += ms; } };
}

const greenhouse = (code: string, date: string): InboxMessage => ({
  uid: 1, messageId: code, from: "no-reply@us.greenhouse-mail.io", fromName: "Acme",
  subject: "Security code for your application to Acme", date, text: `Paste this code into the security code field:\n${code}`,
});

const inbox = (messages: () => InboxMessage[]): InboxReader => ({
  account: "candidate@example.com",
  verify: async () => {},
  async read(_cursor, wanted) {
    return { cursor: { uidValidity: "1", lastUid: 9 }, messages: messages().filter((one) => wanted(one)) };
  },
});

const report = (fields: Partial<FillReport>): FillReport => ({
  status: "handed_off", reason: "", filled: ["Email"], unfilled: [], blockers: [], requiredUnfilled: [], ...fields,
});

describe("applications held for an emailed code", () => {
  let repo: Repository;
  let jobId: string;
  let draftId: number;
  let clock = manualClock();

  beforeEach(() => {
    clock = manualClock();
    repo = new Repository(":memory:");
    const job = createJob({ source: "greenhouse", sourceId: "1", company: "Acme", title: "Engineer", applyUrl: "https://boards.greenhouse.io/acme/jobs/1" });
    repo.insertJob(job);
    jobId = job.id;
    draftId = repo.saveDraft(createDraft({
      jobId, channel: Channel.CONTRACT_GIGS, positioningProfileId: "ai_platform_agent", pitch: "Hello",
      cvBullets: [], screeningAnswers: [], resumePdfPath: "/tmp/cv.pdf", quotedRateUsd: 55, quotedRatePeriod: "hour", contact: "",
    }), DraftStatus.AWAITING_REVIEW);
    repo.setDraftStatus(draftId, DraftStatus.NEEDS_ATTENTION, `${NEEDS_CODE}: Not submitted: after Submit the site emailed you a code`);
  });
  afterEach(() => repo.close());

  /** An applier that behaves like the operator on a Greenhouse form: Submit, then the code. */
  const operatorLike = (ask: (job: JobOpportunity, retry: boolean) => Promise<string | null>, accepts = "cIiEduTB"): Applier => ({
    inspect: async () => { throw new Error("not used"); },
    apply: async (job) => {
      const code = await ask(job, false);
      return code === accepts
        ? report({ status: "submitted", reason: "" })
        : report({ reason: code ? "Not submitted: the site turned down the emailed code" : "Not submitted: no emailed code was approved within 10 minutes", pressed: false, emailedCode: true });
    },
  });

  test("the approver gives nothing outside a run the candidate started", async () => {
    const ask = codeApprover(repo, { readers: [], codeMailbox: "candidate@example.com", lookMinutes: 2, waitMinutes: 10, now: clock.now, sleep: async () => {} });
    expect(await ask(repo.getJob(jobId)!, false)).toBeNull();
  });

  test("I'm ready, the code shows up from the inbox, and only Approve has it typed", async () => {
    expect(codeHoldView(repo, jobId, clock.now())).toMatchObject({ state: "held" });
    expect(actOnCodeHold(repo, jobId, "approve", "cIiEduTB", clock.now())).toBe("There is no code to approve right now");
    expect(actOnCodeHold(repo, jobId, "ready", "", clock.now())).toBeNull();
    expect(actOnCodeHold(repo, jobId, "ready", "", clock.now())).toBe("Reygent is already on it");
    expect(codeHoldView(repo, jobId, clock.now())).toMatchObject({ state: "queued" });
    expect(readyJobs(repo)).toEqual([jobId]);

    // An old code in the inbox is never offered; the one sent after this run started is.
    const mail = [greenhouse("OLDC0DE1", "2026-10-15T11:00:00.000Z")];
    const seen: string[] = [];
    let polls = 0;
    const ask = codeApprover(repo, {
      readers: [inbox(() => mail)], codeMailbox: "Candidate@Example.com", lookMinutes: 2, waitMinutes: 10, now: clock.now,
      sleep: async (ms) => {
        clock.advance(ms);
        polls += 1;
        const view = codeHoldView(repo, jobId, clock.now())!;
        seen.push(view.state);
        if (polls === 1) {
          // The inbox the code went to can be read: it is searched for two minutes before anyone is asked.
          expect(view.unreadable).toBeUndefined();
          expect(Date.parse(view.lookUntil!)).toBe(Date.parse("2026-10-15T12:02:00Z"));
        }
        if (polls === 2) mail.push(greenhouse("cIiEduTB", new Date(clock.now().getTime()).toISOString()));
        // The candidate looks at the card for a while before approving: nothing is typed meanwhile.
        if (polls === 30) {
          expect(view.found?.code).toBe("cIiEduTB");
          expect(actOnCodeHold(repo, jobId, "approve", "bad code!", clock.now())).toBe("A code is 4 to 12 letters or digits");
          expect(actOnCodeHold(repo, jobId, "approve", view.found!.code, clock.now())).toBeNull();
        }
      },
    });
    const session = await runWhenReady({ repo, config, applier: operatorLike(ask), clock: clock.now }, jobId);
    expect(session).toMatchObject({ status: "done", submitted: true, entered: "cIiEduTB" });
    expect(seen.slice(0, 2)).toEqual(["waiting", "waiting"]);
    expect(polls).toBe(30);
    expect(repo.getJob(jobId)!.stage).toBe(PipelineStage.SUBMITTED);
    expect(readyJobs(repo)).toEqual([]);
    expect(codeHoldView(repo, jobId, clock.now())).toBeNull();
  });

  test("Not now: the application is held again, with what happened", async () => {
    actOnCodeHold(repo, jobId, "ready", "", clock.now());
    const ask = codeApprover(repo, {
      readers: [], codeMailbox: "candidate@example.com", lookMinutes: 2, waitMinutes: 10, now: clock.now,
      sleep: async (ms) => {
        clock.advance(ms);
        // Nothing reads the inbox the code went to: the card asks for it straight away.
        expect(codeHoldView(repo, jobId, clock.now())).toMatchObject({ state: "waiting", found: undefined, lookUntil: undefined, unreadable: "candidate@example.com" });
        actOnCodeHold(repo, jobId, "skip", "", clock.now());
      },
    });
    const session = await runWhenReady({ repo, config, applier: operatorLike(ask), clock: clock.now }, jobId);
    expect(session).toMatchObject({ status: "done", submitted: false });
    const stored = repo.latestDraftForJob(jobId)!;
    expect(stored).toMatchObject({ status: DraftStatus.NEEDS_ATTENTION, note: `${NEEDS_CODE}: Not submitted: no emailed code was approved within 10 minutes` });
    expect(codeHoldView(repo, jobId, clock.now())).toMatchObject({ state: "held", message: expect.stringContaining("no emailed code was approved") });
  });

  test("nobody approves: the card times out and nothing is typed", async () => {
    actOnCodeHold(repo, jobId, "ready", "", clock.now());
    const mail = [greenhouse("cIiEduTB", "2026-10-15T23:59:00.000Z")];
    const ask = codeApprover(repo, { readers: [inbox(() => mail)], codeMailbox: "candidate@example.com", lookMinutes: 2, waitMinutes: 2, now: clock.now, sleep: async (ms) => clock.advance(ms) });
    let typed: string | null = "untouched";
    const applier: Applier = {
      inspect: async () => { throw new Error("not used"); },
      apply: async (job) => {
        typed = await ask(job, false);
        return report({ reason: "Not submitted: no emailed code was approved within 2 minutes", pressed: false, emailedCode: true });
      },
    };
    await runWhenReady({ repo, config, applier, clock: clock.now }, jobId);
    expect(typed).toBeNull();
    expect(repo.latestDraftForJob(jobId)!.note.startsWith(NEEDS_CODE)).toBe(true);
  });

  test("when Submit may have gone through, it waits for the candidate to check instead", async () => {
    actOnCodeHold(repo, jobId, "ready", "", clock.now());
    const applier: Applier = {
      inspect: async () => { throw new Error("not used"); },
      apply: async () => report({ reason: "The emailed code was entered but no confirmation page appeared — check before re-applying", pressed: true }),
    };
    await runWhenReady({ repo, config, applier, clock: clock.now }, jobId);
    expect(repo.latestDraftForJob(jobId)!.note).toBe("The emailed code was entered but no confirmation page appeared — check before re-applying.");
    expect(codeHoldView(repo, jobId, clock.now())).toBeNull();
    expect(actOnCodeHold(repo, jobId, "ready", "", clock.now())).toBe("This application is not waiting for a code");
  });

  test("a card left up by a loop that stopped is taken down", () => {
    repo.setState(`code.session.${jobId}`, { status: "waiting", startedAt: clock.now().toISOString(), updatedAt: clock.now().toISOString() });
    expect(codeHoldView(repo, jobId, clock.now())).toMatchObject({ state: "waiting" });
    closeLeftoverSessions(repo, clock.now());
    expect(codeHoldView(repo, jobId, clock.now())).toMatchObject({ state: "held", message: "Reygent stopped while this was open" });
  });
});
