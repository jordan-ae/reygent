"use client";

import { useState } from "react";

import { EventList } from "@/components/EventList";
import { KIND } from "@/components/labels";
import { EmptyState, ErrorCard, PageHead, RefreshButton, Segmented } from "@/components/ui";
import { useApi } from "@/components/use-api";
import type { ActivityBody, ActivityKind } from "@/core/web/types";

const KINDS: Array<{ value: ActivityKind | ""; label: string }> = [
  { value: "", label: "Everything" },
  ...(Object.entries(KIND) as Array<[ActivityKind, string]>).map(([value, label]) => ({ value, label })),
];

export function ActivityView() {
  const [kind, setKind] = useState<ActivityKind | "">("");
  const { data, error, reload } = useApi<ActivityBody>(`/api/activity?limit=300${kind ? `&kind=${kind}` : ""}`);
  return (
    <>
      <PageHead
        title="Activity"
        subtitle="Everything Reygent has done, newest first: listings classified, tasks queued, drafts held, messages sent, and every paid model call."
      >
        <RefreshButton onClick={reload} />
      </PageHead>
      <div className="filters">
        <Segmented label="Filter by action" value={kind} onChange={setKind} options={KINDS} />
      </div>
      {error ? (
        <ErrorCard message={error} onRetry={reload} />
      ) : data ? (
        <section className="card flush">
          {data.events.length ? (
            <EventList events={data.events} />
          ) : (
            <EmptyState
              title="No actions recorded"
              text={
                kind
                  ? "Nothing of this kind has happened yet."
                  : "Listings classified, drafts held, messages sent and paid model calls all appear here as they happen."
              }
            />
          )}
        </section>
      ) : null}
    </>
  );
}
