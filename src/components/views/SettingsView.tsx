"use client";

import { Fragment, useId, useState } from "react";

import { api, errorMessage } from "@/components/api-client";
import { type ConfigDraft, useBoot, useConsole, useDraftSection } from "@/components/console-context";
import { CheckField, NumberField, RadioField, TagsField, TextField } from "@/components/fields";
import { Badge, PageHead, SetupNotices } from "@/components/ui";
import type { JobBoard } from "@/core/models";
import type { KeyStatus, KeyTestBody, StateBody } from "@/core/web/types";

// ---------- API keys ----------

/** One provider's key. Keys are saved at once, separately from the config draft, and never shown again. */
function KeyRow({ status }: { status: KeyStatus }) {
  const { applyBoot, toast } = useConsole();
  const [typed, setTyped] = useState("");
  const [result, setResult] = useState("");

  const run = async (work: () => Promise<void>) => {
    try {
      await work();
    } catch (error) {
      setResult(errorMessage(error));
    }
  };
  const saveKey = () =>
    run(async () => {
      applyBoot(await api<StateBody>("PUT", `/api/keys/${status.id}`, { key: typed }));
      // The key has left the page for good: the server never sends it back.
      setTyped("");
      setResult("");
      toast(`${status.label} key saved.`);
    });
  const testKey = () =>
    run(async () => {
      setResult("Checking…");
      setResult((await api<KeyTestBody>("POST", `/api/keys/${status.id}/test`)).message);
    });
  const removeKey = () =>
    run(async () => {
      applyBoot(await api<StateBody>("DELETE", `/api/keys/${status.id}`));
      setResult("");
      toast(`${status.label} key removed.`);
    });

  return (
    <div className="key-row">
      <div>
        <div className="name">{status.label}</div>
        <div className="sub">{status.purpose}</div>
        <p className="hint">
          {status.source === "environment" ? (
            <Badge tone="good">From ${status.env}</Badge>
          ) : status.source === "stored" ? (
            <Badge tone="good">Stored on this Mac</Badge>
          ) : (
            <Badge tone="warning">Not set</Badge>
          )}
        </p>
      </div>
      <div>
        <div className="key-controls">
          <input
            type="password"
            aria-label={`${status.label} API key`}
            placeholder={status.source ? "Paste a replacement key" : "Paste your key"}
            autoComplete="off"
            value={typed}
            onChange={(event) => setTyped(event.target.value)}
          />
          <button type="button" className="button primary" disabled={!typed.trim()} onClick={saveKey}>
            Save key
          </button>
          {status.source ? (
            <button type="button" className="button" onClick={testKey}>
              Test
            </button>
          ) : null}
          {status.source === "stored" ? (
            <button type="button" className="button danger" onClick={removeKey}>
              Remove
            </button>
          ) : null}
        </div>
        {status.source === "environment" ? (
          <p className="hint">
            The ${status.env} environment variable is in use and takes precedence over a stored key.
          </p>
        ) : null}
        <p className="key-result" aria-live="polite">
          {result}
        </p>
      </div>
    </div>
  );
}

// ---------- Models and prices ----------

interface PriceRow {
  /** Stable React key; the model id itself is being edited. */
  key: number;
  model: string;
  input: number;
  output: number;
}

function PriceInput({ label, value, onChange }: { label: string; value: number; onChange: (value: number) => void }) {
  const [text, setText] = useState(String(value));
  const [invalid, setInvalid] = useState(false);
  return (
    <input
      type="number"
      step="any"
      min={0}
      aria-label={label}
      aria-invalid={invalid}
      value={text}
      onChange={(event) => {
        const raw = event.target.value;
        const parsed = Number(raw);
        const valid = raw.trim() !== "" && Number.isFinite(parsed) && parsed >= 0;
        setText(raw);
        setInvalid(!valid);
        if (valid) onChange(parsed);
      }}
    />
  );
}

