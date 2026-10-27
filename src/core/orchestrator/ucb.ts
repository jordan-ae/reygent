/**
 * Adaptive channel allocation: a UCB1 multi-armed bandit over the four channels.
 *
 * A "pull" is one dispatch (an application submitted or a pitch sent). Its reward is
 * the best outcome that dispatch ever produced, on a 0–1 scale. During the calibration
 * cohort every channel gets an equal share; after it, each unit of the day's effort
 * goes to the channel with the highest upper confidence bound, so channels that
 * convert get more effort while under-sampled ones are still explored.
 */

import type { Repository } from "@/core/db/repository";
import { CHANNELS, type Channel, OutcomeKind } from "@/core/models";

/** How much each outcome is worth; a dispatch scores its best outcome. */
export const OUTCOME_REWARD: Record<OutcomeKind, number> = {
  [OutcomeKind.REJECTION]: 0,
  [OutcomeKind.RESPONSE]: 0.3,
  [OutcomeKind.INTERVIEW]: 0.7,
  [OutcomeKind.OFFER]: 1,
  [OutcomeKind.ACCEPTED]: 1,
};

/** Dispatches made before allocation stops being an even split (the N=50 calibration cohort). */
export const CALIBRATION_PULLS = 50;

export interface ArmStats {
  channel: Channel;
  pulls: number;
  /** Sum of per-dispatch rewards, each in [0, 1]. */
  reward: number;
}

/** Pulls and rewards per channel, read from the dispatch log and recorded outcomes. */
export function channelStats(repo: Repository): ArmStats[] {
  const pulls = new Map<string, number>();
  for (const row of repo.query<{ channel: string; n: number }>(
    "SELECT channel, COUNT(*) AS n FROM dispatch_log GROUP BY channel",
  )) {
    pulls.set(row.channel, row.n);
  }
  // One reward per job: its best outcome, credited to the channel it went out on.
  const best = new Map<string, { channel: string; reward: number }>();
  for (const outcome of repo.listOutcomes()) {
    const reward = OUTCOME_REWARD[outcome.kind] ?? 0;
    const current = best.get(outcome.jobId);
    if (!current || reward > current.reward) best.set(outcome.jobId, { channel: outcome.channel, reward });
  }
  const reward = new Map<string, number>();
  for (const { channel, reward: value } of best.values()) {
    reward.set(channel, (reward.get(channel) ?? 0) + value);
  }
  return CHANNELS.map((channel) => ({
    channel,
    pulls: pulls.get(channel) ?? 0,
    reward: reward.get(channel) ?? 0,
  }));
}

/** UCB1 index: mean reward plus an exploration bonus that shrinks as the arm is sampled. */
export function ucbIndex(arm: Pick<ArmStats, "pulls" | "reward">, totalPulls: number): number {
  if (arm.pulls === 0) return Number.POSITIVE_INFINITY;
  return arm.reward / arm.pulls + Math.sqrt((2 * Math.log(Math.max(totalPulls, 1))) / arm.pulls);
}

/**
 * Split `budget` units of effort across the channels.
 *
 * The result always sums to `budget`. Ties go to the channel listed first.
 */
export function allocate(
  stats: readonly ArmStats[],
  budget: number,
  calibrationPulls: number = CALIBRATION_PULLS,
): Record<Channel, number> {
  const allocation = Object.fromEntries(CHANNELS.map((channel) => [channel, 0])) as Record<Channel, number>;
  const arms = CHANNELS.map((channel) => {
    const found = stats.find((arm) => arm.channel === channel);
    return { channel, pulls: found?.pulls ?? 0, reward: found?.reward ?? 0 };
  });
  let total = arms.reduce((sum, arm) => sum + arm.pulls, 0);

  for (let unit = 0; unit < Math.max(0, Math.floor(budget)); unit += 1) {
    let pick = arms[0];
    if (total < calibrationPulls) {
      // Calibration: keep the channels level, so each ends the cohort with an equal sample.
      for (const arm of arms) if (arm.pulls < pick.pulls) pick = arm;
    } else {
      for (const arm of arms) if (ucbIndex(arm, total) > ucbIndex(pick, total)) pick = arm;
    }
    // The planned pull counts toward the arm's sample so one channel cannot take the whole day.
    pick.pulls += 1;
    total += 1;
    allocation[pick.channel] += 1;
  }
  return allocation;
}
