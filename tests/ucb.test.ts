import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { Repository } from "@/core/db/repository";
import { CHANNELS, Channel, OutcomeKind, createJob } from "@/core/models";
import { type ArmStats, CALIBRATION_PULLS, allocate, channelStats, ucbIndex } from "@/core/orchestrator/ucb";

const arms = (pulls: number[], rewards: number[]): ArmStats[] =>
  CHANNELS.map((channel, i) => ({ channel, pulls: pulls[i], reward: rewards[i] }));
const total = (allocation: Record<string, number>) => Object.values(allocation).reduce((sum, n) => sum + n, 0);

describe("allocate", () => {
  test("calibration cohort splits effort evenly across the four channels", () => {
    expect(allocate(arms([0, 0, 0, 0], [0, 0, 0, 0]), 12)).toEqual({
      founder_direct: 3, ats_inbound: 3, recruiter_direct: 3, contract_gigs: 3,
    });
  });

  test("calibration levels up channels that are behind before adding to the rest", () => {
    const allocation = allocate(arms([10, 2, 10, 10], [5, 0, 0, 0]), 8);
    expect(allocation.ats_inbound).toBe(8);
  });

  test("results ignore rewards until the calibration cohort is complete", () => {
    const pulls = [10, 10, 10, 10];
    expect(pulls.reduce((a, b) => a + b)).toBeLessThan(CALIBRATION_PULLS);
    expect(allocate(arms(pulls, [10, 0, 0, 0]), 8)).toEqual(allocate(arms(pulls, [0, 0, 0, 0]), 8));
  });

  test("after calibration the channel that converts gets the most effort", () => {
    const allocation = allocate(arms([20, 20, 20, 20], [12, 2, 1, 1]), 20);
    expect(allocation.founder_direct).toBeGreaterThan(allocation.ats_inbound);
    expect(allocation.founder_direct).toBeGreaterThan(allocation.contract_gigs);
    expect(total(allocation)).toBe(20);
  });

  test("an under-sampled channel is still explored after calibration", () => {
    const allocation = allocate(arms([40, 40, 40, 1], [20, 20, 20, 0]), 6);
    expect(allocation.contract_gigs).toBeGreaterThan(0);
  });

  test("a channel never tried is pulled first once calibration is over", () => {
    const allocation = allocate(arms([30, 30, 30, 0], [15, 15, 15, 0]), 1);
    expect(allocation.contract_gigs).toBe(1);
  });

  test("always sums to the budget, and a zero budget allocates nothing", () => {
    for (const budget of [0, 1, 7, 45]) {
      expect(total(allocate(arms([60, 5, 9, 31], [22, 1, 3, 4]), budget))).toBe(budget);
    }
    expect(total(allocate([], 9))).toBe(9); // missing stats are treated as untried channels
  });

  test("is deterministic", () => {
    const stats = arms([25, 25, 25, 25], [5, 5, 5, 5]);
    expect(allocate(stats, 10)).toEqual(allocate(stats, 10));
  });
});

describe("ucbIndex", () => {
  test("untried arms have an unbounded index; the bonus shrinks with more pulls", () => {
    expect(ucbIndex({ pulls: 0, reward: 0 }, 100)).toBe(Number.POSITIVE_INFINITY);
    expect(ucbIndex({ pulls: 5, reward: 1 }, 100)).toBeGreaterThan(ucbIndex({ pulls: 50, reward: 10 }, 100));
  });
});

describe("channelStats", () => {
  let repo: Repository;
  beforeEach(() => {
    repo = new Repository(":memory:");
  });
  afterEach(() => repo.close());

  const dispatch = (sourceId: string, channel: Channel) => {
    const job = createJob({ source: "test", sourceId, company: `Company ${sourceId}`, title: "Engineer", channel });
    repo.insertJob(job);
    repo.recordDispatch({ jobId: job.id, channel, companyKey: `company ${sourceId}`, domain: "", contact: "" });
    return job.id;
  };

  test("counts dispatches as pulls and credits each job's best outcome to its channel", () => {
    const interviewed = dispatch("1", Channel.FOUNDER_DIRECT);
    dispatch("2", Channel.FOUNDER_DIRECT);
    const rejected = dispatch("3", Channel.ATS_INBOUND);
    repo.recordOutcome({ jobId: interviewed, channel: Channel.FOUNDER_DIRECT, kind: OutcomeKind.RESPONSE, note: "", monthlyValueUsd: null });
    repo.recordOutcome({ jobId: interviewed, channel: Channel.FOUNDER_DIRECT, kind: OutcomeKind.INTERVIEW, note: "", monthlyValueUsd: null });
    repo.recordOutcome({ jobId: rejected, channel: Channel.ATS_INBOUND, kind: OutcomeKind.REJECTION, note: "", monthlyValueUsd: null });

    const stats = Object.fromEntries(channelStats(repo).map((arm) => [arm.channel, arm]));
    expect(stats.founder_direct).toMatchObject({ pulls: 2, reward: 0.7 }); // interview, not response + interview
    expect(stats.ats_inbound).toMatchObject({ pulls: 1, reward: 0 });
    expect(stats.recruiter_direct).toMatchObject({ pulls: 0, reward: 0 });
    expect(stats.contract_gigs).toMatchObject({ pulls: 0, reward: 0 });
  });
});