function ModelsCard() {
  const { draft } = useBoot();
  const setFireworks = useDraftSection("fireworks");
  const setJev = useDraftSection("jev");
  const { fireworks, jev } = draft;
  const modelId = useId();
  const pricesLabel = useId();
  // Rows are edited here and written to the draft as a map; a row with no model id yet is not written.
  const [rows, setRows] = useState<PriceRow[]>(() =>
    Object.entries(fireworks.pricing_usd_per_million).map(([model, price], key) => ({ key, model, ...price })),
  );

  const commit = (next: PriceRow[]) => {
    setRows(next);
    setFireworks(
      "pricing_usd_per_million",
      Object.fromEntries(
        next.filter((row) => row.model.trim()).map((row) => [row.model.trim(), { input: row.input, output: row.output }]),
      ),
    );
  };
  const change = (key: number, patch: Partial<PriceRow>) =>
    commit(rows.map((row) => (row.key === key ? { ...row, ...patch } : row)));
  const addRow = () =>
    setRows([...rows, { key: Math.max(-1, ...rows.map((row) => row.key)) + 1, model: "", input: 0.9, output: 0.9 }]);

  const priced = Object.keys(fireworks.pricing_usd_per_million);
  const selectable = [...new Set([fireworks.model, ...priced])];

  return (
    <section className="card">
      <h2>Models and prices</h2>
      <p className="lede">
        Prices are used to meter each call. Check the provider&apos;s pricing page before changing them.
      </p>
      <div className="form-grid">
        <div className="field wide">
          <label htmlFor={modelId}>Fireworks model for generation</label>
          <select id={modelId} value={fireworks.model} onChange={(event) => setFireworks("model", event.target.value)}>
            {selectable.map((model) => (
              <option key={model} value={model}>
                {priced.includes(model) ? model : `${model} (no price set)`}
              </option>
            ))}
          </select>
          <p className="hint">
            Only models with a price below can be used: a model whose cost cannot be metered is refused.
          </p>
        </div>
        <NumberField
          label="Longest generation"
          min={1}
          max={450}
          integer
          step={1}
          unit="tokens (max 450)"
          value={fireworks.max_tokens}
          onChange={(value) => setFireworks("max_tokens", value)}
        />
        <TextField
          label="Reasoning effort"
          placeholder="none"
          hint="Fireworks' models reason before they answer, and that is billed out of the generation limit. “none” turns it off (DeepSeek V4.1 Flash); GLM 5.3 and GPT OSS cannot turn it off and need “low”. Empty sends nothing."
          value={fireworks.reasoning_effort}
          onChange={(value) => setFireworks("reasoning_effort", value)}
        />
        <div className="field wide">
          <span className="label" id={pricesLabel}>
            Fireworks prices (USD per 1M tokens)
          </span>
          <div className="table-wrap">
            <table aria-labelledby={pricesLabel}>
              <thead>
                <tr>
                  <th>Model id</th>
                  <th>Input</th>
                  <th>Output</th>
                  <th aria-label="Remove" />
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.key}>
                    <td>
                      <input
                        type="text"
                        className="mono"
                        aria-label="Model id"
                        placeholder="accounts/fireworks/models/…"
                        value={row.model}
                        onChange={(event) => change(row.key, { model: event.target.value })}
                      />
                    </td>
                    <td>
                      <PriceInput
                        label={`Input price for ${row.model || "the new model"}`}
                        value={row.input}
                        onChange={(input) => change(row.key, { input })}
                      />
                    </td>
                    <td>
                      <PriceInput
                        label={`Output price for ${row.model || "the new model"}`}
                        value={row.output}
                        onChange={(output) => change(row.key, { output })}
                      />
                    </td>
                    <td>
                      <button
                        type="button"
                        className="button small danger"
                        aria-label={`Remove ${row.model || "the new model"}`}
                        onClick={() => commit(rows.filter((other) => other.key !== row.key))}
                      >
                        Remove
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p>
            <button type="button" className="button small" onClick={addRow}>
              Add a model
            </button>
          </p>
        </div>
        <TextField label="Jev model" value={jev.model} onChange={(value) => setJev("model", value)} />
        <div />
        <NumberField
          label="Jev input price"
          min={0}
          unit="USD per 1M tokens"
          value={jev.input_usd_per_million}
          onChange={(value) => setJev("input_usd_per_million", value)}
        />
        <NumberField
          label="Jev output price"
          min={0}
          unit="USD per 1M tokens"
          value={jev.output_usd_per_million}
          onChange={(value) => setJev("output_usd_per_million", value)}
        />
      </div>
    </section>
  );
}

