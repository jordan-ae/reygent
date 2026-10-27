/**
 * Reygent command line.
 *
 *     npm run wake                         everything: console, pre-flight, then the pipeline
 *     npm run reygent -- check             pre-flight: profile, keys, live model calls, Chrome
 *     npm run reygent -- run               run the pipeline continuously
 *     npm run reygent -- cycle             run the pipeline once
 *     npm run reygent -- discover          fetch and classify new listings (free)
 *     npm run reygent -- assist            finish applications that need you, in Chrome
 *     npm run reygent -- status            where every job stands
 *     npm run reygent -- tune <listing>    tune your CV to one listing and check it reads back
 *     npm run reygent -- init              sync config.yaml into the fact bank
 *     npm run reygent -- test-eligibility  run the 3-tier scorer on sample listings
 *     npm run reygent -- cost-summary      today's spend against the daily cap
 *
 * The web console is a separate process: `npm run web` (`wake` starts it for you).
 */

import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { type ParseArgsConfig, type ParseArgsOptionsConfig, parseArgs } from "node:util";

import { type Config, ConfigError, loadConfig, resolveDbPath } from "@/core/config";
import { Repository } from "@/core/db/repository";
import { CostLedger } from "@/core/llm/ledger";
import { createJob, EligibilityTier, type JobOpportunity, verifiedAchievements } from "@/core/models";
import { ProfileManager } from "@/core/profile/manager";
import { evaluateRemoteEligibility } from "@/core/qualification/eligibility";

/** Where a command writes, one line per call. Tests capture these; the default is the terminal. */
export interface CliIo {
  out: (line: string) => void;
  err: (line: string) => void;
}

const TERMINAL: CliIo = {
  out: (line) => console.log(line),
  err: (line) => console.error(line),
};

/** Parsed flag values by long name: a string, or true for a boolean flag that was given. */
export type Flags = Record<string, string | boolean | Array<string | boolean> | undefined>;

/** Everything a command may use. */
export interface CommandContext {
  config: Config;
  /** The database in effect: --db, else $REYGENT_DB, else the config's db_path. */
  dbPath: string;
  /**
   * That database, opened on first use and closed once the command returns — a command
   * that never touches it (test-eligibility) creates no file.
   */
  readonly repo: Repository;
  /** The global flags plus those the command declared in `options`. */
  flags: Flags;
  /** Positional arguments after the command name, in the order of `positionals`. */
  args: string[];
  io: CliIo;
}

/** To add a command, write its `run` function and register it in COMMANDS. */
export interface Command {
  /** One line for --help. */
  summary: string;
  /** Flags of its own, on top of the global ones. They go after the command name. */
  options?: ParseArgsOptionsConfig;
  /** Names of the positional arguments it requires, e.g. ["draft-id"]. */
  positionals?: readonly string[];
  /** Returns the process exit code. A ConfigError thrown here is reported as one. */
  run: (context: CommandContext) => number | Promise<number>;
}

const GLOBAL_OPTIONS = {
  config: { type: "string" },
  db: { type: "string" },
  help: { type: "boolean", short: "h" },
} satisfies ParseArgsOptionsConfig;

const USAGE = "usage: reygent [--config <path>] [--db <path>] <command> [options]";

