/** The pipeline's command-line entry points: check, discover, cycle, run, assist, status and tune. */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import type { CliIo, CommandContext } from "@/cli";
import { type Config, expandHome, loadConfig } from "@/core/config";
import { hasWorkHistory } from "@/core/cv/document";
import { CvTuningError, writeTunedCv } from "@/core/cv/tune";
import { renderPdf } from "@/core/drafting/resume";
import { resumeFileName } from "@/core/drafting/tailor";
import { FireworksClient } from "@/core/llm/fireworks";
import { JevClient } from "@/core/llm/jev";
import { CircuitBreakerError, CostLedger } from "@/core/llm/ledger";
import {
  DraftStatus,
  type JobOpportunity,
  PLACEHOLDER,
  PipelineStage,
  createJob,
  sentByHand,
  verifiedAchievements,
} from "@/core/models";
import { closeLeftoverSessions } from "@/core/orchestrator/codeHold";
import { type CycleReport, HEARTBEAT_KEY, type Step, draftingBlockers } from "@/core/orchestrator/pipeline";
import { createRuntime } from "@/core/orchestrator/runtime";
import { ProfileManager } from "@/core/profile/manager";
import { resolveApiKey } from "@/core/secrets";

const asText = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined);
const plural = (n: number, word: string, many = `${word}s`): string => `${n} ${n === 1 ? word : many}`;

/** How the pipeline will behave with this config, in one line the user reads before anything is sent. */
export function describeMode(config: Config): string {
  const { require_human_review: review, auto_submit: autoSubmit, max_submissions_per_day: perDay } = config.pipeline;
  if (review) return "REVIEW FIRST — every draft waits for your approval in the console";
  if (!autoSubmit) return "ASSISTED — forms are filled in a visible Chrome window and you press Submit";
  return `HANDS-FREE — applications that pass the Cop Tool are submitted without asking (up to ${perDay} a day); nothing waits for you`;
}

/**
 * What is left for the user, from this cycle or an earlier one. A company with something
 * waiting is not applied to again, so a cycle that sends nothing usually has this to say.
 * Unattended, nothing waits for anyone: what could not be completed is only reported.
 */
function waitingLine(report: CycleReport): string {
  const { toSend = 0, held = 0, needsAttention = 0 } = report.waiting ?? {};
  if (report.unattended) {
    const parts = [
      held ? `${plural(held, "application")} with a question your details do not answer` : "",
      needsAttention ? `${plural(needsAttention, "application")} that may or may not have gone through` : "",
    ].filter(Boolean);
    return parts.length ? `Set aside, holding nothing back: ${parts.join(", ")}` : "";
  }
  const parts = [
    held ? `${plural(held, "held application")} to answer in the console` : "",
    needsAttention ? `${plural(needsAttention, "application")} to finish (npm run reygent -- assist)` : "",
    toSend ? `${plural(toSend, "pitch", "pitches")} to send` : "",
  ].filter(Boolean);
  return parts.length ? `Waiting for you: ${parts.join(", ")}` : "";
}

