"use client";

import { type ReactNode, useEffect, useRef, useState } from "react";

import { api, errorMessage } from "@/components/api-client";
import { useConsole } from "@/components/console-context";
import { When } from "@/components/ui";
import type { CodeHoldBody, CodeHoldView } from "@/core/web/types";

/** While Reygent is on it, the card asks how it is going this often. */
const POLL_MS = 2_000;
const MOVING: ReadonlyArray<CodeHoldView["state"]> = ["queued", "filling", "waiting", "entering"];

/**
 * An application held for a code the site emails after Submit. "I'm ready" has Reygent
 * submit it again; the code that arrives is shown here, and typed only once you approve it.
 */
export function CodeCard({
  jobId,
  initial,
  onChanged,
  heldActions,
}: {
  jobId: string;
  initial: CodeHoldView;
  onChanged: () => void;
  /** More buttons beside "I'm ready" while it waits for you (Decline). */
  heldActions?: ReactNode;
}) {
  const { toast, refreshCounts } = useConsole();
  const [view, setView] = useState<CodeHoldView>(initial);
  const [typed, setTyped] = useState(initial.found?.code ?? "");
  const [sending, setSending] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [pasteNow, setPasteNow] = useState(false);
  const edited = useRef(false);
  const path = `/api/applications/${encodeURIComponent(jobId)}/code`;
  const moving = MOVING.includes(view.state);

  // The page reloaded around it: start from what it says now.
  useEffect(() => setView(initial), [initial]);

  // While it moves, follow it; once it settles, the page around it has changed too.
  useEffect(() => {
    if (!moving) return;
    let stopped = false;
    const timer = setInterval(async () => {
      try {
        const { codeHold } = await api<CodeHoldBody>("GET", path);
        if (stopped) return;
        if (codeHold) setView(codeHold);
        if (!codeHold || !MOVING.includes(codeHold.state)) {
          stopped = true;
          refreshCounts();
          onChanged();
        }
      } catch {
        // The console restarting: the next tick tries again.
      }
    }, POLL_MS);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [moving, path, onChanged, refreshCounts]);

  // A code found in the inbox fills the box, unless you have typed one yourself.
  useEffect(() => {
    if (view.found?.code && !edited.current) setTyped(view.found.code);
  }, [view.found?.code]);

  const send = async (body: object, done: string) => {
    setSending(true);
    setProblem(null);
    try {
      const { codeHold } = await api<CodeHoldBody>("POST", path, body);
      toast(done);
      if (codeHold) setView(codeHold);
      else onChanged();
    } catch (error) {
      setProblem(errorMessage(error));
    } finally {
      setSending(false);
    }
  };

  let body;
  if (view.state === "held") {
    body = (
      <>
        <p className="lede">
          After Submit, the site emailed you a code to confirm a person is applying, and it takes the application
          only once that code is entered. Nothing has gone out yet.
        </p>
        {view.message ? <p className="sub">Last try: {view.message}</p> : null}
        <p>
          When you have your inbox to hand, press <strong>I&rsquo;m ready</strong>. Reygent fills the form in again
          and presses Submit, the site emails you a fresh code, and it shows up here for you to approve.
        </p>
        <div className="actions">
          <button type="button" className="button primary" disabled={sending} onClick={() => send({ action: "ready" }, "Reygent is starting it.")}>
            I&rsquo;m ready
          </button>
          {heldActions}
        </div>
      </>
    );
  } else if (view.state === "queued") {
    body = (
      <>
        <p className="lede">Waiting for Reygent to start it.</p>
        <p className="sub">
          It starts within seconds, or as soon as a run in progress finishes. If nothing happens, check that{" "}
          <code className="code">npm run wake</code> is running.
        </p>
        <div className="actions">
          <button type="button" className="button" disabled={sending} onClick={() => send({ action: "skip" }, "Called off.")}>
            Cancel
          </button>
        </div>
      </>
    );
  } else if (view.state === "filling") {
    body = <p className="lede">Filling in the form and pressing Submit…</p>;
  } else if (view.state === "entering") {
    body = <p className="lede">Entering the code and checking that the application went through…</p>;
  } else if (!view.found && !pasteNow && view.lookUntil && Date.parse(view.lookUntil) > Date.now()) {
    body = (
      <>
        <p className="lede">The site has emailed you a code. Looking for it in your inbox…</p>
        <p className="sub">
          Reygent checks every 10 seconds until <When iso={view.lookUntil} />. If it does not turn up by then, you
          will be asked to paste it.
        </p>
        <div className="actions">
          <button type="button" className="button" onClick={() => setPasteNow(true)}>
            Paste it myself
          </button>
          <button type="button" className="button" disabled={sending} onClick={() => send({ action: "skip" }, "Not now.")}>
            Not now
          </button>
        </div>
      </>
    );
  } else {
    const found = view.found;
    body = (
      <>
        <p className="lede">
          {found
            ? "The site emailed you this code. Check it is for this application, then approve it."
            : view.unreadable
              ? `The site emailed the code to ${view.unreadable}, which Reygent cannot read yet: paste it here.`
              : "Reygent did not find the code in your inbox: paste it here."}
        </p>
        {!found && view.unreadable ? (
          <p className="sub">
            Save that inbox&rsquo;s app password in <a href="/settings">Settings</a> and Reygent will find codes itself.
          </p>
        ) : null}
        {found ? (
          <p className="sub">
            From “{found.subject}”, received <When iso={found.receivedAt} />.
          </p>
        ) : null}
        {view.message ? <p className="sub">{view.message}</p> : null}
        <div className="field">
          <label htmlFor="emailed-code">Code</label>
          <input
            id="emailed-code"
            type="text"
            autoComplete="one-time-code"
            spellCheck={false}
            value={typed}
            onChange={(event) => {
              edited.current = true;
              setTyped(event.target.value);
            }}
          />
          {view.until ? (
            <div className="hint">
              Waiting until <When iso={view.until} />.
            </div>
          ) : null}
        </div>
        <div className="actions">
          <button
            type="button"
            className="button primary"
            disabled={sending || !typed.trim()}
            onClick={() => send({ action: "approve", code: typed }, "Approved. Entering it now.")}
          >
            Approve
          </button>
          <button type="button" className="button" disabled={sending} onClick={() => send({ action: "skip" }, "Not now.")}>
            Not now
          </button>
        </div>
      </>
    );
  }

  return (
    <>
      {body}
      {problem ? (
        <p className="form-error" role="alert">
          {problem}
        </p>
      ) : null}
    </>
  );
}