const SAMPLE_JOBS: ReadonlyArray<readonly [expected: EligibilityTier, job: JobOpportunity]> = [
  [
    EligibilityTier.CONFIRMED_ELIGIBLE,
    createJob({
      source: "sample", sourceId: "1", company: "Northwind Labs", title: "Senior AI Engineer (Contract)",
      location: "Remote (Worldwide)",
      description: "Async-first team hiring contractors globally. Paid monthly through Deel.",
    }),
  ],
  [
    EligibilityTier.CONFIRMED_ELIGIBLE,
    createJob({
      source: "sample", sourceId: "2", company: "Kestrel", title: "Full-Stack Product Engineer",
      location: "Remote - EMEA", description: "TypeScript, Next.js and PostgreSQL. B2B contract basis.",
    }),
  ],
  [
    EligibilityTier.POTENTIALLY_ELIGIBLE,
    createJob({
      source: "sample", sourceId: "3", company: "Fathom Systems", title: "Agent Platform Engineer",
      location: "Remote",
      description: "San Francisco startup, fully remote team. Build LangGraph agents and hybrid search.",
    }),
  ],
  [
    EligibilityTier.POTENTIALLY_ELIGIBLE,
    createJob({
      source: "sample", sourceId: "4", company: "Brightline", title: "Frontend Systems Engineer",
      location: "Remote - US", description: "React and design systems. Contract role, 6 months.",
    }),
  ],
  [
    EligibilityTier.INELIGIBLE,
    createJob({
      source: "sample", sourceId: "5", company: "Aegis Federal", title: "Senior Software Engineer",
      location: "Remote", description: "US citizenship required. Must hold an active security clearance.",
    }),
  ],
  [
    EligibilityTier.INELIGIBLE,
    createJob({
      source: "sample", sourceId: "6", company: "Paywell", title: "Backend Engineer",
      location: "Remote", description: "Open to candidates in the 50 US states only. W2 only.",
    }),
  ],
  [
    EligibilityTier.INELIGIBLE,
    createJob({
      source: "sample", sourceId: "7", company: "Thames Digital", title: "Senior Engineer",
      location: "London (Hybrid)", description: "Hybrid on-site, 3 days a week in the office. UK PAYE only.",
    }),
  ],
  [
    EligibilityTier.INELIGIBLE,
    createJob({
      source: "sample", sourceId: "8", company: "Gigstack", title: "React Developer",
      location: "Remote Worldwide", description: "Hourly contract.", compMax: 22, compPeriod: "hour",
    }),
  ],
];

/** "confirmed" -> "CONFIRMED_ELIGIBLE": the tier as the sample report names it. */
const TIER_NAMES = Object.fromEntries(
  Object.entries(EligibilityTier).map(([name, tier]) => [tier, name]),
) as Record<EligibilityTier, string>;

function init({ config, dbPath, repo, io }: CommandContext): number {
  const profile = new ProfileManager(repo, config).initialize();
  io.out(`Fact bank synced to ${dbPath}`);
  io.out(`  Candidate:     ${profile.name} — ${profile.location}`);
  io.out(`  Work status:   ${profile.workAuthorization}`);
  io.out(`  Achievements:  ${verifiedAchievements(profile).length} verified of ${profile.achievements.length}`);
  io.out("  Positioning:");
  for (const variant of Object.values(profile.positioning)) {
    const backed = variant.highlightedAchievements.length;
    io.out(`    - ${variant.title}  [${variant.coreSkills.join(", ")}]  (${backed} verified achievements)`);
  }
  const issues = ProfileManager.readinessIssues(profile);
  io.out("");
  if (issues.length > 0) {
    io.out("Not ready for real submissions yet — edit config.yaml and re-run init:");
    for (const issue of issues) io.out(`  ! ${issue.message}`);
  } else {
    io.out("Profile is complete.");
  }
  return 0;
}

function testEligibility({ config, io }: CommandContext): number {
  let failures = 0;
  for (const [expected, job] of SAMPLE_JOBS) {
    const report = evaluateRemoteEligibility(job, config.compensation);
    const ok = report.tier === expected;
    if (!ok) failures += 1;
    io.out(
      `[${ok ? "ok" : "MISMATCH"}] ${TIER_NAMES[report.tier].padEnd(21)} ${job.company} — ${job.title} (${job.location})`,
    );
    io.out(`       ${report.summary}`);
  }
  io.out("");
  io.out(`${SAMPLE_JOBS.length - failures}/${SAMPLE_JOBS.length} sample listings classified as expected.`);
  return failures > 0 ? 1 : 0;
}

const COST_FIGURE_WIDTHS = [6, 9, 8, 7, 10];

