/**
 * What discovery remembers between cycles: when each source was last read, and the
 * company boards it has found by itself.
 *
 * Both are small JSON documents in a key-value store. The Repository's `system_state`
 * satisfies `DiscoveryState` as it is, so the memory lives in the database next to the
 * jobs; a plain in-memory store does for tests and for a caller with no database.
 * Nothing here fetches anything.
 */

import { type BoardProvider, type BoardRef, BOARD_PROVIDERS, boardKey } from "@/core/discovery/boards";

/** The part of the Repository discovery needs: its JSON key-value store. */
export interface DiscoveryState {
  getState<T = unknown>(key: string, fallback?: T | null): T | null;
  setState(key: string, value: unknown): void;
}

/** label -> when the source was last asked, as an ISO timestamp. */
export const READS_KEY = "discovery.reads";
/** board key -> FoundBoard. */
export const BOARDS_KEY = "discovery.boards";

/** A found board is given this many reads in a row to show a listing worth tracking. */
export const MISSES_BEFORE_RETIRING = 3;
/** A found board is read at most this often; the per-cycle budget usually makes it rarer. */
export const FOUND_BOARD_REFRESH_MINUTES = 6 * 60;
/** Upper bound on the boards remembered, read or retired. */
export const MAX_REMEMBERED_BOARDS = 2000;
/** A read older than this belongs to a source that is no longer configured. */
const FORGET_READS_AFTER_DAYS = 45;

/** A company board that a listing linked to. */
export interface FoundBoard {
  provider: BoardProvider;
  token: string;
  /** The source whose listing linked to it first: "hn", "remotive", "greenhouse:gitlab", ... */
  via: string;
  foundAt: string;
  /** Linked from a listing whose title matched the keywords; such boards are read first. */
  wanted: boolean;
  reads: number;
  /** Reads in a row that failed or returned no keyword-matching listing. */
  misses: number;
  lastReadAt: string | null;
  /** Set once `misses` reaches the limit. A retired board is kept so it is not found again. */
  retiredAt: string | null;
  /**
   * The company's name, for a board found by it. Ashby and Lever give none, so their
   * listings would otherwise go by the slug ("Stickermule") and not count as the same
   * company the job sites call "Sticker Mule".
   */
  company?: string;
}

export interface Memory {
  reads: Record<string, string>;
  boards: Record<string, FoundBoard>;
}

