/**
 * In-page probes: every function in this file is serialised and run inside the
 * employer's page (see `runInPage` in driver.ts), so each one is self-contained — it
 * may not touch an import, a module-level constant or another function of this file.
 * They only read the page, apart from stamping `data-reygent-*` attributes on the
 * controls the operator has to find again.
 *
 * The markup these were written against is what Greenhouse, Lever and Ashby serve
 * (read from live postings, October 2026): labels that are `label[for]`, a wrapping
 * `label`, an `aria-labelledby` group or just a sibling `div`; file inputs that are
 * always visually hidden; radios that share a `name` and nothing else; react-select
 * comboboxes posing as text inputs; Yes/No questions that are two toggle buttons.
 * Controls inside a shadow root are not seen.
 */

import type { Blocker, FormField } from "@/core/browser/types";

/** Attribute carrying a field's id; group members (radios, checkboxes, toggles) share one value. */
export const FIELD_ATTRIBUTE = "data-reygent-field";
export const SUBMIT_ATTRIBUTE = "data-reygent-submit";
export const APPLY_ATTRIBUTE = "data-reygent-apply";
export const TOGGLE_ATTRIBUTE = "data-reygent-toggle";
/** Set on the one dropdown option / type-ahead suggestion the operator is about to click. */
export const CHOICE_ATTRIBUTE = "data-reygent-choice";

/**
 * The application form on this document as a compact schema — one entry per question,
 * not per element — or [] when the document holds nothing that looks like one.
 */
