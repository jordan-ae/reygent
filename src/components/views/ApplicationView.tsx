"use client";

import Link from "next/link";
import { type ReactNode, useRef, useState } from "react";

import { api, errorMessage } from "@/components/api-client";
import { useConsole } from "@/components/console-context";
import { EventList } from "@/components/EventList";
import { NumberField, SelectField, TextField } from "@/components/fields";
import { compensation, usd } from "@/components/format";
import { CodeCard } from "@/components/CodeCard";
import { DraftBlock, HoldCard } from "@/components/HoldCard";
import { CHANNEL, OUTCOME, STAGE } from "@/components/labels";
import { ReportBlock } from "@/components/ReportBlock";
import { Badge, Codes, EmptyState, ErrorCard, PageHead, SafeLink, StageBadge, When } from "@/components/ui";
import { useApi } from "@/components/use-api";
import type { ApplicationAction, ApplicationBody } from "@/core/web/types";

const OUTCOME_OPTIONS = Object.entries(OUTCOME).map(([value, { label }]) => [value, label] as const);

/** Record what came of a submitted application. */
function OutcomeForm({ disabled, onRecord }: { disabled: boolean; onRecord: (body: object) => void }) {
  const [kind, setKind] = useState("response");
  const [note, setNote] = useState("");
  const [monthly, setMonthly] = useState<number | null>(null);
  const accepted = kind === "accepted";
  return (
    <>
      <div className="form-grid">
        <SelectField label="What happened" options={OUTCOME_OPTIONS} value={kind} onChange={setKind} />
        {accepted ? (
          <NumberField
            label="Monthly value"
            nullable
            min={0}
            unit="USD / month"
            hint="Counts toward your income goal."
            value={monthly}
            onChange={setMonthly}
          />
        ) : (
          <div />
        )}
        <TextField label="Note (optional)" wide value={note} onChange={setNote} />
      </div>
      <div className="actions">
        <button
          type="button"
          className="button primary"
          // An accepted engagement without its value would add nothing to the income goal.
          disabled={disabled || (accepted && !monthly)}
          onClick={() => onRecord({ kind, note, monthlyValueUsd: accepted ? monthly : null })}
        >
          Record outcome
        </button>
      </div>
    </>
  );
}

