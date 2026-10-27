/**
 * Local browser operator: opens an application form in the user's own Chrome profile,
 * fills what is verifiably known, and either hands the window to the user to finish
 * (assisted) or — when told to and nothing stands in the way — submits it (auto).
 *
 * What it will never do, in either mode: bypass a sign-in, MFA prompt or CAPTCHA,
 * alter browser behavior to bypass a site's checks, type a credential, create an
 * account, answer a question the draft has no vetted answer for, or type an unfilled
 * `CHANGE_ME` placeholder. Those end in a hand-off with the reason spelled out.
 *
 * Calls are serialised: a Chrome profile can only be open once, and `apply` in
 * assisted mode holds the window until the user is done or the hand-off times out.
 */

import fs from "node:fs";
import path from "node:path";
import type { Frame, Locator, Page } from "playwright-core";

import { type AgentRun, type AnswerSheet, type BrowserAgent, type CompleteTools } from "@/core/browser/agent";
import {
  BrowserSession,
  type FormSnapshot,
  asksForEmailedCode,
  awaitConfirmation,
  awaitUploads,
  captureEvidence,
  currentComplaint,
  emptyTypeAhead,
  enterEmailedCode,
  fillField,
  findSubmit,
  holdsValue,
  isWall,
  openCoverLetterBox,
  openForm,
  pressSubmit,
  readDropdowns,
  rescanFields,
  scanPage,
  settle,
  startUrls,
  waitForForm,
} from "@/core/browser/driver";
import {
  CUSTOM_REASON,
  type PlanOptions,
  SENSITIVE_REASON,
  TYPE_AHEAD_REASON,
  placeName,
  planFields,
  questionKey,
} from "@/core/browser/fieldMap";
import type { Blocker, FieldPlan, FillReport, FormField, FormSchema } from "@/core/browser/types";
import { expandHome } from "@/core/config";
import type { FormQuestion } from "@/core/drafting/tailor";
import {
  type ApplicationDraft,
  type CandidateProfile,
  type JobOpportunity,
  PLACEHOLDER,
  type ScreeningAnswer,
  screeningFacts,
} from "@/core/models";
import { notify } from "@/core/notify/macos";
import { provesHuman } from "@/core/orchestrator/questions";

export interface OperatorOptions {
  /** Persistent browser profile (cookies, sessions). Default ~/.reygent/browser_profile/default. */
  profileDir: string;
  /**
   * false (default): fill the form in a visible window and leave Submit to the user.
   * true: also click Submit — only when the page shows no login, MFA or CAPTCHA
   * challenge and no required field is left unfilled.
   */
  autoSubmit?: boolean;
  /** How long to wait for the user to finish a handed-off form before giving the window up. */
  handoffTimeoutMs?: number;
  /** Called when the user is needed (defaults to a macOS notification). */
  notifier?: (message: string) => void;
  /**
   * A code the site emailed after Submit, as the candidate approved it (on the dashboard),
   * or null when they did not; `retry` when the site turned the last one down. Mail and the
   * approval stay outside the operator. Unset: nobody is waiting to approve one, and the
   * application ends at once with `emailedCode` set — nothing went out.
   */
  askForCode?: (job: JobOpportunity, retry: boolean) => Promise<string | null>;
  /**
   * Run `apply` without a window. Default false. Hands-free auto mode is
   * `headless: true` with `autoSubmit: true`. `inspect` is headless either way.
   */
  headless?: boolean;
  /**
   * Whether a person is at the window to finish what the operator may not do; defaults
   * to `!headless`. An unattended run never waits for anyone: a form it cannot complete
   * is handed off at once — and left untouched when that is known before typing.
   * (Tests set this to exercise the hand-off wait without opening a window.)
   */
  attended?: boolean;
  /**
   * false (default): a CAPTCHA that shows nothing and only runs when Submit is pressed
   * (the score-only reCAPTCHA on Greenhouse and Ashby, Lever's invisible hCaptcha) does
   * not stop a submission — the site's own check runs and decides. true: such a check
   * is a blocker like any other CAPTCHA. A visible challenge is a blocker either way.
   */
  strictCaptcha?: boolean;
  /**
   * Where to keep the audit trail of submissions, as full-page screenshots:
   * `<job.id>-form.png` (the filled form, just before the operator presses Submit) and
   * `<job.id>.png` (the confirmation page). Unset: no screenshots.
   */
  evidenceDir?: string;
  /** Browser channel to launch. Default "chrome" — the Google Chrome installed on this Mac. */
  channel?: string;
  /** How long to wait for a form the page renders late (Ashby is all client-side). Default 12 s. */
  formWaitMs?: number;
  /** How long to wait for the confirmation page after pressing Submit. Default 30 s. */
  submitWaitMs?: number;
  /** How long the candidate has to approve an emailed code, as said in reasons. Default 10 min. */
  codeWaitMinutes?: number;
  /** How long to wait for a file still uploading before Submit; past it nothing is pressed. Default 60 s. */
  uploadWaitMs?: number;
  /**
   * The browser agent, for what the fixed patterns cannot do: find the way to a form,
   * fill what they leave, step through a form in parts, find its Submit button. Unset:
   * the patterns alone.
   */
  agent?: BrowserAgent;
  /** Also feed the "Autofill from resume" box (`agent.resume_autofill`). */
  resumeAutofill?: boolean;
  /**
   * Answers, from the candidate's data and by the drafting rules, to questions on the
   * form that the draft holds no answer for (`agent.answer_new_questions`). Unset: such
   * questions are left.
   */
  answerQuestions?: (job: JobOpportunity, draft: ApplicationDraft, questions: FormQuestion[]) => Promise<ScreeningAnswer[]>;
}

