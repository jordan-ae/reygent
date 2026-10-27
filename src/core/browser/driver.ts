/**
 * Browser plumbing for the operator: one persistent Chrome profile, the page probes of
 * domExtractor.ts run inside it, and the handful of actions the operator is allowed to
 * take on a form (fill, choose, attach, and — only when told to — press Submit).
 *
 * Nothing here decides what goes into a field; that is fieldMap.ts. Nothing here gets
 * past a sign-in, an MFA prompt or a CAPTCHA either: they are reported, never touched.
 */

import fs from "node:fs";
import { type BrowserContext, type Frame, type Locator, type Page, chromium } from "playwright-core";

import {
  APPLY_ATTRIBUTE,
  CHOICE_ATTRIBUTE,
  FIELD_ATTRIBUTE,
  SUBMIT_ATTRIBUTE,
  TOGGLE_ATTRIBUTE,
  detectBlockers,
  detectConfirmation,
  detectEmailedCode,
  detectRefusal,
  detectUploadInProgress,
  extractFormFields,
  markApplyLink,
  markCoverLetterToggle,
  markDropdownOpener,
  markDropdownOption,
  markSubmitButton,
  pageSaysGone,
  readDropdown,
  readField,
  readSuggestions,
  rememberDropdown,
  selectOptionIndex,
  unreadDropdowns,
} from "@/core/browser/domExtractor";
import { pickSuggestion, searchTerms } from "@/core/browser/fieldMap";
import type { Blocker, FieldPlan, FormField } from "@/core/browser/types";

const NAVIGATION_TIMEOUT_MS = 45_000;
/** One click, fill or upload. Short, so a control that vanished costs seconds, not the default 30. */
const ACTION_TIMEOUT_MS = 5_000;
const PROBE_TIMEOUT_MS = 5_000;
/** Opening one dropdown. Shorter still: a form can have a dozen of them. */
const DROPDOWN_TIMEOUT_MS = 2_000;
/** How long an opened dropdown gets to show its list. */
const LIST_WAIT_MS = 1_200;
/** A type-ahead searches after a pause (Lever waits 500 ms) and then asks its server. */
const SUGGESTION_TIMEOUT_MS = 4_000;
/** How long a clicked suggestion may take to show in its box. */
const PICK_SETTLE_MS = 2_000;
/** How long an empty CAPTCHA container gets to show whether it is a widget or nothing. */
const CAPTCHA_SETTLE_MS = 4_000;
export const POLL_MS = 400;

const BLOCKER_ORDER: readonly Blocker[] = ["login", "mfa", "captcha"];
// Frames that are the CAPTCHA itself: never a place to look for a form.
export const CAPTCHA_FRAME = /recaptcha|hcaptcha\.com|challenges\.cloudflare\.com|arkoselabs|funcaptcha|captcha-delivery/i;

