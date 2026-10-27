/**
 * `wake`: the one command that brings Reygent up and keeps it up.
 *
 *   1. starts the web console (unless one is already listening);
 *   2. waits — for as long as it takes — until the profile, the fact bank and the keys
 *      are in place, saying what is missing and opening the console to fix it;
 *   3. runs the pre-flight, live calls included;
 *   4. starts the pipeline loop.
 *
 * Ctrl+C stops the pipeline and the console it started.
 */

import { type ChildProcess, spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { CommandContext } from "@/cli";
import { CONFIG_ENV_VAR, type Config, ConfigError, DB_ENV_VAR, expandHome, loadConfig, resolveConfigPath } from "@/core/config";
import type { Repository } from "@/core/db/repository";
import { CHROME_ON_MAC, alreadyRunning, check, run } from "@/core/orchestrator/commands";
import { draftingBlockers } from "@/core/orchestrator/pipeline";
import { ProfileManager } from "@/core/profile/manager";
import { resolveApiKey, secretsPath } from "@/core/secrets";

/** The console's address: the same one `npm run web` uses. */
export const CONSOLE_PORT = 8765;
const CONSOLE_URL = `http://127.0.0.1:${CONSOLE_PORT}`;
const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
/** How often to look again while waiting for the user. */
const WAIT_MS = 5_000;
const CONSOLE_START_MS = 45_000;

/**
 * What still stands between the user and a run, judged without spending anything: the
 * same things `check` fails on, minus the live calls. Empty when the pipeline can start.
 */
export function notReady(config: Config, repo: Repository): string[] {
  const problems = draftingBlockers(new ProfileManager(repo, config).build());
  if (!config.pipeline.require_human_review && !resolveApiKey(config.jev.api_key_env)) {
    problems.push("The TypeSafe (Jev) API key is not set (Settings): listings and answers cannot be judged without it");
  }
  const cv = expandHome(config.candidate.resume_path.trim());
  if (cv && !fs.existsSync(cv)) problems.push(`Your CV is not at ${cv} (Profile): applications would have nothing to attach`);
  if (process.platform === "darwin" && !fs.existsSync(CHROME_ON_MAC)) {
    problems.push("Google Chrome is not installed in /Applications: forms cannot be read or filled");
  }
  return problems;
}

function listening(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ host: "127.0.0.1", port });
    const done = (up: boolean) => {
      socket.destroy();
      resolve(up);
    };
    socket.setTimeout(1_000, () => done(false));
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
  });
}

/** Last-modified times of the files the user's fixes land in; changes when there is something new to check. */
function settingsStamp(configPath: string): string {
  return [configPath, secretsPath()]
    .map((file) => {
      try {
        return fs.statSync(file).mtimeMs;
      } catch {
        return 0;
      }
    })
    .join(":");
}

export async function wake(context: CommandContext): Promise<number> {
  const { io, repo } = context;
  const busy = alreadyRunning(context);
  if (busy) {
    io.err(busy);
    return 1;
  }
  const configFlag = typeof context.flags.config === "string" ? context.flags.config : undefined;
  const configPath = resolveConfigPath(configFlag);

  let stopping = false;
  let wakeUp: (() => void) | null = null;
  const stop = () => {
    stopping = true;
    wakeUp?.();
  };
  /** Sleep that Ctrl+C cuts short. */
  const pause = (ms: number) =>
    new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, ms);
      wakeUp = () => {
        clearTimeout(timer);
        resolve();
      };
    }).finally(() => {
      wakeUp = null;
    });

  let web: ChildProcess | null = null;
  const stopConsole = () => {
    web?.kill("SIGTERM");
    web = null;
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  process.once("exit", stopConsole);

  try {
    io.out("Reygent is waking up.");
    if (await listening(CONSOLE_PORT)) {
      io.out(`Console: ${CONSOLE_URL} (already running)`);
    } else {
      // The console must read the same files this process does.
      const env = { ...process.env };
      if (configFlag) env[CONFIG_ENV_VAR] = configPath;
      if (typeof context.flags.db === "string") env[DB_ENV_VAR] = context.dbPath;
      const logFile = path.join(path.dirname(context.dbPath), "console.log");
      fs.mkdirSync(path.dirname(logFile), { recursive: true });
      const log = fs.openSync(logFile, "a");
      web = spawn(
        process.execPath,
        [path.join(PROJECT_ROOT, "node_modules/next/dist/bin/next"), "dev", "-H", "127.0.0.1", "-p", String(CONSOLE_PORT)],
        { cwd: PROJECT_ROOT, env, stdio: ["ignore", log, log] },
      );
      fs.closeSync(log);
      const started = Date.now();
      let up = false;
      while (!stopping && !up && web.exitCode === null && Date.now() - started < CONSOLE_START_MS) {
        await pause(500);
        up = await listening(CONSOLE_PORT);
      }
      if (stopping) return 0;
      io.out(up ? `Console: ${CONSOLE_URL}` : `Console did not start — see ${logFile}. The pipeline carries on without it.`);
    }

    // Wait for the user, however long it takes: wake is started once and left alone.
    let shown = "";
    let opened = false;
    let failedWith: string | null = null;
    for (;;) {
      if (stopping) {
        io.out("Stopped.");
        return 0;
      }
      let config: Config;
      let problems: string[];
      try {
        config = loadConfig(configFlag);
        problems = notReady(config, repo);
      } catch (error) {
        if (!(error instanceof ConfigError)) throw error;
        config = context.config;
        problems = [`config.yaml cannot be read: ${error.message}`];
      }
      if (problems.length) {
        const listed = problems.join("\n");
        if (listed !== shown) {
          io.out("");
          io.out(`Not ready yet — finish these in the console (${CONSOLE_URL}); the pipeline starts by itself when they are done:`);
          for (const problem of problems) io.out(`  - ${problem}`);
          shown = listed;
        }
        if (!opened && process.platform === "darwin" && process.stdout.isTTY) {
          spawn("open", [CONSOLE_URL], { stdio: "ignore", detached: true }).unref();
        }
        opened = true;
        await pause(WAIT_MS);
        continue;
      }
      // The live calls are only repeated once something the user can change has changed.
      const stamp = settingsStamp(configPath);
      if (failedWith === stamp) {
        await pause(WAIT_MS);
        continue;
      }
      io.out("");
      const ready = { ...context, config, repo };
      if ((await check(ready)) !== 0) {
        io.out(`Fix the failures above in the console (${CONSOLE_URL}); they are checked again when your settings or keys change.`);
        failedWith = stamp;
        shown = "";
        continue;
      }
      if (stopping) return 0;
      io.out("");
      // The loop installs its own Ctrl+C handling; ours would only swallow the signal.
      process.off("SIGINT", stop);
      process.off("SIGTERM", stop);
      return await run(ready);
    }
  } finally {
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
    process.off("exit", stopConsole);
    stopConsole();
  }
}