/** One line of the per-model spend table: names pad to the right, figures to the left. */
function costRow(provider: string, model: string, ...figures: string[]): string {
  const cells = figures.map((figure, column) => figure.padStart(COST_FIGURE_WIDTHS[column]));
  return [provider.padEnd(10), model.padEnd(52), ...cells].join(" ");
}

function costSummary({ config, repo, io }: CommandContext): number {
  const ledger = new CostLedger(repo, { budget: config.budget });
  const offset = config.budget.day_utc_offset_hours;
  const state = ledger.isTripped() ? "TRIPPED — paid calls paused until the next budget day" : "closed (running)";
  io.out(
    `Today (UTC${offset < 0 ? "" : "+"}${offset}): $${ledger.spentToday().toFixed(5)} of $${ledger.capUsd.toFixed(2)} cap`,
  );
  io.out(`Remaining: $${ledger.remainingToday().toFixed(5)}    Circuit breaker: ${state}`);
  const rows = repo.spendBreakdown();
  io.out("");
  if (rows.length === 0) {
    io.out("No paid calls recorded yet.");
    return 0;
  }
  io.out(costRow("provider", "model", "calls", "prompt", "compl.", "avg ms", "cost USD"));
  for (const row of rows) {
    io.out(
      costRow(
        row.provider, row.model, String(row.calls), String(row.promptTokens), String(row.completionTokens),
        String(row.avgLatencyMs), row.costUsd.toFixed(5),
      ),
    );
  }
  io.out("");
  io.out(`All-time spend: $${rows.reduce((total, row) => total + row.costUsd, 0).toFixed(5)}`);
  return 0;
}

/**
 * The pipeline commands are loaded on demand: they pull in the API clients, the Cop Tool
 * and the browser driver, which `init` or `test-eligibility` have no use for.
 */
type PipelineCommand = "check" | "discover" | "cycle" | "run" | "assist" | "status" | "tune";
const pipeline = (name: PipelineCommand) => async (context: CommandContext) =>
  (await import("@/core/orchestrator/commands"))[name](context);

const NO_BROWSER = {
  /** Everything except reading forms and applying. */
  "no-browser": { type: "boolean" },
  /** Fill each form in a visible Chrome window and leave Submit to the user, whatever the config says. */
  watch: { type: "boolean" },
} satisfies ParseArgsOptionsConfig;

const TUNE = {
  /** The role's title, when the listing is a file that does not open with it. */
  title: { type: "string" },
  company: { type: "string" },
  /** Folder to write the CV into, instead of ~/.reygent/resumes/tuned/<listing>. */
  out: { type: "string" },
  /** Ask no model: free. Only skills you already list are looked for, and nothing is reworded beyond opening verbs. */
  "no-model": { type: "boolean" },
} satisfies ParseArgsOptionsConfig;

const COMMANDS = new Map<string, Command>([
  [
    "wake",
    {
      summary: "start everything: the console, the pre-flight, then the pipeline (waits for whatever is missing)",
      options: NO_BROWSER,
      run: async (context) => (await import("@/core/orchestrator/wake")).wake(context),
    },
  ],
  ["init", { summary: "sync the candidate profile and fact bank into SQLite", run: init }],
  ["check", { summary: "pre-flight: profile, keys, a live call to each model API, and Chrome", run: pipeline("check") }],
  ["run", { summary: "run the pipeline continuously (discover, draft and apply every cycle)", options: NO_BROWSER, run: pipeline("run") }],
  ["cycle", { summary: "run the pipeline once", options: NO_BROWSER, run: pipeline("cycle") }],
  ["discover", { summary: "fetch new listings and sort them into eligibility tiers (free)", run: pipeline("discover") }],
  ["assist", { summary: "finish applications that need you, in a visible Chrome window", run: pipeline("assist") }],
  ["status", { summary: "show where every job stands and what the last cycle did", run: pipeline("status") }],
  [
    "tune",
    {
      summary: "tune your CV to one listing (its id, or a file holding the job description) and check it reads back",
      options: TUNE,
      positionals: ["listing"],
      run: pipeline("tune"),
    },
  ],
  ["test-eligibility", { summary: "classify sample listings with the 3-tier scorer", run: testEligibility }],
  ["cost-summary", { summary: "show spend against the daily cap", run: costSummary }],
]);