export interface Operator {
  /**
   * Read the application form at `job.applyUrl`. Nothing is typed or chosen; custom
   * dropdowns are opened and closed again to read their options.
   */
  inspect(job: JobOpportunity): Promise<FormSchema>;
  /**
   * Open the form, fill the standard fields from verified facts, attach the resume and
   * paste the pitch. Custom questions are left for the user — never guessed. Login,
   * MFA and CAPTCHA are never bypassed: the window is surfaced and the user notified.
   */
  apply(job: JobOpportunity, draft: ApplicationDraft, profile: CandidateProfile): Promise<FillReport>;
  close(): Promise<void>;
}

const DEFAULT_HANDOFF_MS = 15 * 60_000;
const DEFAULT_FORM_WAIT_MS = 12_000;
const DEFAULT_SUBMIT_WAIT_MS = 30_000;
const DEFAULT_UPLOAD_WAIT_MS = 60_000;
const BLOCKER_ORDER: readonly Blocker[] = ["login", "mfa", "captcha"];

/** "15 min", "40 s" — for reasons a person reads. */
const span = (ms: number): string =>
  ms >= 60_000 ? `${Math.round(ms / 60_000)} min` : `${Math.max(1, Math.round(ms / 1000))} s`;

/** Playwright appends a multi-line call log to its messages; the first line says what happened. */
const firstLine = (error: unknown): string => (error instanceof Error ? error.message : String(error)).split("\n")[0];

/** What a wall asks of the user, as a reason. */
function wallNeed(blockers: Blocker[]): string {
  if (blockers.includes("login")) return "Login required";
  if (blockers.includes("mfa")) return "MFA code required";
  return "CAPTCHA before the form";
}

function listLabels(labels: string[]): string {
  const shown = labels.slice(0, 3).join("; ");
  return labels.length > 3 ? `${shown} (+${labels.length - 3} more)` : shown;
}

type Tally = Pick<FillReport, "filled" | "unfilled" | "requiredUnfilled">;

/**
 * Split a plan into what is answered (the fields whose ids are in `done`) and what is
 * left. A question answered through one of its controls counts as answered:
 * Greenhouse's cover letter is a file input and a textarea under one label, and
 * filling either satisfies it.
 */
function tally(plans: FieldPlan[], done: ReadonlySet<string>): Tally {
  const filled = plans.filter((plan) => done.has(plan.field.id)).map((plan) => plan.field.label);
  const answered = new Set(filled);
  const left = plans.filter((plan) => !done.has(plan.field.id) && !answered.has(plan.field.label));
  return {
    filled,
    unfilled: left.map((plan) => plan.field.label),
    requiredUnfilled: left.filter((plan) => plan.field.required).map((plan) => plan.field.label),
  };
}

/**
 * A page that loaded and shows no form and nothing in the way: the form may be a click or
 * a pop-up away. One the server answered with an error, or that says the posting is gone,
 * is not worth a decision.
 */
const needsWayIn = (form: FormSnapshot): boolean =>
  form.fields.length === 0 && form.blockers.length === 0 && !form.gone && (form.status === null || form.status < 400);

