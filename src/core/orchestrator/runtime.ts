/**
 * Wires the real implementations into the pipeline: API clients (when their keys are
 * set), the Cop Tool, discovery, the resume renderer and — only when asked — the browser.
 */

import { createAgent } from "@/core/browser/agent";
import type { Operator, OperatorOptions } from "@/core/browser/operator";
import { type Config, expandHome } from "@/core/config";
import { type AnswerVerifier, CopInspector, fireworksRewriter } from "@/core/cop/inspector";
import type { Repository } from "@/core/db/repository";
import { discover } from "@/core/discovery";
import { type BoardRef, BOARD_PROVIDERS, BOARD_SETTINGS } from "@/core/discovery/boards";
import { createBoardFinder, createEmployerLookup } from "@/core/discovery/employer";
import { loadMemory } from "@/core/discovery/state";
import { createContactFinder } from "@/core/mail/contacts";
import { inboxReaders } from "@/core/mail/inbox";
import { mailerFor } from "@/core/mail/mailer";
import { renderPdf } from "@/core/drafting/resume";
import { type DraftingContext, answerOnTheWay, candidateDataFor } from "@/core/drafting/tailor";
import { FireworksClient } from "@/core/llm/fireworks";
import { JevClient } from "@/core/llm/jev";
import { CostLedger } from "@/core/llm/ledger";
import type { Decider } from "@/core/llm/types";
import type { CandidateProfile, JobOpportunity } from "@/core/models";
import { notify } from "@/core/notify/macos";
import { type CodeSession, codeApprover, readyJobs, runWhenReady } from "@/core/orchestrator/codeHold";
import { type Applier, type CycleReport, type PipelineDeps, type Step, STEPS, runCycle } from "@/core/orchestrator/pipeline";
import { ProfileManager } from "@/core/profile/manager";
import { resolveApiKey } from "@/core/secrets";

/** Where screenshots of confirmation pages are kept — the audit trail of hands-free submissions. */
export const EVIDENCE_DIR = "~/.reygent/evidence";

// Worded as the drafting step's own check is: tried on true and false answers, the decision
// model then took a denied skill the CV lacks as true and still refused claims the data lacks.
const VERIFY_INSTRUCTIONS =
  "Is this answer true of the candidate, going by the candidate data and what follows plainly from it?" +
  " A skill, tool, credential or kind of experience that the data does not show is one the candidate does not" +
  " have, so an answer denying it is true. Answer no when the answer claims something the data does not show," +
  " or when the data points to a different option.";

export interface RuntimeOptions {
  /**
   * Keep a browser available, to read application forms while drafting and to apply.
   * Off by default: only `cycle`, `run` and `assist` drive Chrome — never the web console.
   */
  browser?: boolean;
  /**
   * Fill forms in a visible window and leave Submit to the user, whatever the config says.
   * Used by `assist` to finish applications the hands-free run handed off.
   */
  assisted?: boolean;
  log?: (line: string) => void;
}

/**
 * The Cop Tool's independent check of an AI-written answer: a second, differently
 * framed question to the decision model, over exactly the data the answer was written from.
 */
export function answerVerifier(
  decider: Decider,
  profile: CandidateProfile,
  config: Config,
  answeredByCandidate: ReadonlyArray<{ question: string; answer: string }> = [],
): AnswerVerifier {
  // What the candidate typed for earlier questions is candidate data too. Answers the AI
  // wrote are left out: an earlier guess must never become the evidence for the next one.
  const candidate = { ...candidateDataFor(profile, config), answered_before: answeredByCandidate };
  return async (question, answer, options) => {
    const decision = await decider.decideBool({ candidate, question, options, answer }, VERIFY_INSTRUCTIONS, "answer_verification");
    return { supported: decision.value === true, confidence: decision.confidence };
  };
}

/** What the operator borrows from the cycle: the browser agent and the drafting rules' answers. */
type AgentKit = Pick<OperatorOptions, "agent" | "answerQuestions" | "resumeAutofill">;

/**
 * The browser agent, decided with the writing model, and the answers it may use for
 * questions the draft never saw — or nothing, when `agent.enabled` is off or no Fireworks
 * key is set (the fixed patterns then work alone).
 */