export function extractFormFields(): FormField[] {
  const STAMP = "data-reygent-field";
  // A custom dropdown: its options are not in the page until it is opened, so the
  // driver opens it once, reads them and leaves them here for later extractions.
  const COMBOBOX = "data-reygent-combobox";
  const OPTIONS = "data-reygent-options";
  const TYPEAHEAD = "data-reygent-typeahead";
  const MAX_LABEL = 140;
  // Inputs that are not questions (buttons), must never be typed into (password) or
  // carry nothing a person answers (hidden).
  const SKIPPED_TYPES = /^(hidden|submit|button|reset|image|search|password|range|color)$/;
  const HONEYPOT = /honey ?pot|hp[-_]?field|bot[-_]?(field|check|trap)|no[-_]?spam|no[-_]?bots?|_gotcha|leave[-_ ]?(this[-_ ]?)?(blank|empty)/i;
  // Captions of the button beside an upload or reveal control, not of the question.
  const GENERIC_CAPTION = /^(attach|upload|browse|choose|select|add|drop|drag|enter manually|type here|click)\b.{0,24}$/i;
  const HELP_TEXT = /desc|help|hint|instruction|note|subtitle|caption|error/i;
  const CONTROLS = "input:not([type=hidden]), textarea, select, button[aria-pressed]";

  type Control = HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement | HTMLButtonElement;
  type Kind = FormField["type"];
  interface Unit {
    controls: Control[];
    kind: Kind;
  }

  const squash = (text: string | null | undefined): string => (text || "").replace(/\s+/g, " ").trim();

  /**
   * Text a person can read inside `node`: no control values, no scripts, no hidden
   * decoration. With `until`, only what comes before that descendant.
   */
  function readable(node: Node, until?: Node): string {
    let out = "";
    const children = node.childNodes;
    for (let i = 0; i < children.length; i++) {
      const child = children[i];
      if (until && (child === until || child.contains(until))) break;
      if (child.nodeType === 3) {
        out += child.nodeValue || "";
      } else if (child.nodeType === 1) {
        const element = child as Element;
        if (/^(input|select|textarea|button|script|style|svg|option|noscript|template)$/i.test(element.tagName)) continue;
        if (element.getAttribute("aria-hidden") === "true") continue;
        const style = window.getComputedStyle(element);
        if (style.display === "none" || style.visibility === "hidden") continue;
        out += " " + readable(element) + " ";
      }
    }
    return out;
  }
  const textOf = (element: Element | null): string => (element ? squash(readable(element)) : "");

  /** Rendered by every ancestor. The control itself may still be hidden — file inputs always are. */
  function ancestorsShown(element: Element): boolean {
    for (let node = element.parentElement; node; node = node.parentElement) {
      const style = window.getComputedStyle(node);
      if (style.display === "none" || style.visibility === "hidden") return false;
    }
    return true;
  }

  /** Something a person can see and type into. Off-screen, transparent and 1px inputs are how honeypots hide. */
  function visible(element: Element): boolean {
    if (element.getClientRects().length === 0) return false;
    const box = element.getBoundingClientRect();
    if (box.width < 2 || box.height < 2) return false;
    if (box.right + window.scrollX < 0 || box.bottom + window.scrollY < 0) return false;
    for (let node: Element | null = element; node; node = node.parentElement) {
      const style = window.getComputedStyle(node);
      if (style.visibility === "hidden" || style.opacity === "0") return false;
    }
    return true;
  }

  /** A text input that opens a list (react-select, a places autocomplete): a choice, not free text. */
  function isCombobox(control: Control): boolean {
    if (control.tagName !== "INPUT") return false;
    const popup = control.getAttribute("aria-haspopup");
    return (
      control.getAttribute("role") === "combobox" ||
      /^(list|both)$/.test(control.getAttribute("aria-autocomplete") || "") ||
      popup === "listbox" ||
      popup === "true"
    );
  }

  /** Ashby's Yes/No: sibling buttons that carry their state in aria-pressed. */
  function toggleGroup(parent: Element | null): boolean {
    return parent !== null && parent.querySelectorAll(":scope > button[aria-pressed]").length >= 2;
  }

  /**
   * Lever's location box: a plain text input whose value only counts once a suggestion
   * has been picked from the list that drops down under it (the pick goes into a hidden
   * companion input; text typed without picking is wiped when the field loses focus).
   */
  function isTypeAheadText(control: Control): boolean {
    if (control.tagName !== "INPUT" || isCombobox(control) || !control.parentElement) return false;
    const siblings = control.parentElement.children;
    let companion = false;
    let list = false;
    for (let i = 0; i < siblings.length; i++) {
      const sibling = siblings[i];
      if (sibling === control) continue;
      if (sibling.tagName === "INPUT" && (sibling.getAttribute("type") || "").toLowerCase() === "hidden") companion = true;
      if (/dropdown|autocomplete|suggest|typeahead/i.test(sibling.getAttribute("class") || "")) list = true;
    }
    return companion && list;
  }

  function kindOf(control: Control): Kind {
    if (control.tagName === "BUTTON") return "radio";
    if (control.tagName === "TEXTAREA") return "textarea";
    if (control.tagName === "SELECT") return "select";
    if (isCombobox(control)) return "select";
    const type = (control.getAttribute("type") || "text").toLowerCase();
    if (type === "file" || type === "radio" || type === "checkbox") return type;
    if (type === "email" || type === "tel" || type === "url" || type === "number") return type;
    if (/^(date|datetime-local|month|week|time)$/.test(type)) return "date";
    // Greenhouse types its email field as plain text and says what it is in `autocomplete`.
    const hint = (control.getAttribute("autocomplete") || "").toLowerCase();
    if (/\bemail\b/.test(hint)) return "email";
    if (/\btel\b/.test(hint)) return "tel";
    if (/\burl\b/.test(hint)) return "url";
    return "text";
  }

  function eligible(control: Control): boolean {
    const type = (control.getAttribute("type") || "").toLowerCase();
    if (control.tagName === "INPUT" && SKIPPED_TYPES.test(type)) return false;
    if (control.matches(":disabled") || control.getAttribute("aria-hidden") === "true") return false;
    if (control.getAttribute("role") === "searchbox") return false;
    if (control.closest('[role="search"], nav, footer, [role="navigation"], [role="contentinfo"]')) return false;
    // Cookie-preference toggles are not questions. A page-level wrapper that merely has
    // "cookie" in its class is not a banner, so one that holds a real form is ignored.
    const banner = control.closest('[id*="cookie" i], [class*="cookie" i], [id*="onetrust" i], [class*="onetrust" i]');
    if (banner && banner !== document.body && !banner.querySelector("input[type=file], textarea")) return false;
    const identity = [control.getAttribute("name"), control.id, control.getAttribute("class")].join(" ");
    if (HONEYPOT.test(identity)) return false;
    if (control.tagName === "BUTTON") return toggleGroup(control.parentElement) && visible(control);
    const kind = kindOf(control);
    // The checkbox Ashby keeps (display: none) beside its Yes/No buttons is their
    // shadow, not a second question.
    if ((kind === "checkbox" || kind === "radio") && toggleGroup(control.parentElement)) return false;
    // Sites hide the native file, radio and checkbox inputs and draw their own; a
    // react-select input is a couple of pixels wide until it is typed into.
    if (kind === "file" || kind === "radio" || kind === "checkbox" || isCombobox(control)) return ancestorsShown(control);
    if (control.getAttribute("tabindex") === "-1" && control.getAttribute("autocomplete") === "off") return false;
    return visible(control);
  }

  // ---- 1. Collect controls per form and keep the one that looks like an application ----

  const scopes = new Map<Element | null, Control[]>();
  const all = document.querySelectorAll(CONTROLS);
  for (let i = 0; i < all.length; i++) {
    const control = all[i] as Control;
    if (!eligible(control)) continue;
    const owner = control.form;
    const list = scopes.get(owner);
    if (list) list.push(control);
    else scopes.set(owner, [control]);
  }

  function unitsOf(controls: Control[]): Unit[] {
    const units: Unit[] = [];
    const named = new Map<string, Unit>();
    const toggles = new Map<Element, Unit>();
    for (const control of controls) {
      const kind = kindOf(control);
      const name = control.getAttribute("name");
      let group: Unit | undefined;
      if (control.tagName === "BUTTON") {
        const parent = control.parentElement as Element;
        group = toggles.get(parent);
        if (!group) toggles.set(parent, (group = { controls: [], kind }));
      } else if ((kind === "radio" || kind === "checkbox") && name) {
        group = named.get(kind + ":" + name);
        if (!group) named.set(kind + ":" + name, (group = { controls: [], kind }));
      }
      if (!group) units.push({ controls: [control], kind });
      else if (group.controls.push(control) === 1) units.push(group);
    }
    return units;
  }

  // A newsletter box or a site search is also a form. An application is the one with a
  // file to attach, a long answer to write, or at least three questions.
  let units: Unit[] = [];
  let bestScore = 0;
  scopes.forEach((controls) => {
    const candidate = unitsOf(controls);
    const hasFile = candidate.some((unit) => unit.kind === "file");
    const hasProse = candidate.some((unit) => unit.kind === "textarea");
    if (!hasFile && !hasProse && candidate.length < 3) return;
    const score = candidate.length + (hasFile ? 5 : 0) + (hasProse ? 2 : 0);
    if (score > bestScore) {
      bestScore = score;
      units = candidate;
    }
  });
  if (units.length === 0) return [];

  const unitIndex = new Map<Element, number>();
  units.forEach((unit, index) => unit.controls.forEach((control) => unitIndex.set(control, index)));

  // ---- 2. Labels ----

  /** Which of this form's questions live inside `box`. */
  function questionsIn(box: Element): Set<number> {
    const found = new Set<number>();
    const inside = box.querySelectorAll(CONTROLS);
    for (let i = 0; i < inside.length; i++) {
      const index = unitIndex.get(inside[i]);
      if (index !== undefined) found.add(index);
    }
    return found;
  }

  /** True while `box` belongs to the question `mine` alone. */
  function ownedBy(box: Element, mine: number): boolean {
    const inside = questionsIn(box);
    return inside.size === 0 || (inside.size === 1 && inside.has(mine));
  }

  function referenced(element: Element): string {
    const ids = squash(element.getAttribute("aria-labelledby"));
    if (!ids) return "";
    return squash(
      ids
        .split(" ")
        .map((id) => textOf(document.getElementById(id)))
        .join(" "),
    );
  }

  /** label[for], then a wrapping label, then aria-labelledby, then aria-label. */
  function ownLabel(control: Control): string {
    const labels = control.labels ? Array.from(control.labels) : [];
    for (const label of labels) {
      if (control.id && label.htmlFor === control.id && textOf(label)) return textOf(label);
    }
    const wrapper = control.closest("label");
    if (wrapper) {
      // Lever wraps the whole row: the question, then the input with its upload
      // statuses and autocomplete messages. What precedes the control is the question;
      // a checkbox's caption follows it, so fall back to everything.
      const text = squash(readable(wrapper, control)) || textOf(wrapper);
      if (text) return text;
    }
    return referenced(control) || squash(control.getAttribute("aria-label"));
  }

  /**
   * The caption of the fieldset or ARIA group around a question. Only trusted when the
   * box holds one or two questions: a fieldset around a whole section names the
   * section, not the question.
   */
  function boxLabel(control: Control): string {
    for (const selector of ["fieldset", '[role="group"], [role="radiogroup"]']) {
      const box = control.closest(selector);
      if (!box || questionsIn(box).size > 2) continue;
      const legend = box.tagName === "FIELDSET" ? box.querySelector(":scope > legend") : null;
      const caption = textOf(legend) || referenced(box) || squash(box.getAttribute("aria-label"));
      if (caption) return caption;
    }
    return "";
  }

  const holdsControl = (element: Element): boolean => element.matches(CONTROLS) || element.querySelector(CONTROLS) !== null;

  /**
   * The question text belonging to a control that has no label of its own — Lever's
   * custom questions are a `div` followed by a bare input, Ashby's Yes/No buttons sit
   * under an unattached label, its autofill box carries a heading after the input.
   * Looks just above the control, then for a heading inside the wrapper, and climbs
   * only while the ancestor still belongs to this one question, so a neighbour's
   * label is never borrowed.
   */
  function nearbyText(controls: Control[]): string {
    const mine = unitIndex.get(controls[0]) as number;
    let node: Element = controls[0];
    if (controls.length > 1) {
      while (node.parentElement && !controls.every((control) => node.contains(control))) node = node.parentElement;
      // Ashby opens a radio fieldset with the question itself, then the options.
      for (let i = 0; i < node.children.length; i++) {
        const child = node.children[i];
        if (holdsControl(child)) break;
        if (child.tagName !== "BUTTON" && textOf(child)) return textOf(child);
      }
    }
    for (let depth = 0; depth < 4; depth++) {
      let hint = "";
      let steps = 0;
      for (let prev = node.previousElementSibling; prev && steps < 3; prev = prev.previousElementSibling, steps++) {
        if (holdsControl(prev)) break;
        if (prev.tagName === "BUTTON" || !textOf(prev)) continue;
        // A help line sits between the question and its control; keep looking above it.
        if (HELP_TEXT.test(prev.getAttribute("class") || "")) {
          hint = hint || textOf(prev);
          continue;
        }
        return textOf(prev);
      }
      if (hint) return hint;
      const parent: Element | null = node.parentElement;
      if (!parent || parent === document.body || parent.tagName === "FORM" || !ownedBy(parent, mine)) return "";
      const headings = parent.querySelectorAll('h1, h2, h3, h4, h5, h6, legend, [class*="title" i], [class*="heading" i]');
      for (let i = 0; i < headings.length; i++) {
        if (!holdsControl(headings[i]) && textOf(headings[i])) return textOf(headings[i]);
      }
      node = parent;
    }
    return "";
  }

  const fallbackName = (control: Control): string =>
    squash(control.getAttribute("placeholder")) ||
    squash(control.getAttribute("title")) ||
    squash((control.getAttribute("name") || control.id || "").replace(/[_\-[\]]+/g, " "));

  function labelOf(unit: Unit): string {
    const first = unit.controls[0];
    if (unit.kind === "radio" || unit.kind === "checkbox") {
      // A lone checkbox ("I agree to …") is its own question; a group's question is
      // on the box around its options, or just above them.
      const alone = unit.controls.length === 1 ? ownLabel(first) : "";
      return alone || boxLabel(first) || nearbyText(unit.controls) || fallbackName(first);
    }
    const own = ownLabel(first);
    if (own && !GENERIC_CAPTION.test(own)) return own;
    // "Attach" / "Enter manually" name a button; the question is on the group around it.
    return boxLabel(first) || nearbyText(unit.controls) || own || fallbackName(first);
  }

  function optionsOf(unit: Unit): string[] {
    const first = unit.controls[0];
    if (first.tagName === "SELECT") {
      const options: string[] = [];
      const list = (first as HTMLSelectElement).options;
      for (let i = 0; i < list.length; i++) {
        const text = squash(list[i].textContent);
        // The "Select…" placeholder is not a choice.
        if (text && list[i].value !== "" && !list[i].disabled) options.push(text);
      }
      // Never a partial list: a choice missing from it would look like a choice that
      // does not exist. Lever's university picker has 3,300 entries; a country list 250.
      return options.length > 300 ? [] : options.map((text) => (text.length > 60 ? text.slice(0, 59) + "…" : text));
    }
    if (isCombobox(first)) {
      // What the driver read when it opened this dropdown (already capped the same way).
      try {
        const read = JSON.parse(first.getAttribute(OPTIONS) || "[]");
        return Array.isArray(read) ? read.map(String) : [];
      } catch {
        return [];
      }
    }
    if (first.tagName === "BUTTON") return unit.controls.map((control) => squash(control.textContent));
    if (unit.kind !== "radio" && unit.kind !== "checkbox") return [];
    // One entry per control, in page order — the operator picks a choice by position.
    const options = unit.controls.map((control) => {
      const text = ownLabel(control) || textOf(control.nextElementSibling) || squash(control.getAttribute("value"));
      return text.length > 60 ? text.slice(0, 59) + "…" : text;
    });
    if (options.every((text) => text === "")) return [];
    return options.map((text) => text || "?");
  }

  /**
   * Some boards only say "required" in a class name and draw the asterisk in CSS:
   * Ashby's `label._required_…`, Lever's `div.required-field`. Looked for in the
   * wrappers that belong to this question alone.
   */
  function classSaysRequired(unit: Unit): boolean {
    const mine = unitIndex.get(unit.controls[0]) as number;
    let node = unit.controls[0].parentElement;
    for (let depth = 0; node && depth < 5; depth++) {
      if (node === document.body || node.tagName === "FORM" || !ownedBy(node, mine)) return false;
      if (/required/i.test(node.getAttribute("class") || "") || node.querySelector('[class*="required" i]')) return true;
      node = node.parentElement;
    }
    return false;
  }

  function isRequired(unit: Unit, rawLabel: string): boolean {
    if (/[*✱]|\(required\)/i.test(rawLabel)) return true;
    const stated = unit.controls.some((control) => {
      if ((control as HTMLInputElement).required || control.getAttribute("aria-required") === "true") return true;
      const box = control.closest('[role="group"], [role="radiogroup"], fieldset');
      return box !== null && box.getAttribute("aria-required") === "true" && questionsIn(box).size <= 2;
    });
    return stated || classSaysRequired(unit);
  }

  // ---- 3. Stamp and emit ----

  // Ids survive a second extraction of the same page: a control keeps the stamp it has,
  // and new controls continue the numbering.
  let counter = 0;
  const stamped = document.querySelectorAll("[" + STAMP + "]");
  for (let i = 0; i < stamped.length; i++) {
    const n = Number((stamped[i].getAttribute(STAMP) || "").slice(1));
    if (n > counter) counter = n;
  }

  return units.map((unit) => {
    let id = "";
    for (const control of unit.controls) id = id || control.getAttribute(STAMP) || "";
    if (!id) id = "f" + ++counter;
    for (const control of unit.controls) control.setAttribute(STAMP, id);

    const first = unit.controls[0];
    const dropdown = isCombobox(first);
    if (dropdown) first.setAttribute(COMBOBOX, "");

    const raw = labelOf(unit);
    let label = squash(raw.replace(/✱/g, " ").replace(/\(required\)/gi, " ")).replace(/^\*\s*|\s*\*$/g, "");
    if (label.length > MAX_LABEL) label = label.slice(0, MAX_LABEL - 1) + "…";
    const field: FormField = { id, label, type: unit.kind, required: isRequired(unit, raw), options: optionsOf(unit) };
    if ((dropdown && first.hasAttribute(TYPEAHEAD)) || isTypeAheadText(first)) field.typeAhead = true;
    return field;
  });
}

