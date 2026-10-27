"use client";

import Link from "next/link";
import { Fragment, useId, useState } from "react";

import { api, errorMessage } from "@/components/api-client";
import { useConsole } from "@/components/console-context";
import { plural, usd } from "@/components/format";
import { RULE } from "@/components/labels";
import { Badge, When } from "@/components/ui";
import type { DraftContent, HoldQuestion, QuarantineHold, RetryBody, ReviewBody } from "@/core/web/types";

/** What a draft says: pitch, CV bullets, form answers, how the CV lines up, rate and contact. All of it untrusted text. */
export function DraftBlock({ draft }: { draft: DraftContent | null }) {
  if (!draft) return <p className="sub">The draft could not be read.</p>;
  const rate = draft.quotedRateUsd === null ? null : `${usd(draft.quotedRateUsd, 0)} / ${draft.quotedRatePeriod || "?"}`;
  return (
    <div className="draft">
      {draft.pitch ? (
        <>
          <p className="section-label">Pitch</p>
          <div className="prose">{draft.pitch}</div>
        </>
      ) : null}
      {draft.cvSummary ? (
        <>
          <p className="section-label">CV summary, written for this listing</p>
          <div className="prose">{draft.cvSummary}</div>
        </>
      ) : null}
      {draft.cvBullets.length ? (
        <>
          <p className="section-label">{draft.cvMatch ? "CV lines, as worded for this listing" : "CV bullets"}</p>
          <ul className="plain-list">
            {draft.cvBullets.map((bullet, index) => (
              <li key={index}>
                {bullet.text} <span className="code">{bullet.achievementId}</span>
              </li>
            ))}
          </ul>
        </>
      ) : null}
      {draft.screeningAnswers.length ? (
        <>
          <p className="section-label">Form answers</p>
          <ul className="plain-list">
            {draft.screeningAnswers.map((item, index) => (
              <li key={index}>
                <strong>{item.question}</strong>
                <br />
                {item.answer || <span className="sub">Not answered</span>}
                {item.options.length ? <span className="sub"> (options: {item.options.join(" / ")})</span> : null}
              </li>
            ))}
          </ul>
        </>
      ) : null}
      {draft.cvMatch ? (
        <>
          <p className="section-label">CV tuned to this listing</p>
          <dl className="kv">
            <dt>Headline</dt>
            <dd>{draft.cvMatch.headline}</dd>
            <dt>On the page</dt>
            <dd>
              {draft.cvMatch.matched.length
                ? `${draft.cvMatch.matched.length} of the ${draft.cvMatch.asked.length} terms the listing asks for: ${draft.cvMatch.matched.join(", ")}`
                : "The listing names no term your CV backs"}
            </dd>
            {draft.cvMatch.missing.length ? (
              <>
                <dt>Not on your CV</dt>
                <dd>
                  {draft.cvMatch.missing.join(", ")}
                  <br />
                  <span className="sub">
                    Left off because nothing you have listed backs them. Add any that are true to your skills
                    (Profile) or a verified achievement (Fact bank).
                  </span>
                </dd>
              </>
            ) : null}
          </dl>
        </>
      ) : null}
      {rate || draft.contact || draft.resumePdfPath ? (
        <dl className="kv">
          {rate ? (
            <>
              <dt>Quoted rate</dt>
              <dd>{rate}</dd>
            </>
          ) : null}
          {draft.contact ? (
            <>
              <dt>Contact</dt>
              <dd>{draft.contact}</dd>
            </>
          ) : null}
          {draft.resumePdfPath ? (
            <>
              <dt>Resume</dt>
              <dd className="mono">{draft.resumePdfPath}</dd>
            </>
          ) : null}
        </dl>
      ) : null}
    </div>
  );
}

// Field names are snake_case in holds written by the Python version and camelCase now.
const FIELD_LABELS: Record<string, string> = {
  pitch: "Pitch", cvSummary: "CV summary", job: "Listing", links: "Links", profile: "Profile", draft: "Draft",
  resume_pdf: "Resume PDF", resumePdf: "Resume PDF", resumePdfPath: "Resume PDF",
  quoted_rate: "Quoted rate", quotedRate: "Quoted rate", quotedRateUsd: "Quoted rate",
};

/** Critiques arrive as "[field] message"; show the field as a readable label. */
function Critique({ text }: { text: string }) {
  const match = /^\[([A-Za-z_]+)(?:\[(\d+)\])?\] ([\s\S]*)$/.exec(text);
  if (!match) return <li>{text}</li>;
  const [, field, index, message] = match;
  const label =
    field === "cv_bullets" || field === "cvBullets"
      ? `CV bullet ${Number(index) + 1}`
      : field === "screening_answers" || field === "screeningAnswers"
        ? `Form answer ${Number(index) + 1}`
        : (FIELD_LABELS[field] ?? field);
  return (
    <li>
      <span className="code">{label}</span> {message}
    </li>
  );
}

