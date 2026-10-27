"use client";

import { Codes, TierBadge } from "@/components/ui";
import type { EvaluationSummary } from "@/core/web/types";

function Lines({ label, lines }: { label: string; lines: string[] }) {
  if (!lines.length) return null;
  return (
    <>
      <p className="section-label">{label}</p>
      <ul className="plain-list">
        {lines.map((line, index) => (
          <li key={index}>{line}</li>
        ))}
      </ul>
    </>
  );
}

/** An eligibility verdict: the tier and the evidence behind it. */
export function ReportBlock({ report }: { report: EvaluationSummary }) {
  return (
    <>
      <p>
        <TierBadge tier={report.tier} />
      </p>
      {/* Tiers 1 and 3 are fully explained by the lists below; Tier 2 carries the next step. */}
      {report.tier === "potentially_eligible" ? <p className="detail-text">{report.summary}</p> : null}
      {report.reasonCodes.length ? (
        <>
          <p className="section-label">Reason codes</p>
          <Codes codes={report.reasonCodes} />
        </>
      ) : null}
      <Lines label="Signals in favour" lines={report.positiveSignals} />
      <Lines label="Disqualifiers" lines={report.disqualifiers} />
    </>
  );
}