// ---------- Custom dropdowns ----------

/** Ids of the custom dropdowns whose options have not been read yet. */
export function unreadDropdowns(): string[] {
  const found = document.querySelectorAll("[data-reygent-combobox]:not([data-reygent-options])");
  const ids: string[] = [];
  for (let i = 0; i < found.length; i++) ids.push(found[i].getAttribute("data-reygent-field") || "");
  return ids.filter(Boolean);
}

/**
 * The options of the dropdown stamped `id`, which the driver has just opened — or null
 * while it shows no list. Only the list the control itself points at is read: a page
 * can hold other listboxes (Greenhouse keeps a hidden 244-country one for the phone).
 */
export function readDropdown(id: string): string[] | null {
  const input = document.querySelector('[data-reygent-field="' + id + '"][data-reygent-combobox]');
  if (!input) return null;
  const reference = input.getAttribute("aria-controls") || input.getAttribute("aria-owns");
  const list = reference ? document.getElementById(reference) : null;
  if (!list || list.getClientRects().length === 0) return null;
  const options: string[] = [];
  const found = list.querySelectorAll('[role="option"]');
  for (let i = 0; i < found.length; i++) {
    const text = (found[i].textContent || "").replace(/\s+/g, " ").trim();
    if (text && found[i].getAttribute("aria-disabled") !== "true") options.push(text);
  }
  return options;
}

