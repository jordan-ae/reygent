/**
 * Drives the operator against fixture forms served from 127.0.0.1 with the real,
 * headless Google Chrome. Nothing here ever opens an employer's site. The whole suite
 * is skipped when Chrome cannot be launched.
 */

import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { type Page, chromium } from "playwright-core";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";

import { runInPage } from "@/core/browser/driver";
import { ChromeOperator, type OperatorOptions, createOperator } from "@/core/browser/operator";
import type { FormField } from "@/core/browser/types";
import { type ApplicationDraft, type CandidateProfile, type JobOpportunity, PLACEHOLDER, createDraft, createJob } from "@/core/models";

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "forms");

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

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

// ---------- Fixture server ----------

interface Post {
  path: string;
  /** The `from` query parameter: which fixture posted. */
  from: string;
  fields: Record<string, string>;
  files: Record<string, { filename: string; size: number }>;
}

/** Enough multipart parsing to see what a form sent. */
function parseBody(contentType: string, body: Buffer): Pick<Post, "fields" | "files"> {
  const fields: Record<string, string> = {};
  const files: Post["files"] = {};
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
    if (name === undefined) continue;
    const filename = /filename="([^"]*)"/.exec(head)?.[1];
    if (filename === undefined) fields[name] = Buffer.from(content, "latin1").toString("utf8");
    else if (filename) files[name] = { filename, size: content.length };
  }
  return { fields, files };
}

/** Applications that reached the server. */
const posts: Post[] = [];
/** Pages fetched (not the stand-in CAPTCHA frames or the location search). */
const gets: string[] = [];
/** What was typed into a location search (Lever's, Greenhouse's or Ashby's), in order. */
const searches: string[] = [];
/** Values Ashby's form saved to its server the moment they were set: [field path, value]. */
const saves: Array<[string, unknown]> = [];
/** Resumes sent to Lever's parser. */
let parses = 0;

const ALIASES: Record<string, string> = { "/account/session": "login", "/stuck": "stuck" };
// What Lever's /searchLocations and Ashby's location query answer for the places the
// tests type. Neither could be asked for real, so "City, Region, Country" is a guess.
const PLACES: Record<string, string[]> = {
  douala: ["Douala, Littoral, Cameroon", "Douala, Texas, United States"],
  springfield: ["Springfield, Illinois, United States", "Springfield, Missouri, United States"],
  // Two different places for one city and country.
  kumba: ["Kumba, Southwest, Cameroon", "Kumba, Littoral, Cameroon"],
};
// What Greenhouse's geocoder answers. The Douala entries are the real response to
// "Douala" (October 2026), cut to the properties Greenhouse's script reads: the city is
// listed twice, under two record ids, and both become "Douala, Littoral Province,
// Cameroon". The other two keys are made up in the same shape.
type Place = { id: string; label: string; region: string; region_a: string; country: string; macroregion?: string };
const GEOCODER: Record<string, Place[]> = {
  douala: [
    { id: "421189877", label: "Douala, LT, Cameroon", region: "Littoral Province", region_a: "LT", country: "Cameroon" },
    { id: "890435477", label: "Beni Douala, TO, Algeria", region: "Tizi Ouzou", region_a: "TO", country: "Algeria" },
    { id: "1193007245", label: "Doualayel, AD, Cameroon", region: "Adamaoua Province", region_a: "AD", country: "Cameroon" },
    { id: "1226352821", label: "Douala, BE, Guinea", region: "Beyla", region_a: "BE", country: "Guinea" },
    { id: "1293509719", label: "Douala, LO, Chad", region: "Logone Occidental", region_a: "LO", country: "Chad" },
    { id: "12319823", label: "La Ville Doualan, France", region: "Côtes-d'Armor", region_a: "CA", macroregion: "Brittany", country: "France" },
    { id: "1260002215", label: "Douala, LT, Cameroon", region: "Littoral Province", region_a: "LT", country: "Cameroon" },
  ],
  springfield: [
    { id: "85940429", label: "Springfield, IL, USA", region: "Illinois", region_a: "IL", country: "United States" },
    { id: "85967497", label: "Springfield, MO, USA", region: "Missouri", region_a: "MO", country: "United States" },
  ],
  // A two-part label: Greenhouse shows it as "Kribi, Cameroon", the place itself.
  kribi: [{ id: "101913765", label: "Kribi, Cameroon", region: "South Province", region_a: "SU", country: "Cameroon" }],
};
const matching = <T,>(table: Record<string, T[]>, text: string): T[] =>
  table[Object.keys(table).find((key) => text.toLowerCase().startsWith(key)) ?? ""] ?? [];

const server = http.createServer((request, response) => {
  const url = new URL(request.url ?? "/", "http://fixture");
  const page = (name: string, status = 200): void => {
    const file = path.join(FIXTURES, `${name}.html`);
    if (!/^[a-z-]+$/.test(name) || !fs.existsSync(file)) {
      response.writeHead(404, { "content-type": "text/html" }).end("<!doctype html><title>Not found</title><h1>Not found</h1>");
      return;
    }
    response.writeHead(status, { "content-type": "text/html; charset=utf-8" }).end(fs.readFileSync(file));
  };
  const json = (body: unknown): void => {
    response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(body));
  };

  if (request.method === "POST") {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      if (url.pathname === "/parseResume") {
        // What Lever's parser found in the PDF. Slow enough to land after the next keystrokes.
        parses += 1;
        setTimeout(() => json({ name: "Parsed From Resume", email: "parsed@resume.example", location: { name: "Yaoundé, Centre, Cameroon" } }), 150);
        return;
      }
      if (url.pathname === "/api/non-user-graphql") {
        // Ashby's two calls: the location search, and the save that follows every value set.
        const { variables } = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { variables: Record<string, unknown> };
        if (url.searchParams.get("op") === "ApiSetFormValue") {
          saves.push([String(variables.path), variables.value]);
          return json({ data: { ok: true } });
        }
        const text = String(variables.text);
        searches.push(text);
        const suggestions = matching(PLACES, text).map((name, index) => ({
          name,
          geoLocationPath: name.split(", ").reverse().map((part, depth) => ({ name: part, type: ["Country", "Region", "City"][depth], providerLocationId: `geo-${index}-${depth}` })),
        }));
        return json({ data: { result: { suggestions } } });
      }
      const parsed = parseBody(request.headers["content-type"] ?? "", Buffer.concat(chunks));
      posts.push({ path: url.pathname, from: url.searchParams.get("from") ?? "", ...parsed });
      if (url.pathname === "/emailed-code") {
        response.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(
          '<!doctype html><p>A verification code was sent to your email</p><form method="post" action="/emailed-code-verify"><label>Verification code <input name="verification_code" autocomplete="one-time-code" inputmode="numeric"></label><button type="submit">Verify</button></form>',
        );
        return;
      }
      if (url.pathname === "/emailed-code-verify") {
        if (parsed.fields.verification_code === "123456") {
          response.writeHead(303, { location: "/confirmation" }).end();
        } else {
          response.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(
            '<!doctype html><div role="alert">Invalid code</div><form method="post" action="/emailed-code-verify"><label>Verification code <input name="verification_code" autocomplete="one-time-code" inputmode="numeric"></label><button type="submit">Verify</button></form>',
          );
        }
        return;
      }
      // The "stuck" form shows itself again, "refuse" just answers; every other form
      // lands on the confirmation page.
      if (url.pathname === "/stuck") page("stuck");
      else if (url.pathname === "/refuse") json({ ok: false });
      else response.writeHead(303, { location: "/confirmation" }).end();
    });
    return;
  }
  if (url.pathname === "/searchLocations") {
    const text = url.searchParams.get("text") ?? "";
    searches.push(text);
    return json(matching(PLACES, text).map((name, index) => ({ name, id: `place-${index}` })));
  }
  if (url.pathname === "/v1/autocomplete") {
    // Greenhouse's geocoder (Pelias): GeoJSON features, of which the script reads the properties.
    const text = url.searchParams.get("text") ?? "";
    searches.push(text);
    return json({ features: matching(GEOCODER, text).map((properties) => ({ type: "Feature", geometry: { coordinates: [9.7, 4.05] }, properties: { layer: "locality", ...properties } })) });
  }
  // Stand-ins for the CAPTCHA vendors' frames: local, empty, and named like the real ones.
  if (/^\/(recaptcha|hcaptcha)\//.test(url.pathname)) {
    response.writeHead(200, { "content-type": "text/html" }).end("<!doctype html><title>frame</title>");
    return;
  }
  if (url.pathname !== "/favicon.ico") gets.push(url.pathname);
  page(ALIASES[url.pathname] ?? url.pathname.slice(1));
});

