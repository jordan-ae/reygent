/**
 * In-page probes for the browser agent. Like those of domExtractor.ts, each function is
 * serialised and run inside the page (see `runInPage`), so each one is self-contained.
 *
 * `snapshotControls` is how the agent sees a page: not pixels and not the DOM, but a
 * short list of what can be pressed on it — buttons, links, tabs — each stamped with a
 * ref the driver can click by, and where it sits: in a pop-up, in a cookie banner, in the
 * form, or on the page behind them. Form fields are not in it: the operator lists those
 * by the ids `extractFormFields` gave them.
 */

/** Attribute carrying the ref of a control the agent may press. */
export const REF_ATTRIBUTE = "data-reygent-ref";

export interface SnapshotControl {
  ref: string;
  /** button, link, tab, option, checkbox, … — what a person would call it. */
  role: string;
  name: string;
  /** dialog (a pop-up), banner (cookies, consent), form, page, or menu (header, navigation, footer). */
  where: "dialog" | "banner" | "form" | "page" | "menu";
  disabled?: true;
  /** For a link to another site: that site's host. */
  leadsTo?: string;
}

export interface PageSnapshot {
  url: string;
  title: string;
  headings: string[];
  /** The titles of open pop-ups. */
  dialogs: string[];
  /** What sits over the middle of the page, when it is not the page itself (an overlay). */
  covered: string;
  /** Error messages and alerts the page shows. */
  alerts: string[];
  controls: SnapshotControl[];
  /** The start of the page's text, for a page without a form. */
  text: string;
}

/**
 * The page as the agent sees it. Refs are `<prefix><n>`, so that refs from several frames
 * never collide; earlier refs in this document are removed first.
 */