function agentKit(deps: PipelineDeps): AgentKit {
  const { config, generator, repo } = deps;
  const kit: AgentKit = { resumeAutofill: config.agent.resume_autofill };
  if (!config.agent.enabled || !generator) return kit;
  kit.agent = createAgent(generator, { settings: config.agent, log: deps.log });
  if (config.agent.answer_new_questions && deps.inspector instanceof CopInspector) {
    const checker = deps.inspector;
    const context: DraftingContext = {
      repo, config, profile: new ProfileManager(repo, config).build(), generator, decider: deps.decider,
      inspector: deps.inspector, renderPdf: deps.renderPdf, resumeDir: deps.resumeDir,
      standingAnswer: (question) => repo.getStandingAnswer(question)?.answer ?? null,
    };
    kit.answerQuestions = (job, draft, questions) => answerOnTheWay(context, checker, job, draft, questions);
  }
  return kit;
}

/** A browser that opens on first use — so a cycle with no form to read never launches Chrome. */
function lazyApplier(config: Config, assisted: boolean, kit: () => AgentKit = () => ({})): Applier & { close(): Promise<void> } {
  let operator: Operator | null = null;
  const open = async (): Promise<Operator> => {
    if (!operator) {
      // Loaded on demand: the web console builds this module too and must never pull in a browser.
      const { createOperator } = await import("@/core/browser/operator");
      const handsFree = config.pipeline.auto_submit && !assisted;
      operator = createOperator({
        profileDir: expandHome(config.browser_profile_dir),
        autoSubmit: handsFree,
        headless: handsFree,
        strictCaptcha: config.pipeline.stop_at_invisible_captcha,
        // No `askForCode`: a cycle never waits for an emailed code. Such an application is
        // held for the candidate, who finishes it from the dashboard (see `codeRuns`).
        // The console reads screenshots from the same place, override included.
        evidenceDir: expandHome(process.env.REYGENT_EVIDENCE_DIR || EVIDENCE_DIR),
        // Unattended, the cycle reports what is waiting once at its end; a visible window
        // still announces itself, because someone has to come and press Submit.
        notifier: handsFree ? () => {} : undefined,
        ...kit(),
      });
    }
    return operator;
  };
  return {
    inspect: async (job) => (await open()).inspect(job),
    apply: async (job, draft, profile) => (await open()).apply(job, draft, profile),
    async close() {
      await operator?.close();
      operator = null;
    },
  };
}

/** Every company board Reygent knows by name: those in the config and those found through listings. */
function knownBoards(config: Config, repo: Repository): BoardRef[] {
  const configured = BOARD_PROVIDERS.flatMap((provider) =>
    config.discovery[BOARD_SETTINGS[provider]].map((token): BoardRef => ({ provider, token })),
  );
  return [...configured, ...Object.values(loadMemory(repo).boards).map(({ provider, token }) => ({ provider, token }))];
}

/**
 * Build the pipeline's dependencies from the current config.
 *
 * Rebuilt for every cycle so that edits to config.yaml, the fact bank, the remembered
 * answers or the API keys take effect without restarting anything.
 */
export function createPipelineDeps(config: Config, repo: Repository, applier: Applier | null, options: RuntimeOptions = {}): PipelineDeps {
  const ledger = new CostLedger(repo, { budget: config.budget });
  const decider = resolveApiKey(config.jev.api_key_env) ? new JevClient(ledger, { config: config.jev }) : null;
  const generator = resolveApiKey(config.fireworks.api_key_env)
    ? new FireworksClient(ledger, { config: config.fireworks })
    : null;
  const profile = new ProfileManager(repo, config).build();
  const candidateData = candidateDataFor(profile, config);
  const typedByUser = repo
    .listStandingAnswers()
    .filter((remembered) => remembered.source === "user")
    .map(({ question, answer }) => ({ question, answer }));
  const inspector = new CopInspector(repo, {
    policy: config.cop,
    compensation: config.compensation,
    rewriter: generator ? fireworksRewriter(generator, profile) : undefined,
    standingAnswer: (question) => repo.getStandingAnswer(question)?.answer ?? null,
    verifyAnswer: decider ? answerVerifier(decider, profile, config, typedByUser) : undefined,
    answerConfidence: config.pipeline.answer_confidence,
    // The user's screening notes are facts as much as the fact bank is: an answer drawn
    // from them must not be flagged as ungrounded.
    extraFacts: candidateData.notes,
  });
  return {
    repo, config, decider, generator, inspector, applier, renderPdf, log: options.log,
    attended: options.assisted ?? false,
    notify: applier && !options.assisted ? notify : undefined,
    // Listings already tracked are dropped before the per-cycle cap, so a large board is
    // worked through over successive cycles instead of returning the same first page forever.
    // The repository is also discovery's memory: when each source was last read (their terms
    // set how often that may be) and the company boards found through listings. Without it
    // both would be forgotten at every restart.
    discover: () =>
      discover(config.discovery, { log: options.log, state: repo, isKnown: (job) => repo.findTrackedJobId(job) !== null }),
    // Following a listing to its employer's board covers both ways of getting there: by
    // the link in its text, and by the company's name.
    findEmployerListing: config.discovery.follow_board_links
      ? createEmployerLookup({ known: knownBoards(config, repo) })
      : undefined,
    findBoards: config.discovery.follow_board_links ? createBoardFinder({ known: knownBoards(config, repo) }) : undefined,
    // The candidate's mailbox, once its app password is stored: applications sent by email and the notes after a run.
    mailer: config.email.send_applications || config.email.notify ? mailerFor(config) : null,
    findContact: config.email.find_contacts ? createContactFinder() : undefined,
    // The candidate's inboxes whose app passwords are stored, read for what came of each application.
    inboxes: inboxReaders(config),
  };
}