/** One cycle's results, as a few lines. Only what happened is printed. */
export function printReport(report: CycleReport, io: CliIo): void {
  const lines: string[] = [];
  if (report.steps.includes("discover")) {
    const { confirmed, potentially_eligible: potential, ineligible } = report.tiers;
    lines.push(
      `Discovery: ${plural(report.fetched, "listing")} fetched, ${report.added} new` +
        (report.added ? ` (${confirmed} confirmed eligible, ${potential} to investigate, ${ineligible} ineligible)` : ""),
    );
  }
  if (report.boardsLearned) {
    lines.push(`Boards: ${plural(report.boardsLearned, "company board")} found by company name, read from the next cycle on`);
  }
  const { qualified, disqualified, needs_human: unsettled } = report.investigated;
  if (qualified + disqualified + unsettled > 0) {
    lines.push(
      `Investigation: ${qualified} confirmed, ${disqualified} ruled out, ${unsettled} unsettled` +
        (report.pitchedUnconfirmed ? ` (${report.pitchedUnconfirmed} sent on with a contractor pitch)` : ""),
    );
  }
  if (report.scored) lines.push(`Scoring: ${plural(report.scored, "job")} scored, ${report.lowFit} below the fit threshold`);
  // A report stored before these were counted has no such fields.
  if (report.holdsRetried) {
    lines.push(`Held applications: ${report.holdsRetried} sent back to be written again with your details as they are now`);
  }
  if (report.leadsMoved) {
    lines.push(
      `Job sites: ${plural(report.leadsMoved, "listing")} found on the employer's own board, to be judged and applied for there`,
    );
  }
  const drafts = report.drafts;
  if (drafts.approved + drafts.awaitingReview + drafts.quarantined + drafts.skipped > 0) {
    // A report stored before leads were counted has no such field.
    const leads = report.leadsDrafted ?? 0;
    lines.push(
      report.unattended
        ? `Drafting: ${drafts.approved} to apply for, ${drafts.quarantined} set aside by the Cop Tool, ${drafts.skipped} skipped`
        : `Drafting: ${drafts.approved - leads} to apply for, ${plural(leads, "pitch", "pitches")} for you to send, ` +
            `${drafts.awaitingReview} waiting for your review, ${drafts.quarantined} held by the Cop Tool, ${drafts.skipped} skipped`,
    );
  }
  const sent = report.applications;
  if (sent.submitted + sent.handedOff + sent.failed > 0) {
    lines.push(
      `Applications: ${sent.submitted} submitted${report.emailed ? ` (${report.emailed} by email)` : ""}, ` +
        `${sent.handedOff} ${report.unattended ? "could not be completed" : "need you"}, ${sent.failed} failed`,
    );
  } else if (report.steps.includes("apply")) {
    // Said outright: the absence of a line reads as "maybe it applied and did not say".
    lines.push("Applications: none this cycle — nothing has been sent");
  }
  for (const reason of report.blocked) lines.push(`Blocked: ${reason}`);
  if (report.paused) lines.push("Daily spend cap reached: paid steps are paused until tomorrow");
  // A report stored before inboxes were read has no such field.
  const inbox = report.inbox;
  if (inbox && inbox.opened > 0) {
    lines.push(
      `Inbox: ${plural(inbox.opened, "message")} about your applications — ${inbox.confirmed} confirmed one that was unclear, ` +
        `${plural(inbox.rejected, "rejection")}, ${plural(inbox.replies, "reply", "replies")} for you to answer`,
    );
  }
  const waiting = waitingLine(report);
  if (waiting) lines.push(waiting);
  if (report.notified) lines.push(`Emailed you ${plural(report.notified, "new item")}: what no earlier note said`);
  if (!lines.length) lines.push("Nothing to do this cycle.");
  for (const line of lines) io.out(line);
  for (const error of report.errors) io.err(`  ! ${error}`);
}

/** A runtime that re-reads config.yaml before every cycle, so edits in the console take effect. */
function runtimeFor(context: CommandContext, options: { browser: boolean; assisted?: boolean }) {
  const configPath = asText(context.flags.config);
  return createRuntime(() => loadConfig(configPath), context.repo, { ...options, log: (line) => context.io.out(`  ${line}`) });
}

/** `--watch`: this run fills forms where the user can see them and never presses Submit itself. */
const watching = (context: CommandContext): boolean => context.flags.watch === true;

/** The mode line for this run: what the config says, unless `--watch` overrides it. */
const modeLine = (context: CommandContext): string =>
  watching(context) && !context.config.pipeline.require_human_review
    ? "WATCH — forms are filled in a visible Chrome window and you press Submit (this run only)"
    : describeMode(context.config);

