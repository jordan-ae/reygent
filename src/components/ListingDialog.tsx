"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { api, errorMessage } from "@/components/api-client";
import { useConsole } from "@/components/console-context";
import { NumberField, SelectField, TagsField, TextField } from "@/components/fields";
import { CHANNEL, TIER } from "@/components/labels";
import { ReportBlock } from "@/components/ReportBlock";
import type { AddApplicationBody, EligibilityCheckBody, EvaluationSummary, ListingForm } from "@/core/web/types";

interface FormState {
  company: string;
  title: string;
  location: string;
  description: string;
  applyUrl: string;
  companyDomain: string;
  channel: string;
  employmentType: string;
  isRemote: string;
  compMin: number | null;
  compMax: number | null;
  compPeriod: string;
  skills: string[];
}

const EMPTY: FormState = {
  company: "", title: "", location: "", description: "", applyUrl: "", companyDomain: "",
  channel: "ats_inbound", employmentType: "", isRemote: "", compMin: null, compMax: null, compPeriod: "", skills: [],
};

const REMOTE_OPTIONS = [["", "Not stated — infer from text"], ["yes", "Yes"], ["no", "No"]] as const;
const TYPE_OPTIONS = [
  ["", "Not stated"], ["contract", "Contract"], ["fractional", "Fractional"], ["full_time", "Full-time"],
] as const;
const PERIOD_OPTIONS = [["", "Not stated"], ["hour", "Per hour"], ["month", "Per month"], ["year", "Per year"]] as const;

/** Type in a listing by hand: check how it would be classified, or add it to the pipeline. */
export function ListingDialog({ onClose }: { onClose: () => void }) {
  const router = useRouter();
  const { toast, refreshCounts } = useConsole();
  const dialog = useRef<HTMLDialogElement>(null);
  const result = useRef<HTMLDivElement>(null);
  const [form, setForm] = useState(EMPTY);
  const [outcome, setOutcome] = useState<{ report: EvaluationSummary } | { error: string } | null>(null);
  const [working, setWorking] = useState(false);

  useEffect(() => {
    // Strict mode runs effects twice in development; opening an open dialog would throw.
    if (dialog.current && !dialog.current.open) dialog.current.showModal();
  }, []);

  useEffect(() => {
    if (outcome) result.current?.scrollIntoView({ block: "nearest" });
  }, [outcome]);

  const set = <K extends keyof FormState>(key: K, value: FormState[K]) =>
    setForm((current) => ({ ...current, [key]: value }));
  const listing = (): ListingForm => ({ ...form, isRemote: form.isRemote === "" ? null : form.isRemote === "yes" });

  const run = async (work: () => Promise<void>) => {
    setWorking(true);
    try {
      await work();
    } catch (error) {
      setOutcome({ error: errorMessage(error) });
    } finally {
      setWorking(false);
    }
  };

  const check = () =>
    run(async () => {
      setOutcome(await api<EligibilityCheckBody>("POST", "/api/eligibility/check", listing()));
    });

  const add = () =>
    run(async () => {
      const added = await api<AddApplicationBody>("POST", "/api/applications", listing());
      dialog.current?.close();
      toast(
        added.duplicate
          ? "That listing is already tracked."
          : `Added and classified: ${TIER[added.report.tier]?.label ?? added.report.tier}.`,
      );
      refreshCounts();
      router.push(`/applications/${added.jobId}`);
    });

  // Rendered into <body> so the page's own busy/dim styling never applies to the dialog.
  return createPortal(
    <dialog ref={dialog} aria-labelledby="listing-title" onClose={onClose}>
      <div className="dialog-head">
        <h2 id="listing-title">Add a listing</h2>
        <button type="button" className="button small" onClick={() => dialog.current?.close()}>
          Close
        </button>
      </div>
      <div className="dialog-body">
        <div className="form-grid">
          <TextField label="Company" value={form.company} onChange={(value) => set("company", value)} />
          <TextField label="Role title" value={form.title} onChange={(value) => set("title", value)} />
          <TextField
            label="Location as listed"
            placeholder="Remote (Worldwide)"
            value={form.location}
            onChange={(value) => set("location", value)}
          />
          <SelectField
            label="Listed as remote?"
            options={REMOTE_OPTIONS}
            value={form.isRemote}
            onChange={(value) => set("isRemote", value)}
          />
          <TextField
            label="Listing text"
            multiline
            rows={7}
            wide
            hint="Paste the full description. Eligibility is decided from the wording here."
            value={form.description}
            onChange={(value) => set("description", value)}
          />
          <TextField
            label="Apply link"
            type="url"
            placeholder="https://"
            value={form.applyUrl}
            onChange={(value) => set("applyUrl", value)}
          />
          <TextField
            label="Company domain"
            placeholder="example.com"
            hint="Used to recognise the company's own careers site and to avoid contacting it twice."
            value={form.companyDomain}
            onChange={(value) => set("companyDomain", value)}
          />
          <SelectField
            label="Channel"
            options={Object.entries(CHANNEL)}
            value={form.channel}
            onChange={(value) => set("channel", value)}
          />
          <SelectField
            label="Engagement type"
            options={TYPE_OPTIONS}
            value={form.employmentType}
            onChange={(value) => set("employmentType", value)}
          />
          <NumberField
            label="Pay from (USD)"
            nullable
            min={0}
            value={form.compMin}
            onChange={(value) => set("compMin", value)}
          />
          <NumberField
            label="Pay up to (USD)"
            nullable
            min={0}
            value={form.compMax}
            onChange={(value) => set("compMax", value)}
          />
          <SelectField
            label="Pay period"
            options={PERIOD_OPTIONS}
            value={form.compPeriod}
            onChange={(value) => set("compPeriod", value)}
          />
          <TagsField
            label="Stack the listing asks for"
            placeholder="e.g. Python, LangGraph"
            value={form.skills}
            onChange={(value) => set("skills", value)}
          />
        </div>
        <div className="result" ref={result} aria-live="polite" hidden={!outcome}>
          {outcome === null ? null : "error" in outcome ? (
            <p className="form-error">{outcome.error}</p>
          ) : (
            <ReportBlock report={outcome.report} />
          )}
        </div>
      </div>
      <div className="dialog-foot">
        <button type="button" className="button" disabled={working} onClick={check}>
          Check eligibility
        </button>
        <span className="spacer" />
        <button type="button" className="button primary" disabled={working} onClick={add}>
          Add to pipeline
        </button>
      </div>
    </dialog>,
    document.body,
  );
}
