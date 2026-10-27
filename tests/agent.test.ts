/**
 * The browser agent on fixture pages the fixed patterns cannot get through: a pop-up over
 * the posting, a cookie banner, an Apply control worded another way, a form in a dialog
 * sent with "Send it over", a form in three steps, a listing that opens the employer's
 * form in a new tab. Real headless Chrome on 127.0.0.1; the model is a fake that follows
 * a few rules over the prompt it is given, so what is tested is everything around it.
 */

import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";

import { agrees, createAgent, parseAction } from "@/core/browser/agent";
import { ChromeOperator, type OperatorOptions, answerSheet } from "@/core/browser/operator";
import { type AgentConfig, defaultConfig } from "@/core/config";
import type { Generator } from "@/core/llm/types";
import { type CandidateProfile, type JobOpportunity, createDraft, createJob } from "@/core/models";

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "forms");

vi.setConfig({ testTimeout: 90_000, hookTimeout: 60_000 });

async function canLaunchChrome(): Promise<boolean> {
  try {
    const browser = await chromium.launch({ channel: "chrome", headless: true });
    await browser.close();
    return true;
  } catch {
    return false;
  }
}
const chromeAvailable = await canLaunchChrome();

// ---------- The pure parts ----------

describe("parseAction", () => {
  test("reads the first JSON object of a reply, whatever surrounds it", () => {
    expect(parseAction('Sure. {"why":"open it","action":"click","ref":"a7"} done')).toEqual({ action: "click", ref: "a7" });
    expect(parseAction('{"action":"choose","field":"f2","option":"Cameroon","key":"country"}')).toEqual({
      action: "choose", field: "f2", option: "Cameroon", key: "country",
    });
    expect(parseAction('{"action":"stop","reason":"posting closed"}')).toEqual({ action: "stop", reason: "posting closed" });
  });

  test("turns down what is not a whole action", () => {
    expect(parseAction("I would click Apply")).toBeNull();
    expect(parseAction('{"action":"click"}')).toBeNull();
    expect(parseAction('{"action":"type","field":"f1","text":"anything"}')).toBeNull();
    expect(parseAction('{"action":"fill","field":"f1"}')).toBeNull();
  });
});

describe("agrees", () => {
  test("an option agrees with an answer that names it, or that it spells out", () => {
    expect(agrees("Cameroon", "Douala, Cameroon")).toBe(true);
    expect(agrees("Yes, I am", "Yes")).toBe(true);
    expect(agrees("I prefer not to say", "Prefer not to say")).toBe(true);
  });

  test("never the opposite answer, nor another place", () => {
    expect(agrees("No", "Yes")).toBe(false);
    expect(agrees("Yes", "No")).toBe(false);
    expect(agrees("Nigeria", "Douala, Cameroon")).toBe(false);
  });
});

// ---------- Fixture server ----------

interface Post {
  from: string;
  fields: Record<string, string>;
  files: string[];
}
const posts: Post[] = [];
const gets: string[] = [];

function parseMultipart(contentType: string, body: Buffer): Pick<Post, "fields" | "files"> {
  const fields: Record<string, string> = {};
  const files: string[] = [];
  const boundary = /boundary=(.+)$/.exec(contentType)?.[1];
  if (!boundary) {
    for (const [name, value] of new URLSearchParams(body.toString("utf8"))) fields[name] = value;
    return { fields, files };
  }
  for (const part of body.toString("latin1").split(`--${boundary}`)) {
    const split = part.indexOf("\r\n\r\n");
    if (split < 0) continue;
    const head = part.slice(0, split);
    const content = part.slice(split + 4).replace(/\r\n$/, "");
    const name = /name="([^"]*)"/.exec(head)?.[1];
    const filename = /filename="([^"]*)"/.exec(head)?.[1];
    if (name === undefined) continue;
    if (filename === undefined) fields[name] = Buffer.from(content, "latin1").toString("utf8");
    else if (filename) files.push(name);
  }
  return { fields, files };
}