async function once(context: CommandContext, steps: readonly Step[] | undefined, browser: boolean): Promise<number> {
  const runtime = runtimeFor(context, { browser, assisted: watching(context) });
  try {
    printReport(await runtime.cycle(steps), context.io);
    return 0;
  } finally {
    await runtime.close();
  }
}

/** Fetch listings and sort them into eligibility tiers. Free: no model calls, no browser. */
export function discover(context: CommandContext): Promise<number> {
  return once(context, ["discover"], false);
}

/** One full cycle. */
export function cycle(context: CommandContext): Promise<number> {
  context.io.out(`Mode: ${modeLine(context)}`);
  return once(context, undefined, context.flags["no-browser"] !== true);
}

/** Cycle forever, at the configured interval, until interrupted. */
/** The file beside the database naming the process whose loop is running on it. */
const LOCK_FILE = "pipeline.pid";
/** How often the sleeping loop looks for an application the candidate is ready to finish. */
const READY_POLL_MS = 3_000;

/** The loop already running on this database, as its pid and start time, or null when there is none. */
function runningLoop(lock: string): { pid: number; startedAt: string } | null {
  let held: { pid: number; startedAt: string };
  try {
    held = JSON.parse(fs.readFileSync(lock, "utf8"));
  } catch {
    return null;
  }
  if (!Number.isInteger(held?.pid) || held.pid === process.pid) return null;
  try {
    // A pid freed and reused by something else is not a Reygent loop.
    const command = execFileSync("ps", ["-p", String(held.pid), "-o", "command="], { encoding: "utf8" });
    return /\bcli\.[jt]s\b/.test(command) ? held : null;
  } catch {
    return null;
  }
}

const lockFor = (context: CommandContext): string | null =>
  context.dbPath === ":memory:" ? null : path.join(path.dirname(context.dbPath), LOCK_FILE);

/** Why a loop cannot start on this database (another is running on it), or null when one can. */
export function alreadyRunning(context: CommandContext): string | null {
  const lock = lockFor(context);
  const other = lock ? runningLoop(lock) : null;
  return other
    ? `Reygent is already running (process ${other.pid}, started ${new Date(other.startedAt).toLocaleString()}). ` +
        `Stop it first: Ctrl+C in its terminal, or kill ${other.pid}.`
    : null;
}

export async function run(context: CommandContext): Promise<number> {
  const { io } = context;
  // Two loops on one database apply twice, read the same forms twice and write twice as
  // many notes: a second one refuses to start.
  const busy = alreadyRunning(context);
  if (busy) {
    io.err(busy);
    return 1;
  }
  const lock = lockFor(context);
  if (lock) fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
  const runtime = runtimeFor(context, { browser: context.flags["no-browser"] !== true, assisted: watching(context) });
  // A loop that stopped half-way through a code run left its card up: take it down.
  closeLeftoverSessions(context.repo, new Date());
  let stopping = false;
  let wake: (() => void) | null = null;
  const stop = () => {
    stopping = true;
    wake?.();
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  io.out(`Reygent is running. Mode: ${modeLine(context)}`);
  io.out("Press Ctrl+C to stop.");
  try {
    while (!stopping) {
      io.out("");
      io.out(`Cycle started ${new Date().toLocaleTimeString()}`);
      try {
        printReport(await runtime.cycle(), io);
      } catch (error) {
        // One bad cycle (a config typo saved mid-run, a locked database) must not end the daemon.
        io.err(`Cycle failed: ${error instanceof Error ? error.message : String(error)}`);
      }
      if (stopping) break;
      const minutes = loadIntervalMinutes(context);
      io.out(`Next cycle in ${plural(minutes, "minute")}.`);
      // Between cycles, an application the candidate pressed "I'm ready" on is taken within seconds.
      const next = Date.now() + minutes * 60_000;
      while (!stopping && Date.now() < next) {
        try {
          for (const { job, session } of await runtime.codeRuns()) {
            io.out(`Code run ${job.company} — ${job.title}: ${session.submitted ? "submitted" : session.message}`);
          }
        } catch (error) {
          io.err(`Code run failed: ${error instanceof Error ? error.message : String(error)}`);
        }
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, Math.max(0, Math.min(READY_POLL_MS, next - Date.now())));
          wake = () => {
            clearTimeout(timer);
            resolve();
          };
        });
        wake = null;
      }
    }
  } finally {
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
    await runtime.close();
    if (lock && runningLoop(lock) === null) fs.rmSync(lock, { force: true });
  }
  io.out("Stopped.");
  return 0;
}