/** Two tallies as one: a label filled in either is filled. */
function merge(left: Tally, right: Tally): Tally {
  const filled = [...new Set([...left.filled, ...right.filled])];
  const done = new Set(filled);
  const open = (labels: string[]) => [...new Set(labels)].filter((label) => !done.has(label));
  return {
    filled,
    unfilled: open([...left.unfilled, ...right.unfilled]),
    requiredUnfilled: open([...left.requiredUnfilled, ...right.requiredUnfilled]),
  };
}

const usable = (value: string | undefined): value is string => Boolean(value && value.trim() && !value.includes(PLACEHOLDER));

/**
 * What the agent may type, by key: the candidate's verified details (with the name and the
 * place split the ways forms ask for them), the cover note, and the draft's screening
 * answers as q1, q2, …. And the CV it may attach.
 */
export function answerSheet(profile: CandidateProfile, draft: ApplicationDraft): AnswerSheet {
  const values: Record<string, string> = {};
  const questions: Record<string, string> = {};
  const facts = screeningFacts(profile);
  for (const [key, value] of Object.entries(facts)) if (usable(value)) values[key] = value;
  const names = (facts.name ?? "").trim().split(/\s+/).filter(Boolean);
  if (names.length > 1) {
    values.first_name = names[0];
    values.last_name = names.slice(1).join(" ");
  }
  if (usable(facts.location)) {
    const place = placeName(facts.location);
    const parts = place.split(",").map((part) => part.trim()).filter(Boolean);
    if (place) values.location = place;
    if (parts.length > 1) values.city = parts[0];
    if (parts.length > 0) values.country = parts[parts.length - 1];
  }
  if (usable(draft.pitch)) values.pitch = draft.pitch;
  draft.screeningAnswers.forEach((item, index) => {
    if (!usable(item.answer)) return;
    values[`q${index + 1}`] = item.answer;
    questions[`q${index + 1}`] = item.question;
  });
  return { values, questions, resume: usable(draft.resumePdfPath) ? draft.resumePdfPath : null };
}

/** The ids a plan means to fill. */
const plannedIds = (plans: FieldPlan[]): Set<string> =>
  new Set(plans.filter((plan) => plan.action !== "leave").map((plan) => plan.field.id));

/** Why Submit must not be pressed on a form in this state, or null when it may be. */
function submitObstacle(report: FillReport, autoSubmit: boolean): string | null {
  if (report.blockers.length > 0) return report.blockers.includes("captcha") ? "CAPTCHA on the form" : wallNeed(report.blockers);
  if (report.requiredUnfilled.length > 0) return `Required question not answered: ${listLabels(report.requiredUnfilled)}`;
  if (report.filled.length === 0) return "Nothing on the form could be filled";
  if (!autoSubmit) return "Filled in for your review";
  return null;
}

/** The operator behind `createOperator`. */
export class ChromeOperator implements Operator {
  /** The browser behind the operator — the forms handed to the user are among `session.pages()`. */
  readonly session: BrowserSession;
  private readonly options: OperatorOptions;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(options: OperatorOptions) {
    this.options = options;
    this.session = new BrowserSession(expandHome(options.profileDir), options.channel ?? "chrome");
  }

  /** Run `work` after everything queued before it, whether or not that succeeded. */
  private serial<T>(work: () => Promise<T>): Promise<T> {
    const run = this.queue.then(work, work);
    this.queue = run.catch(() => undefined);
    return run;
  }

  /**
   * What stops the operator on a page in this state. With `strictCaptcha` a passive
   * check counts as a CAPTCHA blocker; otherwise only a challenge does.
   */
  private blockersOf(seen: Pick<FormSnapshot, "blockers" | "passiveCaptcha">): Blocker[] {
    const strict = this.options.strictCaptcha === true && seen.passiveCaptcha;
    return BLOCKER_ORDER.filter((blocker) => seen.blockers.includes(blocker) || (strict && blocker === "captcha"));
  }

  private get planOptions(): PlanOptions {
    return { resumeAutofill: this.options.resumeAutofill === true };
  }

