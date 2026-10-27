"use client";

import Link from "next/link";
import type { ReactNode } from "react";

import { useBoot } from "@/components/console-context";
import { dateTimeFormat, fullDateFormat, spend, usd } from "@/components/format";
import { AREA, STAGE, TIER, type Tone } from "@/components/labels";
import type { Budget } from "@/core/web/types";

// All server data — listing text especially — is untrusted. Everything here renders it as
// React text children, which are escaped; nothing in the console sets HTML directly.

export function Badge({ tone, children }: { tone: Tone; children: ReactNode }) {
  return <span className={`badge tone-${tone}`}>{children}</span>;
}

export function TierBadge({ tier }: { tier: string | null }) {
  const known = tier ? TIER[tier] : undefined;
  return known ? <Badge tone={known.tone}>{known.label}</Badge> : <span className="sub">Not classified</span>;
}

export function StageBadge({ stage }: { stage: string }) {
  const known = STAGE[stage];
  return <Badge tone={known?.tone ?? "muted"}>{known?.label ?? stage}</Badge>;
}

export function Codes({ codes }: { codes: string[] }) {
  return (
    <span className="codes">
      {codes.map((code, index) => (
        <span className="code" key={`${index}:${code}`}>
          {code}
        </span>
      ))}
    </span>
  );
}

/** A timestamp in the reader's locale, with the full date on hover. */
export function When({ iso }: { iso: string | null | undefined }) {
  if (!iso) return "—";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return (
    <time dateTime={iso} title={fullDateFormat.format(date)}>
      {dateTimeFormat.format(date)}
    </time>
  );
}

/** A listing's link. Only http(s) becomes clickable; anything else is shown as plain text. */
export function SafeLink({ url }: { url: string | null }) {
  if (!url) return "—";
  if (!/^https?:\/\//i.test(url)) return url;
  return (
    <a href={url} target="_blank" rel="noopener noreferrer">
      {url}
    </a>
  );
}

export function PageHead({ title, subtitle, children }: { title: string; subtitle?: string; children?: ReactNode }) {
  return (
    <header className="page-head">
      <div>
        <h1>{title}</h1>
        {subtitle ? <p>{subtitle}</p> : null}
      </div>
      {children ? <div className="page-actions">{children}</div> : null}
    </header>
  );
}

export function RefreshButton({ onClick }: { onClick: () => void }) {
  return (
    <button type="button" className="button" onClick={onClick}>
      Refresh
    </button>
  );
}

export function EmptyState({ title, text, children }: { title: string; text: string; children?: ReactNode }) {
  return (
    <div className="empty">
      <h3>{title}</h3>
      <p>{text}</p>
      {children}
    </div>
  );
}

export function ErrorCard({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <section className="card notice error" role="alert">
      <h2>Something went wrong</h2>
      <p className="lede">{message}</p>
      <button type="button" className="button" onClick={onRetry}>
        Try again
      </button>
    </section>
  );
}

export function Tile({ label, value, href, note }: { label: string; value: string; href?: string; note?: string }) {
  const body = (
    <>
      <div className="label">{label}</div>
      <div className="value">{value}</div>
      {note ? <div className="note">{note}</div> : null}
    </>
  );
  return href ? (
    <Link className="tile" href={href}>
      {body}
    </Link>
  ) : (
    <div className="tile">{body}</div>
  );
}

/** Today's spend against the daily cap. Renders straight into a card. */
export function Meter({ budget }: { budget: Budget }) {
  const ratio = budget.capUsd > 0 ? Math.min(1, budget.spentUsd / budget.capUsd) : 1;
  const level = budget.tripped || ratio >= 0.9 ? " critical" : ratio >= 0.7 ? " warning" : "";
  const offset = budget.utcOffsetHours;
  return (
    <>
      <div className="meter-row">
        <div className="figure">
          {spend(budget.spentUsd)}
          <small> of {usd(budget.capUsd)} today</small>
        </div>
        {budget.tripped ? <Badge tone="critical">Paused — cap reached</Badge> : <Badge tone="good">Running</Badge>}
      </div>
      <div
        className={`meter${level}`}
        role="meter"
        aria-valuemin={0}
        aria-valuemax={budget.capUsd}
        aria-valuenow={budget.spentUsd}
        aria-label="Spend today against the daily cap"
      >
        <div style={{ width: `${(ratio * 100).toFixed(1)}%` }} />
      </div>
      <div className="meter-caption">
        <span>{spend(budget.remainingUsd)} remaining</span>
        <span>
          Resets at midnight UTC{offset >= 0 ? "+" : ""}
          {offset}
        </span>
      </div>
    </>
  );
}

/** What is wrong with the config file and, on the overview, everything still to set up. */
export function SetupNotices({ errorOnly = false }: { errorOnly?: boolean }) {
  const { boot } = useBoot();
  return (
    <>
      {boot.configError ? (
        <section className="card notice error">
          <h2>config.yaml could not be read</h2>
          <p className="lede">{boot.configError}</p>
          <p>The forms below show defaults. Saving replaces the file; the old one is kept as config.yaml.bak.</p>
        </section>
      ) : null}
      {!errorOnly && boot.readiness.length ? (
        <section className="card notice">
          <h2>Before Reygent can apply on your behalf</h2>
          <ul>
            {boot.readiness.map((issue, index) => (
              <li key={index}>
                {issue.message} — <Link href={AREA[issue.area].href}>{AREA[issue.area].label}</Link>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </>
  );
}

/** A row of mutually exclusive filter buttons. */
export function Segmented<T extends string>({
  label,
  options,
  value,
  onChange,
}: {
  label: string;
  options: ReadonlyArray<{ value: T; label: string; count?: number }>;
  value: T;
  onChange: (value: T) => void;
}) {
  return (
    <div className="seg" role="group" aria-label={label}>
      {options.map((option) => (
        <button
          type="button"
          key={option.value}
          aria-pressed={value === option.value}
          onClick={() => onChange(option.value)}
        >
          {option.label}
          {option.count === undefined ? null : <span>{option.count.toLocaleString("en-US")}</span>}
        </button>
      ))}
    </div>
  );
}
