"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

import { api, errorMessage } from "@/components/api-client";
import { useConsole } from "@/components/console-context";
import { cycleLines, runSummary } from "@/components/cycle";
import { EventList } from "@/components/EventList";
import { count, usd } from "@/components/format";
import { SYSTEM_STATUS } from "@/components/labels";
import { Badge, EmptyState, ErrorCard, Meter, PageHead, RefreshButton, SetupNotices, Tile, When } from "@/components/ui";
import { useApi } from "@/components/use-api";
import type { CycleReport, OverviewBody, PipelineRunBody } from "@/core/web/types";

/** What the last cycle did, wherever it ran. */
function LastCycle({ report, recent }: { report: CycleReport | null; recent: boolean }) {
  return (
    <section className="card">
      <div className="card-head">
        <h2>Last cycle</h2>
        {report ? recent ? <Badge tone="good">Running</Badge> : <Badge tone="warning">Not running</Badge> : null}
      </div>
      {report ? (
        <>
          <p className="sub">
            Finished <When iso={report.finishedAt} />
          </p>
          <ul className="plain-list">
            {cycleLines(report).map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
          {report.paused ? (
            <p className="finding">
              <Badge tone="critical">Paused</Badge> The daily spend cap was reached: paid steps stopped until the next
              budget day.
            </p>
          ) : null}
          {report.blocked.map((reason) => (
            <p className="finding" key={reason}>
              <Badge tone="warning">Blocked</Badge> {reason}
            </p>
          ))}
          {report.errors.length ? (
            <>
              <p className="section-label">Problems</p>
              <ul className="plain-list">
                {report.errors.map((error, index) => (
                  <li key={index}>{error}</li>
                ))}
              </ul>
            </>
          ) : null}
        </>
      ) : (
        <p className="detail-text">
          No cycle has run yet — start it with <code className="code">npm run wake</code>
        </p>
      )}
    </section>
  );
}

/** Monthly income from accepted engagements, against the goal. */
function Income({ goal }: { goal: OverviewBody["goal"] }) {
  const ratio = goal.monthlyIncomeGoalUsd > 0 ? Math.min(1, goal.securedMonthlyUsd / goal.monthlyIncomeGoalUsd) : 0;
  return (
    <section className="card">
      <h2>Income secured</h2>
      <div className="meter-row">
        <div className="figure">
          {usd(goal.securedMonthlyUsd, 0)}
          <small> of {usd(goal.monthlyIncomeGoalUsd, 0)} a month</small>
        </div>
        {ratio >= 1 ? <Badge tone="good">Goal reached</Badge> : null}
      </div>
      <div
        className="meter"
        role="meter"
        aria-valuemin={0}
        aria-valuemax={goal.monthlyIncomeGoalUsd}
        aria-valuenow={goal.securedMonthlyUsd}
        aria-label="Monthly income secured against the goal"
      >
        <div style={{ width: `${(ratio * 100).toFixed(1)}%` }} />
      </div>
      <div className="meter-caption">
        <span>From engagements you recorded as accepted</span>
        <span>Up to {goal.maxConcurrentEngagements} at a time</span>
      </div>
    </section>
  );
}

export function OverviewView() {
  const { showCounts, refreshCounts, toast } = useConsole();
  const { data, error, reload } = useApi<OverviewBody>("/api/overview");
  const [running, setRunning] = useState(false);

  // This page already holds the numbers the sidebar shows; keep them in step.
  useEffect(() => {
    if (data) showCounts(data.stages, data.pending, data.mode);
  }, [data, showCounts]);

  const runDiscovery = async () => {
    setRunning(true);
    try {
      // The server answers only when the run is over, which can take a minute over many job boards.
      const { report } = await api<PipelineRunBody>("POST", "/api/pipeline/run");
      toast(runSummary(report));
    } catch (failure) {
      toast(errorMessage(failure));
    } finally {
      setRunning(false);
      reload();
      refreshCounts();
    }
  };

  if (error) return <ErrorCard message={error} onRetry={reload} />;
  if (!data) return null;
  const { stages, pending, mode } = data;
  const total = Object.values(stages).reduce((sum, n) => sum + n, 0);
  // A Tier 2 job the investigation left open only waits on the user when the pipeline will not apply anyway.
  const undecided = mode.pitchUnconfirmed ? 0 : pending.needsDecision;
  return (
    <>
      <PageHead
        title="Overview"
        subtitle={
          `Goal: ${usd(data.goal.monthlyIncomeGoalUsd, 0)} a month across up to ` +
          `${data.goal.maxConcurrentEngagements} concurrent remote contracts.`
        }
      >
        <RefreshButton onClick={reload} />
        <button type="button" className="button primary" disabled={running} onClick={runDiscovery}>
          {running ? "Running…" : "Run discovery now"}
        </button>
      </PageHead>
      <p className="mode-line">
        <Badge tone={mode.reviewFirst ? "warning" : "accent"}>Mode</Badge>
        <span>{mode.description}</span>
        <Link href="/settings">Change</Link>
      </p>
      <SetupNotices />
      <div className="tiles">
        <Tile label="Tracked applications" value={count(total)} href="/applications" note="every stage" />
        <Tile
          label="Qualified"
          value={count(stages.qualified)}
          href="/applications?stage=qualified"
          note="cleared to draft"
        />
        <Tile
          label="Investigating"
          value={count(stages.investigating)}
          href="/applications?stage=investigating"
          note={undecided ? `${undecided} need your call` : "Tier 2 — B2B check pending"}
        />
        <Tile
          label="Submitted"
          value={count(stages.submitted)}
          href="/applications?stage=submitted"
          note="applications sent"
        />
      </div>
      <p className="tiles-label">Waiting on you</p>
      <div className="tiles">
        <Tile
          label="Held drafts"
          value={count(pending.quarantine)}
          href="/quarantine"
          note="stopped by the Cop Tool"
        />
        <Tile
          label="Need attention"
          value={count(pending.needsAttention)}
          href="/applications?stage=needs_attention"
          note="forms the operator could not finish"
        />
        {pending.needsCode > 0 ? (
          <Tile
            label="Waiting for a code"
            value={count(pending.needsCode)}
            href="/applications?stage=needs_attention"
            note="press I’m ready, then approve the code"
          />
        ) : null}
        {/* Outside review mode nothing waits for approval, so the tile only appears if something somehow does. */}
        {mode.reviewFirst || pending.awaitingReview > 0 ? (
          <Tile
            label="Awaiting review"
            value={count(pending.awaitingReview)}
            href="/applications?stage=awaiting_review"
            note="drafts to approve or decline"
          />
        ) : null}
        {pending.toSend > 0 ? (
          <Tile
            label="Pitches to send"
            value={count(pending.toSend)}
            href="/applications?stage=approved"
            note="no form — you send these"
          />
        ) : null}
      </div>
      <Income goal={data.goal} />
      <section className="card">
        <h2>Spend today</h2>
        <Meter budget={data.budget} />
      </section>
      <div className="columns">
        <div>
          <LastCycle report={data.lastCycle} recent={data.cycleIsRecent} />
          <section className="card flush">
            <div className="card-head">
              <h2>Latest actions</h2>
              <Link href="/activity">All activity</Link>
            </div>
            {data.recentActivity.length ? (
              <EventList events={data.recentActivity} />
            ) : (
              <EmptyState
                title="Nothing has happened yet"
                text="Every action Reygent takes — a listing classified, a draft held, a paid call — is recorded and shown here."
              />
            )}
          </section>
        </div>
        <section className="card flush">
          <h2>What is running</h2>
          <ul className="system-list">
            {data.system.map((part) => (
              <li key={part.name}>
                <span className="name">{part.name}</span>
                <Badge tone={SYSTEM_STATUS[part.status].tone}>{SYSTEM_STATUS[part.status].label}</Badge>
                <span className="detail">{part.detail}</span>
              </li>
            ))}
          </ul>
        </section>
      </div>
    </>
  );
}