const server = http.createServer((request, response) => {
  const url = new URL(request.url ?? "/", "http://fixture");
  if (request.method === "POST") {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      posts.push({ from: url.searchParams.get("from") ?? "", ...parseMultipart(request.headers["content-type"] ?? "", Buffer.concat(chunks)) });
      response.writeHead(303, { location: "/confirmation" }).end();
    });
    return;
  }
  const name = url.pathname.slice(1);
  if (url.pathname !== "/favicon.ico") gets.push(url.pathname);
  const file = path.join(FIXTURES, `${name}.html`);
  if (!/^[a-z-]+$/.test(name) || !fs.existsSync(file)) {
    response.writeHead(404, { "content-type": "text/html" }).end("<!doctype html><title>Not found</title><h1>Not found</h1>");
    return;
  }
  response.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(fs.readFileSync(file));
});

// ---------- A rule-following stand-in for the model ----------

/** The ref of the control whose caption matches, from the prompt's CONTROLS. */
function refFor(prompt: string, caption: RegExp, where?: string): string | null {
  for (const line of prompt.split("\n")) {
    const match = /^([a-d]\d+) · [^·]+ · "(.*)" · (\w+)/.exec(line);
    if (match && caption.test(match[2]) && (!where || match[3] === where)) return match[1];
  }
  return null;
}
/** The id of the field whose label matches and that is still empty, from the prompt's FIELDS. */
function emptyField(prompt: string, label: RegExp): string | null {
  for (const line of prompt.split("\n")) {
    const match = /^(f\d+) · \w+ · (.*?)(?: \*)? · (empty|holds)/.exec(line);
    if (match && match[3] === "empty" && label.test(match[2])) return match[1];
  }
  return null;
}

type Rule = (prompt: string) => Record<string, string> | null;
/** Each turn, the first rule that has something to say decides; with none, it stops. */
function fakeModel(rules: Rule[]): Generator & { prompts: string[] } {
  const prompts: string[] = [];
  return {
    prompts,
    async generate(prompt) {
      prompts.push(prompt);
      for (const rule of rules) {
        const action = rule(prompt);
        if (action) return { text: JSON.stringify({ why: "rule", ...action }), costUsd: 0.001 };
      }
      return { text: '{"action":"stop","reason":"no rule applies"}', costUsd: 0.001 };
    },
  };
}
const click = (caption: RegExp, where?: string): Rule => (prompt) => {
  const ref = refFor(prompt, caption, where);
  return ref ? { action: "click", ref } : null;
};
const submit = (caption: RegExp): Rule => (prompt) => {
  const ref = refFor(prompt, caption);
  return ref ? { action: "submit", ref } : null;
};
const fill = (label: RegExp, key: string): Rule => (prompt) => {
  const field = emptyField(prompt, label);
  return field ? { action: "fill", field, key } : null;
};
/** Only before the form is open: the posting's own Apply control. */
const start: Rule = (prompt) => (/^FIELDS/m.test(prompt) ? null : click(/^start your journey/i)(prompt));
/** Only while the page is covered: the pop-up's close button. */
const closePopUp: Rule = (prompt) => (/^COVERED BY:/m.test(prompt) ? click(/close|×/i, "dialog")(prompt) : null);

// ---------- Candidate and settings ----------

const profile: CandidateProfile = {
  id: "default",
  name: "Amina Ngono Tabi",
  email: "amina@example.com",
  phone: "+237 650 000 000",
  location: "Douala, Cameroon",
  timezone: "Africa/Douala (WAT, UTC+1)",
  workAuthorization: "Eligible for Global Independent B2B Contractor & 1099 Engagements.",
  noticePeriod: "2 weeks",
  githubUrl: "https://github.com/amina-tabi",
  linkedinUrl: "https://www.linkedin.com/in/amina-tabi",
  portfolioUrl: "https://amina.dev",
  yearsExperience: 9,
  employers: [],
  skills: [],
  achievements: [],
  positioning: {},
};
const settings = (extra: Partial<AgentConfig> = {}): AgentConfig => ({ ...defaultConfig().agent, ...extra });

