/** Shapes shared by the browser operator and the modules that drive it. */

export type FieldType =
  | "text" | "email" | "tel" | "url" | "number" | "date" | "textarea"
  | "select" | "radio" | "checkbox" | "file";

/** One form control, as reduced by the in-page extractor (a few dozen bytes, not the DOM). */
export interface FormField {
  /** Stable handle the operator can find the control by again. */
  id: string;
  /** The question as the applicant reads it. */
  label: string;
  type: FieldType;
  required: boolean;
  /** Choices for select / radio / checkbox groups; empty otherwise. */
  options: string[];
  /**
   * Set when the choices only exist after something is typed (a location search, an
   * async autocomplete). Such a field lists no options, and is left for the user —
   * except a location box, where a suggestion naming the verified location is picked.
   */
  typeAhead?: true;
}

/** Something only the user can get past. The operator never tries to. */
export type Blocker = "login" | "mfa" | "captcha";

export interface FormSchema {
  url: string;
  fields: FormField[];
  /**
   * `captcha` here means a challenge a person has to act on: a visible checkbox or
   * widget, an open puzzle, a "verify you are human" wall.
   */
  blockers: Blocker[];
  /**
   * The form carries a check that shows nothing and only runs when Submit is pressed
   * (a score-only reCAPTCHA, an invisible hCaptcha). Not a blocker unless the operator
   * was created with `strictCaptcha`.
   */
  passiveCaptcha?: boolean;
}

/** What the operator did with one application form. */
export interface FillReport {
  /**
   * submitted  — a confirmation page was seen.
   * handed_off — the user is needed: the form is filled and waiting in a visible window,
   *              or (headless) it could not be completed and `reason` says why.
   * failed     — the page could not be opened or no application form was found.
   */
  status: "submitted" | "handed_off" | "failed";
  /** Why it was handed off or failed, short enough to show as-is; empty when submitted. */
  reason: string;
  /** Labels of the fields the operator filled. */
  filled: string[];
  /**
   * Labels of fields left for the user (custom questions are never guessed). When a
   * headless run stops before typing anything, these are the fields it had no answer for.
   */
  unfilled: string[];
  blockers: Blocker[];
  /** The subset of `unfilled` the form marks as required — what stops a hands-free submit. */
  requiredUnfilled: string[];
  /** See FormSchema.passiveCaptcha. */
  passiveCaptcha?: boolean;
  /**
   * The operator pressed Submit. Without a confirmation the application may or may not
   * have gone through; without this, nothing was sent.
   */
  pressed?: boolean;
  /**
   * After Submit the site emailed the candidate a code to confirm a person is applying, and
   * none that it accepted was entered. Nothing went out: the site takes the application only
   * once its code is in.
   */
  emailedCode?: boolean;
  /**
   * Screenshot kept when `evidenceDir` is set: of the confirmation page when submitted,
   * or — when Submit was pressed and no confirmation followed — of what the page showed.
   */
  evidencePath?: string;
  /**
   * Screenshot of the filled form, taken just before the operator pressed Submit itself
   * (`<job.id>-form.png`): what was actually sent when nobody was watching.
   */
  formEvidencePath?: string;
  /**
   * Answers written on the way, from the candidate's data, to questions the draft held
   * none for (a later step of the form, a question revealed by a choice).
   */
  answered?: Array<{ question: string; answer: string; options: string[]; factKey: string }>;
  /** What the browser agent did, one line per action, when it was called on. */
  agentTrail?: string[];
  /** What the agent's decisions cost, in USD. */
  agentUsd?: number;
}

/**
 * What the operator will do with one field. A field is only filled from a verified
 * fact, the approved pitch, the resume, or a screening answer written for exactly
 * that question; everything else is left for the user.
 */
export type FieldPlan =
  /** Type `value`; `source` is the screeningFacts() key, or "screening_answer". */
  | { field: FormField; action: "fill"; value: string; source: string }
  /** Attach the resume PDF at `path`. */
  | { field: FormField; action: "upload"; path: string }
  /** Paste the cover note. */
  | { field: FormField; action: "pitch"; value: string }
  /** Choose `option`, which is one of `field.options` verbatim. */
  | { field: FormField; action: "select"; option: string; source: string }
  /** Type `query` into a type-ahead and pick the one suggestion that names the same place. */
  | { field: FormField; action: "pick"; query: string; source: string }
  | { field: FormField; action: "leave"; reason: string };