export function snapshotControls(args: { prefix: string; limit: number; withText: boolean }): PageSnapshot {
  const REF = "data-reygent-ref";
  const squash = (text: string | null | undefined): string => (text || "").replace(/\s+/g, " ").trim();
  const cut = (text: string, length: number): string => (text.length > length ? text.slice(0, length - 1) + "…" : text);

  const old = document.querySelectorAll("[" + REF + "]");
  for (let i = 0; i < old.length; i++) old[i].removeAttribute(REF);

  function shown(element: Element): boolean {
    if (element.getClientRects().length === 0) return false;
    const box = element.getBoundingClientRect();
    if (box.width < 4 || box.height < 4) return false;
    for (let node: Element | null = element; node; node = node.parentElement) {
      const style = window.getComputedStyle(node);
      if (style.visibility === "hidden" || style.display === "none" || style.opacity === "0") return false;
    }
    return true;
  }

  const DIALOG = '[role="dialog"], [role="alertdialog"], dialog[open], [aria-modal="true"]';
  const BANNER =
    '[id*="cookie" i], [class*="cookie" i], [id*="consent" i], [class*="consent" i], [id*="onetrust" i], ' +
    '[class*="onetrust" i], [id*="cookiebot" i], [id*="gdpr" i], [class*="gdpr" i], [id*="usercentrics" i]';
  const MENU = 'nav, header, footer, [role="navigation"], [role="banner"], [role="contentinfo"]';
  const CAPTCHA = '.g-recaptcha, .h-captcha, .cf-turnstile, [class*="captcha" i], [id*="captcha" i]';

  function nameOf(element: Element): string {
    const input = element as HTMLInputElement;
    const own =
      squash(element.getAttribute("aria-label")) ||
      squash((element as HTMLElement).innerText) ||
      (element.tagName === "INPUT" ? squash(input.value) : "") ||
      squash(element.getAttribute("title"));
    if (own) return own;
    const image = element.querySelector("img[alt], svg title");
    if (image) return squash(image.getAttribute("alt") || image.textContent);
    // An icon-only close button often names itself only in its class.
    const marks = (element.getAttribute("class") || "") + " " + (element.id || "");
    if (/close|dismiss/i.test(marks)) return "× (close)";
    return "";
  }

  function roleOf(element: Element): string {
    const role = element.getAttribute("role");
    if (role) return role;
    if (element.tagName === "A") return "link";
    if (element.tagName === "SUMMARY") return "toggle";
    return "button";
  }

  function whereOf(element: Element): SnapshotControl["where"] {
    if (element.closest(DIALOG)) return "dialog";
    const banner = element.closest(BANNER);
    if (banner && banner !== document.body && banner !== document.documentElement) return "banner";
    if (element.closest("form") || element.closest("[data-reygent-field]")) return "form";
    // A button beside the form's fields, in a page built without <form>.
    let node = element.parentElement;
    for (let depth = 0; node && depth < 6; depth++, node = node.parentElement) {
      if (node.querySelector("[data-reygent-field]")) return node === document.body ? "page" : "form";
    }
    if (element.closest(MENU)) return "menu";
    return "page";
  }

  // What can be pressed: the usual elements, and anything drawn as clickable (a pointer
  // cursor) that holds a short caption and nothing pressable of its own.
  const PRESSABLE =
    'a[href], button, [role="button"], [role="link"], [role="tab"], [role="menuitem"], [role="option"], ' +
    '[role="checkbox"], [role="switch"], input[type="submit"], input[type="button"], summary';
  const candidates: Element[] = Array.from(document.querySelectorAll(PRESSABLE));
  const loose = document.querySelectorAll("div, span, li, label");
  for (let i = 0; i < loose.length && i < 4000; i++) {
    const element = loose[i];
    if (element.querySelector(PRESSABLE + ", input, select, textarea")) continue;
    if (element.closest(PRESSABLE)) continue;
    const text = squash((element as HTMLElement).innerText);
    if (!text || text.length > 40) continue;
    if (window.getComputedStyle(element).cursor !== "pointer") continue;
    // Its parent drawn as clickable too: the parent is the control.
    const parent = element.parentElement;
    if (parent && window.getComputedStyle(parent).cursor === "pointer" && squash(parent.innerText) === text) continue;
    candidates.push(element);
  }

  const order: Record<SnapshotControl["where"], number> = { dialog: 0, banner: 1, form: 2, page: 3, menu: 4 };
  const found: Array<{ element: Element; control: Omit<SnapshotControl, "ref"> }> = [];
  const seen = new Set<Element>();
  for (const element of candidates) {
    if (seen.has(element)) continue;
    seen.add(element);
    // Form fields are listed by the operator; a CAPTCHA is never anything to press.
    if (element.hasAttribute("data-reygent-field") || element.closest(CAPTCHA)) continue;
    if (!shown(element)) continue;
    const name = cut(nameOf(element), 80);
    if (!name) continue;
    const where = whereOf(element);
    const control: Omit<SnapshotControl, "ref"> = { role: roleOf(element), name, where };
    if (element.matches(":disabled") || element.getAttribute("aria-disabled") === "true") control.disabled = true;
    if (element.tagName === "A") {
      try {
        const target = new URL((element as HTMLAnchorElement).href, window.location.href);
        if (target.host && target.host !== window.location.host) control.leadsTo = target.host;
      } catch {
        // Not an address; it is pressed like a button.
      }
    }
    found.push({ element, control });
  }
  // Pop-ups and banners first: they are what stands in the way. Menu links last, and
  // only those that could lead to an application.
  found.sort((left, right) => order[left.control.where] - order[right.control.where]);
  const kept = found.filter(
    ({ control }) => control.where !== "menu" || /apply|job|career|position|opening|role/i.test(control.name),
  );

  const controls: SnapshotControl[] = [];
  for (const { element, control } of kept.slice(0, args.limit)) {
    const ref = args.prefix + (controls.length + 1);
    element.setAttribute(REF, ref);
    controls.push({ ref, ...control });
  }

  const texts = (selector: string, max: number, length: number): string[] => {
    const out: string[] = [];
    const nodes = document.querySelectorAll(selector);
    for (let i = 0; i < nodes.length && out.length < max; i++) {
      if (!shown(nodes[i])) continue;
      const text = cut(squash((nodes[i] as HTMLElement).innerText), length);
      if (text && out.indexOf(text) < 0) out.push(text);
    }
    return out;
  };

  const dialogs: string[] = [];
  const open = document.querySelectorAll(DIALOG);
  for (let i = 0; i < open.length && dialogs.length < 3; i++) {
    if (!shown(open[i])) continue;
    const heading = open[i].querySelector('h1, h2, h3, h4, [class*="title" i]');
    const label = squash(open[i].getAttribute("aria-label"));
    dialogs.push(cut(label || squash(heading ? (heading as HTMLElement).innerText : "") || squash((open[i] as HTMLElement).innerText), 100));
  }

  // Something laid over the middle of the page: the page behind it cannot be used.
  let covered = "";
  const middle = document.elementFromPoint(window.innerWidth / 2, window.innerHeight / 2);
  for (let node: Element | null = middle; node && node !== document.body; node = node.parentElement) {
    const style = window.getComputedStyle(node);
    if (style.position !== "fixed" && style.position !== "sticky") continue;
    const box = node.getBoundingClientRect();
    if (box.width * box.height < window.innerWidth * window.innerHeight * 0.25) continue;
    covered = cut(squash((node as HTMLElement).innerText), 120) || "an overlay without text";
    break;
  }

  return {
    url: window.location.href,
    title: cut(squash(document.title), 100),
    headings: texts("h1, h2", 4, 100),
    dialogs,
    covered,
    alerts: texts('[role="alert"], [aria-live="assertive"], [class*="error" i]:not(input):not(select):not(textarea)', 4, 120),
    controls,
    text: args.withText ? cut(squash(document.body ? document.body.innerText : ""), 700) : "",
  };
}