// ---------- How the pipeline runs ----------

type Mode = "hands_free" | "assisted" | "review";

const MODES: ReadonlyArray<{ value: Mode; label: string; hint: string }> = [
  {
    value: "hands_free", label: "Hands-free: submit without asking",
    hint: "An application that passes the Cop Tool is filled in and submitted, and nothing waits for you. One that cannot be completed (a login, MFA prompt or CAPTCHA, or a question your details do not answer) is set aside and the next best role at that company is tried; no pitch is written for you to send. Needs the TypeSafe key: without it nothing past discovery runs.",
  },
  {
    value: "assisted", label: "Fill the form, I press Submit",
    hint: "Each form is filled in a visible Chrome window and left for you to check and submit.",
  },
  {
    value: "review", label: "Show me every draft first",
    hint: "Nothing is filled in or sent until you approve the draft in this console.",
  },
];

function HowItRuns({ draft }: { draft: ConfigDraft }) {
  const { editDraft } = useConsole();
  const set = useDraftSection("pipeline");
  const { pipeline } = draft;
  // The three modes are two settings underneath: whether drafts wait for approval, and who presses Submit.
  const mode: Mode = pipeline.require_human_review ? "review" : pipeline.auto_submit ? "hands_free" : "assisted";
  const setMode = (next: Mode) =>
    editDraft((current) => ({
      ...current,
      pipeline: {
        ...current.pipeline,
        require_human_review: next === "review",
        // Review mode leaves "who presses Submit" as it was; the checkbox below it shows and changes it.
        auto_submit: next === "review" ? current.pipeline.auto_submit : next === "hands_free",
      },
    }));
  return (
    <section className="card">
      <h2>How it runs</h2>
      <p className="lede">
        The pipeline runs from the terminal (<code className="code">npm run wake</code>) and reads these
        settings at the start of every cycle.
      </p>
      <RadioField legend="When a draft passes the Cop Tool" options={MODES} value={mode} onChange={setMode} />
      {mode === "review" ? (
        <CheckField
          label="Once I approve a draft, submit it without asking again"
          hint="Off: the approved application is filled in a visible Chrome window and you press Submit."
          checked={pipeline.auto_submit}
          onChange={(value) => set("auto_submit", value)}
        />
      ) : null}
      <CheckField
        label="Stop at invisible CAPTCHAs"
        hint={
          "Most application forms run an invisible CAPTCHA when Submit is pressed. Off: Reygent presses Submit and " +
          "lets the site's check decide; if a challenge appears it is handed to you. On: every such form is filled " +
          "and left for you to submit. Reygent never solves or hides from a CAPTCHA either way." +
          (pipeline.auto_submit ? "" : " Only applies when Reygent presses Submit itself.")
        }
        checked={pipeline.stop_at_invisible_captcha}
        // With Submit left to the user there is no automatic press for a CAPTCHA to stop.
        disabled={!pipeline.auto_submit}
        onChange={(value) => set("stop_at_invisible_captcha", value)}
      />
      <CheckField
        label="Apply to vaguely “Remote” jobs the investigation could not settle"
        hint="The pitch states your contractor arrangement and the form is answered truthfully. A listing that names a country (“Remote, Poland”) is only sent on with the next setting. Off: every unsettled job waits for you."
        checked={pipeline.pitch_unconfirmed_tier2}
        onChange={(value) => set("pitch_unconfirmed_tier2", value)}
      />
      <CheckField
        label="Also apply to “Remote” jobs that name one country"
        hint="“Remote, Spain” and the like, applied for the same way. A form asking whether you can work there is answered truthfully, so many will say no. At a company with another open role Reygent can apply for, that role is chosen instead. Off: they wait for you."
        checked={pipeline.apply_single_country}
        disabled={!pipeline.pitch_unconfirmed_tier2}
        onChange={(value) => set("apply_single_country", value)}
      />
      <div className="form-grid">
        <NumberField
          label="Lowest fit score worth drafting"
          min={0}
          max={100}
          unit="out of 100"
          value={pipeline.fit_threshold}
          onChange={(value) => set("fit_threshold", value)}
        />
        <NumberField
          label="Time between cycles"
          min={1}
          integer
          step={1}
          unit="minutes"
          value={pipeline.loop_interval_minutes}
          onChange={(value) => set("loop_interval_minutes", value)}
        />
        <NumberField
          label="Drafts per cycle"
          min={0}
          integer
          step={1}
          unit="at most"
          value={pipeline.max_drafts_per_cycle}
          onChange={(value) => set("max_drafts_per_cycle", value)}
        />
        <NumberField
          label="Submissions per day"
          min={0}
          integer
          step={1}
          unit="at most"
          value={pipeline.max_submissions_per_day}
          onChange={(value) => set("max_submissions_per_day", value)}
        />
        <NumberField
          label="Confidence needed to use an AI answer"
          min={0.5}
          max={1}
          step={0.01}
          unit="0.5 – 1"
          hint="How sure the decision model must be before an answer it wrote to a screening question is used."
          value={pipeline.answer_confidence}
          onChange={(value) => set("answer_confidence", value)}
        />
        <NumberField
          label="Confidence needed to act on an investigation"
          min={0.5}
          max={1}
          step={0.01}
          unit="0.5 – 1"
          hint="Below this, a Tier 2 verdict is not acted on."
          value={pipeline.investigation_confidence}
          onChange={(value) => set("investigation_confidence", value)}
        />
      </div>
    </section>
  );
}

