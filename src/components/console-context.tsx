"use client";

import {
  type ReactNode,
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import { api, errorMessage } from "@/components/api-client";
import type { Config, OverviewBody, PendingCounts, StageCounts, StateBody } from "@/core/web/types";

// ---------- The config draft ----------

/** A fact-bank entry as the forms edit it: every field present, in the YAML's own spelling. */
export interface AchievementDraft {
  id: string;
  category: string;
  positioning: string[];
  headline: string;
  impact_metric: string;
  technologies: string[];
  employer: string;
  evidence_url: string;
  context: string;
  verified: boolean;
}

/** The whole of config.yaml as edited on the three setup pages, until it is saved or discarded. */
export type ConfigDraft = Omit<Config, "fact_bank"> & { fact_bank: { achievements: AchievementDraft[] } };

export function newAchievementId(): string {
  return `ach_${Math.random().toString(36).slice(2, 8)}`;
}

const asText = (value: unknown): string => (typeof value === "string" ? value : "");
const asList = (value: unknown): string[] => (Array.isArray(value) ? value.map(String) : []);

export function achievementDraft(raw: Record<string, unknown> = {}): AchievementDraft {
  return {
    id: String(raw.id || newAchievementId()),
    category: asText(raw.category),
    positioning: asList(raw.positioning),
    headline: asText(raw.headline),
    impact_metric: asText(raw.impact_metric),
    technologies: asList(raw.technologies),
    employer: asText(raw.employer),
    evidence_url: asText(raw.evidence_url),
    context: asText(raw.context),
    verified: raw.verified === true,
  };
}

/** A private copy of the saved config, with every achievement in the shape the forms expect. */
function draftOf(config: Config): ConfigDraft {
  const copy = structuredClone(config);
  return { ...copy, fact_bank: { achievements: copy.fact_bank.achievements.map(achievementDraft) } };
}

// ---------- Context ----------

interface ToastItem {
  id: number;
  message: string;
}

interface SidebarCounts {
  /** Every tracked application. */
  applications: number;
  /** Applications that cannot move until the user does something. */
  waiting: number;
  /** Drafts held by the Cop Tool. */
  held: number;
}

/**
 * Applications that are stuck until the user acts: handed off by the operator, awaiting
 * approval, a pitch only they can send — and, unless the pipeline is set to apply anyway,
 * Tier 2 jobs the investigation could not settle.
 */
export function waitingOnUser(pending: PendingCounts, mode: OverviewBody["mode"]): number {
  return (
    pending.needsAttention + pending.awaitingReview + pending.toSend + (mode.pitchUnconfirmed ? 0 : pending.needsDecision)
  );
}

interface ConsoleValue {
  /** What /api/state last returned; null until the first answer. */
  boot: StateBody | null;
  bootError: string | null;
  loadBoot: () => void;
  /** Adopt a fresh /api/state. Unsaved edits are kept. */
  applyBoot: (boot: StateBody) => void;

  draft: ConfigDraft | null;
  /** Changes whenever the draft is replaced from the saved config; forms use it as their React key. */
  draftVersion: number;
  dirty: boolean;
  editDraft: (change: (draft: ConfigDraft) => ConfigDraft) => void;
  saving: boolean;
  saveError: string | null;
  save: () => Promise<void>;
  discard: () => void;

  /** Sidebar numbers; null until first known. */
  counts: SidebarCounts | null;
  showCounts: (stages: StageCounts, pending: PendingCounts, mode: OverviewBody["mode"]) => void;
  refreshCounts: () => void;

  toasts: ToastItem[];
  toast: (message: string) => void;

  busy: boolean;
  adjustBusy: (delta: number) => void;
}

const ConsoleContext = createContext<ConsoleValue | null>(null);

const TOAST_MS = 4500;

export function ConsoleProvider({ children }: { children: ReactNode }) {
  const [boot, setBoot] = useState<StateBody | null>(null);
  const [bootError, setBootError] = useState<string | null>(null);
  const [draft, setDraft] = useState<ConfigDraft | null>(null);
  const [draftVersion, setDraftVersion] = useState(0);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [counts, setCounts] = useState<ConsoleValue["counts"]>(null);
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const [busyCount, setBusyCount] = useState(0);
  // Read by callbacks that must stay stable; mirrors `dirty`.
  const dirtyRef = useRef(false);
  const toastId = useRef(0);

  const markDirty = useCallback((value: boolean) => {
    dirtyRef.current = value;
    setDirty(value);
  }, []);

  const applyBoot = useCallback((next: StateBody) => {
    setBoot(next);
    setBootError(null);
    if (!dirtyRef.current) {
      setDraft(draftOf(next.config));
      setDraftVersion((version) => version + 1);
    }
  }, []);

  const loadBoot = useCallback(() => {
    setBootError(null);
    api<StateBody>("GET", "/api/state").then(applyBoot, (error: unknown) => setBootError(errorMessage(error)));
  }, [applyBoot]);

  const showCounts = useCallback((stages: StageCounts, pending: PendingCounts, mode: OverviewBody["mode"]) => {
    setCounts({
      applications: Object.values(stages).reduce((sum, n) => sum + n, 0),
      waiting: waitingOnUser(pending, mode),
      held: pending.quarantine,
    });
  }, []);

  const refreshCounts = useCallback(() => {
    api<OverviewBody>("GET", "/api/overview").then(
      (overview) => showCounts(overview.stages, overview.pending, overview.mode),
      () => {
        // The page itself reports connection problems; the sidebar just keeps its last numbers.
      },
    );
  }, [showCounts]);

  const toast = useCallback((message: string) => {
    const id = ++toastId.current;
    setToasts((list) => [...list, { id, message }]);
    window.setTimeout(() => setToasts((list) => list.filter((item) => item.id !== id)), TOAST_MS);
  }, []);

  const editDraft = useCallback(
    (change: (draft: ConfigDraft) => ConfigDraft) => {
      setDraft((current) => (current ? change(current) : current));
      setSaveError(null);
      markDirty(true);
    },
    [markDirty],
  );

  const adjustBusy = useCallback((delta: number) => setBusyCount((n) => n + delta), []);

  useEffect(() => {
    loadBoot();
    refreshCounts();
  }, [loadBoot, refreshCounts]);

  // Closing or reloading the tab would silently drop unsaved edits.
  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  const value = useMemo<ConsoleValue>(() => {
    const save = async () => {
      if (!draft) return;
      setSaving(true);
      try {
        const next = await api<StateBody>("PUT", "/api/config", { config: draft });
        markDirty(false);
        setSaveError(null);
        applyBoot(next);
        toast("Saved. The fact bank is in sync.");
      } catch (error) {
        setSaveError(errorMessage(error));
      } finally {
        setSaving(false);
      }
    };
    const discard = () => {
      markDirty(false);
      setSaveError(null);
      if (boot) applyBoot(boot);
    };
    return {
      boot, bootError, loadBoot, applyBoot, draft, draftVersion, dirty, editDraft, saving, saveError, save, discard,
      counts, showCounts, refreshCounts, toasts, toast, busy: busyCount > 0, adjustBusy,
    };
  }, [
    boot, bootError, loadBoot, applyBoot, draft, draftVersion, dirty, editDraft, saving, saveError, markDirty,
    counts, showCounts, refreshCounts, toasts, toast, busyCount, adjustBusy,
  ]);

  return <ConsoleContext.Provider value={value}>{children}</ConsoleContext.Provider>;
}

export function useConsole(): ConsoleValue {
  const value = useContext(ConsoleContext);
  if (!value) throw new Error("useConsole must be used inside <ConsoleProvider>");
  return value;
}

/** The loaded state and draft. Pages render only once both exist, so they can rely on them. */
export function useBoot(): { boot: StateBody; draft: ConfigDraft } {
  const { boot, draft } = useConsole();
  if (!boot || !draft) throw new Error("useBoot must be used inside the loaded console shell");
  return { boot, draft };
}

/** Dim the page while `active`. */
export function useBusy(active: boolean): void {
  const { adjustBusy } = useConsole();
  useEffect(() => {
    if (!active) return;
    adjustBusy(1);
    return () => adjustBusy(-1);
  }, [active, adjustBusy]);
}

type Section = "candidate" | "compensation" | "budget" | "cop" | "jev" | "fireworks" | "pipeline" | "discovery";

/** A setter for one section of the draft: `set("name", "Ada")`. */
export function useDraftSection<S extends Section>(section: S) {
  const { editDraft } = useConsole();
  return useCallback(
    <K extends keyof ConfigDraft[S]>(key: K, value: ConfigDraft[S][K]) =>
      editDraft((draft) => ({ ...draft, [section]: { ...draft[section], [key]: value } })),
    [editDraft, section],
  );
}