/**
 * Keep what was read from a dropdown on the control, so later extractions carry it
 * without opening the dropdown again. A list too long to be useful is kept as empty;
 * one that showed nothing at all is marked as a type-ahead.
 */
export function rememberDropdown(read: { id: string; options: string[] }): void {
  const input = document.querySelector('[data-reygent-field="' + read.id + '"][data-reygent-combobox]');
  if (!input) return;
  const kept = read.options.length > 300 ? [] : read.options.map((text) => (text.length > 60 ? text.slice(0, 59) + "…" : text));
  input.setAttribute("data-reygent-options", JSON.stringify(kept));
  if (read.options.length === 0) input.setAttribute("data-reygent-typeahead", "");
}

/**
 * Ashby's autocomplete does not open when its input is clicked — only when typed into,
 * or when the arrow button beside the input is pressed. Stamps that button so the
 * driver can press it. Only an icon-only button that is the input's sole button
 * sibling counts: a button with a caption is something else (Greenhouse's "Locate me").
 */
export function markDropdownOpener(id: string): boolean {
  const STAMP = "data-reygent-toggle";
  const old = document.querySelectorAll("[" + STAMP + "]");
  for (let i = 0; i < old.length; i++) old[i].removeAttribute(STAMP);
  const input = document.querySelector('[data-reygent-field="' + id + '"][data-reygent-combobox]');
  if (!input || !input.parentElement) return false;
  const buttons = input.parentElement.querySelectorAll(":scope > button");
  if (buttons.length !== 1) return false;
  const button = buttons[0] as HTMLButtonElement;
  if (button.disabled || button.getClientRects().length === 0) return false;
  if ((button.textContent || "").trim() !== "" || button.getAttribute("type") === "submit") return false;
  button.setAttribute(STAMP, "");
  return true;
}

