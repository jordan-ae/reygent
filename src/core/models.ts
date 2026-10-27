/**
 * Domain models shared by every module.
 *
 * Models are plain data (camelCase); behaviour lives in functions. Values that are
 * persisted as strings (tiers, stages, channels) keep the exact spellings used in the
 * SQLite database, so an existing ~/.reygent/reygent.db keeps working.
 */

import { createHash } from "node:crypto";

/** Marks a candidate fact the user has not filled in yet. Nothing may be grounded on it. */
export const PLACEHOLDER = "CHANGE_ME";

// ---------- Pipeline vocabulary ----------

export const EligibilityTier = {
  CONFIRMED_ELIGIBLE: "confirmed",
  POTENTIALLY_ELIGIBLE: "potentially_eligible",
  INELIGIBLE: "ineligible",
} as const;
export type EligibilityTier = (typeof EligibilityTier)[keyof typeof EligibilityTier];

export const PipelineStage = {
  DISCOVERED: "discovered",
  /** Tier 1, or Tier 2 cleared by investigation: ready to score and draft. */
  QUALIFIED: "qualified",
  /** Tier 2: waiting in the B2B investigation queue. */
  INVESTIGATING: "investigating",
  /** Tier 3, a failed investigation, or a fit below the threshold. */
  DISQUALIFIED: "disqualified",
  /** A draft was stopped by the Cop Tool and is held for the user. */
  QUARANTINED: "quarantined",
  /** A draft passed the Cop Tool and waits for the user's approval. */
  AWAITING_REVIEW: "awaiting_review",
  /** The user approved the draft; the operator may submit it. */
  APPROVED: "approved",
  SUBMITTED: "submitted",
  /** The operator could not finish (MFA, CAPTCHA, unknown form) and handed off. */
  NEEDS_ATTENTION: "needs_attention",
  /** The user declined the draft. */
  DECLINED: "declined",
} as const;
export type PipelineStage = (typeof PipelineStage)[keyof typeof PipelineStage];

/** The four arms of the UCB1 channel allocator. */
export const Channel = {
  FOUNDER_DIRECT: "founder_direct",
  ATS_INBOUND: "ats_inbound",
  RECRUITER_DIRECT: "recruiter_direct",
  CONTRACT_GIGS: "contract_gigs",
} as const;
export type Channel = (typeof Channel)[keyof typeof Channel];
export const CHANNELS: readonly Channel[] = Object.values(Channel);

/** pipeline_tasks.task_type for Tier 2 jobs awaiting a contractor-viability check. */
export const B2B_INVESTIGATION = "b2b_investigation";

// ---------- Jobs ----------

export interface JobOpportunity {
  id: string;
  /** "greenhouse", "ashby", "lever", "remotive", "weworkremotely", "hn", "manual", ... */
  source: string;
  /** The listing's id within that source. */
  sourceId: string;
  company: string;
  title: string;
  location: string;
  description: string;
  applyUrl: string;
  companyDomain: string;
  channel: Channel;
  /** null = not stated by the source; inferred from the text. */
  isRemote: boolean | null;
  /** "" | "full_time" | "contract" | "fractional" */
  employmentType: string;
  compMin: number | null;
  compMax: number | null;
  /** "" | "hour" | "month" | "year" */
  compPeriod: string;
  compCurrency: string;
  skills: string[];
  postedAt: string | null;
  stage: PipelineStage;
}

export type JobInput = Pick<JobOpportunity, "source" | "sourceId" | "company" | "title"> &
  Partial<Omit<JobOpportunity, "source" | "sourceId" | "company" | "title">>;

/** Stable id for a listing: the same (source, sourceId) always yields the same id. */
export function jobId(source: string, sourceId: string): string {
  return createHash("sha1").update(`${source}:${sourceId}`).digest("hex").slice(0, 16);
}