/** What the user can do next, given where the application stands. Renders nothing when that is nothing. */
function NextStep({ data, onChanged }: { data: ApplicationBody; onChanged: () => void }) {
  const { toast, refreshCounts } = useConsole();
  const [sending, setSending] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const { job, draft, actions } = data;
  const can = (action: ApplicationAction): boolean => actions.includes(action);
  const base = `/api/applications/${encodeURIComponent(job.id)}`;

  const send = async (path: string, body: object, done: string) => {
    setSending(true);
    setProblem(null);
    try {
      await api<ApplicationBody>("POST", `${base}/${path}`, body);
      toast(done);
      refreshCounts();
      onChanged();
    } catch (error) {
      setProblem(errorMessage(error));
    } finally {
      setSending(false);
    }
  };
  const act = (action: string, done: string) => send("draft", { action }, done);
  const button = (label: string, onClick: () => void, style = "") => (
    <button type="button" className={`button${style}`} disabled={sending} onClick={onClick}>
      {label}
    </button>
  );
  const pitch = useRef<HTMLDivElement>(null);
  const copyPitch = async () => {
    try {
      await navigator.clipboard.writeText(draft?.content.pitch ?? "");
      toast("Pitch copied.");
    } catch {
      // The browser can refuse clipboard access; selecting the text leaves the user one keystroke from a copy.
      if (pitch.current) window.getSelection()?.selectAllChildren(pitch.current);
      toast("Pitch selected — press ⌘C or Ctrl+C to copy it.");
    }
  };

  let body: ReactNode = null;
  if (can("qualify")) {
    body = (
      <>
        <p className="lede">
          The listing says remote without saying where it can hire. If you know the employer can engage a
          Cameroon-based contractor, qualify it; if you know it cannot, rule it out.
        </p>
        <div className="actions">
          {button("Qualify", () => send("investigation", { decision: "qualify" }, "Qualified. The next cycle scores and drafts it."), " primary")}
          {button("Disqualify", () => send("investigation", { decision: "disqualify" }, "Ruled out."), " danger")}
        </div>
      </>
    );
  } else if (can("approve")) {
    body = (
      <>
        <p className="lede">This draft passed the Cop Tool and is waiting for your approval. Read it below.</p>
        <div className="actions">
          {button("Approve", () => act("approve", "Approved."), " primary")}
          {button("Decline", () => act("decline", "Declined."), " danger")}
        </div>
      </>
    );
  } else if (job.stage === "approved" && draft) {
    body = data.sentByHand ? (
      <>
        <p className="lede">
          There is no form for this one, so nothing sends it for you. Copy the pitch, send it
          {draft.content.contact ? ` to ${draft.content.contact}` : ""} yourself, then mark it as sent.
        </p>
        <div className="prose" ref={pitch}>
          {draft.content.pitch}
        </div>
        <div className="actions">
          {button("Copy", copyPitch)}
          {can("submitted") ? button("Mark as sent", () => act("submitted", "Marked as sent."), " primary") : null}
          {can("decline") ? button("Decline", () => act("decline", "Declined."), " danger") : null}
        </div>
      </>
    ) : (
      <>
        <p className="lede">
          Approved. The terminal run (<code className="code">npm run wake</code>) fills in and submits the
          form on its next cycle.
        </p>
        <div className="actions">{can("decline") ? button("Decline", () => act("decline", "Declined."), " danger") : null}</div>
      </>
    );
  } else if (data.codeHold) {
    body = (
      <CodeCard
        jobId={job.id}
        initial={data.codeHold}
        onChanged={onChanged}
        heldActions={can("decline") ? button("Decline", () => act("decline", "Declined."), " danger") : null}
      />
    );
  } else if (can("retry")) {
    body = (
      <>
        <p className="lede">{draft?.note || "The operator could not finish this application."}</p>
        <p>
          Run <code className="code">npm run reygent -- assist</code> to open it in Chrome, already filled in, and
          finish it yourself.
        </p>
        <div className="actions">
          {button("Mark as submitted", () => act("submitted", "Marked as submitted."), " primary")}
          {button("Retry hands-free", () => act("retry", "Approved again. The next cycle retries it."))}
          {button("Decline", () => act("decline", "Declined."), " danger")}
        </div>
      </>
    );
  } else if (can("outcome")) {
    body = <OutcomeForm disabled={sending} onRecord={(outcome) => send("outcomes", outcome, "Outcome recorded.")} />;
  }
  if (!body) return null;
  return (
    <section className="card">
      <h2>{can("outcome") ? "Record an outcome" : data.codeHold ? "Needs the emailed code" : "Next step"}</h2>
      {body}
      {problem ? (
        <p className="form-error" role="alert">
          {problem}
        </p>
      ) : null}
    </section>
  );
}

