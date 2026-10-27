"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { type MouseEvent, useEffect, useState } from "react";

import { compensation } from "@/components/format";
import { CHANNEL, STAGE } from "@/components/labels";
import { ListingDialog } from "@/components/ListingDialog";
import { Codes, EmptyState, ErrorCard, PageHead, RefreshButton, Segmented, StageBadge, TierBadge, When } from "@/components/ui";
import { useApi } from "@/components/use-api";
import type { ApplicationsBody, ApplicationSummary } from "@/core/web/types";

const SEARCH_DELAY_MS = 200;

function Table({ applications }: { applications: ApplicationSummary[] }) {
  const router = useRouter();
  // The whole row opens the application, without hijacking a click on the link inside it.
  const open = (event: MouseEvent<HTMLTableRowElement>, id: string) => {
    if (!(event.target as Element).closest("a")) router.push(`/applications/${id}`);
  };
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Role</th>
            <th>Location</th>
            <th>Eligibility</th>
            <th>Stage</th>
            <th>Channel</th>
            <th className="num">Compensation</th>
            <th>Updated</th>
          </tr>
        </thead>
        <tbody>
          {applications.map((job) => (
            <tr className="link-row" key={job.id} onClick={(event) => open(event, job.id)}>
              <td className="primary-cell">
                <Link href={`/applications/${job.id}`}>{job.company}</Link>
                <div className="sub">{job.title}</div>
              </td>
              <td>{job.location || "—"}</td>
              <td>
                <TierBadge tier={job.tier} />
                {job.reasonCodes.length ? (
                  <div className="sub">
                    <Codes codes={job.reasonCodes.slice(0, 2)} />
                  </div>
                ) : null}
              </td>
              <td>
                <StageBadge stage={job.stage} />
                {job.held ? <div className="sub">{job.held} held</div> : null}
              </td>
              <td>{CHANNEL[job.channel] ?? job.channel}</td>
              <td className="num">{compensation(job)}</td>
              <td className="when">
                <When iso={job.updatedAt} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function ApplicationsView() {
  // The stage filter lives in the URL so the overview tiles can link straight to it.
  const stage = useSearchParams().get("stage") ?? "";
  const [typed, setTyped] = useState("");
  const [search, setSearch] = useState("");
  const [adding, setAdding] = useState(false);

  // Search as the user types, but not on every keystroke.
  useEffect(() => {
    const timer = window.setTimeout(() => setSearch(typed.trim()), SEARCH_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [typed]);

  const params = new URLSearchParams();
  if (stage) params.set("stage", stage);
  if (search) params.set("q", search);
  const { data, error, reload } = useApi<ApplicationsBody>(`/api/applications?${params}`);

  const selectStage = (value: string) => {
    // Next keeps useSearchParams in step with the History API, so no server round trip is needed.
    window.history.replaceState(null, "", value ? `/applications?stage=${encodeURIComponent(value)}` : "/applications");
  };

  const total = data ? Object.values(data.stages).reduce((sum, n) => sum + n, 0) : 0;
  const stages = Object.keys(STAGE);
  const addButton = (
    <button type="button" className="button primary" onClick={() => setAdding(true)}>
      Add a listing
    </button>
  );

  return (
    <>
      <PageHead
        title="Applications"
        subtitle="Every listing Reygent is tracking, with the tier it was given and where it stands."
      >
        <RefreshButton onClick={reload} />
        {addButton}
      </PageHead>
      {/* The filters stay put when a request fails, so the search box keeps its focus and text. */}
      {data ? (
        <>
          <div className="filters">
            <Segmented
              label="Filter by stage"
              value={stage}
              onChange={selectStage}
              options={[
                { value: "", label: "All", count: total },
                ...stages.map((name) => ({ value: name, label: STAGE[name].label, count: data.stages[name] ?? 0 })),
              ]}
            />
            <span className="spacer" />
            <input
              type="search"
              placeholder="Search company, role or location"
              aria-label="Search applications"
              value={typed}
              onChange={(event) => setTyped(event.target.value)}
            />
          </div>
          {error ? (
            <ErrorCard message={error} onRetry={reload} />
          ) : (
            <section className="card flush">
              {data.applications.length ? (
                <Table applications={data.applications} />
              ) : total === 0 ? (
                <EmptyState
                  title="No applications yet"
                  text="Listings arrive when discovery runs — from the Overview page, or with every cycle of the terminal run. You can also add one by hand: Reygent classifies it for a Cameroon-based contractor and routes it by tier."
                >
                  {addButton}
                </EmptyState>
              ) : (
                <EmptyState title="Nothing matches" text="No tracked application fits this filter." />
              )}
            </section>
          )}
        </>
      ) : error ? (
        <ErrorCard message={error} onRetry={reload} />
      ) : null}
      {adding ? <ListingDialog onClose={() => setAdding(false)} /> : null}
    </>
  );
}