export const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function withTimeout<T>(work: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const expiry = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} did not finish within ${ms} ms`)), ms);
  });
  return Promise.race([work, expiry]).finally(() => clearTimeout(timer));
}

/**
 * Run one of the domExtractor probes inside `frame`.
 *
 * The probe is sent as source text rather than handed to Playwright as a function:
 * tsx (which runs the CLI) compiles with esbuild's keepNames, which wraps every inner
 * function in a `__name(...)` helper that does not exist in the page. Declaring a
 * no-op `__name` next to the probe makes the same source run under tsx, Vitest and
 * Next alike.
 */
export function runInPage<R>(frame: Frame, probe: () => R): Promise<R>;
export function runInPage<R, A>(frame: Frame, probe: (argument: A) => R, argument: A): Promise<R>;
export function runInPage<R, A>(frame: Frame, probe: (argument: A) => R, argument?: A): Promise<R> {
  const source =
    `(() => { const __name = (target) => target; ` +
    `return (${probe.toString()})(${JSON.stringify(argument ?? null)}); })()`;
  return withTimeout(frame.evaluate<R>(source), PROBE_TIMEOUT_MS, "page probe");
}

// ---------- Session ----------

/**
 * A lazily launched persistent Chrome context. A profile can be open in only one Chrome
 * at a time, so there is a single context and it is either visible or headless.
 */
export class BrowserSession {
  private readonly profileDir: string;
  private readonly channel: string;
  private context: BrowserContext | null = null;
  private headless = true;
  /** Finished pages left on screen until the next job opens. */
  private readonly lingering = new Set<Page>();

  constructor(profileDir: string, channel = "chrome") {
    this.profileDir = profileDir;
    this.channel = channel;
  }

  /** Pages currently open — the forms handed to the user among them. */
  pages(): Page[] {
    return this.context ? this.context.pages() : [];
  }

  /**
   * A fresh page in a context that is at least as visible as asked.
   *
   * A headless context is replaced when a visible one is needed. The reverse never
   * happens while a visible window has a tab open: the user may be half-way through a
   * form in it, and a headless read can use a visible window just as well.
   */
  async newPage(headless: boolean): Promise<Page> {
    const context = await this.acquire(headless);
    // A new persistent context opens with one empty tab; use it rather than leave it behind.
    const blank = context.pages().find((page) => page.url() === "about:blank");
    const page = blank ?? (await context.newPage());
    for (const old of this.lingering) await old.close().catch(() => undefined);
    this.lingering.clear();
    return page;
  }

  /**
   * Done with `page`, but leave it on screen until the next job opens: the user has
   * just pressed Submit and should get to read the confirmation they were waiting for.
   */
  linger(page: Page): void {
    this.lingering.add(page);
  }

  /**
   * Done with `page`. The last tab is blanked rather than closed: closing it would
   * take the window — and on some platforms Chrome itself — with it, and the next job
   * would have to launch the browser again.
   */
  async release(page: Page): Promise<void> {
    if (page.isClosed()) return;
    const others = this.context ? this.context.pages().filter((other) => other !== page && !other.isClosed()) : [];
    if (others.length > 0) await page.close().catch(() => undefined);
    else await page.goto("about:blank").catch(() => undefined);
  }

  private async acquire(headless: boolean): Promise<BrowserContext> {
    if (this.context) {
      const inUse = this.context.pages().some((page) => page.url() !== "about:blank");
      if (this.headless === headless || (!this.headless && inUse)) return this.context;
      await this.close();
    }
    fs.mkdirSync(this.profileDir, { recursive: true });
    // Launched as what it is. No user-agent override, no flag or script that hides
    // automation from the page: sites that check for it (every board's passive
    // CAPTCHA does) see an automated Chrome and decide for themselves. Do not "fix"
    // a refused submission by adding one — a refusal is an answer, and it is handed
    // to the user as such.
    const context = await chromium.launchPersistentContext(this.profileDir, {
      channel: this.channel,
      headless,
      // A visible window is the size the user makes it; headless gets a tall fixed one
      // so a whole form is laid out.
      viewport: headless ? { width: 1280, height: 1600 } : null,
      acceptDownloads: false,
    });
    context.setDefaultTimeout(ACTION_TIMEOUT_MS);
    context.setDefaultNavigationTimeout(NAVIGATION_TIMEOUT_MS);
    // The user can quit the window at any time; forget it so the next job relaunches.
    context.on("close", () => {
      if (this.context === context) this.context = null;
    });
    this.context = context;
    this.headless = headless;
    return context;
  }

  async close(): Promise<void> {
    const context = this.context;
    this.context = null;
    this.lingering.clear();
    if (context) await context.close().catch(() => undefined);
  }
}

// ---------- Finding the form ----------

export interface FormSnapshot {
  /** Address of the page the form was found on (after following an "Apply" link). */
  url: string;
  /** The frame that holds the form — a child frame when the ATS form is embedded. */
  frame: Frame;
  fields: FormField[];
  /** `captcha` only for a challenge a person must act on; see `passiveCaptcha`. */
  blockers: Blocker[];
  /** A CAPTCHA that shows nothing and runs by itself when Submit is pressed. */
  passiveCaptcha: boolean;
  /** HTTP status of the last navigation, when there was one. */
  status: number | null;
  /** What the page says when the posting is not there ("Page not found"), else "". */
  gone: string;
}

/** A blocker with no form behind it yet: a sign-in page, a code prompt, a full-page human check. */
export const isWall = (snapshot: FormSnapshot): boolean => snapshot.fields.length === 0 && snapshot.blockers.length > 0;

interface Scan extends FormSnapshot {
  /** A CAPTCHA container that has not rendered yet: widget or nothing, not known. */
  captchaPending: boolean;
}

/** Read the page as it is now: the form (in whichever frame has it) and the blockers. */
export async function scanPage(page: Page, status: number | null = null): Promise<Scan> {
  const main = page.mainFrame();
  let frame = main;
  let fields: FormField[] = [];

  for (const candidate of page.frames()) {
    if (candidate.isDetached() || CAPTCHA_FRAME.test(candidate.url())) continue;
    const found = await runInPage(candidate, extractFormFields).catch(() => []);
    // Strictly more: on a tie the main frame, scanned first, keeps the form.
    if (found.length > fields.length) {
      frame = candidate;
      fields = found;
    }
  }

  const seen = new Set<Blocker>();
  let passiveCaptcha = false;
  let captchaPending = false;
  for (const candidate of new Set([main, frame])) {
    const found = await runInPage(candidate, detectBlockers).catch(() => null);
    if (!found) continue;
    for (const blocker of found.blockers) seen.add(blocker);
    passiveCaptcha = passiveCaptcha || found.passiveCaptcha;
    captchaPending = captchaPending || found.captchaPending;
  }

  const blockers = BLOCKER_ORDER.filter((blocker) => seen.has(blocker));
  // Whatever inputs a sign-in or code page shows are credentials, not an application.
  if (seen.has("login") || seen.has("mfa")) fields = [];
  return {
    url: page.url(), frame, fields, blockers, status, gone: "",
    passiveCaptcha: passiveCaptcha && !seen.has("captcha"),
    captchaPending: captchaPending && !seen.has("captcha"),
  };
}

/**
 * Open `url` and wait for an application form to show up, following the posting's
 * "Apply" link once if the page has no form of its own. Returns as soon as there is a
 * form or a wall; after `waitMs` without either — or as soon as the page plainly says
 * the posting is gone — it returns the empty snapshot.
 */
export async function openForm(page: Page, url: string, waitMs: number): Promise<FormSnapshot> {
  const response = await page.goto(url, { waitUntil: "domcontentloaded" });
  let status = response ? response.status() : null;
  let followed = false;
  let emptyScans = 0;
  let pendingSince = 0;
  let deadline = Date.now() + waitMs;

  for (;;) {
    const snapshot = await scanPage(page, status);
    if (snapshot.blockers.includes("login") || snapshot.blockers.includes("mfa")) return snapshot;
    if (snapshot.fields.length > 0) {
      if (!pendingSince) {
        // Greenhouse serves its form as HTML and only then wires it up: a dropdown
        // clicked, or a value typed, before that is lost. Let the page finish loading
        // and go quiet, then read it again as it really is.
        pendingSince = Date.now();
        await page.waitForLoadState("load", { timeout: 10_000 }).catch(() => undefined);
        await page.waitForLoadState("networkidle", { timeout: 4_000 }).catch(() => undefined);
        continue;
      }
      // Lever's hCaptcha container is empty for a moment after the form is there; give
      // it that moment, so a widget that is about to appear is not called passive.
      if (!snapshot.captchaPending || Date.now() - pendingSince >= Math.min(CAPTCHA_SETTLE_MS, waitMs)) return snapshot;
      await sleep(POLL_MS);
      continue;
    }
    emptyScans += 1;
    const loaded = (await page.evaluate<string>("document.readyState").catch(() => "")) === "complete";
    // Client-rendered boards (Ashby) show nothing for a moment, so the link is only
    // looked for once the page has loaded and has stayed formless for two scans.
    if (!followed && emptyScans >= 2 && loaded) {
      const link = await runInPage(page.mainFrame(), markApplyLink).catch(() => ({ found: false, href: null }));
      if (link.found) {
        followed = true;
        if (link.href) {
          const next = await page.goto(link.href, { waitUntil: "domcontentloaded" });
          status = next ? next.status() : null;
        } else {
          // A button that reveals the form in place; if it cannot be pressed the
          // scan below simply keeps finding nothing.
          await page.locator(`[${APPLY_ATTRIBUTE}]`).first().click().catch(() => undefined);
          await page.waitForLoadState("domcontentloaded").catch(() => undefined);
        }
        emptyScans = 0;
        deadline = Date.now() + waitMs;
        continue;
      }
    }
    // An Ashby board whose hosted page is switched off answers every posting with
    // "Page not found"; there is no point waiting the full time for a form.
    if (loaded && emptyScans >= 3 && snapshot.blockers.length === 0) {
      const gone = await runInPage(page.mainFrame(), pageSaysGone).catch(() => "");
      if (gone) return { ...snapshot, gone };
    }
    if (Date.now() >= deadline) return snapshot;
    await sleep(POLL_MS);
  }
}

/**
 * Wait, while the user deals with a wall in the visible window, for the form to appear.
 *
 * Sign-in flows often land on a dashboard rather than back on the posting, so once the
 * wall has stayed gone for a few scans on the ATS's own host the posting is reopened —
 * once, so a user who is still mid-flow is not fought over the address bar.
 */
export async function waitForForm(
  page: Page,
  applyUrl: string,
  timeoutMs: number,
  formWaitMs: number,
): Promise<FormSnapshot | "closed" | "timeout"> {
  const deadline = Date.now() + timeoutMs;
  const host = (address: string): string => {
    try {
      return new URL(address).host;
    } catch {
      return "";
    }
  };
  let clearScans = 0;
  let reopened = false;

  for (;;) {
    if (page.isClosed()) return "closed";
    const snapshot = await scanPage(page).catch(() => null);
    if (snapshot && snapshot.fields.length > 0) return snapshot;
    clearScans = snapshot && snapshot.blockers.length === 0 ? clearScans + 1 : 0;
    if (!reopened && clearScans >= 4 && host(page.url()) === host(applyUrl)) {
      reopened = true;
      const again = await openForm(page, applyUrl, formWaitMs).catch(() => null);
      if (again && again.fields.length > 0) return again;
    }
    if (Date.now() >= deadline) return "timeout";
    await sleep(POLL_MS);
  }
}

/** Re-read the fields of a form already found, e.g. after the page reacted to an upload. */
export async function rescanFields(frame: Frame): Promise<FormField[]> {
  return runInPage(frame, extractFormFields).catch(() => []);
}

/** The options of the dropdown `id` once it has opened; null if it never shows a list. */
async function openedOptions(frame: Frame, id: string): Promise<string[] | null> {
  const deadline = Date.now() + LIST_WAIT_MS;
  let options: string[] | null = null;
  for (;;) {
    options = await runInPage(frame, readDropdown, id).catch(() => null);
    if (options && options.length > 0) return options;
    if (Date.now() >= deadline) return options;
    // An empty list may still be loading; one that is not there may still be opening.
    await sleep(options ? 250 : 100);
  }
}

/**
 * Open the dropdown `id` and return what it lists; null if it shows no list at all.
 * Nothing is typed and nothing is chosen.
 *
 * Greenhouse's react-select opens when its input is clicked. Ashby's autocomplete does
 * not; it opens from the arrow button beside the input. A dropdown that still shows
 * nothing gets one more click on its input: the page may not have been ready for the first.
 */
async function openDropdown(frame: Frame, id: string): Promise<string[] | null> {
  const input = frame.locator(`[${FIELD_ATTRIBUTE}="${id}"]`).first();
  await input.click({ timeout: DROPDOWN_TIMEOUT_MS });
  let options = await openedOptions(frame, id);
  if (options !== null) return options;
  if (await runInPage(frame, markDropdownOpener, id).catch(() => false)) {
    await frame.locator(`[${TOGGLE_ATTRIBUTE}]`).first().click({ timeout: DROPDOWN_TIMEOUT_MS });
  } else {
    await input.click({ timeout: DROPDOWN_TIMEOUT_MS });
  }
  options = await openedOptions(frame, id);
  return options;
}

/**
 * Read the options of every custom dropdown on the form (Greenhouse's react-select,
 * Ashby's autocomplete): they are not in the page until the dropdown is open. Each one
 * is opened, read and closed with Escape — nothing is typed and nothing is chosen.
 * What was read stays on the control, so this costs nothing the second time. Returns
 * the form's fields, now with their options; a dropdown that lists nothing until typed
 * into comes back marked `typeAhead`.
 */
export async function readDropdowns(page: Page, frame: Frame): Promise<FormField[]> {
  const ids = await runInPage(frame, unreadDropdowns).catch(() => []);
  for (const id of ids) {
    // Covered or gone: it reads as empty, and is left for the user like any option-less choice.
    const options = await openDropdown(frame, id).catch(() => null);
    await page.keyboard.press("Escape").catch(() => undefined);
    await runInPage(frame, rememberDropdown, { id, options: options ?? [] }).catch(() => undefined);
  }
  return rescanFields(frame);
}

/**
 * Press Greenhouse's "Enter manually" under Cover Letter so there is a textarea to
 * paste the note into. True when something was opened and the form should be re-read.
 */
export async function openCoverLetterBox(frame: Frame): Promise<boolean> {
  if (!(await runInPage(frame, markCoverLetterToggle).catch(() => false))) return false;
  try {
    await frame.locator(`[${TOGGLE_ATTRIBUTE}]`).first().click();
    return true;
  } catch {
    return false;
  }
}

// ---------- Filling ----------

/** Browsers normalise line endings in a textarea and trim an email input. */
const sameText = (left: string, right: string): boolean =>
  left.replace(/\r\n?/g, "\n").trim() === right.replace(/\r\n?/g, "\n").trim();

/**
 * A typed value against the planned one. A phone box formats the number as it is typed
 * ("+237680573022" shows as "+237 6 80 57 30 22"): for a phone, the digits are what count.
 */
const holdsTyped = (field: FieldPlan["field"], shown: string, planned: string): boolean => {
  if (sameText(shown, planned)) return true;
  const digits = (text: string) => text.replace(/\D/g, "");
  return field.type === "tel" && digits(planned).length >= 6 && digits(shown) === digits(planned);
};

/** A shown choice against a planned one; the schema shortens long options with an ellipsis. */
const sameChoice = (shown: string, planned: string): boolean =>
  shown === planned || (planned.endsWith("…") && shown.startsWith(planned.slice(0, -1)));

/**
 * A dropdown that shows only part of the chosen option once it is chosen: Greenhouse's
 * phone-country list offers "Cameroon +237" and then shows "+237". That part counts only
 * when no other option has it, so "+1" never stands for the United States.
 */
const showsPartOf = (shown: string, planned: string, options: readonly string[]): boolean => {
  const part = shown.trim();
  if (part.length < 2 || !planned.split(/\s+/).includes(part)) return false;
  return options.filter((option) => option.split(/\s+/).includes(part)).length === 1;
};

/** True when the page shows the planned choice for a select, radio, checkbox or toggle plan. */
function choiceHolds(state: Awaited<ReturnType<typeof readField>>, plan: Extract<FieldPlan, { action: "select" }>): boolean {
  if (state.control === "select" || state.control === "dropdown") {
    return state.selected.some(
      (shown) => sameChoice(shown, plan.option) || showsPartOf(shown, plan.option, plan.field.options),
    );
  }
  return state.checked[plan.field.options.indexOf(plan.option)] === true;
}

/**
 * True when a type-ahead holds a pick for the place `query`.
 *
 * A dropdown (Greenhouse, Ashby) shows the picked suggestion as its choice. Lever's
 * text box shows it as its text and keeps the suggestion itself, as JSON with its
 * `name`, in the hidden input beside it — and both have to agree, because Lever's
 * resume parser overwrites either half on its own.
 */
function pickHolds(state: Awaited<ReturnType<typeof readField>>, query: string): boolean {
  if (state.control === "dropdown") return state.selected.some((shown) => pickSuggestion(query, [shown]) === 0);
  if (state.companion === "" || pickSuggestion(query, [state.value]) !== 0) return false;
  return !state.companion.includes('"name"') || state.companion.includes(JSON.stringify(state.value.trim()));
}

/**
 * Carry out one plan on the page and check that it took. Never throws: a control that
 * has gone, refuses the value or is covered by something simply reports false, and the
 * caller lists the field as left for the user.
 */
export async function fillField(page: Page, frame: Frame, plan: FieldPlan): Promise<boolean> {
  if (plan.action === "leave") return false;
  const { id } = plan.field;
  const controls = frame.locator(`[${FIELD_ATTRIBUTE}="${id}"]`);
  try {
    if (plan.action === "upload") {
      if (!fs.existsSync(plan.path)) return false;
      await controls.first().setInputFiles(plan.path);
      return (await runInPage(frame, readField, id)).files > 0;
    }

    if (plan.action === "fill" || plan.action === "pitch") {
      await controls.first().fill(plan.value);
      return holdsTyped(plan.field, await controls.first().inputValue(), plan.value);
    }

    if (plan.action === "pick") return await pickFromTypeAhead(page, frame, plan);

    const state = await runInPage(frame, readField, id);
    if (choiceHolds(state, plan)) return true;

    if (state.control === "select") {
      const index = await runInPage(frame, selectOptionIndex, { id, option: plan.option });
      if (index < 0) return false;
      await controls.first().selectOption({ index });
    } else if (state.control === "dropdown") {
      // Open it, click the option whose text is exactly the planned one. No option
      // with that text means no click at all — never the nearest one.
      await openDropdown(frame, id);
      if (!(await runInPage(frame, markDropdownOption, { id, option: plan.option }))) {
        await page.keyboard.press("Escape").catch(() => undefined);
        return false;
      }
      await frame.locator(`[${CHOICE_ATTRIBUTE}]`).first().click();
      // As for a pick: Ashby shows the choice a render after the click.
      const settled = Date.now() + PICK_SETTLE_MS;
      while (!choiceHolds(await runInPage(frame, readField, id), plan)) {
        if (Date.now() >= settled) return false;
        await sleep(POLL_MS / 2);
      }
      return true;
    } else {
      const index = plan.field.options.indexOf(plan.option);
      if (index < 0) return false;
      const choice = controls.nth(index);
      // A toggle button is pressed like any button. A native radio or checkbox that the
      // site hides behind its own drawing cannot be clicked as a person would; a click
      // event on the input itself still flips it and tells the page's framework.
      if (state.control === "buttons") await choice.click();
      else if (await choice.isVisible()) await choice.check();
      else await choice.dispatchEvent("click");
    }
    return choiceHolds(await runInPage(frame, readField, id), plan);
  } catch {
    return false;
  }
}

/**
 * A location search box: Lever's "Current location" (a text input over a list),
 * Greenhouse's "Location (City)" and Ashby's "Location" (dropdowns that search as you
 * type). The place is typed the way a person would — the pages search on key presses,
 * after a pause — and a suggestion is clicked only if `pickSuggestion` says it is that
 * place. The city is tried first, then the whole place.
 *
 * When nothing offered is the place, the box is left the way it was found: all three
 * pages throw typed text away when the box loses focus, so Escape and a blur empty it
 * without telling anyone. That matters on Ashby, where emptying the box by hand is
 * itself saved to the server as an answer. Enter is never pressed: on Ashby it takes
 * the first suggestion, whatever it is.
 */
async function pickFromTypeAhead(page: Page, frame: Frame, plan: Extract<FieldPlan, { action: "pick" }>): Promise<boolean> {
  const { id } = plan.field;
  const dropdown = plan.field.type === "select";
  const input = frame.locator(`[${FIELD_ATTRIBUTE}="${id}"]`).first();
  const listed = async (): Promise<string[]> =>
    dropdown ? ((await runInPage(frame, readDropdown, id)) ?? []) : await runInPage(frame, readSuggestions, id);

  for (const term of searchTerms(plan.query)) {
    await input.click();
    // Text from an earlier pick (or from a resume parser) has to go before a new search.
    if ((await input.inputValue()) !== "") await input.fill("");
    await input.pressSequentially(term, { delay: 15 });

    const deadline = Date.now() + SUGGESTION_TIMEOUT_MS;
    let suggestions: string[] = [];
    for (;;) {
      const now = await listed().catch(() => []);
      // Listed, and the same as a moment ago: the search has come back.
      if (now.length > 0 && now.join("\n") === suggestions.join("\n")) break;
      suggestions = now;
      if (Date.now() >= deadline) break;
      await sleep(250);
    }

    const index = pickSuggestion(plan.query, suggestions);
    const marked =
      index >= 0 && (!dropdown || (await runInPage(frame, markDropdownOption, { id, option: suggestions[index] }).catch(() => false)));
    if (marked) {
      await frame.locator(dropdown ? `[${CHOICE_ATTRIBUTE}]` : `[${CHOICE_ATTRIBUTE}="${index}"]`).first().click();
      // Ashby writes the pick into the box a moment after the click, not with it: read
      // too soon, a pick that took looks like one that did not.
      const settled = Date.now() + PICK_SETTLE_MS;
      for (;;) {
        if (pickHolds(await runInPage(frame, readField, id), plan.query)) return true;
        if (Date.now() >= settled) return false;
        await sleep(POLL_MS / 2);
      }
    }

    await page.keyboard.press("Escape").catch(() => undefined);
    await input.blur().catch(() => undefined);
    // A box that kept the text anyway is emptied by hand, so nothing unpicked is left in it.
    if ((await input.inputValue().catch(() => "")) !== "") {
      await input.fill("").catch(() => undefined);
      await input.blur().catch(() => undefined);
    }
  }
  return false;
}

/**
 * Type `typed` into the type-ahead `field` and click the suggestion that reads `option`:
 * the same text, ignoring case and accents, or else the only suggestion that contains it.
 * Nothing is picked for being merely the first or the closest; when no suggestion reads
 * `option`, the box is left empty, as `pickFromTypeAhead` leaves it.
 */
export async function chooseFromTypeAhead(page: Page, frame: Frame, field: FormField, typed: string, option: string): Promise<boolean> {
  const { id } = field;
  const dropdown = field.type === "select";
  const input = frame.locator(`[${FIELD_ATTRIBUTE}="${id}"]`).first();
  const fold = (text: string): string => text.normalize("NFKD").replace(/\p{M}+/gu, "").replace(/\s+/g, " ").trim().toLowerCase();
  const wanted = fold(option);
  try {
    await input.click();
    if ((await input.inputValue()) !== "") await input.fill("");
    await input.pressSequentially(typed, { delay: 15 });
    const deadline = Date.now() + SUGGESTION_TIMEOUT_MS;
    let suggestions: string[] = [];
    for (;;) {
      const now = await (dropdown ? runInPage(frame, readDropdown, id).then((list) => list ?? []) : runInPage(frame, readSuggestions, id)).catch(
        () => [] as string[],
      );
      if (now.length > 0 && now.join("\n") === suggestions.join("\n")) break;
      suggestions = now;
      if (Date.now() >= deadline) break;
      await sleep(250);
    }
    let index = suggestions.findIndex((text) => fold(text) === wanted);
    if (index < 0) {
      const containing = suggestions.map((text, at) => ({ text, at })).filter(({ text }) => fold(text).includes(wanted));
      if (new Set(containing.map(({ text }) => fold(text))).size === 1) index = containing[0].at;
    }
    const marked =
      index >= 0 && (!dropdown || (await runInPage(frame, markDropdownOption, { id, option: suggestions[index] }).catch(() => false)));
    if (marked) {
      await frame.locator(dropdown ? `[${CHOICE_ATTRIBUTE}]` : `[${CHOICE_ATTRIBUTE}="${index}"]`).first().click();
      const settled = Date.now() + PICK_SETTLE_MS;
      for (;;) {
        if (fold(await shownValue(frame, field)).includes(fold(suggestions[index]).slice(0, 20))) return true;
        if (Date.now() >= settled) return false;
        await sleep(POLL_MS / 2);
      }
    }
    await page.keyboard.press("Escape").catch(() => undefined);
    await input.blur().catch(() => undefined);
    if ((await input.inputValue().catch(() => "")) !== "") {
      await input.fill("").catch(() => undefined);
      await input.blur().catch(() => undefined);
    }
    return false;
  } catch {
    return false;
  }
}

/**
 * What `field` shows right now, as a person would read it back: the text typed, the
 * choice made, the boxes ticked, or the file attached. "" when it holds nothing.
 */
export async function shownValue(frame: Frame, field: FormField): Promise<string> {
  try {
    const state = await runInPage(frame, readField, field.id);
    if (state.files > 0) return `${state.files} file attached`;
    if (state.selected.length > 0) return state.selected.join(", ");
    if (state.checked.some(Boolean)) {
      const ticked = field.options.filter((_, index) => state.checked[index]);
      return ticked.length > 0 ? ticked.join(", ") : "ticked";
    }
    return state.value.trim();
  } catch {
    return "";
  }
}

/**
 * Empty a location text box the operator could not answer. Lever's resume parser
 * writes the city it read from the PDF into a box nobody has picked in; left there, a
 * guess nobody verified would go out as the answer.
 */
export async function emptyTypeAhead(frame: Frame, plan: FieldPlan): Promise<void> {
  if (plan.action !== "pick" || plan.field.type === "select") return;
  try {
    const input = frame.locator(`[${FIELD_ATTRIBUTE}="${plan.field.id}"]`).first();
    if ((await input.inputValue()) === "") return;
    await input.fill("");
    await input.blur();
  } catch {
    // The box has gone; there is nothing in it to worry about.
  }
}

/**
 * True when a field still holds what the plan put there. A resume parser may have
 * overwritten a typed value; a page may have reset a choice.
 */
export async function holdsValue(frame: Frame, plan: FieldPlan): Promise<boolean> {
  // An attached file is not re-checked: upload widgets rebuild their input.
  if (plan.action === "leave" || plan.action === "upload") return true;
  try {
    if (plan.action === "fill" || plan.action === "pitch") {
      const value = await frame.locator(`[${FIELD_ATTRIBUTE}="${plan.field.id}"]`).first().inputValue();
      return holdsTyped(plan.field, value, plan.value);
    }
    const state = await runInPage(frame, readField, plan.field.id);
    // Lever's resume parser writes the location it read from the PDF over a pick it
    // does not know about — into the box, its hidden half, or both. Only a box that
    // still names the planned place, with a hidden half that agrees, counts.
    if (plan.action === "pick") return pickHolds(state, plan.query);
    return choiceHolds(state, plan);
  } catch {
    return false;
  }
}

/** Give the page a moment to react to an upload: resume parsers re-render the form. */
export async function settle(page: Page): Promise<void> {
  await page.waitForLoadState("networkidle", { timeout: 3_000 }).catch(() => undefined);
  await sleep(150);
}

/**
 * Wait for the files the form is still uploading. True once none is (or there never was
 * one); false when one is still going after `timeoutMs`. A 45 KB CV usually takes a
 * couple of seconds, but over a poor line an upload can stall: pressed then, Submit is
 * refused with "Resume/CV is required".
 */
export async function awaitUploads(frame: Frame, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (frame.isDetached()) return true;
    if (!(await runInPage(frame, detectUploadInProgress).catch(() => false))) return true;
    const left = deadline - Date.now();
    if (left <= 0) return false;
    await sleep(Math.min(POLL_MS, left));
  }
}

// ---------- Submitting and confirmation ----------

/** True when the form has an enabled button that says "submit" in words (it is stamped, not pressed). */
export async function findSubmit(frame: Frame): Promise<boolean> {
  return runInPage(frame, markSubmitButton).catch(() => false);
}

/**
 * Press the form's Submit button. False when no enabled button says "submit" in words.
 * With `target` (the button the agent named), that button is pressed instead.
 */
export async function pressSubmit(frame: Frame, target?: Locator): Promise<boolean> {
  if (!target && !(await findSubmit(frame))) return false;
  try {
    await (target ?? frame.locator(`[${SUBMIT_ATTRIBUTE}]`).first()).click();
    return true;
  } catch {
    return false;
  }
}

/** Fill a visible emailed one-time-code control and press its verify/submit button. */
export async function enterEmailedCode(frame: Frame, code: string): Promise<boolean> {
  if (!/^[A-Za-z0-9]{4,12}$/.test(code)) return false;
  const inputs = frame.locator("input");
  const candidates = await inputs.evaluateAll((elements) => elements.flatMap((element, index) => {
    const input = element as HTMLInputElement;
    const style = getComputedStyle(input);
    const visible = style.visibility !== "hidden" && style.display !== "none" && input.getClientRects().length > 0;
    const labelText = Array.from(input.labels ?? []).map((label) => label.innerText || label.textContent || "").join(" ");
    const parentHint = [input.parentElement?.getAttribute("aria-label"), input.parentElement?.getAttribute("data-testid")].join(" ");
    const hint = [input.name, input.id, input.placeholder, input.getAttribute("aria-label"), input.getAttribute("autocomplete"), labelText, parentHint]
      .join(" ").toLowerCase();
    const codeField = /one.?time|otp|verification|security|auth|code/.test(hint);
    return visible && codeField && !input.disabled && !input.readOnly && !input.value.trim()
      ? [{ index, maxLength: input.maxLength }]
      : [];
  })).catch(() => [] as Array<{ index: number; maxLength: number }>);
  if (!candidates.length) return false;
  try {
    const split = candidates.length > 1 && candidates.every(({ maxLength }) => maxLength === 1);
    if (split) {
      if (candidates.length < code.length) return false;
      for (const [offset, character] of [...code].entries()) await inputs.nth(candidates[offset].index).fill(character);
    } else {
      const target = candidates.find(({ maxLength }) => maxLength < 0 || maxLength >= code.length);
      if (!target) return false;
      await inputs.nth(target.index).fill(code);
    }
    const verify = frame.getByRole("button", { name: /verify|confirm|continue|submit/i }).first();
    if (await verify.count()) {
      if (!(await verify.isVisible()) || !(await verify.isEnabled())) return false;
      await verify.click();
      return true;
    }
    const submit = frame.locator('input[type="submit"]:visible, button[type="submit"]:visible').first();
    if (!(await submit.count()) || !(await submit.isEnabled())) return false;
    await submit.click();
    return true;
  } catch {
    return false;
  }
}

/** Whether the page still asks for the code the site emailed after Submit. */
export async function asksForEmailedCode(page: Page, frame: Frame): Promise<boolean> {
  for (const candidate of new Set([frame.isDetached() ? page.mainFrame() : frame, page.mainFrame()])) {
    if (await runInPage(candidate, detectEmailedCode).catch(() => false)) return true;
  }
  return false;
}

/** Addresses the form lives at, to tell "moved on to a confirmation page" from "still here". */
export function startUrls(page: Page, frame: Frame): string[] {
  return [...new Set([page.url(), frame.url()].map((address) => address.split("#")[0]))];
}

/** Whatever complaint the page already shows, so only a new one is blamed on Submit. */
export async function currentComplaint(page: Page, frame: Frame): Promise<string> {
  for (const candidate of new Set([frame, page.mainFrame()])) {
    if (candidate.isDetached()) continue;
    const complaint = await runInPage(candidate, detectRefusal).catch(() => null);
    if (complaint) return complaint.text;
  }
  return "";
}

export interface Verdict {
  /**
   * confirmed  — the "application received" page is showing.
   * closed     — the user closed the page.
   * timeout    — nothing conclusive happened in time.
   * challenged — a CAPTCHA challenge opened (only reported when `watch` is given).
   * refused    — the site said it would not take the application (`detail` quotes it).
   * invalid    — the site asked for corrections to the form (`detail` quotes it).
   */
  outcome: "confirmed" | "closed" | "timeout" | "challenged" | "refused" | "invalid";
  detail: string;
}

/**
 * Watch the page until it shows an "application received" page, the user closes it, or
 * `timeoutMs` passes. Only watches — pressing Submit is someone else's decision.
 *
 * With `watch` (right after the operator pressed Submit itself) it also stops as soon
 * as a challenge opens or the page complains about anything other than `watch.complaint`,
 * instead of waiting out the clock for a confirmation that will not come. It never
 * touches the challenge.
 */
export async function awaitConfirmation(
  page: Page,
  formFrame: Frame,
  formUrls: string[],
  timeoutMs: number,
  watch?: { complaint: string },
): Promise<Verdict> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (page.isClosed()) return { outcome: "closed", detail: "" };
    const main = page.mainFrame();
    // An embedded form's frame can be replaced outright by the confirmation.
    const formHolder = formFrame.isDetached() ? main : formFrame;
    for (const frame of page.frames()) {
      if (frame.isDetached()) continue;
      const probe = { startUrls: formUrls, heldForm: frame === formHolder };
      if (await runInPage(frame, detectConfirmation, probe).catch(() => false)) return { outcome: "confirmed", detail: "" };
    }
    if (watch) {
      for (const frame of new Set([formHolder, main])) {
        const blocked = await runInPage(frame, detectBlockers).catch(() => null);
        if (blocked && blocked.blockers.includes("captcha")) return { outcome: "challenged", detail: "" };
        if (await runInPage(frame, detectEmailedCode).catch(() => false)) {
          return { outcome: "challenged", detail: "emailed" };
        }
        const complaint = await runInPage(frame, detectRefusal).catch(() => null);
        if (complaint && complaint.text !== watch.complaint) return { outcome: complaint.kind, detail: complaint.text };
      }
    }
    const left = deadline - Date.now();
    if (left <= 0) return { outcome: page.isClosed() ? "closed" : "timeout", detail: "" };
    await sleep(Math.min(POLL_MS, left));
  }
}

/** Save a full-page screenshot; null if the page would not give one. */
export async function captureEvidence(page: Page, file: string): Promise<string | null> {
  try {
    await page.screenshot({ path: file, fullPage: true, timeout: 15_000 });
    return file;
  } catch {
    return null;
  }
}