/** One tracked listing: its verdict, fit, draft, anything held, the listing text and its history. */
export function ApplicationView({ id }: { id: string }) {
  const { data, error, reload } = useApi<ApplicationBody>(`/api/applications/${encodeURIComponent(id)}`);
  const back = (
    <Link className="back" href="/applications">
      ← All applications
    </Link>
  );

  if (error) {
    return (
      <>
        {back}
        <ErrorCard message={error} onRetry={reload} />
      </>
    );
  }
  if (!data) return null;
  const { job, fit, draft } = data;
  const evidence = `/api/applications/${encodeURIComponent(job.id)}/evidence`;
  return (
    <>
      {back}
      <PageHead title={job.company} subtitle={job.title}>
        <StageBadge stage={job.stage} />
      </PageHead>
      <div className="columns">
        <div>
          {/* Re-keyed whenever the job moves or an outcome lands, so a filled-in form never carries over. */}
          <NextStep key={`${job.stage}:${data.outcomes.length}`} data={data} onChanged={reload} />
          <section className="card">
            <h2>Eligibility</h2>
            {data.evaluation ? <ReportBlock report={data.evaluation} /> : <p className="sub">Not classified yet.</p>}
          </section>
          {fit ? (
            <section className="card">
              <h2>Fit</h2>
              <div className="meter-row">
                <div className="figure">
                  {Math.round(fit.fitScore)}
                  <small> out of 100</small>
                </div>
                {fit.bestPositioningProfile ? <span className="code">{fit.bestPositioningProfile}</span> : null}
              </div>
              {fit.matchedSkills.length ? (
                <>
                  <p className="section-label">Skills you have</p>
                  <Codes codes={fit.matchedSkills} />
                </>
              ) : null}
              {fit.missingSkills.length ? (
                <>
                  <p className="section-label">Skills the listing wants that you have not claimed</p>
                  <Codes codes={fit.missingSkills} />
                </>
              ) : null}
            </section>
          ) : null}
          {draft ? (
            <section className="card">
              <div className="card-head">
                <h2>Draft</h2>
                <Badge tone={STAGE[draft.status]?.tone ?? "muted"}>{STAGE[draft.status]?.label ?? draft.status}</Badge>
              </div>
              <p className="sub">
                Written <When iso={draft.createdAt} />
                {draft.copRetries
                  ? ` · passed the Cop Tool after ${draft.copRetries} ${draft.copRetries === 1 ? "rewrite" : "rewrites"}`
                  : " · passed the Cop Tool first time"}
              </p>
              {draft.note ? <p className="detail-text">{draft.note}</p> : null}
              <DraftBlock draft={draft.content} />
            </section>
          ) : null}
          {data.quarantine.length ? (
            <section className="card flush">
              <h2>Held by the Cop Tool</h2>
              {data.quarantine.map((hold) => (
                <HoldCard key={hold.ids.join("-")} hold={hold} withJob={false} onChanged={reload} />
              ))}
            </section>
          ) : null}
          {data.hasEvidence ? (
            <section className="card">
              <h2>Confirmation page</h2>
              <p className="lede">What the employer&apos;s site showed after the form was submitted.</p>
              <a href={evidence} target="_blank" rel="noopener noreferrer">
                {/* Served by this console from its own evidence folder; next/image has nothing to optimise here. */}
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img className="evidence" src={evidence} alt={`Confirmation page for ${job.company} — ${job.title}`} />
              </a>
            </section>
          ) : null}
          <section className="card">
            <h2>Listing</h2>
            {/* Untrusted text from the employer's page: rendered as text, never as markup. */}
            <div className="prose">{job.description || "No description was captured."}</div>
          </section>
        </div>
        <div>
          <section className="card">
            <h2>Details</h2>
            <dl className="kv">
              <dt>Location</dt>
              <dd>{job.location || "—"}</dd>
              <dt>Remote</dt>
              <dd>{job.isRemote === null ? "Not stated" : job.isRemote ? "Yes" : "No"}</dd>
              <dt>Channel</dt>
              <dd>{CHANNEL[job.channel] ?? job.channel}</dd>
              <dt>Source</dt>
              <dd>{job.source}</dd>
              <dt>Type</dt>
              <dd>{job.employmentType ? job.employmentType.replace("_", "-") : "—"}</dd>
              <dt>Compensation</dt>
              <dd>{compensation(job)}</dd>
              <dt>Apply link</dt>
              <dd>
                <SafeLink url={job.applyUrl} />
              </dd>
              <dt>Company domain</dt>
              <dd>{job.companyDomain || "—"}</dd>
              <dt>Skills</dt>
              <dd>{job.skills.length ? job.skills.join(", ") : "—"}</dd>
              <dt>Added</dt>
              <dd>
                <When iso={job.createdAt} />
              </dd>
              <dt>Reference</dt>
              <dd className="mono">{job.id}</dd>
            </dl>
          </section>
          {data.dispatches.length ? (
            <section className="card">
              <h2>Sent</h2>
              <ul className="plain-list">
                {data.dispatches.map((sent, index) => (
                  <li key={index}>
                    <When iso={sent.dispatchedAt} /> · {CHANNEL[sent.channel] ?? sent.channel}
                    {sent.contact || sent.domain ? ` · ${sent.contact || sent.domain}` : ""}
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
          {data.outcomes.length ? (
            <section className="card">
              <h2>Outcomes</h2>
              <ul className="plain-list">
                {data.outcomes.map((outcome, index) => (
                  <li key={index}>
                    <Badge tone={OUTCOME[outcome.kind]?.tone ?? "muted"}>{OUTCOME[outcome.kind]?.label ?? outcome.kind}</Badge>{" "}
                    <When iso={outcome.recordedAt} />
                    {outcome.monthlyValueUsd !== null ? ` · ${usd(outcome.monthlyValueUsd, 0)} a month` : ""}
                    {outcome.note ? ` · ${outcome.note}` : ""}
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
          <section className="card flush">
            <h2>History</h2>
            {data.activity.length ? (
              <EventList events={data.activity} withSubject={false} />
            ) : (
              <EmptyState title="No actions yet" text="" />
            )}
          </section>
        </div>
      </div>
    </>
  );
}