  /**
   * Make a form ready to plan and plan it: read its custom dropdowns, open the cover
   * letter box when there is a note to paste, and answer — from the candidate's data, by
   * the drafting rules — the questions the draft holds no answer for.
   */
  private async prepare(
    page: Page,
    found: FormSnapshot,
    job: JobOpportunity,
    draft: ApplicationDraft,
    profile: CandidateProfile,
  ): Promise<{ form: FormSnapshot; plans: FieldPlan[]; draft: ApplicationDraft; answered: ScreeningAnswer[] }> {
    let form = found;
    // Reading, not writing: each custom dropdown is opened, read and closed again,
    // so the plan knows the choices it has.
    const read = await readDropdowns(page, form.frame);
    if (read.length > 0) form = { ...form, fields: read };
    const hasPitch = draft.pitch.trim() !== "" && !draft.pitch.includes(PLACEHOLDER);
    if (hasPitch && (await openCoverLetterBox(form.frame))) {
      const reread = await rescanFields(form.frame);
      if (reread.length > 0) form = { ...form, fields: reread };
    }
    let plans = planFields(form.fields, profile, draft, this.planOptions);
    const answered = await this.answerNew(job, draft, plans);
    if (answered.length > 0) {
      draft = { ...draft, screeningAnswers: [...draft.screeningAnswers, ...answered] };
      plans = planFields(form.fields, profile, draft, this.planOptions);
    }
    return { form, plans, draft, answered };
  }

  /** Answers to the questions a plan leaves that the draft was never asked: those on a later step, or revealed by a choice. */
  private async answerNew(job: JobOpportunity, draft: ApplicationDraft, plans: FieldPlan[]): Promise<ScreeningAnswer[]> {
    const answer = this.options.answerQuestions;
    if (!answer) return [];
    const known = new Set(draft.screeningAnswers.map((item) => questionKey(item.question)));
    const questions: FormQuestion[] = [];
    for (const plan of plans) {
      if (plan.action !== "leave" || plan.field.type === "file" || !plan.field.label) continue;
      if (plan.reason !== CUSTOM_REASON && plan.reason !== SENSITIVE_REASON && plan.reason !== TYPE_AHEAD_REASON) continue;
      const key = questionKey(plan.field.label);
      // A check that the applicant is a person is never answered, however it is worded.
      if (known.has(key) || provesHuman(plan.field.label)) continue;
      known.add(key);
      const { field } = plan;
      questions.push({
        question: field.label,
        kind: field.options.length > 0 ? "choice" : "text",
        options: field.options,
        required: field.required,
        sensitive: plan.reason === SENSITIVE_REASON,
        short: field.options.length === 0 && field.type !== "textarea",
      });
    }
    if (questions.length === 0) return [];
    try {
      return (await answer(job, draft, questions)).filter((item) => item.answer.trim() !== "");
    } catch {
      // Unanswered, they are left like any question without an answer.
      return [];
    }
  }

