"use client";

import { useState } from "react";

import { HoldCard } from "@/components/HoldCard";
import { EmptyState, ErrorCard, PageHead, RefreshButton, Segmented } from "@/components/ui";
import { useApi } from "@/components/use-api";
import type { QuarantineBody } from "@/core/web/types";

type Status = "pending" | "reviewed" | "all";

export function QuarantineView() {
  const [status, setStatus] = useState<Status>("pending");
  const { data, error, reload } = useApi<QuarantineBody>(`/api/quarantine?status=${status}`);
  return (
    <>
      <PageHead
        title="Quarantine"
        subtitle="Drafts the Cop Tool refused to send. Each shows the rules that fired and exactly what they objected to. Answer what it could not, or retry, and the next cycle writes the application again."
      >
        <RefreshButton onClick={reload} />
      </PageHead>
      <div className="filters">
        <Segmented<Status>
          label="Filter by status"
          value={status}
          onChange={setStatus}
          options={[
            { value: "pending", label: "Waiting for you", count: data?.pending },
            { value: "reviewed", label: "Reviewed" },
            { value: "all", label: "All" },
          ]}
        />
      </div>
      {error ? (
        <ErrorCard message={error} onRetry={reload} />
      ) : data ? (
        <section className="card flush">
          {data.holds.length ? (
            data.holds.map((hold) => <HoldCard key={hold.ids.join("-")} hold={hold} onChanged={reload} />)
          ) : (
            <EmptyState
              title="Nothing is being held"
              text="When the Cop Tool stops a draft — a work-status question it will not guess, a claim it could not ground, a suspicious employer — it waits here for your decision."
            />
          )}
        </section>
      ) : null}
    </>
  );
}
