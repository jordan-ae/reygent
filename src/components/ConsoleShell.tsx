"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";

import { ConsoleProvider, useConsole } from "@/components/console-context";
import { count } from "@/components/format";
import { ErrorCard } from "@/components/ui";
import type { ReadinessArea } from "@/core/web/types";

interface NavItem {
  href: string;
  /** First path segment; also the hook the stylesheet uses. */
  route: string;
  label: string;
  /** Setup pages show "to do" while something in their area is unfinished. */
  area?: ReadinessArea;
}

const OPERATE: NavItem[] = [
  { href: "/", route: "overview", label: "Overview" },
  { href: "/applications", route: "applications", label: "Applications" },
  { href: "/activity", route: "activity", label: "Activity" },
  { href: "/quarantine", route: "quarantine", label: "Quarantine" },
  { href: "/costs", route: "costs", label: "Costs" },
];

const SET_UP: NavItem[] = [
  { href: "/profile", route: "profile", label: "Profile", area: "profile" },
  { href: "/fact-bank", route: "fact-bank", label: "Fact bank", area: "fact_bank" },
  { href: "/answers", route: "answers", label: "Answers" },
  { href: "/settings", route: "settings", label: "Settings", area: "settings" },
];

/** The number beside a section: what is waiting on the user there, or failing that a plain total. */
function NavCount({ route }: { route: string }) {
  const { counts } = useConsole();
  if (!counts) return null;
  if (route === "applications") {
    if (counts.waiting > 0) {
      return (
        <span className="count attention" title="Waiting on you">
          {count(counts.waiting)}
        </span>
      );
    }
    return counts.applications > 0 ? <span className="count">{count(counts.applications)}</span> : null;
  }
  if (route === "quarantine" && counts.held > 0) {
    return (
      <span className="count attention" title="Held drafts waiting on you">
        {count(counts.held)}
      </span>
    );
  }
  return null;
}

function NavGroup({ label, items }: { label: string; items: NavItem[] }) {
  const pathname = usePathname();
  const { boot } = useConsole();
  const current = pathname === "/" ? "overview" : pathname.split("/")[1];
  return (
    <div className="nav-group">
      <p className="nav-label">{label}</p>
      {items.map((item) => (
        <Link
          key={item.route}
          href={item.href}
          data-route={item.route}
          aria-current={item.route === current ? "page" : undefined}
        >
          {item.label}
          <NavCount route={item.route} />
          {item.area && boot?.readiness.some((issue) => issue.area === item.area) ? (
            <span className="todo">to do</span>
          ) : null}
        </Link>
      ))}
    </div>
  );
}

/** Unsaved setup edits, kept on screen on every page until they are saved or discarded. */
function SaveBar() {
  const { dirty, saving, saveError, save, discard } = useConsole();
  return (
    <div className="savebar" role="region" aria-label="Unsaved changes" hidden={!dirty}>
      <p className={saveError ? "form-error" : undefined} role={saveError ? "alert" : undefined}>
        {saveError ?? "You have unsaved changes."}
      </p>
      <button type="button" className="button" onClick={discard}>
        Discard
      </button>
      <button type="button" className="button primary" disabled={saving} onClick={save}>
        Save changes
      </button>
    </div>
  );
}

function Toasts() {
  const { toasts } = useConsole();
  return (
    <div className="toasts" role="status" aria-live="polite">
      {toasts.map((item) => (
        <div className="toast" key={item.id}>
          {item.message}
        </div>
      ))}
    </div>
  );
}

function Frame({ children }: { children: ReactNode }) {
  const { boot, draft, bootError, loadBoot, busy } = useConsole();
  const ready = boot !== null && draft !== null;
  return (
    <>
      <div className="shell">
        <nav className="sidebar" aria-label="Sections">
          <Link className="brand" href="/">
            Reygent<span>career operator</span>
          </Link>
          <NavGroup label="Operate" items={OPERATE} />
          <NavGroup label="Set up" items={SET_UP} />
        </nav>
        <main id="view" tabIndex={-1} aria-busy={busy || (!ready && !bootError) ? true : undefined}>
          {/* Every page needs the saved config and setup state, so nothing renders before they arrive. */}
          {ready ? children : bootError ? <ErrorCard message={bootError} onRetry={loadBoot} /> : null}
        </main>
      </div>
      <SaveBar />
      <Toasts />
    </>
  );
}

/** Sidebar, page area, save bar and toasts around every page; owns the state they share. */
export function ConsoleShell({ children }: { children: ReactNode }) {
  return (
    <ConsoleProvider>
      <Frame>{children}</Frame>
    </ConsoleProvider>
  );
}