// ---------- Candidate, draft, jobs ----------

const PITCH = "I build agent runtimes that recover from failure.\nHappy to walk you through one.";

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
  // Never filled in by the user: must not reach any form.
  portfolioUrl: PLACEHOLDER,
  yearsExperience: 9,
  employers: [],
  skills: [],
  achievements: [],
  positioning: {},
};

const answer = (question: string, text: string) => ({ question, answer: text, options: [], factKey: "" });
const YEARS = "How many years of TypeScript experience do you have?";
const NOTICE = "What is your notice period?";
const SPONSORSHIP = "Will you require visa sponsorship?";
const WORK_AUTH = "Are you legally authorized to work in the country in which you are applying?";
const RESIDENCE = "What is your current country of residence?";
const PREFERRED = "What's the name you'd prefer us to use throughout the interview process?";
const LEVER_SPONSORSHIP = "Will you now or in the future require sponsorship for employment visa status (e.g., H-1B, etc.)?";
const ADULT = "Are you over the age of 18?";
const B2B = "Are you open to a B2B contract engagement?";
const HOURS = "How many hours a week can you commit?";
const OFFICE = "Which office would you visit most often?";
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

describe.skipIf(!chromeAvailable)("browser operator on fixture forms (real headless Chrome)", () => {
  let tmp: string;
  let base: string;
  let deadUrl: string;
  let resume: string;
  let notes: string[];
  let operators: ChromeOperator[];

  beforeAll(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "reygent-operator-"));
    resume = path.join(tmp, "resume.pdf");
    fs.writeFileSync(resume, "%PDF-1.4\n% fixture resume\n%%EOF\n");
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    // A port that was just free: nothing answers there.
    const dead = http.createServer();
    await new Promise<void>((resolve) => dead.listen(0, "127.0.0.1", resolve));
    deadUrl = `http://127.0.0.1:${(dead.address() as AddressInfo).port}/apply`;
    await new Promise((resolve) => dead.close(resolve));
  });

  afterAll(async () => {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  beforeEach(() => {
    posts.length = 0;
    gets.length = 0;
    searches.length = 0;
    saves.length = 0;
    parses = 0;
    notes = [];
    operators = [];
  });

  // Every test closes the Chrome it started, pass or fail.
  afterEach(async () => {
    await Promise.all(operators.map((operator) => operator.close()));
  });

  /** A headless operator on a throw-away profile. Never the real ~/.reygent profile. */
  function launch(options: Partial<OperatorOptions> = {}): ChromeOperator {
    const operator = new ChromeOperator({
      profileDir: fs.mkdtempSync(path.join(tmp, "profile-")),
      headless: true,
      notifier: (message) => notes.push(message),
      handoffTimeoutMs: 1_500,
      formWaitMs: 1_500,
      submitWaitMs: 3_000,
      ...options,
    });
    operators.push(operator);
    return operator;
  }
  /** Assisted apply, minus the window: a person is "there", so the operator waits for them. */
  const assisted = (options: Partial<OperatorOptions> = {}) => launch({ attended: true, ...options });
  /** Hands-free: headless, submits when it may, and waits for nobody. */
  const auto = (options: Partial<OperatorOptions> = {}) => launch({ autoSubmit: true, handoffTimeoutMs: 60_000, ...options });

  const job = (fixture: string, extra: Partial<JobOpportunity> = {}): JobOpportunity =>
    createJob({
      source: "fixture", sourceId: fixture, company: "Fixture Labs", title: "Senior Engineer",
      applyUrl: /^[a-z]+:/.test(fixture) ? fixture : `${base}/${fixture}`, ...extra,
    });
  const draft = (extra: Partial<ApplicationDraft> = {}): ApplicationDraft =>
    createDraft({ jobId: "job-1", pitch: PITCH, resumePdfPath: resume, ...extra });

  /** The tab the operator left open for the user. */
  function handedPage(operator: ChromeOperator, fragment: string): Page {
    const page = operator.session.pages().find((candidate) => candidate.url().includes(fragment));
    if (!page) throw new Error(`no open page for ${fragment}`);
    return page;
  }
  const attachedTo = (page: Page, selector: string): Promise<string[]> =>
    page.locator(selector).evaluate((input) => Array.from((input as HTMLInputElement).files ?? []).map((file) => file.name));
  const told = (fragment: string) => () => expect(notes.some((note) => note.includes(fragment))).toBe(true);
  const field = (id: string, label: string, extra: Partial<FormField> = {}): FormField => ({
    id, label, type: "text", required: false, options: [], ...extra,
  });

  // ---------- inspect ----------

  describe("inspect", () => {
    test("reads a Greenhouse-style form, opening each dropdown to read its options", async () => {
      const schema = await launch().inspect(job("greenhouse"));
      expect(schema).toEqual({
        url: `${base}/greenhouse`,
        // The reCAPTCHA badge and its site key are a passive check, not something to solve.
        blockers: [],
        passiveCaptcha: true,
        fields: [
          field("f1", "First Name", { required: true }),
          field("f2", "Last Name", { required: true }),
          field("f3", "Email", { type: "email", required: true }),
          // react-select: the options exist only while the dropdown is open.
          field("f4", "Country", {
            type: "select", options: ["United States +1", "Afghanistan +93", "Cameroon +237", "Canada +1", "France +33"],
          }),
          field("f5", "Phone", { type: "tel" }),
          // Opens, but lists nothing until something is typed.
          field("f6", "Location (City)", { type: "select", typeAhead: true }),
          field("f7", "Resume/CV", { type: "file", required: true }),
          field("f8", "Cover Letter", { type: "file" }),
          field("f9", "LinkedIn Profile"),
          field("f10", PREFERRED),
          field("f11", WORK_AUTH, { type: "select", required: true, options: ["Yes", "No"] }),
          field("f12", RESIDENCE, { type: "select", required: true, options: ["Benin", "Cameroon", "Canada", "United States"] }),
        ],
      });
      expect(JSON.stringify(schema.fields).length).toBeLessThan(1_500);
      expect(posts).toEqual([]);
      // Reading opens the location box and sees it empty; it never types into it.
      expect(searches).toEqual([]);
    });

    test("reads a Lever-style form, whose questions have no label elements, and its invisible hCaptcha", async () => {
      const schema = await launch().inspect(job("lever"));
      expect(schema.blockers).toEqual([]);
      expect(schema.passiveCaptcha).toBe(true);
      expect(schema.fields.map((entry) => [entry.label, entry.type, entry.required])).toEqual([
        ["Resume/CV", "file", true],
        ["Full name", "text", true],
        ["Email", "email", true],
        ["Phone", "text", false],
        ["Current location", "text", true],
        ["Current company", "text", false],
        ["LinkedIn URL", "text", false],
        ["GitHub URL", "text", false],
        ["Portfolio URL", "text", false],
        ["Language Skill(s) (Check all that apply)", "checkbox", false],
        ["Preferred Name | What would you like us to call you?", "text", false],
        [LEVER_SPONSORSHIP, "radio", true],
        ["Why do you want to work at Fixture Labs?", "textarea", false],
        ["Additional information", "textarea", false],
      ]);
      // Radios and checkboxes collapse into one field each, carrying their choices.
      expect(schema.fields[9].options).toEqual(["English (ENG)", "French (FRA)", "German (DEU)"]);
      expect(schema.fields[11].options).toEqual(["Yes", "No"]);
      // The location box only keeps a picked suggestion; nothing else on the form is a type-ahead.
      expect(schema.fields.filter((entry) => entry.typeAhead).map((entry) => entry.label)).toEqual(["Current location"]);
      expect(searches).toEqual([]);
    });

    test("reads an Ashby-style page: no <form>, Yes/No as buttons, 'required' only as a class", async () => {
      const schema = await launch().inspect(job("ashby"));
      expect(schema.blockers).toEqual([]);
      expect(schema.passiveCaptcha).toBe(true);
      expect(schema.fields).toEqual([
        // Its heading comes after the input, and the "application limits" notice above is not its label.
        field("f1", "Autofill from resume", { type: "file" }),
        field("f2", "Legal Name", { required: true }),
        field("f3", "Email", { type: "email", required: true }),
        field("f4", "Resume", { type: "file", required: true }),
        // The location search: opened with its arrow button, it lists nothing until typed into.
        field("f5", "Location", { type: "select", required: true, typeAhead: true }),
        field("f6", "Country of Residence", { required: true }),
        // Two toggle buttons are one question with two choices; the hidden checkbox beside them is not a second one.
        field("f7", ADULT, { type: "radio", required: true, options: ["Yes", "No"] }),
        field("f8", "Linkedin"),
        field("f9", B2B, { type: "radio", options: ["Yes", "No"] }),
        field("f10", HOURS, { type: "radio", options: ["20", "40"] }),
        // The same autocomplete over a fixed list: its arrow button shows every choice.
        field("f11", OFFICE, {
          type: "select",
          options: ["Amsterdam", "Berlin", "Dublin", "Lagos", "Lisbon", "London", "Nairobi", "New York", "None, fully remote", "Paris"],
        }),
        field("f12", "Why Fixture Labs?", { type: "textarea" }),
      ]);
      // Nothing was typed, so nothing was searched for — and nothing was saved to the server.
      expect(searches).toEqual([]);
      expect(saves).toEqual([]);
    });

    test("reports a sign-in wall and none of its inputs", async () => {
      const operator = launch();
      expect(await operator.inspect(job("login"))).toEqual({
        url: `${base}/login`, fields: [], blockers: ["login"], passiveCaptcha: false,
      });
      // The password box alone is enough; the address need not say "login".
      expect(await operator.inspect(job("account/session"))).toMatchObject({ fields: [], blockers: ["login"] });
    });

    test("reports a one-time-code prompt", async () => {
      expect(await launch().inspect(job("verify"))).toMatchObject({ fields: [], blockers: ["mfa"] });
    });

    test("tells a CAPTCHA someone must solve from a check that runs by itself", async () => {
      const operator = launch();
      // A site key in an inline script and nothing on screen: passive.
      const silent = await operator.inspect(job("invisible"));
      expect(silent).toMatchObject({ blockers: [], passiveCaptcha: true });
      expect(silent.fields.map((entry) => entry.label)).toEqual(["Full name", "Email", "GitHub"]);
      // A challenge frame parked off-screen until it is needed: passive, for now.
      expect(await operator.inspect(job("puzzle"))).toMatchObject({ blockers: [], passiveCaptcha: true });
      // A rendered "I'm not a robot" checkbox: a blocker.
      expect(await operator.inspect(job("widget"))).toMatchObject({ blockers: ["captcha"], passiveCaptcha: false });
      // The same checkbox arriving 600 ms after the form: waited for, not mistaken for nothing.
      expect(await operator.inspect(job("widget?late"))).toMatchObject({ blockers: ["captcha"], passiveCaptcha: false });
      // No CAPTCHA at all.
      expect(await operator.inspect(job("clean"))).toMatchObject({ blockers: [], passiveCaptcha: false });
    });

    test("with strictCaptcha a passive check is reported as a blocker", async () => {
      const strict = launch({ strictCaptcha: true });
      expect(await strict.inspect(job("invisible"))).toMatchObject({ blockers: ["captcha"], passiveCaptcha: true });
      expect(await strict.inspect(job("clean"))).toMatchObject({ blockers: [], passiveCaptcha: false });
    });

    test("follows a posting's Apply link once — not 'Apply with LinkedIn', not the newsletter box", async () => {
      const schema = await launch().inspect(job("posting"));
      expect(schema.url).toBe(`${base}/lever`);
      expect(schema.fields[1].label).toBe("Full name");
      // The posting talks about "two-factor authentication"; that is not an MFA prompt.
      expect(schema.blockers).toEqual([]);
      expect(gets).toEqual(["/posting", "/lever"]);
    });

    test("finds a form embedded in an iframe", async () => {
      const schema = await launch().inspect(job("embedded"));
      expect(schema.fields.map((entry) => entry.label)).toEqual([
        "Full name", "Email address", "Where are you based?", "GitHub", "Resume (PDF)", "Cover letter",
        "Anything else you would like us to know?",
      ]);
    });

    test("returns no fields for a page without a form, and rejects for a page that cannot be opened", async () => {
      const operator = launch({ formWaitMs: 20_000 });
      const started = Date.now();
      expect(await operator.inspect(job("closed"))).toEqual({
        url: `${base}/closed`, fields: [], blockers: [], passiveCaptcha: false,
      });
      // The page says the position is filled, so the full wait for a late form is not spent on it.
      expect(Date.now() - started).toBeLessThan(10_000);
      await expect(operator.inspect(job(deadUrl))).rejects.toThrow(/ERR_CONNECTION_REFUSED/);
      // Still usable afterwards.
      expect((await operator.inspect(job("clean"))).fields).toHaveLength(7);
    });
  });

  // ---------- assisted apply ----------

  describe("assisted apply", () => {
    test("fills a Greenhouse-style form — dropdowns included — and leaves the rest and Submit to the user", async () => {
      const operator = assisted();
      const report = await operator.apply(job("greenhouse"), draft(), profile);

      expect(report.status).toBe("handed_off");
      expect(report.reason).toBe(`Required question not answered: ${WORK_AUTH} — left open in Chrome, no confirmation within 2 s`);
      expect(report.blockers).toEqual([]);
      expect(report.passiveCaptcha).toBe(true);
      expect(report.filled).toEqual([
        "First Name", "Last Name", "Email", "Country", "Phone", "Location (City)", "Resume/CV", "Cover Letter", "LinkedIn Profile",
        RESIDENCE,
      ]);
      expect(report.unfilled).toEqual([PREFERRED, WORK_AUTH]);
      expect(report.requiredUnfilled).toEqual([WORK_AUTH]);

      const page = handedPage(operator, "/greenhouse");
      expect(await page.locator("#first_name").inputValue()).toBe("Amina");
      expect(await page.locator("#last_name").inputValue()).toBe("Ngono Tabi");
      expect(await page.locator("#email").inputValue()).toBe("amina@example.com");
      expect(await page.locator("#phone").inputValue()).toBe("+237 650 000 000");
      expect(await page.locator("#question_1").inputValue()).toBe("https://www.linkedin.com/in/amina-tabi");
      expect(await attachedTo(page, "#resume")).toEqual(["resume.pdf"]);
      // The cover note went into the textarea behind "Enter manually", not into the file input.
      expect(await page.locator("#cover_letter_text").inputValue()).toBe(PITCH);
      expect(await attachedTo(page, "#cover_letter")).toEqual([]);
      // The two dropdowns the verified facts answer: the phone's country (the option
      // carries the dial code, which matches the number on file) and the country of residence.
      expect(await page.locator('[data-select="country"] .select__single-value').innerText()).toBe("Cameroon +237");
      expect(await page.locator('[name="country"]').inputValue()).toBe("Cameroon +237");
      expect(await page.locator('[data-select="question_4"] .select__single-value').innerText()).toBe("Cameroon");
      // The location search: "Douala" was typed (the city — the box only lists results
      // that contain what is typed), and of the seven places the geocoder offered, the
      // one that is Douala in Cameroon was clicked. It is listed twice; the first is taken.
      expect(searches).toEqual(["Douala"]);
      expect(await page.locator('[data-select="candidate-location"] .select__single-value').innerText()).toBe("Douala, Littoral Province, Cameroon");
      expect(JSON.parse(await page.locator('[name="candidate_location"]').inputValue())).toEqual({
        label: "Douala, Littoral Province, Cameroon", value: "421189877",
      });
      expect(await page.locator("#candidate-location").inputValue()).toBe("");
      // Untouched: the custom question, the work-authorization dropdown and the bot trap.
      // No dropdown is left open.
      expect(await page.locator("#question_2").inputValue()).toBe("");
      expect(await page.locator('[name="question_3"]').inputValue()).toBe("");
      expect(await page.locator("#website_hp").inputValue()).toBe("");
      expect(await page.locator(".select__menu").count()).toBe(0);

      expect(notes).toEqual(["Fixture Labs — Senior Engineer is filled in. Review it in Chrome and press Submit. 2 questions are left for you."]);
      expect(posts).toEqual([]);
    });

    test("a location search box takes the place itself when it is offered", async () => {
      // Greenhouse words a place without a region as "City, Country": exactly the verified location.
      const operator = assisted();
      const report = await operator.apply(job("greenhouse"), draft(), { ...profile, location: "Kribi, Cameroon (UTC+1)" });
      expect(report.filled).toContain("Location (City)");
      expect(searches).toEqual(["Kribi"]);
      const page = handedPage(operator, "/greenhouse");
      expect(await page.locator('[data-select="candidate-location"] .select__single-value').innerText()).toBe("Kribi, Cameroon");
    });

    test("a location search box is left empty when the place is offered twice over, or not at all", async () => {
      const operator = assisted();
      // Two different Springfields in the United States; no Bamenda anywhere.
      for (const location of ["Springfield, United States", "Bamenda, Cameroon"]) {
        searches.length = 0;
        const report = await operator.apply(job("greenhouse"), draft(), { ...profile, location });
        expect(report.unfilled).toContain("Location (City)");
        // The city was tried, then the whole place, then the country alone; no search was allowed
        // to settle for a near miss, and none offered the country by itself.
        expect(searches).toEqual([location.split(",")[0], location, location.split(",")[1].trim()]);
        const page = operator.session.pages().filter((candidate) => candidate.url().includes("/greenhouse")).at(-1) as Page;
        expect(await page.locator('[data-select="candidate-location"] .select__single-value').count()).toBe(0);
        expect(await page.locator('[name="candidate_location"]').inputValue()).toBe("");
        expect(await page.locator("#candidate-location").inputValue()).toBe("");
        expect(await page.locator(".select__menu").count()).toBe(0);
        // "Locate me" asks the browser where the device is. It was not pressed instead.
        expect(await page.locator("#locate-me").getAttribute("data-pressed")).toBeNull();
        // Everything else was still filled.
        expect(await page.locator("#email").inputValue()).toBe("amina@example.com");
      }
    });

    test("a phone-country dropdown is left alone when the number on file has another dial code", async () => {
      const operator = assisted();
      const report = await operator.apply(job("greenhouse"), draft(), { ...profile, phone: "+33 6 12 34 56 78" });
      expect(report.unfilled).toContain("Country");
      expect(report.filled).toContain(RESIDENCE);
      const page = handedPage(operator, "/greenhouse");
      expect(await page.locator('[name="country"]').inputValue()).toBe("");
    });

    test("a Lever-style form: the location is typed and the matching suggestion picked, and the resume parser does not win", async () => {
      const operator = assisted({ autoSubmit: true });
      const report = await operator.apply(job("lever"), draft(), profile);

      // Lever's hCaptcha is invisible, so it is not what stops this: the unanswered question is.
      expect(report).toMatchObject({ status: "handed_off", blockers: [], passiveCaptcha: true, requiredUnfilled: [LEVER_SPONSORSHIP] });
      expect(report.reason).toMatch(/^Required question not answered: Will you now or in the future require sponsorship/);
      expect(report.filled).toEqual([
        "Resume/CV", "Full name", "Email", "Phone", "Current location", "LinkedIn URL", "GitHub URL", "Additional information",
      ]);
      expect(report.unfilled).toEqual([
        "Current company", "Portfolio URL", "Language Skill(s) (Check all that apply)",
        "Preferred Name | What would you like us to call you?", LEVER_SPONSORSHIP, "Why do you want to work at Fixture Labs?",
      ]);
      expect(posts).toEqual([]);

      const page = handedPage(operator, "/lever");
      // The fixture's parser (Lever's logic) answered with another name, email and
      // city; what is on the form is still what is on file.
      expect(parses).toBe(1);
      expect(await page.locator('[name="name"]').inputValue()).toBe("Amina Ngono Tabi");
      expect(await page.locator('[name="email"]').inputValue()).toBe("amina@example.com");
      expect(await page.locator('[name="phone"]').inputValue()).toBe("+237 650 000 000");
      // "Douala" was typed — before the upload and again after it, because the parser
      // had overwritten the pick; of the two suggestions only one is Douala in Cameroon.
      expect(searches).toEqual(["Douala", "Douala"]);
      expect(await page.locator('[name="location"]').inputValue()).toBe("Douala, Littoral, Cameroon");
      expect(JSON.parse(await page.locator('[name="selectedLocation"]').inputValue())).toEqual({
        name: "Douala, Littoral, Cameroon", id: "place-0",
      });
      expect(await page.locator('[name="urls[LinkedIn]"]').inputValue()).toBe("https://www.linkedin.com/in/amina-tabi");
      expect(await page.locator('[name="urls[GitHub]"]').inputValue()).toBe("https://github.com/amina-tabi");
      expect(await page.locator('[name="comments"]').inputValue()).toBe(PITCH);
      expect(await attachedTo(page, "#resume-upload-input")).toEqual(["resume.pdf"]);
      // The portfolio fact is still CHANGE_ME, so the field stays empty.
      expect(await page.locator('[name="urls[Portfolio]"]').inputValue()).toBe("");
      expect(await page.locator('[name="cards[ce72][field0]"]').inputValue()).toBe("");
      expect(await page.locator("input[type=radio]:checked, input[type=checkbox]:checked").count()).toBe(0);
      expect(await page.content()).not.toContain(`value="${PLACEHOLDER}"`);
    });

    test("a location with no matching suggestion, or two, is left empty for the user", async () => {
      const operator = assisted();
      // No resume on these drafts: Lever's parser would otherwise put the resume's own city in the box.
      for (const location of ["Cameroon (UTC+1)", "Springfield, United States"]) {
        const report = await operator.apply(job("lever"), draft({ resumePdfPath: "" }), { ...profile, location });
        expect(report.unfilled).toContain("Current location");
        const page = operator.session.pages().filter((candidate) => candidate.url().includes("/lever")).at(-1) as Page;
        expect(await page.locator('[name="location"]').inputValue()).toBe("");
        expect(await page.locator('[name="selectedLocation"]').inputValue()).toBe("");
        expect(await page.locator('[name="name"]').inputValue()).toBe("Amina Ngono Tabi");
      }
      // Each was searched for by its place alone (the timezone note is not part of it) —
      // the city first, then the whole place, then the country; no search offered one unambiguous match.
      expect(searches).toEqual(["Cameroon", "Springfield", "Springfield, United States", "United States"]);
    });

    test("the city the resume parser guessed is never left standing in for the verified one", async () => {
      // Springfield is ambiguous, so nothing is picked. The parser then writes "Yaoundé"
      // into the box; trying again after the upload clears that out, and the question
      // is handed over empty rather than answered by a guess nobody verified.
      const operator = assisted();
      const report = await operator.apply(job("lever"), draft(), { ...profile, location: "Springfield, United States" });
      expect(parses).toBe(1);
      expect(report.requiredUnfilled).toContain("Current location");
      const page = handedPage(operator, "/lever");
      expect(await page.locator('[name="location"]').inputValue()).toBe("");
      expect(await page.locator('[name="selectedLocation"]').inputValue()).toBe("");
    });

    test("reports submitted once the user has pressed Submit and the confirmation page shows", async () => {
      const evidenceDir = path.join(tmp, "evidence-assisted");
      const operator = assisted({ handoffTimeoutMs: 30_000, evidenceDir });
      const target = job("clean");
      const pending = operator.apply(target, draft(), profile);

      await vi.waitFor(told("is filled in"), { timeout: 20_000 });
      expect(posts).toEqual([]);
      // What the user does next.
      await handedPage(operator, "/clean").locator("input[type=submit]").click();

      const report = await pending;
      expect(report).toMatchObject({ status: "submitted", reason: "", requiredUnfilled: [] });
      expect(report.unfilled).toEqual(["Anything else you would like us to know?"]);
      expect(posts).toHaveLength(1);
      expect(posts[0].fields).toMatchObject({
        name: "Amina Ngono Tabi", email: "amina@example.com", location: "Douala, Cameroon",
        github: "https://github.com/amina-tabi", notes: "",
      });
      expect(posts[0].fields.cover_letter.replace(/\r\n/g, "\n")).toBe(PITCH);
      expect(posts[0].files.resume).toEqual({ filename: "resume.pdf", size: fs.statSync(resume).size });
      expect(report.evidencePath).toBe(path.join(evidenceDir, `${target.id}.png`));
      expect(fs.existsSync(report.evidencePath as string)).toBe(true);
      // The user pressed Submit, not the operator: there is no "what the operator sent" shot.
      expect(report.formEvidencePath).toBeUndefined();

      // The confirmation stays on screen for the user, until the next job needs the window.
      expect(operator.session.pages().map((page) => page.url())).toEqual([`${base}/confirmation`]);
      await operator.inspect(job("closed"));
      expect(operator.session.pages().map((page) => page.url())).toEqual(["about:blank"]);
    });

    test("a sign-in wall is surfaced, never typed into, and handed off when nobody signs in", async () => {
      const operator = assisted();
      const report = await operator.apply(job("login"), draft(), profile);

      expect(report).toMatchObject({ status: "handed_off", blockers: ["login"], filled: [], unfilled: [] });
      expect(report.reason).toBe("Login required — the form did not appear within 2 s");
      expect(notes).toEqual(["Sign-in needed for Fixture Labs — finish it in Chrome and the form will be filled"]);
      const page = handedPage(operator, "/login");
      expect(await page.locator("#user_email").inputValue()).toBe("");
      expect(await page.locator("#user_password").inputValue()).toBe("");
      expect(posts).toEqual([]);
    });

    test("once the user is past the sign-in wall the form behind it is filled", async () => {
      const operator = assisted({ handoffTimeoutMs: 30_000 });
      const pending = operator.apply(job("login"), draft(), profile);

      await vi.waitFor(told("Sign-in needed"), { timeout: 20_000 });
      // Stands in for the user signing in and being sent on to the application.
      await handedPage(operator, "/login").goto(`${base}/clean`);
      await vi.waitFor(told("is filled in"), { timeout: 20_000 });
      const page = handedPage(operator, "/clean");
      expect(await page.locator('[name="email"]').inputValue()).toBe("amina@example.com");
      await page.locator("input[type=submit]").click();

      expect(await pending).toMatchObject({ status: "submitted", blockers: [] });
      expect(posts.map((post) => post.from)).toEqual(["clean"]);
    });

    test("a visible CAPTCHA widget is never touched: the form is filled around it and handed over", async () => {
      const operator = assisted({ autoSubmit: true });
      const report = await operator.apply(job("widget"), draft(), profile);
      expect(report).toMatchObject({ status: "handed_off", blockers: ["captcha"], filled: ["Full name", "Email", "GitHub"] });
      expect(report.reason).toMatch(/^CAPTCHA on the form — left open in Chrome/);
      expect(posts).toEqual([]);
    });

    test("a visible window with auto-submit on submits a clean form by itself", async () => {
      const report = await assisted({ autoSubmit: true, handoffTimeoutMs: 30_000 }).apply(job("clean"), draft(), profile);
      expect(report).toMatchObject({ status: "submitted", reason: "" });
      expect(posts.map((post) => post.from)).toEqual(["clean"]);
      // Nobody was needed, so nobody was pinged.
      expect(notes).toEqual([]);
    });

    test("when its own Submit brings no confirmation it says so and leaves the window to the user", async () => {
      const operator = assisted({ autoSubmit: true });
      const report = await operator.apply(job("stuck"), draft(), profile);
      expect(report.status).toBe("handed_off");
      expect(report.reason).toMatch(/^Submit was pressed but no confirmation page appeared — check before re-applying — left open in Chrome/);
      expect(notes).toEqual([
        "Fixture Labs — Senior Engineer: Submit was pressed but no confirmation page appeared — check before re-applying. Have a look in Chrome.",
      ]);
      // Pressed once, not again while waiting.
      expect(posts.map((post) => post.path)).toEqual(["/stuck"]);
    });

    test("closing the window ends the hand-off", async () => {
      const operator = assisted({ handoffTimeoutMs: 30_000 });
      const pending = operator.apply(job("clean"), draft(), profile);
      await vi.waitFor(told("is filled in"), { timeout: 20_000 });
      await handedPage(operator, "/clean").close();

      expect(await pending).toMatchObject({
        status: "handed_off", reason: "Filled in for your review — the window was closed before a confirmation appeared",
      });
      expect(posts).toEqual([]);
    });
  });

  // ---------- hands-free (auto) apply ----------

  describe("auto apply", () => {
    test("types only the code the candidate approved, and finishes the application", async () => {
      const asked: boolean[] = [];
      const report = await auto({
        askForCode: async (_target, retry) => { asked.push(retry); return "123456"; },
      }).apply(job("emailed-code"), draft(), profile);
      expect(report.status).toBe("submitted");
      expect(asked).toEqual([false]);
      expect(posts.map((post) => post.path)).toEqual(["/emailed-code", "/emailed-code-verify"]);
      expect(posts[1].fields.verification_code).toBe("123456");
    });

    test("with nobody to approve a code, holds the application at once: nothing went out", async () => {
      const operator = auto();
      const report = await operator.apply(job("emailed-code"), draft(), profile);
      expect(report).toMatchObject({
        status: "handed_off", emailedCode: true, pressed: false,
        reason: "Not submitted: after Submit the site emailed you a code to confirm a person is applying",
      });
      expect(posts.map((post) => post.path)).toEqual(["/emailed-code"]);
    });

    test("holds the application when no code is approved, and releases the page", async () => {
      const operator = auto({ askForCode: async () => null });
      const report = await operator.apply(job("emailed-code"), draft(), profile);
      expect(report).toMatchObject({
        status: "handed_off", emailedCode: true, pressed: false, reason: expect.stringContaining("no emailed code was approved"),
      });
      // Released: the last tab is blanked, not closed, as after any other job.
      expect(operator.session.pages().map((page) => page.url())).toEqual(["about:blank"]);
    });

    test("asks once more when the site turns a code down, then gives up", async () => {
      const asks: boolean[] = [];
      const report = await auto({
        askForCode: async (_target, retry) => { asks.push(retry); return "000000"; },
      }).apply(job("emailed-code"), draft(), profile);
      expect(report).toMatchObject({
        status: "handed_off", emailedCode: true, pressed: false, reason: expect.stringContaining("turned down the emailed code"),
      });
      expect(asks).toEqual([false, true]);
      expect(posts.map((post) => post.fields.verification_code)).toEqual([undefined, "000000", "000000"]);
    });

    test("submits a clean form and keeps screenshots of what it sent and of the confirmation", async () => {
      const evidenceDir = path.join(tmp, "evidence-auto");
      const target = job("clean");
      const report = await auto({ evidenceDir }).apply(target, draft(), profile);

      expect(report).toEqual({
        status: "submitted",
        reason: "",
        filled: ["Full name", "Email address", "Where are you based?", "GitHub", "Resume (PDF)", "Cover letter"],
        // Optional and unanswered: listed, but it does not hold the submission back.
        unfilled: ["Anything else you would like us to know?"],
        requiredUnfilled: [],
        blockers: [],
        passiveCaptcha: false,
        pressed: true,
        formEvidencePath: path.join(evidenceDir, `${target.id}-form.png`),
        evidencePath: path.join(evidenceDir, `${target.id}.png`),
      });
      // Two different pictures: the filled form as it went out, then the confirmation page.
      const formShot = fs.readFileSync(report.formEvidencePath as string);
      const confirmationShot = fs.readFileSync(report.evidencePath as string);
      expect(formShot.subarray(0, 8)).toEqual(PNG);
      expect(confirmationShot.subarray(0, 8)).toEqual(PNG);
      expect(formShot.equals(confirmationShot)).toBe(false);
      expect(posts).toHaveLength(1);
      expect(posts[0]).toMatchObject({
        from: "clean",
        fields: { name: "Amina Ngono Tabi", email: "amina@example.com", location: "Douala, Cameroon", notes: "" },
        files: { resume: { filename: "resume.pdf" } },
      });
      expect(notes).toEqual([]);
    });

    test("a screenshot that cannot be saved never stops a submission", async () => {
      // A file where the evidence folder should be: nothing can be written under it.
      const blocked = path.join(tmp, "not-a-folder");
      fs.writeFileSync(blocked, "");
      const report = await auto({ evidenceDir: blocked }).apply(job("clean"), draft(), profile);
      expect(report).toMatchObject({ status: "submitted", reason: "" });
      expect(report.formEvidencePath).toBeUndefined();
      expect(report.evidencePath).toBeUndefined();
      expect(posts).toHaveLength(1);
    });

    test("screening answers fill the custom questions they were written for", async () => {
      const prepared = draft({ screeningAnswers: [answer(YEARS, "9"), answer(NOTICE, "2 weeks"), answer(SPONSORSHIP, "No")] });
      const report = await auto().apply(job("custom"), prepared, profile);

      expect(report).toMatchObject({ status: "submitted", requiredUnfilled: [] });
      expect(report.filled).toEqual(["Full name", "Email", "Resume", YEARS, NOTICE, SPONSORSHIP]);
      expect(report.unfilled).toEqual(["Which engagement do you prefer?", "Anything we should know about your setup?"]);
      expect(posts).toHaveLength(1);
      // The text answer was typed; each choice is the option the answer named.
      expect(posts[0].fields).toMatchObject({ years: "9", notice: "2w", sponsorship: "no", setup: "" });
      expect(posts[0].fields).not.toHaveProperty("engagement");
    });

    test("a required question with no answer stops it at once, before anything is typed", async () => {
      const started = Date.now();
      const prepared = draft({ screeningAnswers: [answer(NOTICE, "2 weeks"), answer(SPONSORSHIP, "No")] });
      const report = await auto().apply(job("custom"), prepared, profile);

      expect(report).toMatchObject({
        status: "handed_off",
        reason: `Required question not answered: ${YEARS}`,
        filled: [],
        requiredUnfilled: [YEARS],
        blockers: [],
      });
      expect(report.unfilled).toEqual([YEARS, "Which engagement do you prefer?", "Anything we should know about your setup?"]);
      expect(Date.now() - started).toBeLessThan(15_000);
      expect(notes).toEqual([`Fixture Labs — Senior Engineer needs you: Required question not answered: ${YEARS}`]);
      expect(posts).toEqual([]);
    });

    test("a sensitive question is only answered on an exact question and option match", async () => {
      const operator = auto();
      // Right question, but "Not at this time" is not one of Yes / No.
      const vague = draft({ screeningAnswers: [answer(YEARS, "9"), answer(SPONSORSHIP, "Not at this time")] });
      expect(await operator.apply(job("custom"), vague, profile)).toMatchObject({
        status: "handed_off", requiredUnfilled: [SPONSORSHIP], reason: `Required question not answered: ${SPONSORSHIP}`,
      });
      // Right answer, but written for a differently worded question.
      const reworded = draft({ screeningAnswers: [answer(YEARS, "9"), answer("Do you require visa sponsorship?", "No")] });
      expect(await operator.apply(job("custom"), reworded, profile)).toMatchObject({
        status: "handed_off", requiredUnfilled: [SPONSORSHIP],
      });
      expect(posts).toEqual([]);

      const exact = draft({ screeningAnswers: [answer(YEARS, "9"), answer(`${SPONSORSHIP} *`, "no")] });
      expect(await operator.apply(job("custom"), exact, profile)).toMatchObject({ status: "submitted" });
      expect(posts).toHaveLength(1);
      expect(posts[0].fields).toMatchObject({ sponsorship: "no", notice: "" });
    });

    test("a Greenhouse-style form goes through its passive check once every required dropdown has an answer", async () => {
      const operator = auto();
      expect(await operator.apply(job("greenhouse"), draft(), profile)).toMatchObject({
        status: "handed_off", reason: `Required question not answered: ${WORK_AUTH}`, requiredUnfilled: [WORK_AUTH], filled: [],
      });
      expect(posts).toEqual([]);

      const report = await operator.apply(job("greenhouse"), draft({ screeningAnswers: [answer(WORK_AUTH, "yes")] }), profile);
      expect(report).toMatchObject({ status: "submitted", requiredUnfilled: [], blockers: [], passiveCaptcha: true });
      // The cover letter was pasted into the textarea, so its (optional) file input is not "left".
      expect(report.unfilled).toEqual([PREFERRED]);
      // Each dropdown was set by clicking the option with exactly that text.
      expect(posts[0].fields).toMatchObject({
        country: "Cameroon +237", question_3: "Yes", question_4: "Cameroon", question_2: "", website_hp: "",
      });
      // The location was picked from the search, and was still the pick after the resume went up.
      expect(JSON.parse(posts[0].fields.candidate_location)).toEqual({ label: "Douala, Littoral Province, Cameroon", value: "421189877" });
      expect(posts[0].fields.cover_letter_text.replace(/\r\n/g, "\n")).toBe(PITCH);
      expect(posts[0].files).toEqual({ resume: { filename: "resume.pdf", size: fs.statSync(resume).size } });
    });

    test("a Greenhouse-style form whose required location cannot be picked is not typed into at all", async () => {
      const prepared = draft({ screeningAnswers: [answer(WORK_AUTH, "Yes")] });
      const report = await auto().apply(job("greenhouse?location=required"), prepared, { ...profile, location: "Bamenda, Cameroon" });

      expect(report).toMatchObject({
        status: "handed_off", reason: "Required question not answered: Location (City)", filled: [],
        requiredUnfilled: ["Location (City)"],
      });
      // The search was tried — the city, the whole place, the country — and that is all that happened.
      expect(searches).toEqual(["Bamenda", "Bamenda, Cameroon", "Cameroon"]);
      expect(posts).toEqual([]);

      // The same form, the same answers, a place the search does offer: it goes through.
      expect(await auto().apply(job("greenhouse?location=required"), prepared, profile)).toMatchObject({ status: "submitted" });
    });

    test("a dropdown answer that is not one of its options is never rounded to the nearest", async () => {
      const report = await auto().apply(job("greenhouse"), draft({ screeningAnswers: [answer(WORK_AUTH, "Yes, with a permit")] }), profile);
      expect(report).toMatchObject({ status: "handed_off", requiredUnfilled: [WORK_AUTH], filled: [] });
      expect(posts).toEqual([]);
    });

    test("an Ashby-style page: location search, Yes/No buttons, form-less submit, in-place confirmation, and a resume parser that must not win", async () => {
      const prepared = draft({
        screeningAnswers: [
          answer(ADULT, "Yes"), answer(B2B, "no"), answer(HOURS, "40"), answer(OFFICE, "lisbon"),
          answer("Why Fixture Labs?", "Because fixtures never lie."),
        ],
      });
      const report = await auto().apply(job("ashby"), prepared, profile);

      expect(report).toMatchObject({ status: "submitted", requiredUnfilled: [], blockers: [], passiveCaptcha: true });
      expect(report.filled).toEqual([
        "Legal Name", "Email", "Resume", "Location", "Country of Residence", ADULT, "Linkedin", B2B, HOURS, OFFICE, "Why Fixture Labs?",
      ]);
      // The autofill drop zone is skipped on purpose.
      expect(report.unfilled).toEqual(["Autofill from resume"]);
      expect(posts).toHaveLength(1);
      // The fixture overwrites name and email the moment a resume is chosen, as Ashby's
      // parser does; attaching first and typing afterwards keeps the verified values.
      expect(posts[0].fields).toEqual({
        name: "Amina Ngono Tabi",
        email: "amina@example.com",
        location: "Douala, Littoral, Cameroon",
        // A choice with more than eight options is the same autocomplete over a fixed list.
        office: "Lisbon",
        country: "Cameroon",
        adult: "yes",
        linkedin: "https://www.linkedin.com/in/amina-tabi",
        b2b: "no",
        hours: "40",
        why: "Because fixtures never lie.",
        autofill_files: "0",
      });
      expect(posts[0].files.resume.filename).toBe("resume.pdf");

      // Ashby saves every answer as it is given. The location was searched for by its
      // city and saved first — before anything else on the form was touched — and
      // only once: it still held after the resume upload, so it was not picked again.
      expect(searches).toEqual(["Douala"]);
      expect(saves[0]).toEqual(["_systemfield_location", { text: "Douala, Littoral, Cameroon", providerLocationId: "geo-0-2" }]);
      expect(saves.filter(([path]) => path === "_systemfield_location")).toHaveLength(1);
      expect(saves.map(([path]) => path)).toContain("_systemfield_name");
    });

    test("an Ashby-style page with a required Yes/No nobody answered is not typed into at all", async () => {
      const report = await auto().apply(job("ashby"), draft(), profile);
      expect(report).toMatchObject({
        status: "handed_off", reason: `Required question not answered: ${ADULT}`, filled: [], requiredUnfilled: [ADULT],
      });
      // Not even the location search was started: the plan alone showed the form could not be completed.
      expect(searches).toEqual([]);
      expect(saves).toEqual([]);
      expect(posts).toEqual([]);
    });

    test("an Ashby-style page whose required location cannot be picked has nothing saved to it", async () => {
      const prepared = draft({ screeningAnswers: [answer(ADULT, "Yes")] });
      // Two Kumbas are offered for Cameroon, and no Bamenda at all.
      for (const location of ["Kumba, Cameroon", "Bamenda, Cameroon"]) {
        searches.length = 0;
        const report = await auto().apply(job("ashby"), prepared, { ...profile, location });
        expect(report).toMatchObject({
          status: "handed_off", reason: "Required question not answered: Location", filled: [], requiredUnfilled: ["Location"],
        });
        // The place was searched for, city first, country last; no suggestion was the place, so none was taken.
        expect(searches).toEqual([location.split(",")[0], location, "Cameroon"]);
      }
      // Searching is not answering: the box was left by walking away from it, never
      // emptied by hand, so not one value — not even "no location" — reached the server.
      expect(saves).toEqual([]);
      expect(posts).toEqual([]);
    });

    test("a Lever-style form is submitted through its invisible hCaptcha once it is complete", async () => {
      const report = await auto().apply(job("lever"), draft({ screeningAnswers: [answer(LEVER_SPONSORSHIP, "No")] }), profile);

      expect(report).toMatchObject({ status: "submitted", blockers: [], passiveCaptcha: true, requiredUnfilled: [] });
      expect(posts).toHaveLength(1);
      expect(posts[0].fields).toMatchObject({
        name: "Amina Ngono Tabi",
        email: "amina@example.com",
        phone: "+237 650 000 000",
        location: "Douala, Littoral, Cameroon",
        org: "",
        "urls[LinkedIn]": "https://www.linkedin.com/in/amina-tabi",
        "urls[Portfolio]": "",
        "cards[1c71][field1]": "No",
        // Granted by the page's own script when its Submit button was pressed; the operator never touches it.
        "h-captcha-response": "fixture-token",
      });
      expect(JSON.parse(posts[0].fields.selectedLocation)).toEqual({ name: "Douala, Littoral, Cameroon", id: "place-0" });
      expect(posts[0].fields.comments.replace(/\r\n/g, "\n")).toBe(PITCH);
    });

    test("a Lever-style form whose required location finds no suggestion is abandoned before anything else is typed", async () => {
      const elsewhere = { ...profile, location: "Cameroon (UTC+1)" };
      const report = await auto().apply(job("lever"), draft({ screeningAnswers: [answer(LEVER_SPONSORSHIP, "No")] }), elsewhere);

      expect(report).toMatchObject({
        status: "handed_off", reason: "Required question not answered: Current location", filled: [],
        requiredUnfilled: ["Current location"],
      });
      // Only the location search was used: no resume went to the parser, nothing was posted.
      expect(searches.length).toBeGreaterThan(0);
      expect(parses).toBe(0);
      expect(posts).toEqual([]);
    });

    test("a CAPTCHA someone must solve hands off immediately instead of waiting for a user who cannot see the window", async () => {
      const operator = auto();
      for (const fixture of ["widget", "widget?late"]) {
        const started = Date.now();
        const report = await operator.apply(job(fixture), draft(), profile);
        expect(report).toMatchObject({
          status: "handed_off", reason: "CAPTCHA on the form", blockers: ["captcha"], passiveCaptcha: false, filled: [],
        });
        // Nothing was sent: the pipeline may set it aside and move on to the next role.
        expect(report.pressed).toBeUndefined();
        // handoffTimeoutMs is a minute here; this must not come anywhere near it.
        expect(Date.now() - started).toBeLessThan(15_000);
      }
      expect(notes).toEqual(Array(2).fill("Fixture Labs — Senior Engineer needs you: CAPTCHA on the form"));
      expect(posts).toEqual([]);
    });

    test("a passive check does not stop a submission — unless strictCaptcha says it should", async () => {
      expect(await auto().apply(job("invisible"), draft(), profile)).toMatchObject({
        status: "submitted", blockers: [], passiveCaptcha: true,
      });
      expect(posts.map((post) => post.from)).toEqual(["invisible"]);

      const report = await auto({ strictCaptcha: true }).apply(job("invisible"), draft(), profile);
      expect(report).toMatchObject({
        status: "handed_off", reason: "CAPTCHA on the form", blockers: ["captcha"], passiveCaptcha: true, filled: [],
      });
      // Still only the one submission, from the run that was allowed to make it.
      expect(posts).toHaveLength(1);
    });

    test("Submit waits for the resume to finish uploading, and is never pressed over an upload that stalls", async () => {
      const done = await auto().apply(job("uploading"), draft(), profile);
      expect(done.status).toBe("submitted");
      expect(posts.filter((post) => post.from === "uploading")).toHaveLength(1);

      posts.length = 0;
      const stalled = await auto({ uploadWaitMs: 1_500 }).apply(job("uploading?stall"), draft(), profile);
      expect(stalled).toMatchObject({ status: "failed", reason: "Not submitted: the CV upload did not finish within 2 s" });
      expect(stalled.pressed).toBeFalsy();
      expect(posts).toEqual([]);
    });

    test("on Ashby, Submit waits while the spinner beside the resume's name turns", async () => {
      const done = await auto().apply(job("uploading-ashby"), draft(), profile);
      expect(done.status).toBe("submitted");
      // Sent once, and only after the file was up: Ashby keeps Submit enabled meanwhile.
      expect(posts.filter((post) => post.from === "uploading-ashby").map((post) => post.fields.upload_done)).toEqual(["yes"]);

      posts.length = 0;
      const stalled = await auto({ uploadWaitMs: 1_500 }).apply(job("uploading-ashby?stall"), draft(), profile);
      expect(stalled).toMatchObject({ status: "failed", reason: "Not submitted: the CV upload did not finish within 2 s" });
      expect(posts).toEqual([]);
    });

    test("a challenge that comes up after Submit is handed over, untouched", async () => {
      const evidenceDir = path.join(tmp, "evidence-challenge");
      const target = job("puzzle");
      const started = Date.now();
      const report = await auto({ evidenceDir, submitWaitMs: 30_000 }).apply(target, draft(), profile);

      expect(report).toMatchObject({
        status: "handed_off",
        reason: "Not submitted: a CAPTCHA challenge came up after Submit",
        blockers: ["captcha"],
        filled: ["Full name", "Email", "GitHub"],
        formEvidencePath: path.join(evidenceDir, `${target.id}-form.png`),
        evidencePath: path.join(evidenceDir, `${target.id}-unconfirmed.png`),
      });
      // Noticed as soon as it opened, not after waiting out submitWaitMs.
      expect(Date.now() - started).toBeLessThan(20_000);
      expect(posts).toEqual([]);
    });

    test("a submission the site refuses is reported in the site's own words", async () => {
      const report = await auto({ submitWaitMs: 30_000 }).apply(job("refused"), draft(), profile);
      expect(report).toMatchObject({
        status: "handed_off",
        reason: `The site refused the submission: "We couldn't submit your application Your application was flagged as possible spam."`,
        blockers: [],
      });
      // Sent once; the refusal is not retried.
      expect(posts.map((post) => post.path)).toEqual(["/refuse"]);
    });

    test("a sign-in wall or a code prompt hands off immediately with the reason", async () => {
      const operator = auto();
      const started = Date.now();
      expect(await operator.apply(job("login"), draft(), profile)).toMatchObject({
        status: "handed_off", reason: "Login required", blockers: ["login"], filled: [],
      });
      expect(await operator.apply(job("verify"), draft(), profile)).toMatchObject({
        status: "handed_off", reason: "MFA code required", blockers: ["mfa"],
      });
      expect(Date.now() - started).toBeLessThan(20_000);
      expect(notes).toEqual([
        "Fixture Labs — Senior Engineer needs you: Login required",
        "Fixture Labs — Senior Engineer needs you: MFA code required",
      ]);
      expect(posts).toEqual([]);
    });

    test("no confirmation after Submit is a hand-off, with a screenshot of what the page showed", async () => {
      const evidenceDir = path.join(tmp, "evidence-stuck");
      const target = job("stuck");
      const report = await auto({ evidenceDir }).apply(target, draft(), profile);

      expect(report).toMatchObject({
        status: "handed_off",
        reason: "Submit was pressed but no confirmation page appeared — check before re-applying",
        filled: ["Full name", "Email", "LinkedIn"],
        evidencePath: path.join(evidenceDir, `${target.id}-unconfirmed.png`),
        // The pipeline must not take this for an application that was never sent.
        pressed: true,
      });
      expect(fs.existsSync(report.evidencePath as string)).toBe(true);
      // Pressed exactly once.
      expect(posts.map((post) => post.path)).toEqual(["/stuck"]);
    });

    test("with auto-submit off a headless run types nothing for nobody: it says so and returns", async () => {
      const report = await launch({ handoffTimeoutMs: 60_000 }).apply(job("clean"), draft(), profile);
      expect(report).toMatchObject({
        status: "handed_off",
        reason: "Not submitted — auto-submit is off and nobody is at the window",
        filled: [],
        unfilled: ["Anything else you would like us to know?"],
      });
      expect(posts).toEqual([]);
    });

    test("submits a form embedded in an iframe and sees the confirmation inside it", async () => {
      const report = await auto().apply(job("embedded"), draft(), profile);
      expect(report).toMatchObject({ status: "submitted", requiredUnfilled: [] });
      expect(posts.map((post) => post.from)).toEqual(["clean"]);
    });

    test("an unreachable page, a page without a form and a non-web address fail — and the operator carries on", async () => {
      const operator = auto();
      const unreachable = await operator.apply(job(deadUrl), draft(), profile);
      expect(unreachable.status).toBe("failed");
      expect(unreachable.reason).toMatch(/ERR_CONNECTION_REFUSED/);
      expect(await operator.apply(job("closed"), draft(), profile)).toMatchObject({
        status: "failed", reason: 'The posting is not there: the page says "position has been filled"',
      });
      expect(await operator.apply(job("missing"), draft(), profile)).toMatchObject({
        status: "failed", reason: `No application form found at ${base}/missing (HTTP 404)`,
      });
      expect(await operator.apply(job("mailto:jobs@fixture.test"), draft(), profile)).toMatchObject({
        status: "failed", reason: "This job has no web application address",
      });
      // The same operator, the next job.
      expect(await operator.apply(job("clean"), draft(), profile)).toMatchObject({ status: "submitted" });
      expect(posts).toHaveLength(1);
    });
  });

  test("page probes run even when the compiler has wrapped their inner functions in __name()", async () => {
    // What esbuild's keepNames (tsx, which runs the CLI) does to every probe: it adds
    // calls to a helper that exists in Node but not in the page.
    const wrapped = new Function("return __name(function inner() { return 42; }, 'inner')();") as () => number;
    const page = await launch().session.newPage(true);
    expect(await runInPage(page.mainFrame(), wrapped)).toBe(42);
  });

  test("createOperator returns the operator and close() shuts Chrome down", async () => {
    const operator = createOperator({ profileDir: fs.mkdtempSync(path.join(tmp, "profile-")), headless: true, formWaitMs: 1_500 });
    try {
      expect((await operator.inspect(job("clean"))).fields).toHaveLength(7);
      // Chrome stays up between jobs, on a blank tab.
      expect((operator as ChromeOperator).session.pages().map((page) => page.url())).toEqual(["about:blank"]);
    } finally {
      await operator.close();
    }
    expect((operator as ChromeOperator).session.pages()).toEqual([]);
  });
});