function loadIntervalMinutes(context: CommandContext): number {
  try {
    return loadConfig(asText(context.flags.config)).pipeline.loop_interval_minutes;
  } catch {
    return context.config.pipeline.loop_interval_minutes;
  }
}

/**
 * Finish the applications a hands-free run could not: each one is opened, filled, and
 * left in a visible Chrome window for the user to complete and submit.
 */
export async function assist(context: CommandContext): Promise<number> {
  const { repo, io } = context;
  const waiting = repo.listDrafts(DraftStatus.NEEDS_ATTENTION).filter((stored) => {
    const job = repo.getJob(stored.jobId);
    return job && !sentByHand(job);
  });
  if (!waiting.length) {
    io.out("No applications are waiting for you.");
    return 0;
  }
  io.out(`${plural(waiting.length, "application")} to finish. Each opens in Chrome, already filled in:`);
  for (const stored of waiting) {
    const job = repo.getJob(stored.jobId)!;
    io.out(`  - ${job.company} — ${job.title}: ${stored.note}`);
    repo.setDraftStatus(stored.id, DraftStatus.APPROVED);
  }
  const runtime = runtimeFor(context, { browser: true, assisted: true });
  try {
    printReport(await runtime.cycle(["apply"]), io);
    return 0;
  } finally {
    await runtime.close();
  }
}

export const CHROME_ON_MAC = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

/**
 * Pre-flight: is everything the pipeline depends on in place and answering?
 *
 * Checks the profile and fact bank, then makes one tiny real call of each kind the
 * pipeline makes — a yes/no, a choice and a score to the decision model, a few words from
 * the writing model — so a wrong key or an API that answers in an unexpected shape shows
 * up here rather than in the middle of a cycle. The calls are metered like any other
 * (well under a hundredth of a cent in all). Nothing is fetched, drafted or sent.
 */