/** A store that lasts as long as the object does. */
export function createMemoryState(): DiscoveryState {
  const values = new Map<string, string>();
  return {
    getState<T = unknown>(key: string, fallback: T | null = null): T | null {
      const stored = values.get(key);
      return stored === undefined ? fallback : (JSON.parse(stored) as T);
    },
    setState(key, value) {
      values.set(key, JSON.stringify(value));
    },
  };
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Read the memory, dropping anything that is not in the expected shape (an edited or older database). */
export function loadMemory(state: DiscoveryState | null): Memory {
  const memory: Memory = { reads: {}, boards: {} };
  const reads = state?.getState(READS_KEY);
  if (isRecord(reads)) {
    for (const [label, at] of Object.entries(reads)) if (typeof at === "string") memory.reads[label] = at;
  }
  const boards = state?.getState(BOARDS_KEY);
  if (isRecord(boards)) {
    for (const [key, board] of Object.entries(boards)) {
      if (!isRecord(board) || typeof board.token !== "string") continue;
      if (!BOARD_PROVIDERS.includes(board.provider as BoardProvider)) continue;
      memory.boards[key] = {
        provider: board.provider as BoardProvider,
        token: board.token,
        via: typeof board.via === "string" ? board.via : "",
        foundAt: typeof board.foundAt === "string" ? board.foundAt : "",
        wanted: board.wanted === true,
        reads: typeof board.reads === "number" ? board.reads : 0,
        misses: typeof board.misses === "number" ? board.misses : 0,
        lastReadAt: typeof board.lastReadAt === "string" ? board.lastReadAt : null,
        retiredAt: typeof board.retiredAt === "string" ? board.retiredAt : null,
        ...(typeof board.company === "string" && board.company ? { company: board.company } : {}),
      };
    }
  }
  return memory;
}

const minutesSince = (iso: string | null | undefined, now: Date): number =>
  iso ? (now.getTime() - new Date(iso).getTime()) / 60_000 : Infinity;

/** True when `label` has not been asked within its refresh interval. A clock set back does not block it. */
export function isDue(memory: Memory, label: string, refreshMinutes: number, now: Date): boolean {
  const elapsed = minutesSince(memory.reads[label], now);
  return !(elapsed >= 0 && elapsed < refreshMinutes);
}

/**
 * Note that `label` is being asked now, and store it at once.
 *
 * It is stored before the answer arrives and whether or not the read succeeds: the
 * interval is the source's rate guidance, and a source that is failing or a run that is
 * interrupted is no reason to ask it sooner.
 */
export function markRead(state: DiscoveryState | null, memory: Memory, label: string, now: Date): void {
  memory.reads[label] = now.toISOString();
  for (const [other, at] of Object.entries(memory.reads)) {
    if (minutesSince(at, now) > FORGET_READS_AFTER_DAYS * 24 * 60) delete memory.reads[other];
  }
  state?.setState(READS_KEY, memory.reads);
}

/**
 * Remember a board a listing linked to. Returns true when it is new.
 *
 * A board already known keeps its record, retired or not; one first seen on an unwanted
 * listing is promoted when a wanted listing links to it too. When the memory is full the
 * longest-retired boards make room, and if there are none the board is not taken.
 */
export function rememberBoard(
  memory: Memory,
  board: BoardRef,
  via: string,
  wanted: boolean,
  now: Date,
  company?: string,
): boolean {
  const key = boardKey(board);
  const known = memory.boards[key];
  if (known) {
    known.wanted ||= wanted;
    if (company && !known.company) known.company = company;
    return false;
  }
  if (Object.keys(memory.boards).length >= MAX_REMEMBERED_BOARDS) {
    const [oldest] = Object.entries(memory.boards)
      .filter(([, other]) => other.retiredAt)
      .sort(([, a], [, b]) => (a.retiredAt! < b.retiredAt! ? -1 : 1));
    if (!oldest) return false;
    delete memory.boards[oldest[0]];
  }
  memory.boards[key] = {
    ...board, via, wanted, foundAt: now.toISOString(), reads: 0, misses: 0, lastReadAt: null, retiredAt: null,
    ...(company ? { company } : {}),
  };
  return true;
}

/**
 * The found boards to read this cycle, at most `limit`.
 *
 * Boards the user has configured are read as configured and skipped here. The rest take
 * turns: those never read first, then those found through a listing worth tracking, then
 * whichever has waited longest. So every board is reached however many there are.
 */
export function boardsToRead(memory: Memory, configured: ReadonlySet<string>, limit: number, now: Date): FoundBoard[] {
  const waiting = (board: FoundBoard) => board.lastReadAt ?? board.foundAt;
  return Object.entries(memory.boards)
    .filter(([key, board]) => !board.retiredAt && !configured.has(key))
    .map(([, board]) => board)
    .filter((board) => minutesSince(board.lastReadAt, now) >= FOUND_BOARD_REFRESH_MINUTES)
    .sort(
      (a, b) =>
        Number(a.lastReadAt !== null) - Number(b.lastReadAt !== null) ||
        Number(b.wanted) - Number(a.wanted) ||
        (waiting(a) < waiting(b) ? -1 : waiting(a) > waiting(b) ? 1 : 0) ||
        (boardKey(a) < boardKey(b) ? -1 : 1),
    )
    .slice(0, Math.max(0, limit));
}

/** Record how a found board's read went: whether it returned a listing whose title matched the keywords. */
export function recordBoardRead(memory: Memory, board: BoardRef, productive: boolean, now: Date): void {
  const record = memory.boards[boardKey(board)];
  if (!record) return;
  record.reads += 1;
  record.lastReadAt = now.toISOString();
  record.misses = productive ? 0 : record.misses + 1;
  if (record.misses >= MISSES_BEFORE_RETIRING) record.retiredAt = now.toISOString();
}

export function saveBoards(state: DiscoveryState | null, memory: Memory): void {
  state?.setState(BOARDS_KEY, memory.boards);
}