describe("answerSheet", () => {
  test("offers the candidate's details by key, the name and place split the ways forms ask", () => {
    const sheet = answerSheet(
      profile,
      createDraft({
        jobId: "j", pitch: "I build agent runtimes.", resumePdfPath: "/tmp/cv.pdf",
        screeningAnswers: [{ question: "Notice period?", answer: "2 weeks", options: [], factKey: "" }],
      }),
    );
    expect(sheet.values).toMatchObject({
      first_name: "Amina", last_name: "Ngono Tabi", email: "amina@example.com", location: "Douala, Cameroon",
      city: "Douala", country: "Cameroon", pitch: "I build agent runtimes.", q1: "2 weeks",
    });
    expect(sheet.questions.q1).toBe("Notice period?");
    expect(sheet.resume).toBe("/tmp/cv.pdf");
  });
});

describe.skipIf(!chromeAvailable)("browser agent on fixture pages (real headless Chrome)", () => {
  let tmp: string;
  let base: string;
  let resume: string;
  let operators: ChromeOperator[];

  beforeAll(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "reygent-agent-"));
    resume = path.join(tmp, "resume.pdf");
    fs.writeFileSync(resume, "%PDF-1.4\n% fixture resume\n%%EOF\n");
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  beforeEach(() => {
    posts.length = 0;
    gets.length = 0;
    operators = [];
  });

  afterEach(async () => {
    await Promise.all(operators.map((operator) => operator.close()));
  });

  function launch(model: Generator, extra: Partial<AgentConfig> = {}, options: Partial<OperatorOptions> = {}): ChromeOperator {
    const operator = new ChromeOperator({
      profileDir: fs.mkdtempSync(path.join(tmp, "profile-")),
      headless: true,
      autoSubmit: true,
      notifier: () => {},
      formWaitMs: 1_500,
      submitWaitMs: 4_000,
      agent: createAgent(model, { settings: settings(extra) }),
      ...options,
    });
    operators.push(operator);
    return operator;
  }
  const job = (fixture: string): JobOpportunity =>
    createJob({ source: "fixture", sourceId: fixture, company: "Fixture Labs", title: "Senior Engineer", applyUrl: `${base}/${fixture}` });
  const draft = (extra = {}) => createDraft({ jobId: "job-1", pitch: "I build agent runtimes.", resumePdfPath: resume, ...extra });

  test("gets past a pop-up and a cookie banner to a form in a dialog, and sends it with its own button", async () => {
    const model = fakeModel([
      click(/^reject all$/i, "banner"),
      closePopUp,
      start,
      fill(/where are you based/i, "location"),
      submit(/^send it over$/i),
    ]);
    const report = await launch(model).apply(job("modal-posting"), draft(), profile);

    expect(report.status).toBe("submitted");
    expect(posts).toHaveLength(1);
    expect(posts[0]).toMatchObject({
      from: "modal-posting",
      fields: { first_name: "Amina", last_name: "Ngono Tabi", email: "amina@example.com", where: "Douala, Cameroon" },
      files: ["resume"],
    });
    // The fixed patterns filled the names and the email; the agent only what they left.
    expect(report.agentTrail?.some((line) => line.startsWith("fill") && line.includes("location"))).toBe(true);
    expect(report.agentTrail?.some((line) => /fill .* (first_name|email)/.test(line))).toBe(false);
    expect(report.agentUsd).toBeGreaterThan(0);
  });

  test("rejects cookies when told to accept them, if the banner offers a way to reject", async () => {
    const model = fakeModel([
      // Told why it was not pressed, it presses what it was pointed to.
      (prompt) => (/cookies are to be rejected/.test(prompt) ? click(/^reject all$/i, "banner")(prompt) : null),
      click(/^accept all$/i, "banner"),
    ]);
    // Accept (turned down), then reject; once the banner is gone no rule applies and it stops.
    await launch(model).inspect(job("modal-posting"));
    expect(model.prompts.some((prompt) => /not pressed: cookies are to be rejected/.test(prompt))).toBe(true);
  });

  test("accepts cookies when the settings say so", async () => {
    const model = fakeModel([click(/^accept all$/i, "banner"), closePopUp, start]);
    const schema = await launch(model, { cookies: "accept" }).inspect(job("modal-posting"));
    expect(schema.fields.map((field) => field.label)).toContain("Where are you based right now?");
    expect(model.prompts.some((prompt) => /not pressed/.test(prompt))).toBe(false);
  });

  test("steps through a form in three parts, filling each step the usual way", async () => {
    const model = fakeModel([click(/^continue$/i, "form"), submit(/^submit application$/i)]);
    const notice = "What is your notice period?";
    const report = await launch(model).apply(
      job("wizard"),
      draft({ screeningAnswers: [{ question: notice, answer: "2 weeks", options: [], factKey: "" }] }),
      profile,
    );

    expect(report.status).toBe("submitted");
    expect(posts[0]).toMatchObject({
      from: "wizard",
      fields: { first_name: "Amina", last_name: "Ngono Tabi", email: "amina@example.com", notice: "2 weeks" },
      files: ["resume"],
    });
    expect(report.filled).toEqual(expect.arrayContaining(["First name", "Email address", "Resume", notice]));
  });

  test("answers a question a later step asks, through the drafting rules", async () => {
    const model = fakeModel([click(/^continue$/i, "form"), submit(/^submit application$/i)]);
    const asked: string[] = [];
    const operator = launch(model, {}, {
      answerQuestions: async (_job, _draft, questions) => {
        asked.push(...questions.map((question) => question.question));
        return questions.map((question) => ({ question: question.question, answer: "Two weeks", options: [], factKey: "" }));
      },
    });
    const report = await operator.apply(job("wizard"), draft(), profile);

    expect(asked).toEqual(["What is your notice period?"]);
    expect(report.status).toBe("submitted");
    expect(posts[0].fields.notice).toBe("Two weeks");
    expect(report.answered).toEqual([{ question: "What is your notice period?", answer: "Two weeks", options: [], factKey: "" }]);
  });

  test("follows a listing's Apply link into the new tab it opens", async () => {
    const model = fakeModel([click(/^apply on company website$/i)]);
    const schema = await launch(model).inspect(job("listing"));
    expect(schema.url).toBe(`${base}/clean`);
    expect(schema.fields.map((field) => field.label)).toContain("Email address");
  });

  test("never presses what the never-click list names", async () => {
    const model = fakeModel([
      (prompt) => (/never-click list/.test(prompt) ? { action: "stop", reason: "only a sign-in is left" } : null),
      click(/^sign in to save this job$/i),
    ]);
    const report = await launch(model).apply(job("listing"), draft(), profile);
    expect(report.status).toBe("failed");
    expect(report.reason).toContain("only a sign-in is left");
    expect(gets).not.toContain("/login");
  });

  test("stops at its spending limit for one application", async () => {
    const model = fakeModel([(prompt) => ({ action: "wait", seen: String(prompt.length) })]);
    const report = await launch(model, { max_usd_per_application: 0.002 }).apply(job("modal-posting"), draft(), profile);
    expect(report.status).toBe("failed");
    expect(report.reason).toContain("limit of $0.00");
    expect(model.prompts.length).toBe(2);
    expect(posts).toHaveLength(0);
  });

  test("leaves the fixed patterns to work alone when there is no agent", async () => {
    const operator = new ChromeOperator({
      profileDir: fs.mkdtempSync(path.join(tmp, "profile-")), headless: true, autoSubmit: true, notifier: () => {}, formWaitMs: 1_500,
    });
    operators.push(operator);
    const report = await operator.apply(job("modal-posting"), draft(), profile);
    expect(report.status).toBe("failed");
    expect(report.reason).toContain("No application form found");
    expect(report.agentTrail).toBeUndefined();
  });
});