/**
 * The remote-job sites Reygent can read, as `discovery.job_boards` names them. Spelled
 * out here rather than imported: this file runs in the browser and may only take types
 * from the core modules.
 */
const JOB_BOARD_LABELS: Record<JobBoard, string> = {
  remotive: "Remotive",
  remoteok: "Remote OK",
  jobicy: "Jobicy",
  himalayas: "Himalayas (worldwide roles)",
  workingnomads: "Working Nomads",
  weworkremotely: "We Work Remotely",
  realworkfromanywhere: "Real Work From Anywhere",
  golangprojects: "Golangprojects",
  python_org: "Python.org job board",
};
const JOB_BOARDS = Object.keys(JOB_BOARD_LABELS) as JobBoard[];

function Sources({ draft }: { draft: ConfigDraft }) {
  const set = useDraftSection("discovery");
  const { discovery } = draft;
  const toggleJobBoard = (board: JobBoard, on: boolean) =>
    // Kept in the listed order, so toggling one twice leaves the setting as it was.
    set("job_boards", JOB_BOARDS.filter((name) => (name === board ? on : discovery.job_boards.includes(name))));
  return (
    <section className="card">
      <h2>Sources</h2>
      <p className="lede">
        Where listings come from. All of these are public feeds; no account is needed. Each source is read no more
        often than its own terms ask, however short the cycle.
      </p>
      <div className="form-grid">
        <TagsField
          label="Greenhouse boards"
          wide
          placeholder="e.g. gitlab"
          hint="The name in boards.greenhouse.io/<name>."
          value={discovery.greenhouse_boards}
          onChange={(value) => set("greenhouse_boards", value)}
        />
        <TagsField
          label="Ashby organisations"
          wide
          placeholder="e.g. posthog"
          hint="The name in jobs.ashbyhq.com/<name>."
          value={discovery.ashby_orgs}
          onChange={(value) => set("ashby_orgs", value)}
        />
        <TagsField
          label="Lever companies"
          wide
          placeholder="e.g. metabase"
          hint="The name in jobs.lever.co/<name>."
          value={discovery.lever_companies}
          onChange={(value) => set("lever_companies", value)}
        />
        <TagsField
          label="Workable accounts"
          wide
          placeholder="e.g. zyte"
          hint="The name in apply.workable.com/<name>."
          value={discovery.workable_accounts}
          onChange={(value) => set("workable_accounts", value)}
        />
        <TagsField
          label="Recruitee companies"
          wide
          placeholder="e.g. tether"
          hint="The name in <name>.recruitee.com."
          value={discovery.recruitee_companies}
          onChange={(value) => set("recruitee_companies", value)}
        />
        <TagsField
          label="Teamtailor companies"
          wide
          placeholder="e.g. axmed"
          hint="The name in <name>.teamtailor.com."
          value={discovery.teamtailor_companies}
          onChange={(value) => set("teamtailor_companies", value)}
        />
        <TagsField
          label="Breezy companies"
          wide
          placeholder="e.g. abstractgroup"
          hint="The name in <name>.breezy.hr."
          value={discovery.breezy_companies}
          onChange={(value) => set("breezy_companies", value)}
        />
        <TagsField
          label="Title keywords"
          wide
          placeholder="e.g. engineer"
          hint="Only listings whose title contains one of these are tracked."
          value={discovery.title_keywords}
          onChange={(value) => set("title_keywords", value)}
        />
        <TagsField
          label="Titles to skip"
          wide
          placeholder="e.g. junior"
          hint="A listing whose title contains one of these is not tracked, whatever else the title says."
          value={discovery.title_exclude_keywords}
          onChange={(value) => set("title_exclude_keywords", value)}
        />
        <NumberField
          label="New listings per cycle"
          min={1}
          integer
          step={1}
          unit="at most"
          value={discovery.max_new_jobs_per_cycle}
          onChange={(value) => set("max_new_jobs_per_cycle", value)}
        />
        <NumberField
          label="Found boards read per cycle"
          min={0}
          integer
          step={1}
          unit="at most"
          hint="They take turns. A found board with no listing matching the keywords after three reads is dropped."
          value={discovery.found_boards_per_cycle}
          onChange={(value) => set("found_boards_per_cycle", value)}
        />
      </div>
      <CheckField
        label="Follow links to company boards"
        hint="When a listing links to its employer's own board on one of the providers above, that board is read too from then on. This is how coverage grows by itself. A job site's listing is also looked up on its employer's board by name, so the role is applied for through the form instead of being left as a pitch."
        checked={discovery.follow_board_links}
        onChange={(value) => set("follow_board_links", value)}
      />
      <CheckField
        label="Read the monthly Hacker News “Who is hiring?” thread"
        checked={discovery.hn_who_is_hiring}
        onChange={(value) => set("hn_who_is_hiring", value)}
      />
      <CheckField
        label="Read the monthly Hacker News “Freelancer? Seeking freelancer?” thread"
        hint="Contract gigs. Reygent writes the reply; you send it."
        checked={discovery.hn_freelancer}
        onChange={(value) => set("hn_freelancer", value)}
      />
      <fieldset className="choices">
        <legend>Remote-job sites</legend>
        {JOB_BOARDS.map((board) => (
          <CheckField
            key={board}
            label={JOB_BOARD_LABELS[board]}
            checked={discovery.job_boards.includes(board)}
            onChange={(value) => toggleJobBoard(board, value)}
          />
        ))}
      </fieldset>
    </section>
  );
}