/** In the open dropdown `id`, stamp the option whose text is exactly `option`. False if there is none. */
export function markDropdownOption(target: { id: string; option: string }): boolean {
  const STAMP = "data-reygent-choice";
  const old = document.querySelectorAll("[" + STAMP + "]");
  for (let i = 0; i < old.length; i++) old[i].removeAttribute(STAMP);
  const input = document.querySelector('[data-reygent-field="' + target.id + '"][data-reygent-combobox]');
  if (!input) return false;
  const reference = input.getAttribute("aria-controls") || input.getAttribute("aria-owns");
  const list = reference ? document.getElementById(reference) : null;
  if (!list) return false;
  // The schema shortens very long options with an ellipsis; match those by their start.
  const cut = target.option.slice(-1) === "…" ? target.option.slice(0, -1) : null;
  const found = list.querySelectorAll('[role="option"]');
  for (let i = 0; i < found.length; i++) {
    const text = (found[i].textContent || "").replace(/\s+/g, " ").trim();
    if (found[i].getAttribute("aria-disabled") === "true") continue;
    if (text === target.option || (cut !== null && text.indexOf(cut) === 0)) {
      found[i].setAttribute(STAMP, "");
      return true;
    }
  }
  return false;
}

/**
 * The suggestions currently listed under the type-ahead text input stamped `id`, each
 * stamped with its position so the driver can click one. Placeholders such as
 * "No location found" and "Loading" are not suggestions.
 */
export function readSuggestions(id: string): string[] {
  const STAMP = "data-reygent-choice";
  const old = document.querySelectorAll("[" + STAMP + "]");
  for (let i = 0; i < old.length; i++) old[i].removeAttribute(STAMP);
  const input = document.querySelector('[data-reygent-field="' + id + '"]');
  if (!input || !input.parentElement) return [];
  const texts: string[] = [];
  const siblings = input.parentElement.children;
  for (let i = 0; i < siblings.length; i++) {
    if (!/dropdown|autocomplete|suggest|typeahead/i.test(siblings[i].getAttribute("class") || "")) continue;
    const items = siblings[i].querySelectorAll("*");
    for (let j = 0; j < items.length; j++) {
      const item = items[j];
      if (item.children.length > 0 || item.getClientRects().length === 0) continue;
      if (item.closest('[class*="no-result" i], [class*="noresult" i], [class*="loading" i], [class*="empty" i]')) continue;
      const text = (item.textContent || "").replace(/\s+/g, " ").trim();
      if (!text) continue;
      item.setAttribute(STAMP, String(texts.length));
      texts.push(text);
    }
  }
  return texts;
}

// ---------- Blockers ----------

/**
 * What stands between the operator and the form. Detection only: nothing here (or
 * anywhere else) tries to get past one.
 *
 * A CAPTCHA is a blocker when it asks a person to do something: a rendered checkbox or
 * widget, an open puzzle, a "verify you are human" wall. One that shows nothing and
 * only runs when Submit is pressed is reported as `passiveCaptcha` instead — on the
 * live boards that is a hidden or badge-sized reCAPTCHA frame (Greenhouse, Ashby) or
 * hCaptcha's hidden frames in a zero-height container (Lever). `captchaPending` says a
 * widget container is still empty, so which of the two it is cannot be told yet.
 */
