"use client";

import Link from "next/link";
import type { ReactNode } from "react";

import { count, plural, spend, usd } from "@/components/format";
import { CHANNEL, KIND, OUTCOME, RULE, STAGE, TIER, type Tone } from "@/components/labels";
import { Badge, Codes, When } from "@/components/ui";
import type { ActivityEvent } from "@/core/web/types";

function describe(event: ActivityEvent): { tone: Tone; detail: ReactNode } {
  switch (event.kind) {
    case "discovered": {
      const { source, channel } = event.detail;
      return { tone: "accent", detail: `From ${source} · ${CHANNEL[channel] ?? channel}` };
    }
    case "evaluated": {
      const tier = TIER[event.detail.tier] ?? { label: event.detail.tier, tone: "muted" as const };
      return {
        tone: tier.tone,
        detail: (
          <>
            {tier.label} <Codes codes={event.detail.reasonCodes} />
          </>
        ),
      };
    }
    case "queued": {
      const { taskType, status } = event.detail;
      return {
        tone: "warning",
        detail: `${taskType === "b2b_investigation" ? "B2B contractor investigation" : taskType} · ${status}`,
      };
    }
    case "drafted": {
      const { status, note, copRetries } = event.detail;
      const stage = STAGE[status] ?? { label: status, tone: "muted" as const };
      return {
        tone: stage.tone,
        detail:
          `Passed the Cop Tool${copRetries ? ` after ${copRetries} ${plural(copRetries, "rewrite", "rewrites")}` : ""}` +
          ` · now ${stage.label.toLowerCase()}${note ? ` · ${note}` : ""}`,
      };
    }
    case "outcome": {
      const { outcome, note, monthlyValueUsd } = event.detail;
      const known = OUTCOME[outcome] ?? { label: outcome, tone: "muted" as const };
      return {
        tone: known.tone,
        detail:
          known.label +
          (monthlyValueUsd !== null ? ` · ${usd(monthlyValueUsd, 0)} a month` : "") +
          (note ? ` · ${note}` : ""),
      };
    }
    case "quarantined": {
      const { rules, retryCount, status } = event.detail;
      return {
        tone: "serious",
        detail:
          `Stopped on ${rules.map((rule) => RULE[rule] ?? rule).join(", ")}` +
          (retryCount ? ` · after ${retryCount} auto-fix ${plural(retryCount, "attempt", "attempts")}` : "") +
          (status === "reviewed" ? " · reviewed" : ""),
      };
    }
    case "dispatched": {
      const { channel, contact, domain } = event.detail;
      return {
        tone: "good",
        detail: `${CHANNEL[channel] ?? channel}${contact || domain ? ` · ${contact || domain}` : ""}`,
      };
    }
    case "llm_call": {
      const call = event.detail;
      return {
        tone: call.outcome === "ok" ? "accent" : "serious",
        detail:
          `${call.taskType} · ${count(call.promptTokens)} in / ${count(call.completionTokens)} out · ` +
          `${spend(call.costUsd)} · ${count(call.latencyMs)} ms · ${call.outcome}`,
      };
    }
    case "breaker":
      return {
        tone: "critical",
        detail: `Daily cap reached at ${spend(event.detail.spentUsd)}; paid calls paused for ${event.detail.day}`,
      };
    default:
      return { tone: "muted", detail: "" };
  }
}

function Subject({ event }: { event: ActivityEvent }) {
  if (event.jobId) {
    return (
      <Link href={`/applications/${event.jobId}`}>
        {event.company || "Unknown company"} — {event.title || ""}
      </Link>
    );
  }
  if (event.kind === "llm_call") return `${event.detail.provider} · ${event.detail.model.split("/").pop()}`;
  return "Spend guard";
}

/** Actions, newest first. `withSubject` is off on a job's own page, where the job is already known. */
export function EventList({ events, withSubject = true }: { events: ActivityEvent[]; withSubject?: boolean }) {
  return (
    <ul className="events">
      {events.map((event, index) => {
        const described = describe(event);
        return (
          <li key={`${event.at}:${event.kind}:${event.jobId ?? ""}:${index}`}>
            <span className="when">
              <When iso={event.at} />
            </span>
            <span>
              <Badge tone={described.tone}>{KIND[event.kind] ?? event.kind}</Badge>
            </span>
            <div className="what">
              {withSubject ? (
                <div className="subject">
                  <Subject event={event} />
                </div>
              ) : null}
              <div className="detail-text">{described.detail}</div>
            </div>
          </li>
        );
      })}
    </ul>
  );
}