  inspect(job: JobOpportunity): Promise<FormSchema> {
    return this.serial(async () => {
      if (!/^https?:\/\//i.test(job.applyUrl)) throw new Error(`Not a web address: "${job.applyUrl}"`);
      let page = await this.session.newPage(true);
      try {
        let form = await openForm(page, job.applyUrl, this.options.formWaitMs ?? DEFAULT_FORM_WAIT_MS);
        if (this.options.agent && needsWayIn(form)) {
          // Pressing Apply, closing a pop-up or a cookie banner: nothing is typed on the way.
          const reached = await this.options.agent.start(job).reach(page);
          page = reached.page;
          if (reached.form) form = reached.form;
        }
        // Dropdown options are part of the schema; reading them opens and closes each one.
        const read = form.fields.length > 0 ? await readDropdowns(page, form.frame) : [];
        return {
          url: form.url,
          fields: read.length > 0 ? read : form.fields,
          blockers: this.blockersOf(form),
          passiveCaptcha: form.passiveCaptcha,
        };
      } catch (error) {
        throw new Error(firstLine(error));
      } finally {
        await this.session.release(page);
      }
    });
  }

  apply(job: JobOpportunity, draft: ApplicationDraft, profile: CandidateProfile): Promise<FillReport> {
    return this.serial(() => this.run(job, draft, profile));
  }

  async close(): Promise<void> {
    // Not queued: closing must also release an `apply` that is waiting on the user.
    await this.session.close();
  }

  private async run(job: JobOpportunity, draft: ApplicationDraft, profile: CandidateProfile): Promise<FillReport> {
    const report: FillReport = { status: "failed", reason: "", filled: [], unfilled: [], blockers: [], requiredUnfilled: [] };
    const headless = this.options.headless ?? false;
    const attended = this.options.attended ?? !headless;
    const autoSubmit = this.options.autoSubmit ?? false;
    const handoffMs = this.options.handoffTimeoutMs ?? DEFAULT_HANDOFF_MS;
    const formWaitMs = this.options.formWaitMs ?? DEFAULT_FORM_WAIT_MS;
    const who = `${job.company} — ${job.title}`;
    /** Notify the user. A notifier that throws must not cost them the application. */
    const tell = (message: string): void => {
      try {
        (this.options.notifier ?? notify)(message);
      } catch {
        // Nothing useful to do: the report carries the same information.
      }
    };

    // One agent run per application: its steps and spend are this application's.
    const agent: AgentRun | null = this.options.agent?.start(job) ?? null;
    /** What the agent did and spent, on the report. */
    const stamp = (): void => {
      if (!agent || agent.steps === 0) return;
      report.agentTrail = [...agent.trail];
      report.agentUsd = agent.spentUsd;
    };
    const end = (status: FillReport["status"], reason: string): FillReport => {
      stamp();
      return { ...report, status, reason };
    };
    /** Hand off with nobody at the window: say why, now, instead of waiting. */
    const giveUp = (reason: string): FillReport => {
      tell(`${who} needs you: ${reason}`);
      return end("handed_off", reason);
    };
    const see = (seen: Pick<FormSnapshot, "blockers" | "passiveCaptcha">): void => {
      report.blockers = this.blockersOf(seen);
      report.passiveCaptcha = seen.passiveCaptcha;
    };

    if (!/^https?:\/\//i.test(job.applyUrl)) return end("failed", "This job has no web application address");

    let page: Page;
    try {
      page = await this.session.newPage(headless);
    } catch (error) {
      return end("failed", `Chrome could not be started: ${firstLine(error)}`);
    }

    // A form the user is still looking at stays open; everything else is tidied away.
    let keepOpen = false;
    const submitted = async (): Promise<FillReport> => {
      stamp();
      const result = await this.confirmed(page, job, report);
      if (attended) {
        // The confirmation stays up until the next job opens.
        keepOpen = true;
        this.session.linger(page);
      }
      return result;
    };
    try {
      let form = await openForm(page, job.applyUrl, formWaitMs);
      // A posting whose form the patterns cannot open — an Apply button worded another
      // way, a pop-up in front of it, a form in a new tab: the agent finds the way in.
      let notReached = "";
      if (agent && needsWayIn(form)) {
        const reached = await agent.reach(page);
        page = reached.page;
        if (reached.form) form = reached.form;
        notReached = reached.reason;
      }
      see(form);

      if (isWall(form)) {
        const need = wallNeed(form.blockers);
        if (!attended) return giveUp(need);
        await page.bringToFront().catch(() => undefined);
        const what = form.blockers.includes("login") || form.blockers.includes("mfa") ? "Sign-in" : "A human check is";
        tell(`${what} needed for ${job.company} — finish it in Chrome and the form will be filled`);
        const arrived = await waitForForm(page, job.applyUrl, handoffMs, formWaitMs);
        if (arrived === "closed") return end("handed_off", `${need} — the window was closed before the form appeared`);
        if (arrived === "timeout") {
          keepOpen = true;
          return end("handed_off", `${need} — the form did not appear within ${span(handoffMs)}`);
        }
        form = arrived;
        see(form);
      }

      if (form.fields.length === 0) {
        if (form.gone) return end("failed", `The posting is not there: the page says "${form.gone}"`);
        const http = form.status !== null && form.status >= 400 ? ` (HTTP ${form.status})` : "";
        return end("failed", `No application form found at ${form.url}${http}${notReached ? `: ${notReached}` : ""}`);
      }

      // With nobody at the window, a form that cannot be submitted is not typed into
      // at all: the outcome is already known, and the employer's page should not be
      // left half-filled for it (Ashby saves every value to its server as it is
      // typed). `unfilled` then lists what the plan leaves for the user — what they
      // will be asked when they run it assisted.
      const untouched = (plans: FieldPlan[], reason: string): FillReport => {
        Object.assign(report, tally(plans, plannedIds(plans)), { filled: [] });
        return giveUp(reason);
      };
      if (!attended && report.blockers.length > 0) {
        return untouched(planFields(form.fields, profile, draft, this.planOptions), "CAPTCHA on the form");
      }
      if (!attended && !autoSubmit) {
        return untouched(
          planFields(form.fields, profile, draft, this.planOptions),
          "Not submitted — auto-submit is off and nobody is at the window",
        );
      }

      const prepared = await this.prepare(page, form, job, draft, profile);
      form = prepared.form;
      let current = prepared.draft;
      const answered: ScreeningAnswer[] = [...prepared.answered];
      const plans = prepared.plans;

      // Without the agent, nothing more can be done for a form the plan cannot finish. With
      // it, what the plan leaves is the agent's to try: a field the patterns did not
      // recognise, a Submit button they do not know, a form in steps.
      if (!attended && !agent) {
        const missing = tally(plans, plannedIds(plans)).requiredUnfilled;
        if (missing.length > 0) return untouched(plans, `Required question not answered: ${listLabels(missing)}`);
        if (!(await findSubmit(form.frame))) return untouched(plans, "No Submit button recognised on the form");
      }

      let formUrls = startUrls(page, form.frame);
      const tried = new Set(plans.map((plan) => plan.field.id));
      const outcome = await this.fill(page, form.frame, plans, profile, current, !attended && !agent);
      let totals = outcome.tally;
      Object.assign(report, totals);
      if (outcome.stopped) {
        // A required type-ahead found no suggestion to pick; nothing else was typed.
        report.filled = [];
        return giveUp(`Required question not answered: ${listLabels(report.requiredUnfilled)}`);
      }

      let submitTarget: Locator | undefined;
      let agentStopped: string | null = null;
      if (agent && (report.requiredUnfilled.length > 0 || !(await findSubmit(form.frame)))) {
        const sheet = answerSheet(profile, current);
        const tools: CompleteTools = {
          sheet,
          // Each new step of the form is planned and filled the usual way first; the agent
          // only decides what that leaves.
          fillNew: async (at, step) => {
            if (step.fields.every((field) => tried.has(field.id))) return;
            const next = await this.prepare(at, step, job, current, profile);
            current = next.draft;
            answered.push(...next.answered);
            if (next.answered.length > 0) Object.assign(sheet, answerSheet(profile, current));
            const before = new Set(tried);
            const fresh = next.plans.filter((plan) => !before.has(plan.field.id));
            for (const field of next.form.fields) tried.add(field.id);
            const done = await this.fill(at, next.form.frame, fresh, profile, current, false, before);
            totals = merge(totals, done.tally);
          },
          record: (field: FormField, filled: boolean) => {
            const label = [field.label];
            totals = merge(
              totals,
              filled ? { filled: label, unfilled: [], requiredUnfilled: [] } : { filled: [], unfilled: label, requiredUnfilled: field.required ? label : [] },
            );
          },
        };
        const done = await agent.complete(page, form, tools);
        page = done.page;
        form = done.form;
        Object.assign(report, totals);
        if (done.kind === "ready") {
          submitTarget = done.submit ?? undefined;
          report.requiredUnfilled = [];
        } else if (done.kind === "stopped") {
          agentStopped = done.reason;
          if (done.missing.length > 0) report.requiredUnfilled = done.missing;
        }
        formUrls = [...new Set([...formUrls, ...startUrls(page, form.frame)])];
      }
      if (answered.length > 0) report.answered = answered;

      // A CAPTCHA widget can load late, so look again before deciding anything about Submit.
      const after = await scanPage(page).catch(() => null);
      if (after) {
        see({
          blockers: BLOCKER_ORDER.filter((blocker) => form.blockers.includes(blocker) || after.blockers.includes(blocker)),
          passiveCaptcha: form.passiveCaptcha || after.passiveCaptcha,
        });
      }

      // The site's own obstacles first; then why the agent stopped, when it did.
      let why =
        report.blockers.length > 0 || report.requiredUnfilled.length > 0 || agentStopped === null
          ? submitObstacle(report, autoSubmit)
          : agentStopped;
      let pressed = false;
      if (why === null && !(await awaitUploads(form.frame, this.options.uploadWaitMs ?? DEFAULT_UPLOAD_WAIT_MS))) {
        // Nothing is pressed over a stalled upload: the form would only come back asking for
        // the file. Nothing was sent, so the application can simply be tried again.
        return end("failed", `Not submitted: the CV upload did not finish within ${span(this.options.uploadWaitMs ?? DEFAULT_UPLOAD_WAIT_MS)}`);
      }
      if (why === null) {
        const complaint = await currentComplaint(page, form.frame);
        // What goes out, as it goes out: nobody is watching a hands-free submission.
        const formShot = await this.evidence(page, `${job.id}-form`);
        if (formShot) report.formEvidencePath = formShot;
        if (!(await pressSubmit(form.frame, submitTarget))) {
          why = "No Submit button recognised on the form";
        } else {
          pressed = true;
          report.pressed = true;
          const submitWaitMs = this.options.submitWaitMs ?? DEFAULT_SUBMIT_WAIT_MS;
          let verdict = await awaitConfirmation(page, form.frame, formUrls, submitWaitMs, { complaint });
          // Nothing came of it: a pop-up may be asking to confirm the submission.
          if (verdict.outcome === "timeout" && agent && (await agent.confirm(page))) {
            verdict = await awaitConfirmation(page, form.frame, formUrls, submitWaitMs, { complaint });
          }
          if (verdict.outcome === "confirmed") return await submitted();
          if (verdict.outcome === "closed") {
            return end("handed_off", "Submit was pressed and the window closed before a confirmation — check before re-applying");
          }
          // The application may or may not have gone through: keep what the page shows.
          const shot = await this.evidence(page, `${job.id}-unconfirmed`);
          if (shot) report.evidencePath = shot;
          if (verdict.outcome === "challenged") {
            report.blockers = BLOCKER_ORDER.filter((blocker) => report.blockers.includes(blocker) || blocker === "captcha");
            if (verdict.detail === "emailed") {
              // The site has not taken it: its page asks for the code before it does.
              report.pressed = false;
              report.emailedCode = true;
              why = "Not submitted: after Submit the site emailed you a code to confirm a person is applying";
              // Only a code the candidate approved is typed. Without anyone to approve one,
              // the application is held for them.
              for (let attempt = 0; this.options.askForCode && attempt < 2; attempt += 1) {
                const code = await this.options.askForCode(job, attempt > 0);
                if (!code) {
                  why = `Not submitted: no emailed code was approved within ${this.options.codeWaitMinutes ?? 10} minutes`;
                  break;
                }
                if (!(await enterEmailedCode(form.frame, code))) {
                  why = "Not submitted: the emailed-code field or its verify button could not be recognised";
                  break;
                }
                // Only a confirmation counts: the code prompt can stay on screen while it is checked.
                const afterCode = await awaitConfirmation(page, form.frame, formUrls, submitWaitMs);
                if (afterCode.outcome === "confirmed") return await submitted();
                if (afterCode.outcome === "closed") return end("handed_off", "The form was closed while the emailed code was being checked");
                const said = await currentComplaint(page, form.frame);
                if (/\bcode\b/i.test(said) && /invalid|incorrect|expired|wrong|not valid/i.test(said)) {
                  why = "Not submitted: the site turned down the emailed code";
                  continue;
                }
                if (await asksForEmailedCode(page, form.frame)) {
                  why = "Not submitted: the site still asks for its emailed code";
                  break;
                }
                // The prompt is gone and no confirmation took its place: it may well have gone through.
                report.pressed = true;
                report.emailedCode = false;
                why = "The emailed code was entered but no confirmation page appeared — check before re-applying";
                break;
              }
            } else {
              // The site's own check asked for a person. It is theirs to answer.
              why = "Not submitted: a CAPTCHA challenge came up after Submit";
            }
          } else if (verdict.outcome === "refused") {
            why = `The site refused the submission: "${verdict.detail}"`;
          } else if (verdict.outcome === "invalid") {
            why = `Not submitted: the site asked for corrections: "${verdict.detail}"`;
            if (!attended) {
              // The form itself said it did not take the application: nothing went out, and
              // a field that did not hold this time (an upload that stalled) may next time.
              report.pressed = false;
              return end("failed", why);
            }
          } else {
            why = "Submit was pressed but no confirmation page appeared — check before re-applying";
          }
        }
      }

      if (!attended) return giveUp(why ?? "The application could not be completed");

      await page.bringToFront().catch(() => undefined);
      const left = report.unfilled.length;
      const tail = left > 0 ? ` ${left} question${left === 1 ? " is" : "s are"} left for you.` : "";
      if (pressed) tell(`${who}: ${why}. Have a look in Chrome.`);
      else tell(`${who} is filled in. Review it in Chrome and press Submit.${tail}`);
      const verdict = await awaitConfirmation(page, form.frame, formUrls, handoffMs);
      if (verdict.outcome === "confirmed") return await submitted();
      if (verdict.outcome === "closed") return end("handed_off", `${why} — the window was closed before a confirmation appeared`);
      keepOpen = true;
      return end("handed_off", `${why} — left open in Chrome, no confirmation within ${span(handoffMs)}`);
    } catch (error) {
      return end("failed", firstLine(error));
    } finally {
      if (!keepOpen) await this.session.release(page);
    }
  }

  /**
   * Carry out the plan and report which fields hold their value afterwards.
   *
   * Order matters. A type-ahead goes first, because whether it can be answered is only
   * known once it has been tried — and with `stopOnMiss` (nobody at the window) a
   * required one that finds no suggestion ends the run before anything else is typed.
   * The resume goes next: Lever and Ashby parse it and write what they read into the
   * name, email, location and link fields, so those are typed (and the type-ahead
   * picked again) afterwards — and everything is checked once more at the end, in
   * case the parser was slow.
   */
  private async fill(
    page: Page,
    frame: Frame,
    initial: FieldPlan[],
    profile: CandidateProfile,
    draft: ApplicationDraft,
    stopOnMiss: boolean,
    /** Fields an earlier step already filled: not touched again when the form is re-read. */
    skip: ReadonlySet<string> = new Set(),
  ): Promise<{ tally: Tally; stopped: boolean }> {
    let plans = initial;
    const done = new Set<string>();

    for (const plan of plans) {
      if (plan.action !== "pick") continue;
      if (await fillField(page, frame, plan)) done.add(plan.field.id);
      else if (stopOnMiss && plan.field.required) {
        // Report what a complete run would have left, plus this one.
        const others = plannedIds(plans);
        others.delete(plan.field.id);
        return { tally: tally(plans, others), stopped: true };
      }
    }

    const attached = new Set<string>();
    const uploads = plans.filter((plan) => plan.action === "upload");
    for (const plan of uploads) {
      if (await fillField(page, frame, plan)) {
        done.add(plan.field.id);
        attached.add(plan.field.label);
      }
    }
    if (uploads.length > 0) {
      await settle(page);
      // An upload widget may rebuild itself (and the form around it); read the form
      // again so the remaining fields are found by their current stamps.
      const reread = await rescanFields(frame);
      if (reread.length > 0) plans = planFields(reread, profile, draft, this.planOptions).filter((plan) => !skip.has(plan.field.id));
      // Lever's parser has by now written the location it read from the resume into
      // the location box or its hidden half, whatever was picked there. A pick that
      // no longer holds is made again; one that does is left alone — on Ashby every
      // pick is a save, and there is no reason to send the same one twice. A box
      // that could not be answered is emptied of whatever the parser guessed.
      for (const plan of plans) {
        if (plan.action !== "pick") continue;
        if (!done.has(plan.field.id)) await emptyTypeAhead(frame, plan);
        else if (!(await holdsValue(frame, plan)) && !(await fillField(page, frame, plan))) done.delete(plan.field.id);
      }
    }

    for (const plan of plans) {
      if (plan.action === "upload") {
        // Never attached twice: a rebuilt input under the same label is the same question.
        if (attached.has(plan.field.label)) done.add(plan.field.id);
      } else if (plan.action !== "leave" && plan.action !== "pick" && (await fillField(page, frame, plan))) {
        done.add(plan.field.id);
      }
    }

    for (const plan of plans) {
      if (!done.has(plan.field.id) || (await holdsValue(frame, plan))) continue;
      if (!(await fillField(page, frame, plan))) done.delete(plan.field.id);
    }
    return { tally: tally(plans, done), stopped: false };
  }

  private async confirmed(page: Page, job: JobOpportunity, report: FillReport): Promise<FillReport> {
    const result: FillReport = { ...report, status: "submitted", reason: "" };
    // Replaces any "unconfirmed" shot taken while the confirmation was still loading.
    const shot = await this.evidence(page, job.id);
    if (shot) result.evidencePath = shot;
    else delete result.evidencePath;
    return result;
  }

  /** Screenshot the page into `evidenceDir`, if one is configured. Never fails the application. */
  private async evidence(page: Page, name: string): Promise<string | undefined> {
    if (!this.options.evidenceDir) return undefined;
    try {
      const directory = path.resolve(expandHome(this.options.evidenceDir));
      fs.mkdirSync(directory, { recursive: true });
      const file = path.join(directory, `${name.replace(/[^A-Za-z0-9._-]+/g, "_")}.png`);
      return (await captureEvidence(page, file)) ?? undefined;
    } catch {
      return undefined;
    }
  }
}

export function createOperator(options: OperatorOptions): Operator {
  return new ChromeOperator(options);
}
