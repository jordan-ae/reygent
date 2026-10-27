/** A pipeline cycle's report, in words. */

import { count, plural } from "@/components/format";
import type { CycleReport } from "@/core/web/types";

/** What one cycle did, a line per step that had something to do. */
export function cycleLines(report: CycleReport): string[] {
  const lines: string[] = [];
  if (report.steps.includes("discover")) {
    const { confirmed, potentially_eligible: unclear, ineligible } = report.tiers;
    lines.push(
      `Discovery: ${count(report.fetched)} ${plural(report.fetched, "listing", "listings")} fetched, ${count(report.added)} new` +
        (report.added ? ` (${confirmed} confirmed eligible, ${unclear} to investigate, ${ineligible} ineligible)` : ""),
    );
  }
  if (report.boardsLearned) {
    lines.push(
      `Boards: ${report.boardsLearned} ${plural(report.boardsLearned, "company board", "company boards")} found by company name, ` +
        "read from the next cycle on",
    );
  }
  const { qualified, disqualified, needs_human: unsettled } = report.investigated;
  if (qualified + disqualified + unsettled > 0) {
    lines.push(
      `Investigation: ${qualified} confirmed, ${disqualified} ruled out, ${unsettled} unsettled` +
        (report.pitchedUnconfirmed ? ` (${report.pitchedUnconfirmed} sent on with a contractor pitch)` : ""),
    );
  }
  if (report.scored) {
    lines.push(
      `Scoring: ${count(report.scored)} ${plural(report.scored, "job", "jobs")} scored, ${report.lowFit} below the fit threshold`,
    );
  }
  // A report stored before these were counted has no such fields.
  if (report.holdsRetried) {
    lines.push(`Held applications: ${report.holdsRetried} sent back to be written again with your details as they are now`);
  }
  if (report.leadsMoved) {
    lines.push(
      `Job sites: ${report.leadsMoved} ${plural(report.leadsMoved, "listing", "listings")} found on the employer's own board, ` +
        "to be judged and applied for there",
    );
  }
  const { approved, awaitingReview, quarantined, skipped } = report.drafts;
  if (approved + awaitingReview + quarantined + skipped > 0) {
    // A report stored before leads were counted has no such field.
    const leads = report.leadsDrafted ?? 0;
    lines.push(
      report.unattended
        ? `Drafting: ${approved} to apply for, ${quarantined} set aside by the Cop Tool, ${skipped} skipped`
        : `Drafting: ${approved - leads} to apply for, ${leads} ${plural(leads, "pitch", "pitches")} for you to send, ` +
            `${awaitingReview} waiting for your review, ${quarantined} held by the Cop Tool, ${skipped} skipped`,
    );
  }
  const { submitted, handedOff, failed } = report.applications;
  if (submitted + handedOff + failed > 0) {
    const emailed = report.emailed ? ` (${report.emailed} by email)` : "";
    lines.push(
      `Applications: ${submitted} submitted${emailed}, ${handedOff} ${report.unattended ? "could not be completed" : "need you"}, ${failed} failed`,
    );
  } else if (report.steps.includes("apply")) {
    lines.push("Applications: none this cycle — nothing has been sent");
  }
  const inbox = report.inbox;
  if (inbox && inbox.opened > 0) {
    lines.push(
      `Inbox: ${count(inbox.opened)} ${plural(inbox.opened, "message", "messages")} about your applications — ` +
        `${inbox.confirmed} confirmed, ${inbox.rejected} ${plural(inbox.rejected, "rejection", "rejections")}, ` +
        `${inbox.replies} ${plural(inbox.replies, "reply", "replies")} for you to answer`,
    );
  }
  return lines.length ? lines : ["Nothing to do this cycle."];
}

/** The same in one sentence, for the toast after "Run discovery now". */
export function runSummary(report: CycleReport): string {
  const failed = report.errors.length;
  return (
    `Discovery finished: ${count(report.fetched)} ${plural(report.fetched, "listing", "listings")} fetched, ` +
    `${count(report.added)} new, ${count(report.scored)} scored.` +
    (failed ? ` ${failed} ${plural(failed, "problem", "problems")} — see Last cycle.` : "") +
    (report.paused ? " The daily spend cap was reached." : "")
  );
}