export function createJob(input: JobInput): JobOpportunity {
  return {
    location: "",
    description: "",
    applyUrl: "",
    companyDomain: "",
    channel: Channel.ATS_INBOUND,
    isRemote: null,
    employmentType: "",
    compMin: null,
    compMax: null,
    compPeriod: "",
    compCurrency: "USD",
    skills: [],
    postedAt: null,
    stage: PipelineStage.DISCOVERED,
    ...input,
    id: input.id || jobId(input.source, input.sourceId),
  };
}

/**
 * Sources that are a company's own job board. Their apply URL is the employer's real
 * application form, so when the same role also arrives from a job board that re-lists
 * it, this is the copy that is kept.
 */
export const COMPANY_BOARD_SOURCES: ReadonlySet<string> = new Set([
  "greenhouse", "ashby", "lever", "workable", "recruitee", "teamtailor", "breezy",
]);

/** The job boards Reygent reads through their public API or RSS feed, by the name each goes by in the config. */
export const JOB_BOARDS = [
  "remotive", "remoteok", "jobicy", "himalayas", "workingnomads", "weworkremotely",
  "realworkfromanywhere", "golangprojects", "python_org",
] as const;
export type JobBoard = (typeof JOB_BOARDS)[number];

/**
 * Job boards re-publish other employers' openings. Their apply URL is usually the board's
 * own page, and the same role often reaches Reygent from several of them.
 */
export const AGGREGATOR_SOURCES: ReadonlySet<string> = new Set(JOB_BOARDS);

/**
 * Sources whose listings Reygent cannot apply to by itself. A job board links to its own
 * page, usually behind a bot check, with the real application on the employer's site
 * beyond it; and the operator cannot read Teamtailor's or Breezy's forms yet. Their
 * listings are leads: Reygent writes the pitch and the user applies.
 */
export const HAND_APPLIED_SOURCES: ReadonlySet<string> = new Set([...JOB_BOARDS, "teamtailor", "breezy"]);

/** Application forms the operator reads, wherever the listing that links to one came from. */
const READABLE_FORM_URL =
  /^https?:\/\/(?:[\w-]+\.)*(?:greenhouse\.io|ashbyhq\.com|lever\.co|workable\.com|recruitee\.com)\//i;

/**
 * An application nothing but the user can send: a founder-direct pitch, a listing with no
 * web form, or one from a source Reygent cannot apply through (unless it links straight to
 * a form the operator reads). A Hacker News comment is never a form, whatever channel its
 * listing is on. The apply step skips exactly these, and the console offers them to the
 * user to send and mark as sent.
 */