/** One form question the draft is waiting on: a choice among the form's options, or free text. */
function QuestionInput({
  question,
  value,
  onChange,
}: {
  question: HoldQuestion;
  value: string;
  onChange: (value: string) => void;
}) {
  const id = useId();
  return (
    <div className="field">
      <label htmlFor={id}>{question.question}</label>
      {question.options.length ? (
        <select id={id} value={value} onChange={(event) => onChange(event.target.value)}>
          <option value="">Choose…</option>
          {question.options.map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </select>
      ) : (
        <input id={id} type="text" autoComplete="off" value={value} onChange={(event) => onChange(event.target.value)} />
      )}
      <p className="hint">
        {question.reason === "unanswered"
          ? "Reygent could not answer this from your data."
          : question.answer
            ? `The AI answered “${question.answer}” but could not verify it against your data. Confirm or correct it.`
            : "The AI's answer could not be verified against your data."}
      </p>
    </div>
  );
}

/**
 * One draft the Cop Tool refused to send: the rules that fired, what they objected to,
 * the questions only the candidate can answer, and the draft itself.
 */
export function HoldCard({
  hold,
  withJob = true,
  onChanged,
}: {
  hold: QuarantineHold;
  /** Name the job; off on the job's own page. */
  withJob?: boolean;
  /** Called after the hold was reviewed or retried, so the page can reload. */
  onChanged: () => void;
}) {
  const { toast, refreshCounts } = useConsole();
  const [sending, setSending] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  // An unverified AI answer starts in its box, for the user to confirm or correct.
  const [answers, setAnswers] = useState<string[]>(() => hold.questions.map((question) => question.answer));
  const given = hold.questions
    .map((question, index) => ({ question: question.question, answer: (answers[index] ?? "").trim() }))
    .filter((entry) => entry.answer);

  const send = async (work: () => Promise<string>) => {
    setSending(true);
    setProblem(null);
    try {
      toast(await work());
      refreshCounts();
      onChanged();
    } catch (error) {
      setProblem(errorMessage(error));
    } finally {
      setSending(false);
    }
  };

  const review = () =>
    send(async () => {
      await api<ReviewBody>("POST", "/api/quarantine/review", { ids: hold.ids });
      return "Marked as reviewed.";
    });
  const retry = (withAnswers: boolean) =>
    send(async () => {
      const { saved } = await api<RetryBody>("POST", "/api/quarantine/retry", {
        ids: hold.ids, answers: withAnswers ? given : [],
      });
      const remembered = saved ? `${saved} ${plural(saved, "answer", "answers")} remembered. ` : "";
      return `${remembered}Sent back to drafting — the next cycle writes it again.`;
    });

  return (
    <article className="held">
      <div className="held-head">
        <span className="title">
          {withJob && hold.company ? (
            <Link href={`/applications/${hold.jobId}`}>
              {hold.company} — {hold.title}
            </Link>
          ) : (
            "Draft held"
          )}
        </span>
        <span className="sub">
          <When iso={hold.createdAt} />
        </span>
        <span className="sub">
          {hold.retryCount
            ? `after ${hold.retryCount} auto-fix ${plural(hold.retryCount, "attempt", "attempts")}`
            : "held without a rewrite"}
        </span>
        {hold.status === "pending" ? (
          <>
            {hold.canRetry ? (
              <button type="button" className="button small" disabled={sending} onClick={() => retry(false)}>
                Retry
              </button>
            ) : null}
            <button type="button" className="button small" disabled={sending} onClick={review}>
              Mark reviewed
            </button>
          </>
        ) : (
          <Badge tone="muted">Reviewed</Badge>
        )}
      </div>
      {hold.findings.map((finding, index) => (
        <Fragment key={`${index}:${finding.rule}`}>
          <p className="finding">
            <Badge tone="serious">{RULE[finding.rule] ?? finding.rule}</Badge>
          </p>
          <ul className="plain-list">
            {finding.critiques.map((critique, at) => (
              <Critique key={at} text={critique} />
            ))}
          </ul>
        </Fragment>
      ))}
      {hold.canRetry && hold.questions.length ? (
        <div className="result">
          <p className="section-label first">
            Answer {plural(hold.questions.length, "this", "these")} once — Reygent gives the same answer every time
            the question is asked
          </p>
          <div className="form-grid">
            {hold.questions.map((question, index) => (
              <QuestionInput
                key={question.question}
                question={question}
                value={answers[index] ?? ""}
                onChange={(value) => setAnswers((current) => current.map((old, at) => (at === index ? value : old)))}
              />
            ))}
          </div>
          <div className="actions">
            <button
              type="button"
              className="button primary small"
              disabled={sending || given.length === 0}
              onClick={() => retry(true)}
            >
              Save answers and retry
            </button>
          </div>
        </div>
      ) : null}
      {problem ? (
        <p className="form-error" role="alert">
          {problem}
        </p>
      ) : null}
      <details>
        <summary>Show the draft</summary>
        <DraftBlock draft={hold.draft} />
      </details>
    </article>
  );
}