// ---------- Limits ----------

function Limits({ draft }: { draft: ConfigDraft }) {
  const setCompensation = useDraftSection("compensation");
  const setBudget = useDraftSection("budget");
  const setCop = useDraftSection("cop");
  const { compensation, budget, cop } = draft;
  return (
    <>
      <section className="card">
        <h2>Compensation floors</h2>
        <p className="lede">Listings that top out below a floor are disqualified, and no draft may quote less.</p>
        <div className="form-grid">
          <NumberField
            label="Hourly floor"
            min={0}
            unit="USD / hour"
            value={compensation.hourly_floor_usd}
            onChange={(value) => setCompensation("hourly_floor_usd", value)}
          />
          <NumberField
            label="Monthly retainer floor"
            min={0}
            unit="USD / month"
            value={compensation.monthly_floor_usd}
            onChange={(value) => setCompensation("monthly_floor_usd", value)}
          />
          <NumberField
            label="Quoted hourly rate"
            min={0}
            unit="USD / hour"
            hint="What Reygent quotes when a form or a founder asks. It cannot be below the hourly floor."
            value={compensation.quoted_hourly_rate_usd}
            onChange={(value) => setCompensation("quoted_hourly_rate_usd", value)}
          />
          <NumberField
            label="Income goal"
            min={1}
            unit="USD / month"
            value={compensation.monthly_income_goal_usd}
            onChange={(value) => setCompensation("monthly_income_goal_usd", value)}
          />
          <NumberField
            label="Concurrent engagements"
            min={1}
            integer
            step={1}
            value={compensation.max_concurrent_engagements}
            onChange={(value) => setCompensation("max_concurrent_engagements", value)}
          />
        </div>
      </section>
      <section className="card">
        <h2>Spend guard</h2>
        <p className="lede">
          A paid call that would take the day past the cap is refused before it is sent. The first refusal pauses all
          paid calls until the next day and notifies you.
        </p>
        <div className="form-grid">
          <NumberField
            label="Daily spend cap"
            min={0}
            unit="USD / day"
            value={budget.daily_cap_usd}
            onChange={(value) => setBudget("daily_cap_usd", value)}
          />
          <NumberField
            label="Budget day starts at midnight"
            min={-12}
            max={14}
            integer
            step={1}
            unit="hours from UTC"
            value={budget.day_utc_offset_hours}
            onChange={(value) => setBudget("day_utc_offset_hours", value)}
          />
        </div>
      </section>
      <section className="card">
        <h2>Cop Tool</h2>
        <div className="form-grid">
          <NumberField
            label="Auto-fix attempts before quarantine"
            min={0}
            max={5}
            integer
            step={1}
            value={cop.max_autofix_retries}
            onChange={(value) => setCop("max_autofix_retries", value)}
          />
          <NumberField
            label="Do not re-contact a company within"
            min={0}
            integer
            step={1}
            unit="days"
            value={cop.dedup_window_days}
            onChange={(value) => setCop("dedup_window_days", value)}
          />
          <NumberField
            label="Longest pitch"
            min={20}
            integer
            step={1}
            unit="words"
            value={cop.max_pitch_words}
            onChange={(value) => setCop("max_pitch_words", value)}
          />
          <NumberField
            label="Longest resume"
            min={1}
            integer
            step={1}
            unit="pages"
            value={cop.max_pdf_pages}
            onChange={(value) => setCop("max_pdf_pages", value)}
          />
        </div>
      </section>
    </>
  );
}

export function SettingsView() {
  const { boot, draft } = useBoot();
  const { draftVersion } = useConsole();
  return (
    <>
      <PageHead title="Settings" subtitle="Keys, limits and guard rails. Changes take effect when you save." />
      <SetupNotices errorOnly />
      <section className="card">
        <h2>API keys</h2>
        <p className="lede">
          Saved straight away to {boot.secretsPath} (readable only by you). Keys are never written to config.yaml and
          are never shown again after saving.
        </p>
        {boot.keys.map((status) => (
          <KeyRow key={status.id} status={status} />
        ))}
      </section>
      {/* Fields hold their own text while typing; a new key rebuilds them after Discard or a save. */}
      <Fragment key={draftVersion}>
        <HowItRuns draft={draft} />
        <Sources draft={draft} />
        <Limits draft={draft} />
        <ModelsCard />
      </Fragment>
      <section className="card">
        <h2>Files</h2>
        <dl className="kv">
          <dt>Configuration</dt>
          <dd className="mono">{boot.configPath}</dd>
          <dt>Database</dt>
          <dd className="mono">{boot.dbPath}</dd>
          <dt>API keys</dt>
          <dd className="mono">{boot.secretsPath}</dd>
        </dl>
      </section>
    </>
  );
}