/** One application finished from the dashboard: what it was, and how it went. */
export interface CodeRun {
  job: Pick<JobOpportunity, "company" | "title">;
  session: CodeSession;
}

export interface Runtime {
  /** Run one cycle against the config as it is right now. */
  cycle(steps?: readonly Step[]): Promise<CycleReport>;
  /**
   * Apply again for each application the candidate pressed "I'm ready" on, one at a time,
   * typing a code the site emails only once they approve it. Needs `browser`.
   */
  codeRuns(): Promise<CodeRun[]>;
  close(): Promise<void>;
}

export function createRuntime(loadCurrentConfig: () => Config, repo: Repository, options: RuntimeOptions = {}): Runtime {
  let applier: ReturnType<typeof lazyApplier> | null = null;
  return {
    async cycle(steps = STEPS) {
      const config = loadCurrentConfig();
      // A browser per cycle, bound to the settings as they are now, and closed when the
      // cycle ends: a Chrome profile can be open only once, and `assist` needs it while
      // the daemon sleeps.
      let kit: AgentKit = {};
      applier = options.browser ? lazyApplier(config, options.assisted ?? false, () => kit) : null;
      try {
        const deps = createPipelineDeps(config, repo, applier, options);
        kit = agentKit(deps);
        return await runCycle(deps, steps);
      } finally {
        await applier?.close();
        applier = null;
      }
    },
    async codeRuns() {
      const done: CodeRun[] = [];
      if (!options.browser || !readyJobs(repo).length) return done;
      const config = loadCurrentConfig();
      const { createOperator } = await import("@/core/browser/operator");
      // Its own browser, closed again at the end: the cycle's is closed between cycles, and
      // the profile can be open only once. It submits by itself: the candidate asked for
      // this one, and the code it waits on is theirs to approve.
      const operator = createOperator({
        profileDir: expandHome(config.browser_profile_dir),
        autoSubmit: true,
        headless: true,
        strictCaptcha: config.pipeline.stop_at_invisible_captcha,
        codeWaitMinutes: config.apply.code_wait_minutes,
        askForCode: codeApprover(repo, {
          readers: inboxReaders(config),
          codeMailbox: config.candidate.email,
          lookMinutes: config.apply.code_look_minutes,
          waitMinutes: config.apply.code_wait_minutes,
        }),
        evidenceDir: expandHome(process.env.REYGENT_EVIDENCE_DIR || EVIDENCE_DIR),
        notifier: () => {},
      });
      try {
        // Pressed while one was running: those are taken too, until none is left.
        for (let ready = readyJobs(repo); ready.length; ready = readyJobs(repo)) {
          const jobId = ready[0];
          const job = repo.getJob(jobId);
          const session = await runWhenReady({ repo, config, applier: operator }, jobId);
          done.push({ job: { company: job?.company ?? "", title: job?.title ?? "" }, session });
        }
      } finally {
        await operator.close();
      }
      return done;
    },
    async close() {
      await applier?.close();
      applier = null;
    },
  };
}
