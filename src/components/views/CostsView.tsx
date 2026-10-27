"use client";

import { useState } from "react";

import { CostChart } from "@/components/CostChart";
import { count, dayLabel, spend } from "@/components/format";
import { Badge, EmptyState, ErrorCard, Meter, PageHead, RefreshButton, Tile, When } from "@/components/ui";
import { useApi } from "@/components/use-api";
import type { CostsBody } from "@/core/web/types";

const shortModel = (model: string): string => model.split("/").pop() ?? model;

export function CostsView() {
  const { data, error, reload } = useApi<CostsBody>("/api/costs");
  // The chart's figures are also available as a table, for screen readers and exact values.
  const [asTable, setAsTable] = useState(false);

  if (error) return <ErrorCard message={error} onRetry={reload} />;
  if (!data) return null;
  const callsToday = data.daily.length ? data.daily[data.daily.length - 1].calls : 0;
  const hasHistory = data.daily.some((day) => day.calls > 0);
  return (
    <>
      <PageHead
        title="Costs"
        subtitle="Every paid model call is metered. A call that would take the day past the cap is refused before it is sent."
      >
        <RefreshButton onClick={reload} />
      </PageHead>
      <div className="tiles">
        <Tile label="Calls today" value={count(callsToday)} />
        <Tile label="Remaining today" value={spend(data.budget.remainingUsd)} />
        <Tile label="All-time spend" value={spend(data.allTimeUsd)} />
      </div>
      <section className="card">
        <h2>Spend today</h2>
        <Meter budget={data.budget} />
      </section>
      <section className="card">
        <div className="card-head">
          <h2>Spend per day, last {data.daily.length} days</h2>
          {hasHistory ? (
            <button type="button" className="button small" onClick={() => setAsTable((shown) => !shown)}>
              {asTable ? "Show as chart" : "Show as table"}
            </button>
          ) : null}
        </div>
        {!hasHistory ? (
          <EmptyState
            title="No paid calls in this period"
            text="Spend appears here once Reygent starts calling Jev or Fireworks."
          />
        ) : asTable ? (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Day</th>
                  <th className="num">Calls</th>
                  <th className="num">Spend</th>
                </tr>
              </thead>
              <tbody>
                {[...data.daily].reverse().map((day) => (
                  <tr key={day.day}>
                    <td>{dayLabel(day.day)}</td>
                    <td className="num">{count(day.calls)}</td>
                    <td className="num">{spend(day.costUsd)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <CostChart daily={data.daily} capUsd={data.budget.capUsd} />
        )}
      </section>
      <section className="card flush">
        <h2>By model, all time</h2>
        {data.byModel.length ? (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Provider</th>
                  <th>Model</th>
                  <th className="num">Calls</th>
                  <th className="num">Tokens in</th>
                  <th className="num">Tokens out</th>
                  <th className="num">Avg latency</th>
                  <th className="num">Spend</th>
                </tr>
              </thead>
              <tbody>
                {data.byModel.map((row) => (
                  <tr key={`${row.provider}:${row.model}`}>
                    <td>{row.provider}</td>
                    <td className="mono">{row.model}</td>
                    <td className="num">{count(row.calls)}</td>
                    <td className="num">{count(row.promptTokens)}</td>
                    <td className="num">{count(row.completionTokens)}</td>
                    <td className="num">{count(row.avgLatencyMs)} ms</td>
                    <td className="num">{spend(row.costUsd)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <EmptyState title="No calls recorded" text="" />
        )}
      </section>
      <section className="card flush">
        <h2>Latest calls</h2>
        {data.recent.length ? (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>When</th>
                  <th>Task</th>
                  <th>Model</th>
                  <th className="num">Tokens in / out</th>
                  <th className="num">Latency</th>
                  <th className="num">Cost</th>
                  <th>Outcome</th>
                </tr>
              </thead>
              <tbody>
                {data.recent.map((call) => (
                  <tr key={call.id}>
                    <td className="when">
                      <When iso={call.timestamp} />
                    </td>
                    <td>{call.taskType}</td>
                    <td className="mono">{shortModel(call.model)}</td>
                    <td className="num">
                      {count(call.promptTokens)} / {count(call.completionTokens)}
                    </td>
                    <td className="num">{count(call.latencyMs)} ms</td>
                    <td className="num">{spend(call.costUsd)}</td>
                    <td>
                      <Badge tone={call.outcome === "ok" ? "good" : call.outcome === "pending" ? "muted" : "serious"}>
                        {call.outcome}
                      </Badge>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <EmptyState title="No calls recorded" text="" />
        )}
      </section>
    </>
  );
}