export function detectBlockers(): { blockers: Blocker[]; passiveCaptcha: boolean; captchaPending: boolean } {
  const shown = (element: Element): boolean => {
    if (element.getClientRects().length === 0) return false;
    return window.getComputedStyle(element).visibility !== "hidden";
  };
  const anyShown = (selector: string): boolean => {
    const found = document.querySelectorAll(selector);
    for (let i = 0; i < found.length; i++) if (shown(found[i])) return true;
    return false;
  };
  const exists = (selector: string): boolean => document.querySelector(selector) !== null;

  const typable = document.querySelectorAll(
    "input:not([type=hidden]):not([type=submit]):not([type=button]):not([type=checkbox]):not([type=radio]), textarea",
  );
  let typableShown = 0;
  // An input made for a short code: named for one, numeric, or four to eight characters long.
  let codeBox = false;
  for (let i = 0; i < typable.length; i++) {
    const input = typable[i] as HTMLInputElement;
    if (!shown(input)) continue;
    typableShown += 1;
    const hint = [input.name, input.id, input.getAttribute("placeholder"), input.getAttribute("aria-label")].join(" ");
    const length = Number(input.getAttribute("maxlength") || 0);
    if (/code|token|otp|passcode|\bpin\b|2fa|mfa/i.test(hint) || input.inputMode === "numeric" || (length >= 4 && length <= 8)) {
      codeBox = true;
    }
  }
  // A sign-in or code page is a handful of inputs and nothing to attach or write. An
  // application form whose job description mentions "two-factor", or whose URL has
  // "/auth/" in it, must not be mistaken for one — so text and URL evidence only
  // count on a page that looks like a wall.
  const wallLike = !exists("input[type=file], textarea") && typableShown <= 4;
  const body = document.body ? (document.body.innerText || "").slice(0, 20_000) : "";

  const blockers: Blocker[] = [];

  const loginPath = /(^|\/)(log[-_]?in|sign[-_]?in|sso|saml|oauth2?|auth|authenticate|authorize)(\.\w+)?(\/|$)/i;
  const loginHost = /^(login|signin|auth|accounts?|sso|id|identity)\./i;
  if (
    anyShown("input[type=password]") ||
    (wallLike && (loginPath.test(window.location.pathname) || loginHost.test(window.location.hostname)))
  ) {
    blockers.push("login");
  }

  const codeText =
    /verification code|two[- ]factor|2[- ]?fa\b|two[- ]step verification|2[- ]step verification|one[- ]time (pass)?code|authenticat(or|ion) (app|code)|security code|enter the (\d[- ]digit )?code/i;
  // The words alone prove nothing — a posting can ask for "two-factor authentication
  // experience" — so they need a code box next to them on a page that looks like a wall.
  if (
    anyShown('input[autocomplete="one-time-code"], input[name="otp" i], input[id="otp" i], input[name*="totp" i]') ||
    (wallLike && codeBox && codeText.test(body)) ||
    (wallLike && /(^|\/)(mfa|2fa|two[-_]factor|otp|challenge)(\/|$)/i.test(window.location.pathname))
  ) {
    blockers.push("mfa");
  }

  /** A frame a person can see and act in: on screen, not hidden, bigger than an icon. */
  const inView = (frame: Element): boolean => {
    if (frame.getClientRects().length === 0) return false;
    const box = frame.getBoundingClientRect();
    if (box.width < 30 || box.height < 30) return false;
    if (box.right + window.scrollX <= 0 || box.bottom + window.scrollY <= 0) return false;
    for (let node: Element | null = frame; node; node = node.parentElement) {
      const style = window.getComputedStyle(node);
      if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") return false;
    }
    return true;
  };

  let challenge = false;
  let machinery = false;
  const frames = document.querySelectorAll(
    'iframe[src*="recaptcha"], iframe[src*="hcaptcha"], iframe[src*="challenges.cloudflare.com"], ' +
      'iframe[src*="arkoselabs"], iframe[src*="funcaptcha"], iframe[title*="captcha" i]',
  );
  for (let i = 0; i < frames.length; i++) {
    machinery = true;
    // The reCAPTCHA badge in the corner is a notice, not something to solve.
    if (inView(frames[i]) && !frames[i].closest(".grecaptcha-badge")) challenge = true;
  }

  // A full-page human check: Cloudflare's interstitial and its relatives.
  if (
    exists("#challenge-form, #FunCaptcha") ||
    /^(just a moment|attention required|security check|verify (that )?you are (a )?human)/i.test(document.title) ||
    (wallLike && /verify (that )?you are (a )?human|are you a robot|complete the captcha/i.test(body))
  ) {
    challenge = true;
  }

  // Everything else is evidence of a check that runs by itself: the site key in an
  // inline script (all Greenhouse and Ashby ship at first), loader scripts, the badge,
  // hidden response fields, containers sized "invisible".
  const scripts = document.scripts;
  for (let i = 0; i < scripts.length && !machinery; i++) {
    if (!scripts[i].src) machinery = /recaptcha|hcaptcha|turnstile/i.test((scripts[i].textContent || "").slice(0, 400_000));
  }
  machinery =
    machinery ||
    exists(".g-recaptcha, .h-captcha, .cf-turnstile, .grecaptcha-badge, [data-sitekey]") ||
    exists('[name="g-recaptcha-response"], [name="h-captcha-response"], [name="cf-turnstile-response"], [name*="captcha" i]') ||
    exists(
      'script[src*="recaptcha"], script[src*="hcaptcha"], script[src*="challenges.cloudflare.com/turnstile"], ' +
        'script[src*="arkoselabs"], script[src*="captcha-delivery"]',
    );

  // A widget container that has not been filled in yet may still become a visible checkbox.
  let captchaPending = false;
  const containers = document.querySelectorAll(".g-recaptcha, .h-captcha, .cf-turnstile");
  for (let i = 0; i < containers.length; i++) {
    if (containers[i].getAttribute("data-size") !== "invisible" && !containers[i].querySelector("iframe")) captchaPending = true;
  }

  if (challenge) blockers.push("captcha");
  return { blockers, passiveCaptcha: machinery && !challenge, captchaPending: captchaPending && !challenge };
}

/**
 * What the page says after a Submit that did not go through: a refusal by the site
 * ("We couldn't submit your application", a spam flag, an application limit) or a
 * complaint about the form itself. Null when it says neither.
 */
/**
 * True when the page, after Submit, asks for a code sent to the applicant's email "to
 * confirm you're a human" (Greenhouse does this when it doubts a submission). That is a
 * human check like any CAPTCHA: the application is not sent until a person answers it.
 */