export async function check(context: CommandContext): Promise<number> {
  const { config, repo, io } = context;
  const handsFree = !config.pipeline.require_human_review;
  let problems = 0;
  /** `ok === null` is a note: worth knowing, does not stop a run. */
  const line = (ok: boolean | null, what: string, detail = ""): void => {
    if (ok === false) problems += 1;
    io.out(`  [${ok === null ? "note" : ok ? " ok " : "FAIL"}] ${what}${detail ? ` — ${detail}` : ""}`);
  };
  /** Run one live call and report it; a failure is reported, never thrown. */
  const probe = async (what: string, call: () => Promise<string>): Promise<void> => {
    try {
      line(true, what, await call());
    } catch (error) {
      line(false, what, (error instanceof Error ? error.message : String(error)).split("\n")[0]);
    }
  };

  io.out(`Mode: ${describeMode(config)}`);
  io.out("");
  io.out("Profile and fact bank");
  const profile = new ProfileManager(repo, config).initialize();
  const blockers = draftingBlockers(profile);
  for (const blocker of blockers) line(false, blocker);
  for (const issue of ProfileManager.readinessIssues(profile)) {
    // The blockers above already cover a missing name, email or verified achievement.
    if (!blockers.length || issue.area !== "fact_bank") line(null, issue.message);
  }
  if (!blockers.length) line(true, `${verifiedAchievements(profile).length} verified achievement(s) to write from`);
  const notes = config.candidate.screening_notes.trim();
  if (!notes || notes.includes(PLACEHOLDER)) {
    line(null, "No screening notes", "questions about citizenship, work authorization or sponsorship will be held for you to answer");
  }
  const cv = expandHome(config.candidate.resume_path.trim());
  const tuning = config.pipeline.tune_cv && hasWorkHistory(config);
  if (tuning) line(true, "CV tuning", "each application attaches your CV rebuilt and reworded around its listing, read back before it is sent");
  else if (config.pipeline.tune_cv) line(null, "CV tuning is on but has no work history", "list your roles under candidate.experience and each application gets your CV tuned to its listing");
  if (!cv && !tuning) line(null, "No CV of your own set", "applications attach a one-page resume generated from the fact bank instead");
  // With tuning on the file is never attached, so a missing one stops nothing.
  else if (cv && !tuning) line(fs.existsSync(cv), "Your CV", fs.existsSync(cv) ? `${cv} is what applications attach` : `not found at ${cv}`);
  if (!profile.location.includes(",")) {
    line(null, `Location "${profile.location}" names no city`, 'forms that search for one will be left for you; write it as "City, Country"');
  }

  io.out("");
  io.out("Model APIs (live calls)");
  const ledger = new CostLedger(repo, { budget: config.budget });
  if (ledger.isTripped()) {
    line(false, "Daily spend cap", "reached; paid calls are refused until the budget day rolls over");
  } else {
    if (!resolveApiKey(config.jev.api_key_env)) {
      line(handsFree ? false : null, "TypeSafe (Jev) key", handsFree ? "not set; without it nothing past discovery runs unless you review every draft first" : "not set");
    } else {
      const jev = new JevClient(ledger, { config: config.jev });
      await probe("Jev yes/no decision", async () => {
        const decision = await jev.decideBool({ statement: "Two plus two equals four." }, "Is the statement true?", "self_check");
        if (decision.value !== true) throw new Error(`expected true, got ${JSON.stringify(decision.value)}`);
        return `confidence ${decision.confidence.toFixed(2)}`;
      });
      await probe("Jev choice decision", async () => {
        const options = { mammal: "A mammal", bird: "A bird", fish: "A fish" };
        const decision = await jev.decideEnum({ animal: "A dog" }, "What kind of animal is described?", options, "self_check");
        if (decision.value !== "mammal") throw new Error(`expected "mammal", got ${JSON.stringify(decision.value)}`);
        return `confidence ${decision.confidence.toFixed(2)}`;
      });
      await probe("Jev score decision", async () => {
        const levels = ["negative", "neutral", "positive"];
        const decision = await jev.decideScore({ review: "Excellent work, the best I have seen." }, "How positive is the review?", levels, "self_check");
        if (typeof decision.value !== "number" || !Number.isFinite(decision.value)) {
          throw new Error(`expected a level number, got ${JSON.stringify(decision.value)}`);
        }
        return `level ${decision.value} of ${levels.length - 1}`;
      });
    }
    if (!resolveApiKey(config.fireworks.api_key_env)) {
      line(null, "Fireworks key", "not set; pitches are assembled from your verified text instead of written for each job");
    } else {
      const fireworks = new FireworksClient(ledger, { config: config.fireworks });
      await probe(`Fireworks generation (${config.fireworks.model.split("/").pop()})`, async () => {
        const completion = await fireworks.generate("Reply with the single word READY.", { taskType: "self_check", maxTokens: 8, temperature: 0 });
        if (!completion.text.trim()) throw new Error("the model returned no text");
        return `replied "${completion.text.trim().slice(0, 40)}"`;
      });
    }
  }

  io.out("");
  io.out("Browser");
  if (process.platform === "darwin") {
    line(fs.existsSync(CHROME_ON_MAC), "Google Chrome", fs.existsSync(CHROME_ON_MAC) ? "" : "not found in /Applications; forms cannot be read or filled");
  } else {
    line(null, "Google Chrome", "not checked on this platform");
  }

  io.out("");
  io.out(`Spent today: $${ledger.spentToday().toFixed(5)} of $${ledger.capUsd.toFixed(2)}`);
  io.out(problems ? `Not ready: ${plural(problems, "problem")} above.` : "Ready.");
  return problems ? 1 : 0;
}