function help(): string[] {
  const width = Math.max(...[...COMMANDS.keys()].map((name) => name.length));
  return [
    USAGE,
    "",
    "Autonomous job-search operator.",
    "",
    "commands:",
    ...[...COMMANDS].map(([name, command]) => `  ${name.padEnd(width)}  ${command.summary}`),
    "",
    "options:",
    "  --config <path>  path to config.yaml (default: ./config.yaml or $REYGENT_CONFIG)",
    "  --db <path>      override the database path from config",
    "  -h, --help       show this help",
    "",
    "The web console is a separate process: npm run web",
  ];
}

/** Exit code 2 with a message, as for any command line that cannot be understood. */
function usageError(io: CliIo, message: string): number {
  io.err(USAGE);
  io.err(`reygent: error: ${message}`);
  return 2;
}

/** Report a bad config the same way wherever it surfaces; anything else is a bug and propagates. */
function configError(io: CliIo, error: unknown): number {
  if (!(error instanceof ConfigError)) throw error;
  io.err(`Config error: ${error.message}`);
  return 2;
}

const asText = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined);

/** Run the command line `argv` (without the program name) and return its exit code. */
export async function main(argv: string[], io: CliIo = TERMINAL): Promise<number> {
  // A lenient first pass finds the command, so that its own flags can then be parsed strictly.
  const glance = parseArgs({ args: argv, options: GLOBAL_OPTIONS, allowPositionals: true, strict: false });
  if (glance.values.help === true) {
    for (const line of help()) io.out(line);
    return 0;
  }
  const name = glance.positionals[0];
  if (name === undefined) return usageError(io, "a command is required (see --help)");
  const command = COMMANDS.get(name);
  if (!command) {
    return usageError(io, `unknown command '${name}' (choose from ${[...COMMANDS.keys()].join(", ")})`);
  }

  const grammar: ParseArgsConfig = {
    args: argv,
    options: { ...GLOBAL_OPTIONS, ...command.options },
    allowPositionals: true,
    strict: true,
  };
  let flags: Flags;
  let args: string[];
  try {
    const parsed = parseArgs(grammar);
    flags = parsed.values;
    args = parsed.positionals.slice(1);
  } catch (error) {
    return usageError(io, (error as Error).message);
  }
  const expected = command.positionals ?? [];
  if (args.length < expected.length) return usageError(io, `${name}: missing <${expected[args.length]}>`);
  if (args.length > expected.length) return usageError(io, `${name}: unexpected argument '${args[expected.length]}'`);

  let config: Config;
  try {
    config = loadConfig(asText(flags.config));
  } catch (error) {
    return configError(io, error);
  }
  const dbPath = asText(flags.db) || resolveDbPath(config);
  // Held in an object so the lazy getter below and the cleanup share one handle.
  const database: { handle?: Repository } = {};
  const context: CommandContext = {
    config,
    dbPath,
    flags,
    args,
    io,
    get repo() {
      return (database.handle ??= new Repository(dbPath));
    },
  };
  try {
    return await command.run(context);
  } catch (error) {
    return configError(io, error);
  } finally {
    database.handle?.close();
  }
}

/** True when this file is the program being run (`tsx src/cli.ts ...`) rather than imported. */
function isEntryPoint(): boolean {
  const script = process.argv[1];
  if (!script) return false;
  try {
    return fileURLToPath(import.meta.url) === fs.realpathSync(script);
  } catch {
    return false;
  }
}

if (isEntryPoint()) process.exitCode = await main(process.argv.slice(2));