export function detectEmailedCode(): boolean {
  const body = document.body ? (document.body.innerText || "").slice(0, 40_000) : "";
  return /\b(?:verification|security|confirmation)\s+code\s+(?:(?:was|has\s+been)\s+)?sent\b|\bconfirm\s+(?:that\s+)?you(?:'|\u2019)?re\s+(?:a\s+)?human\b/i.test(body);
}

/**
 * True while a file is still on its way up: an upload widget shows that it is busy.
 * Greenhouse shows a progress bar ("file-upload__progressbar") in place of the file's
 * name; Ashby a spinning icon ("loadingSvg") beside it, with Submit enabled all along.
 * A progress bar or spinner that is no part of an upload — "step 2 of 3", a page loading
 * — does not count.
 */
export function detectUploadInProgress(): boolean {
  const busy = document.querySelectorAll(
    '[role="progressbar"], progress, [class*="loading" i], [class*="spinner" i], [aria-busy="true"]',
  );
  for (let i = 0; i < busy.length; i++) {
    const indicator = busy[i];
    if (indicator.getClientRects().length === 0 || window.getComputedStyle(indicator).visibility === "hidden") continue;
    // An SVG's className is not a string: the attribute is read instead.
    let node: Element | null = indicator;
    for (let depth = 0; node && depth < 4; depth++, node = node.parentElement) {
      const marks = `${node.getAttribute("class") || ""} ${node.id || ""}`;
      if (/upload|file|attach|resume|\bcv\b/i.test(marks) || node.querySelector('input[type="file"]')) return true;
    }
  }
  return false;
}

export function detectRefusal(): { kind: "refused" | "invalid"; text: string } | null {
  const regions = document.querySelectorAll(
    '[role="alert"], [aria-live="assertive"], [class*="error" i], [class*="failure" i], [class*="blocked" i]',
  );
  let invalid: { kind: "refused" | "invalid"; text: string } | null = null;
  for (let i = 0; i < regions.length; i++) {
    const region = regions[i] as HTMLElement;
    if (region.getClientRects().length === 0 || window.getComputedStyle(region).visibility === "hidden") continue;
    const text = (region.innerText || "").replace(/\s+/g, " ").trim();
    if (!text) continue;
    const short = text.length > 90 ? text.slice(0, 89) + "…" : text;
    if (/couldn.?t submit|could not (be )?submit|unable to submit|was not submitted|flagged|spam|suspicious|blocked|try again later|too many|application limit/i.test(text)) {
      return { kind: "refused", text: short };
    }
    if (!invalid && /required|invalid|correction|missing|please (fill|enter|complete|select|provide|choose)|error/i.test(text)) {
      invalid = { kind: "invalid", text: short };
    }
  }
  return invalid;
}

/** The headline of a page that says the posting is not there ("Page not found"), else "". */
export function pageSaysGone(): string {
  const text = ((document.body ? document.body.innerText : "") || "").replace(/\s+/g, " ").trim().slice(0, 600);
  const found = /page not found|404 not found|job not found|posting not found|no longer (available|accepting applications|open)|position (has been|is) (filled|closed)|job (has been|is) (closed|filled|no longer)/i.exec(text);
  return found ? found[0] : "";
}

// ---------- Navigation and submit ----------

/**
 * On a posting that shows no form: stamp its "Apply" link or button, and report the
 * address it leads to when it is a plain link. "Apply with LinkedIn" and the like are
 * never candidates — those start a third-party sign-in.
 */
export function markApplyLink(): { found: boolean; href: string | null } {
  const STAMP = "data-reygent-apply";
  const CAPTION =
    /^(apply|apply now|apply here|apply today|apply online|apply for (this|the) (job|role|position|opening)|apply to (this|the) (job|role|position)|apply for job|start (your )?application|begin application|i'm interested)$/i;
  const old = document.querySelectorAll("[" + STAMP + "]");
  for (let i = 0; i < old.length; i++) old[i].removeAttribute(STAMP);

  const candidates = document.querySelectorAll('a[href], button, [role="button"], [role="link"]');
  for (let i = 0; i < candidates.length; i++) {
    const element = candidates[i] as HTMLElement;
    if (element.getClientRects().length === 0 || window.getComputedStyle(element).visibility === "hidden") continue;
    // A button inside a form submits it. Following a link is all this is allowed to do.
    if (element.closest("form") || element.getAttribute("type") === "submit") continue;
    if (element.matches(":disabled") || element.getAttribute("aria-disabled") === "true") continue;
    const caption = (element.innerText || element.getAttribute("aria-label") || "").replace(/\s+/g, " ").trim();
    if (!CAPTION.test(caption)) continue;
    element.setAttribute(STAMP, "");
    const href = element.tagName === "A" ? (element as HTMLAnchorElement).href : "";
    return { found: true, href: /^https?:/i.test(href) ? href : null };
  }
  return { found: false, href: null };
}

/**
 * Greenhouse offers "Attach" or "Enter manually" for the cover letter, and the textarea
 * only exists after the second is pressed. Stamps that button; pressing it is the
 * operator's job, and only when there is a cover note to paste.
 */
export function markCoverLetterToggle(): boolean {
  const STAMP = "data-reygent-toggle";
  const squash = (text: string | null | undefined): string => (text || "").replace(/\s+/g, " ").trim();
  const old = document.querySelectorAll("[" + STAMP + "]");
  for (let i = 0; i < old.length; i++) old[i].removeAttribute(STAMP);

  const buttons = document.querySelectorAll('button[type="button"]');
  for (let i = 0; i < buttons.length; i++) {
    const button = buttons[i] as HTMLButtonElement;
    if (button.disabled || button.getClientRects().length === 0) continue;
    if (!/^(enter|type|write|paste)( it| text)? (manually|here)$/i.test(squash(button.textContent))) continue;
    const box = button.closest('[role="group"], fieldset');
    if (!box || box.querySelector("textarea")) continue;
    const legend = box.querySelector(":scope > legend");
    const ids = squash(box.getAttribute("aria-labelledby"));
    const referenced = ids
      ? ids
          .split(" ")
          .map((id) => {
            const node = document.getElementById(id);
            return node ? node.textContent : "";
          })
          .join(" ")
      : "";
    const caption = squash((legend ? legend.textContent : "") + " " + referenced + " " + (box.getAttribute("aria-label") || ""));
    if (!/\bcover (letter|note)\b/i.test(caption)) continue;
    button.setAttribute(STAMP, "");
    return true;
  }
  return false;
}

/**
 * Stamp the button that submits the filled form. Only a visible, enabled button that
 * says so in words: "Next" or "Continue" on a multi-step form is not a submit.
 */
export function markSubmitButton(): boolean {
  const STAMP = "data-reygent-submit";
  const CAPTION = /^(submit|submit application|submit my application|submit your application|send application|send my application|apply|apply now|complete application|finish application)$/i;
  const old = document.querySelectorAll("[" + STAMP + "]");
  for (let i = 0; i < old.length; i++) old[i].removeAttribute(STAMP);

  const fields = document.querySelectorAll("[data-reygent-field]");
  if (fields.length === 0) return false;
  // The form that owns most of the filled fields; none at all on a page built without <form>.
  const tally = new Map<Element, number>();
  let form: Element | null = null;
  for (let i = 0; i < fields.length; i++) {
    const owner = fields[i].closest("form");
    if (!owner) continue;
    const count = (tally.get(owner) || 0) + 1;
    tally.set(owner, count);
    if (!form || count > (tally.get(form) || 0)) form = owner;
  }

  const buttons = (form || document).querySelectorAll('button, input[type="submit"], [role="button"]');
  for (let i = 0; i < buttons.length; i++) {
    const button = buttons[i] as HTMLElement;
    if (button.getClientRects().length === 0 || window.getComputedStyle(button).visibility === "hidden") continue;
    if (button.matches(":disabled") || button.getAttribute("aria-disabled") === "true") continue;
    const caption = ((button as HTMLInputElement).value || button.innerText || button.getAttribute("aria-label") || "")
      .replace(/\s+/g, " ")
      .trim();
    if (!CAPTION.test(caption)) continue;
    button.setAttribute(STAMP, "");
    return true;
  }
  return false;
}

// ---------- Reading a field back ----------

/**
 * Where `option` sits in the native `<select>` stamped `id`, as an index into its DOM
 * options — the schema skips placeholders, so its own positions do not line up. -1
 * when the control is not a native select or has no such option.
 */
export function selectOptionIndex(target: { id: string; option: string }): number {
  const select = document.querySelector('[data-reygent-field="' + target.id + '"]');
  if (!select || select.tagName !== "SELECT") return -1;
  const options = (select as HTMLSelectElement).options;
  // The schema shortens very long options with an ellipsis; match those by their start.
  const cut = target.option.slice(-1) === "…" ? target.option.slice(0, -1) : null;
  for (let i = 0; i < options.length; i++) {
    const text = (options[i].textContent || "").replace(/\s+/g, " ").trim();
    if (options[i].value === "" || options[i].disabled) continue;
    if (text === target.option || (cut !== null && text.indexOf(cut) === 0)) return i;
  }
  return -1;
}

/** What the controls stamped `id` hold right now, for checking that a fill actually took. */
export function readField(id: string): {
  /** "select" (native), "dropdown" (custom), "buttons" (toggle pair) or "input". */
  control: "select" | "dropdown" | "buttons" | "input";
  files: number;
  /** One entry per radio, checkbox or toggle button, in page order. */
  checked: boolean[];
  /** The choice(s) a select or custom dropdown shows. */
  selected: string[];
  value: string;
  /** The hidden input beside a type-ahead, which holds the picked suggestion. */
  companion: string;
} {
  const squash = (text: string | null | undefined): string => (text || "").replace(/\s+/g, " ").trim();
  const state = {
    control: "input" as "select" | "dropdown" | "buttons" | "input",
    files: 0,
    checked: [] as boolean[],
    selected: [] as string[],
    value: "",
    companion: "",
  };
  const controls = document.querySelectorAll('[data-reygent-field="' + id + '"]');
  for (let i = 0; i < controls.length; i++) {
    const control = controls[i];
    if (control.tagName === "SELECT") {
      state.control = "select";
      const chosen = (control as HTMLSelectElement).selectedOptions;
      for (let j = 0; j < chosen.length; j++) if (chosen[j].value !== "") state.selected.push(squash(chosen[j].textContent));
    } else if (control.tagName === "BUTTON") {
      state.control = "buttons";
      state.checked.push(control.getAttribute("aria-pressed") === "true");
    } else if (control.hasAttribute("data-reygent-combobox")) {
      state.control = "dropdown";
      // react-select shows the choice in an element beside the input, never in it;
      // Ashby's autocomplete writes it into the input. Only this field's own wrappers
      // are searched: further up, the choice shown would be a neighbour's.
      let box = control.parentElement;
      for (let depth = 0; box && depth < 5 && state.selected.length === 0; depth++, box = box.parentElement) {
        const others = box.querySelectorAll("[data-reygent-field]");
        let shared = false;
        for (let j = 0; j < others.length; j++) shared = shared || others[j].getAttribute("data-reygent-field") !== id;
        if (shared) break;
        const values = box.querySelectorAll(
          '[class*="single-value" i], [class*="singleValue" i], [class*="multi-value__label" i], [class*="multiValueLabel" i]',
        );
        for (let j = 0; j < values.length; j++) state.selected.push(squash(values[j].textContent));
      }
      state.value = (control as HTMLInputElement).value;
      if (state.selected.length === 0 && state.value) state.selected.push(squash(state.value));
    } else if (control.tagName === "INPUT" || control.tagName === "TEXTAREA") {
      const input = control as HTMLInputElement;
      if (input.type === "file") state.files += input.files ? input.files.length : 0;
      else if (input.type === "radio" || input.type === "checkbox") state.checked.push(input.checked);
      else {
        state.value = input.value;
        const hidden = input.parentElement ? input.parentElement.querySelector(':scope > input[type="hidden"]') : null;
        state.companion = hidden ? (hidden as HTMLInputElement).value : "";
      }
    }
  }
  return state;
}

/**
 * Has this document become the "application received" page?
 *
 * Words alone are not enough — a form can say "once your application is submitted…"
 * above its own Submit button — so they only count once the document has moved to
 * another address, or (in the frame that held the form) once the form is gone.
 */
export function detectConfirmation(probe: { startUrls: string[]; heldForm: boolean }): boolean {
  const here = window.location.href.split("#")[0];
  const moved = probe.startUrls.indexOf(here) === -1;
  const formGone = probe.heldForm && document.querySelector("[data-reygent-field]") === null;
  if (!moved && !formGone) return false;

  const address = window.location.pathname + window.location.search;
  const urlSays = /thank[-_ ]?you|thanks|confirmation|confirmed|submitted|success|application[-_ ]?received|applied/i.test(address);
  const text = ((document.body ? document.body.innerText : "") + " " + document.title).slice(0, 20_000);
  const textSays =
    /thank you for (applying|your application|submitting)|thanks for (applying|your application|submitting)|application (has been |was )?(successfully )?(received|submitted|sent)|we(['’]ve| have) received your application|successfully submitted/i.test(
      text,
    );
  return textSays || (moved && urlSays);
}