/** Folder for CVs made by `tune`: looked at or sent by hand, and apart from what each application carried. */
const TUNED_DIR = "~/.reygent/resumes/tuned";
/** Terms on one line of the report. */
const TERMS_PER_LINE = 8;

/** The listing `tune` was pointed at: a file holding a job description, else a tracked listing's id. */
function listingFor(context: CommandContext): JobOpportunity | null {
  const [listing] = context.args;
  const file = expandHome(listing);
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) return context.repo.getJob(listing);
  const description = fs.readFileSync(file, "utf8");
  // A pasted listing usually opens with its title.
  const firstLine = description.split("\n").find((row) => row.trim())?.trim() ?? "";
  return createJob({
    source: "manual", sourceId: createHash("sha1").update(description, "utf8").digest("hex").slice(0, 12),
    company: asText(context.flags.company) ?? "", title: asText(context.flags.title) ?? firstLine.slice(0, 120),
    description,
  });
}

/**
 * Tune the CV to one listing, print it, read it back as a parser would, and say how it
 * lines up: what the listing asks for that is on the page, what is not because the CV
 * does not back it, and what was reworded. Nothing is sent and no application is
 * touched; the file is for the user to look at, or to send themselves.
 */
export async function tune(context: CommandContext): Promise<number> {
  const { config, repo, io, flags } = context;
  if (!hasWorkHistory(config)) {
    io.err("No work history to build a CV from. List your roles under candidate.experience in config.yaml (see config.example.yaml).");
    return 1;
  }
  const job = listingFor(context);
  if (!job) {
    io.err(`'${context.args[0]}' is neither a file holding a job description nor the id of a tracked listing.`);
    return 2;
  }
  const profile = new ProfileManager(repo, config).build();
  const fit = repo.getFit(job.id);
  const positioning = profile.positioning[fit?.bestPositioningProfile ?? ProfileManager.selectPositioning(job)];
  const models = flags["no-model"] !== true;
  const ledger = new CostLedger(repo, { budget: config.budget });
  const generator = models && resolveApiKey(config.fireworks.api_key_env) ? new FireworksClient(ledger, { config: config.fireworks }) : null;
  const decider = models && resolveApiKey(config.jev.api_key_env) ? new JevClient(ledger, { config: config.jev }) : null;
  const folder = expandHome(asText(flags.out) ?? path.join(TUNED_DIR, job.id.replace(/[^\w-]+/g, "_")));
  const outputPath = path.join(folder, resumeFileName(profile));

  const listed = (terms: readonly string[]): void => {
    for (let at = 0; at < terms.length; at += TERMS_PER_LINE) io.out(`    ${terms.slice(at, at + TERMS_PER_LINE).join(", ")}`);
  };
  io.out(`${job.title}${job.company ? ` at ${job.company}` : ""}`);
  try {
    const { match, checks, prepared } = await writeTunedCv({
      config, profile, job, fit: fit ?? { matchedSkills: [], missingSkills: [] }, generator, decider, renderPdf, outputPath,
      fallbackHeadline: positioning?.title,
    });
    io.out(`  CV:        ${outputPath} (${plural(match.pages, "page")})`);
    io.out(`  Headline:  ${match.headline}`);
    io.out("");
    if (!match.asked.length) {
      io.out("  The listing names no skill that could be checked against your CV.");
    } else {
      io.out(`  The listing asks for ${plural(match.asked.length, "term")}. Your CV backs ${match.matched.length}, each now on the page as the listing spells it:`);
      listed(match.matched);
    }
    if (match.missing.length) {
      io.out(`  Not on your CV, so not on the page (${match.missing.length}):`);
      listed(match.missing);
      io.out("  If one of these is true of you, add it to your skills (Profile) or to a verified achievement (Fact bank):");
      io.out("  it is then printed whenever a listing asks for it. Reygent never adds one for you.");
    }

    // What was put in the listing's words: the summary, and each line that reads differently from the fact bank's.
    const own = new Map(
      [...prepared.base.experience.flatMap((role) => role.lines), ...prepared.base.projects.flatMap((project) => project.lines), ...prepared.base.other]
        .map((line) => [line.achievementId, line.text]),
    );
    const reworded = prepared.bullets.filter((bullet) => own.get(bullet.achievementId) !== bullet.text);
    io.out("");
    if (prepared.summary) {
      io.out("  Summary, rewritten for this listing:");
      io.out(`    ${prepared.summary}`);
    } else {
      io.out("  Summary: your own, as written.");
    }
    if (reworded.length) {
      io.out(`  ${plural(reworded.length, "line")} reworded in the listing's words:`);
      for (const bullet of reworded) {
        io.out(`    - ${own.get(bullet.achievementId)}`);
        io.out(`      ${bullet.text}`);
      }
    }
    if (!generator || !decider) {
      const why = !models ? "--no-model" : !generator ? "no Fireworks key" : "no TypeSafe key";
      io.out(`  Nothing a model wrote is on this CV (${why}): rewording needs the writing model to propose it and the decision model to check it.`);
      if (!generator) io.out("  The listing was not read by the writing model either: only its skill list and your own skills were looked for.");
    }

    io.out("");
    io.out("  Read back from the PDF, as an applicant tracking system reads it:");
    for (const check of checks) io.out(`    [${check.ok ? " ok " : "FAIL"}] ${check.name}: ${check.detail}`);
    if (match.problems.length) {
      io.err("The CV does not read back whole, even after a repair. An application carrying it would be held, not sent.");
      return 1;
    }
    return 0;
  } catch (error) {
    if (error instanceof CircuitBreakerError) {
      io.err("The daily spend cap is reached, so the models could not be asked. Run it again with --no-model.");
      return 1;
    }
    if (!(error instanceof CvTuningError)) throw error;
    io.err(`No CV was written: ${error.message}`);
    return 1;
  }
}

