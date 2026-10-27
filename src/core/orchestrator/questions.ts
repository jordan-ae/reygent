/** Turns an application form into the list of custom questions a draft must answer. */

import { CUSTOM_REASON, SENSITIVE_REASON, planFields } from "@/core/browser/fieldMap";
import type { FormSchema } from "@/core/browser/types";
import type { FormQuestion } from "@/core/drafting/tailor";
import { type CandidateProfile, createDraft } from "@/core/models";

// "I agree to use only my own words. I understand that plagiarism, the use of AI or other
// generated content will result in…", "AI Policy for Application: we value authenticity
// and individuality in the hiring process…". An employer's consent to its own use of AI
// ("the use of AI for evaluating my candidacy") is a different question and does not match.
const OWN_WORDS_RX = new RegExp(
  String.raw`\bonly\s+my\s+own\s+words\b` +
    String.raw`|\b(?:use\s+of|using)\s+(?:AI|A\.I\.|artificial\s+intelligence|generative\s+AI|ChatGPT|LLMs?)\b[^?]{0,200}` +
    String.raw`\b(?:disqualif\w+|prohibited|forbidden|not\s+(?:permitted|allowed|acceptable)|will\s+result)\b` +
    String.raw`|\bwithout\s+(?:the\s+)?(?:use|help|assistance|aid)\s+of\s+(?:AI|artificial\s+intelligence|generative\s+AI|ChatGPT)\b` +
    String.raw`|\b(?:did|have|will)\s+not\s+used?\s+(?:AI|artificial\s+intelligence|generative\s+AI|ChatGPT)\b` +
    String.raw`|\b(?:AI|A\.I\.|artificial\s+intelligence)\s+polic(?:y|ies)\s+for\s+(?:the\s+|your\s+|this\s+)?(?:application|applicants?|candidates?)\b`,
  "i",
);

/**
 * The form's own words asking applicants not to use AI, when it does. Such an application
 * is the candidate's to write: answering it with generated text would break the very
 * agreement the form asks them to make.
 */
export function asksForOwnWords(form: FormSchema): string | null {
  return form.fields.find((field) => forbidsAi(field.label))?.label ?? null;
}

/** True when `question` asks the applicant not to use AI. */
export function forbidsAi(question: string): boolean {
  return OWN_WORDS_RX.test(question);
}

// "What is the application code found in the browser console at …/jobs (to help us filter
// out robots)", "follow the instructions at … and paste the value of the secret here".
// A check that the applicant is a person, worded as a question.
const PROVE_HUMAN_RX = new RegExp(
  String.raw`\bfilter\s+out\s+(?:the\s+)?(?:robots?|bots?)\b|\b(?:not\s+a|are\s+you\s+a)\s+(?:robot|bot)\b|\bprove\s+(?:that\s+)?you(?:'re|\s+are)\s+(?:a\s+)?human\b` +
    String.raw`|\bpaste\s+(?:the\s+)?(?:value\s+of\s+the\s+)?secret\b|\b(?:application|secret)\s+code\b[^?]{0,80}\b(?:browser\s+)?console\b` +
    String.raw`|\b(?:browser|developer|javascript)\s+console\b`,
  "i",
);

/** True when `question` is a check that the applicant is a person: Reygent never answers one. */
export function provesHuman(question: string): boolean {
  return PROVE_HUMAN_RX.test(question);
}

/**
 * The form's question checking that the applicant is a person, when it has one. Such an
 * application is the candidate's to make by hand: Reygent does not get past a check meant
 * to keep software out, however it is worded.
 */
export function asksToProveHuman(form: FormSchema): string | null {
  return form.fields.find((field) => provesHuman(field.label))?.label ?? null;
}

/**
 * The questions on `form` that are not standard fields.
 *
 * The operator's own field plan decides what is standard (name, email, links, resume,
 * cover note): whatever it would leave as a custom or sensitive question is what the
 * drafting step has to answer. File uploads other than the resume cannot be answered
 * with text and are left out.
 */
export function formQuestions(form: FormSchema, profile: CandidateProfile, jobId: string): FormQuestion[] {
  const questions: FormQuestion[] = [];
  const seen = new Set<string>();
  for (const plan of planFields(form.fields, profile, createDraft({ jobId }))) {
    if (plan.action !== "leave" || plan.field.type === "file") continue;
    if (plan.reason !== CUSTOM_REASON && plan.reason !== SENSITIVE_REASON) continue;
    // A form can repeat a label (a text box next to a file input); one answer covers it.
    if (seen.has(plan.field.label)) continue;
    seen.add(plan.field.label);
    questions.push({
      question: plan.field.label,
      kind: plan.field.options.length > 0 ? "choice" : "text",
      options: plan.field.options,
      required: plan.field.required,
      sensitive: plan.reason === SENSITIVE_REASON,
      short: plan.field.options.length === 0 && plan.field.type !== "textarea",
    });
  }
  return questions;
}