export function sentByHand(job: Pick<JobOpportunity, "channel" | "applyUrl"> & { source?: string }): boolean {
  if (job.channel === Channel.FOUNDER_DIRECT || !/^https?:\/\//i.test(job.applyUrl)) return true;
  if (/^https?:\/\/news\.ycombinator\.com\/item\b/i.test(job.applyUrl)) return true;
  return job.source !== undefined && HAND_APPLIED_SOURCES.has(job.source) && !READABLE_FORM_URL.test(job.applyUrl);
}

export interface EligibilityReport {
  jobId: string;
  tier: EligibilityTier;
  reasonCodes: string[];
  /** "CODE: matched text" */
  positiveSignals: string[];
  /** "CODE: matched text" */
  disqualifiers: string[];
  needsB2bInvestigation: boolean;
  summary: string;
}

export interface FitEvaluation {
  jobId: string;
  /** 0–100. */
  fitScore: number;
  bestPositioningProfile: string;
  matchedSkills: string[];
  missingSkills: string[];
}

// ---------- Candidate fact bank ----------

export interface Achievement {
  id: string;
  category: string;
  headline: string;
  impactMetric: string;
  technologies: string[];
  context: string;
  employer: string;
  evidenceUrl: string;
  /** Positioning profile ids this achievement supports. */
  positioning: string[];
  /** Only achievements the user has personally confirmed may ground a claim. */
  verified: boolean;
}

export interface PositioningProfile {
  id: string;
  title: string;
  targetSummary: string;
  coreSkills: string[];
  pitchAngle: string;
  highlightedAchievements: string[];
}

export interface CandidateProfile {
  id: string;
  name: string;
  email: string;
  phone: string;
  location: string;
  timezone: string;
  workAuthorization: string;
  noticePeriod: string;
  githubUrl: string;
  linkedinUrl: string;
  portfolioUrl: string;
  yearsExperience: number | null;
  employers: string[];
  skills: string[];
  achievements: Achievement[];
  positioning: Record<string, PositioningProfile>;
}

export function achievementFactText(achievement: Achievement): string {
  return [achievement.headline, achievement.impactMetric, achievement.context].filter(Boolean).join(" ");
}

export function verifiedAchievements(profile: CandidateProfile): Achievement[] {
  return profile.achievements.filter((achievement) => achievement.verified);
}

/**
 * Facts that may be copied verbatim into form fields, keyed by fact name.
 * Unfilled placeholders are excluded, so nothing can be grounded on them.
 */
export function screeningFacts(profile: CandidateProfile): Record<string, string> {
  const facts: Record<string, string> = {
    name: profile.name,
    email: profile.email,
    phone: profile.phone,
    location: profile.location,
    timezone: profile.timezone,
    work_authorization: profile.workAuthorization,
    notice_period: profile.noticePeriod,
    github_url: profile.githubUrl,
    linkedin_url: profile.linkedinUrl,
    portfolio_url: profile.portfolioUrl,
  };
  if (profile.yearsExperience) facts.years_experience = String(profile.yearsExperience);
  return Object.fromEntries(
    Object.entries(facts).filter(([, value]) => value && !value.includes(PLACEHOLDER)),
  );
}

export function verifiedLinks(profile: CandidateProfile): Set<string> {
  const facts = screeningFacts(profile);
  const links = new Set<string>();
  for (const key of ["github_url", "linkedin_url", "portfolio_url"]) {
    if (facts[key]) links.add(facts[key]);
  }
  for (const achievement of verifiedAchievements(profile)) {
    if (achievement.evidenceUrl) links.add(achievement.evidenceUrl);
  }
  return links;
}

export function verifiedTechnologies(profile: CandidateProfile): Set<string> {
  // The positioning profiles' core skills are not here: they are a built-in template of
  // what such a role usually asks for, not something this candidate has vouched for.
  const tech = new Set(profile.skills);
  for (const achievement of verifiedAchievements(profile)) {
    for (const technology of achievement.technologies) tech.add(technology);
  }
  return tech;
}

// ---------- Drafts ----------

export interface CvBullet {
  text: string;
  /** The verified achievement this bullet restates. */
  achievementId: string;
}

export interface ScreeningAnswer {
  question: string;
  answer: string;
  /** Non-empty for dropdown / multi-choice fields. */
  options: string[];
  /**
   * Key into screeningFacts() when the answer is a verbatim fact.
   * Empty means the answer is generated prose for an open-ended question.
   */
  factKey: string;
}

/**
 * How a CV tuned for one listing lines up with it. `matched` terms are on the page, in
 * the listing's spelling; `missing` ones are not, because nothing on the CV backs them.
 */
export interface CvMatch {
  /** The line under the candidate's name. */
  headline: string;
  /** Every term the listing asks for, most prominent first. */
  asked: string[];
  matched: string[];
  missing: string[];
  pages: number;
  /**
   * What reading the printed file back found wrong and could not repair. Empty for a CV
   * that reads back whole; anything here holds the draft.
   */
  problems: string[];
}

export interface ApplicationDraft {
  jobId: string;
  channel: Channel;
  positioningProfileId: string;
  /** Cover note or cold pitch body. */
  pitch: string;
  cvBullets: CvBullet[];
  screeningAnswers: ScreeningAnswer[];
  resumePdfPath: string;
  quotedRateUsd: number | null;
  /** "" | "hour" | "month" */
  quotedRatePeriod: string;
  /** Email or handle of the person being contacted. */
  contact: string;
  /** Set when the attached resume is the candidate's CV tuned to this listing. */
  cvMatch?: CvMatch;
  /**
   * The summary on a tuned CV when a model wrote it for this listing. Absent when the
   * candidate's own summary is printed: that is theirs, and is not inspected.
   */
  cvSummary?: string;
}

export function createDraft(input: Pick<ApplicationDraft, "jobId"> & Partial<ApplicationDraft>): ApplicationDraft {
  return {
    channel: Channel.ATS_INBOUND,
    positioningProfileId: "",
    pitch: "",
    cvBullets: [],
    screeningAnswers: [],
    resumePdfPath: "",
    quotedRateUsd: null,
    quotedRatePeriod: "",
    contact: "",
    ...input,
  };
}

/** Where a piece of draft text lives: "pitch", "cvSummary", "cvBullets[0]", "screeningAnswers[2]". */
export type DraftTextField = "pitch" | "cvSummary" | `cvBullets[${number}]` | `screeningAnswers[${number}]`;

/** Status of a stored draft in application_drafts. */
export const DraftStatus = {
  AWAITING_REVIEW: "awaiting_review",
  APPROVED: "approved",
  DECLINED: "declined",
  SUBMITTED: "submitted",
  /** The operator handed off; `note` says why. */
  NEEDS_ATTENTION: "needs_attention",
} as const;
export type DraftStatus = (typeof DraftStatus)[keyof typeof DraftStatus];

export interface StoredDraft {
  id: number;
  jobId: string;
  status: DraftStatus;
  draft: ApplicationDraft;
  /** Auto-fix rewrites the Cop Tool spent before greenlighting. */
  copRetries: number;
  note: string;
  createdAt: string;
  updatedAt: string;
}

/**
 * How the note of an application begins when the site emailed the candidate a code after
 * Submit and the application waits on the dashboard for them to be ready to approve it.
 * Nothing went out: the site takes the application only once its code is entered.
 */
export const NEEDS_CODE = "Needs the code the site emails you";

/** Whether `draft` is held for an emailed code, waiting for the candidate's "I'm ready". */
export const isCodeHold = (draft: Pick<StoredDraft, "status" | "note"> | null | undefined): boolean =>
  draft?.status === DraftStatus.NEEDS_ATTENTION && draft.note.startsWith(NEEDS_CODE);

// ---------- Telemetry, quarantine, queue ----------

export interface CostTelemetry {
  id?: number;
  /** UTC ISO-8601. */
  timestamp: string;
  provider: string;
  model: string;
  taskType: string;
  promptTokens: number;
  completionTokens: number;
  costUsd: number;
  latencyMs: number;
  outcome: string;
}

export interface QuarantinedItem {
  id?: number;
  jobId: string;
  violationRule: string;
  originalContent: string;
  critique: string;
  retryCount: number;
  status: string;
  createdAt: string;
}

export interface PipelineTask {
  id?: number;
  taskType: string;
  jobId: string;
  detail: string;
  status: string;
  createdAt: string;
}

/** What happened after a dispatch; feeds the channel allocator's rewards and the income goal. */
export const OutcomeKind = {
  RESPONSE: "response",
  INTERVIEW: "interview",
  OFFER: "offer",
  /** An engagement the candidate accepted; `monthlyValueUsd` counts toward the income goal. */
  ACCEPTED: "accepted",
  REJECTION: "rejection",
} as const;
export type OutcomeKind = (typeof OutcomeKind)[keyof typeof OutcomeKind];

export interface Outcome {
  id?: number;
  jobId: string;
  channel: Channel;
  kind: OutcomeKind;
  note: string;
  monthlyValueUsd: number | null;
  recordedAt: string;
}

/**
 * An answer Reygent gives to one exact screening question, every time it is asked.
 * "user" answers were typed by the candidate; "ai" answers were written from the
 * candidate's data and verified by the Cop Tool, and stay open to correction.
 */
export interface StandingAnswer {
  question: string;
  answer: string;
  /** The choices the form offered when the answer was recorded; empty for free text. */
  options: string[];
  source: "user" | "ai";
  updatedAt: string;
}

export interface DispatchRecord {
  id?: number;
  jobId: string;
  channel: Channel;
  companyKey: string;
  domain: string;
  contact: string;
  dispatchedAt: string;
}
