/**
 * The JSON the console API exchanges, shared by the server and the browser.
 *
 * Types only — the browser imports from here with `import type`, so nothing that touches
 * the file system or SQLite is ever bundled for it.
 */

import type { Config } from "@/core/config";
import type {
  ActivityEvent,
  ApplicationDetail,
  ApplicationSummary,
  CallRecord,
  DailySpend,
  EvaluationSummary,
  ModelSpend,
  PendingCounts,
  QuarantineHold,
  StageCounts,
} from "@/core/db/reports";
import type { StandingAnswer } from "@/core/models";
import type { CodeHoldView } from "@/core/orchestrator/codeHold";
import type { CycleReport } from "@/core/orchestrator/pipeline";

export type {
  ActivityEvent,
  ActivityKind,
  ApplicationAction,
  ApplicationDetail,
  ApplicationJob,
  ApplicationSummary,
  CallRecord,
  DailySpend,
  DispatchSummary,
  DraftContent,
  DraftView,
  EvaluationSummary,
  FitSummary,
  HeldDraft,
  HoldQuestion,
  ModelSpend,
  OutcomeSummary,
  PendingCounts,
  QuarantineFinding,
  QuarantineHold,
  StageCounts,
} from "@/core/db/reports";
export type { Config } from "@/core/config";
export type { StandingAnswer } from "@/core/models";
export type { CycleReport } from "@/core/orchestrator/pipeline";
export type { CodeHoldView } from "@/core/orchestrator/codeHold";

export type ReadinessArea = "profile" | "fact_bank" | "settings";

export interface ReadinessItem {
  /** Which setup page fixes it. */
  area: ReadinessArea;
  message: string;
}

export type KeySource = "environment" | "stored" | null;

/** Where a provider's API key comes from. The key itself is never part of any response. */
export interface KeyStatus {
  id: string;
  label: string;
  purpose: string;
  /** The environment variable that holds (or overrides) the key. */
  env: string;
  source: KeySource;
}

export interface PositioningSummary {
  id: string;
  title: string;
  coreSkills: string[];
  verifiedAchievements: number;
}

/** "running" and "idle" describe the pipeline, which lives in another process. */
export type SystemStatus = "ready" | "needs_setup" | "paused" | "running" | "idle";

export interface SystemPart {
  name: string;
  status: SystemStatus;
  detail: string;
}

export interface Budget {
  spentUsd: number;
  capUsd: number;
  remainingUsd: number;
  tripped: boolean;
  utcOffsetHours: number;
}

export interface StateBody {
  /** config.yaml as it is on disk (snake_case, key for key), or defaults when it is missing or unreadable. */
  config: Config;
  /** Why the config could not be used, or "". */
  configError: string;
  configPath: string;
  dbPath: string;
  secretsPath: string;
  /** The marker a required-but-unfilled profile field holds. */
  placeholder: string;
  readiness: ReadinessItem[];
  keys: KeyStatus[];
  positioning: PositioningSummary[];
  system: SystemPart[];
}

export interface KeyTestBody {
  ok: boolean;
  message: string;
}

export interface OverviewBody {
  stages: StageCounts;
  pending: PendingCounts;
  budget: Budget;
  goal: {
    monthlyIncomeGoalUsd: number;
    maxConcurrentEngagements: number;
    /** Monthly income from engagements recorded as accepted. */
    securedMonthlyUsd: number;
  };
  mode: {
    /** One line saying how the pipeline behaves with the saved settings. */
    description: string;
    /** Every draft waits for the user's approval. */
    reviewFirst: boolean;
    /** Unsettled Tier 2 jobs are applied for anyway rather than waiting for the user's call. */
    pitchUnconfirmed: boolean;
  };
  /** The last cycle any process finished, or null if none ever has. */
  lastCycle: CycleReport | null;
  /** Whether that cycle is recent enough for the pipeline to count as running. */
  cycleIsRecent: boolean;
  system: SystemPart[];
  recentActivity: ActivityEvent[];
}

export interface PipelineRunBody {
  report: CycleReport;
}

export interface ApplicationsBody {
  applications: ApplicationSummary[];
  stages: StageCounts;
}

export type ApplicationBody = ApplicationDetail & {
  /** A screenshot of the confirmation page is available at /api/applications/<id>/evidence. */
  hasEvidence: boolean;
  /** Held for a code the site emails, or being finished from the dashboard; null otherwise. */
  codeHold: CodeHoldView | null;
};

export interface CodeHoldBody {
  codeHold: CodeHoldView | null;
}

export interface EligibilityCheckBody {
  report: EvaluationSummary;
}

export type AddApplicationBody =
  | { duplicate: true; jobId: string }
  | { duplicate: false; jobId: string; report: EvaluationSummary };

export interface ActivityBody {
  events: ActivityEvent[];
}

export interface QuarantineBody {
  holds: QuarantineHold[];
  /** Holds still waiting for the user, whatever the filter. */
  pending: number;
}

export interface ReviewBody {
  ok: true;
}

export interface RetryBody {
  ok: true;
  /** The job sent back to drafting. */
  jobId: string;
  /** How many answers were stored as standing answers. */
  saved: number;
}

export interface AnswersBody {
  /** Most recently changed first. */
  answers: StandingAnswer[];
}

export interface CostsBody {
  budget: Budget;
  byModel: ModelSpend[];
  allTimeUsd: number;
  /** One entry per budget day, oldest first. */
  daily: DailySpend[];
  recent: CallRecord[];
}

/** A listing typed into the "Add a listing" dialog. */
export interface ListingForm {
  company: string;
  title: string;
  location?: string;
  description?: string;
  applyUrl?: string;
  companyDomain?: string;
  channel?: string;
  isRemote?: boolean | null;
  employmentType?: string;
  compMin?: number | null;
  compMax?: number | null;
  compPeriod?: string;
  compCurrency?: string;
  skills?: string[];
}