/** Where everything stands: jobs by stage, what is waiting on the user, and the last cycle. */
export function status(context: CommandContext): number {
  const { repo, io, config } = context;
  io.out(`Mode: ${describeMode(config)}`);
  const stages = new Map(
    repo.query<{ stage: string; n: number }>("SELECT stage, COUNT(*) AS n FROM jobs GROUP BY stage").map((row) => [row.stage, row.n]),
  );
  io.out("");
  io.out("Jobs by stage:");
  for (const stage of Object.values(PipelineStage)) io.out(`  ${stage.padEnd(16)} ${stages.get(stage) ?? 0}`);
  const held = repo.query<{ n: number }>(
    "SELECT COUNT(*) AS n FROM (SELECT 1 FROM quarantined_items WHERE status = 'pending' GROUP BY job_id, created_at)",
  )[0].n;
  io.out("");
  io.out(`Waiting on you: ${plural(held, "draft")} held by the Cop Tool, ${repo.listDrafts(DraftStatus.NEEDS_ATTENTION).length} to finish in the browser, ${repo.listDrafts(DraftStatus.AWAITING_REVIEW).length} to review`);
  io.out(`Income secured: $${repo.securedMonthlyIncome().toLocaleString("en-US")} of $${config.compensation.monthly_income_goal_usd.toLocaleString("en-US")} a month`);
  const last = repo.getState<CycleReport>(HEARTBEAT_KEY);
  io.out("");
  if (!last) {
    io.out("No cycle has run yet.");
  } else {
    io.out(`Last cycle finished ${new Date(last.finishedAt).toLocaleString()}:`);
    printReport(last, { out: (line) => io.out(`  ${line}`), err: (line) => io.out(`  ${line}`) });
  }
  return 0;
}
