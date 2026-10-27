/** How stored values are named and coloured on screen. */

import type { ActivityKind, ReadinessArea, SystemStatus } from "@/core/web/types";

export type Tone = "good" | "warning" | "serious" | "critical" | "accent" | "muted";

interface Label {
  label: string;
  tone: Tone;
}

export const TIER: Record<string, Label> = {
  confirmed: { label: "Confirmed eligible", tone: "good" },
  potentially_eligible: { label: "Potentially eligible", tone: "warning" },
  ineligible: { label: "Ineligible", tone: "muted" },
};

/** Pipeline stages, in the order a job moves through them. Also the status of a stored draft. */
export const STAGE: Record<string, Label> = {
  discovered: { label: "Discovered", tone: "muted" },
  qualified: { label: "Qualified", tone: "good" },
  investigating: { label: "Investigating", tone: "warning" },
  disqualified: { label: "Disqualified", tone: "muted" },
  quarantined: { label: "Quarantined", tone: "serious" },
  awaiting_review: { label: "Awaiting review", tone: "warning" },
  approved: { label: "Approved", tone: "accent" },
  submitted: { label: "Submitted", tone: "accent" },
  needs_attention: { label: "Needs attention", tone: "serious" },
  declined: { label: "Declined", tone: "muted" },
};

export const CHANNEL: Record<string, string> = {
  founder_direct: "Founder direct",
  ats_inbound: "ATS inbound",
  recruiter_direct: "Recruiter direct",
  contract_gigs: "Contract gigs",
};

export const RULE: Record<string, string> = {
  "1_fact_grounding": "Fact grounding",
  "2_screening_sanity": "Screening answers",
  "3_link_verification": "Links",
  "4_asset_integrity": "Assets & format",
  "5_commitment_guard": "Commitments",
  "6_rate_floor": "Rate floor",
  "7_scam_filter": "Scam filter",
  "8_deduplication": "De-duplication",
  "9_tone": "Tone",
};

export const KIND: Record<ActivityKind, string> = {
  discovered: "Added",
  evaluated: "Classified",
  queued: "Queued",
  drafted: "Drafted",
  quarantined: "Held",
  dispatched: "Sent",
  outcome: "Outcome",
  llm_call: "Paid call",
  breaker: "Spend cap",
};

/** What came of a submitted application. */
export const OUTCOME: Record<string, Label> = {
  response: { label: "Response", tone: "accent" },
  interview: { label: "Interview", tone: "accent" },
  offer: { label: "Offer", tone: "good" },
  accepted: { label: "Accepted", tone: "good" },
  rejection: { label: "Rejection", tone: "muted" },
};

export const SYSTEM_STATUS: Record<SystemStatus, Label> = {
  ready: { label: "Ready", tone: "good" },
  needs_setup: { label: "Needs setup", tone: "warning" },
  paused: { label: "Paused", tone: "critical" },
  running: { label: "Running", tone: "good" },
  idle: { label: "Not running", tone: "warning" },
};

export const AREA: Record<ReadinessArea, { href: string; label: string }> = {
  profile: { href: "/profile", label: "Open Profile" },
  fact_bank: { href: "/fact-bank", label: "Open Fact bank" },
  settings: { href: "/settings", label: "Open Settings" },
};

/** Shown on the Fact bank page while the config cannot be read, so its form still works. */
export const POSITIONING_FALLBACK = [
  { id: "ai_platform_agent", title: "AI Platform / Agent Engineer" },
  { id: "fullstack_product", title: "Senior Full-Stack Product Engineer" },
  { id: "applied_ai_llm", title: "Applied AI / LLM Engineer" },
  { id: "frontend_systems", title: "Frontend Systems Engineer" },
];
