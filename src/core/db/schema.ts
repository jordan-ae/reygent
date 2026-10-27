/** SQLite schema and connection bootstrap (Node's built-in node:sqlite). */

import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { expandHome } from "@/core/config";
import { roleKey } from "@/core/text";

export const SCHEMA_VERSION = 2;

/**
 * Every statement is idempotent, so opening a database created by an older version
 * (including the original Python implementation) simply adds what is missing.
 */
const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS candidate_profile (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    email TEXT NOT NULL,
    phone TEXT,
    location TEXT,
    timezone TEXT,
    work_authorization TEXT,
    notice_period TEXT,
    github_url TEXT,
    linkedin_url TEXT,
    portfolio_url TEXT,
    years_experience REAL,
    employers_json TEXT NOT NULL DEFAULT '[]',
    skills_json TEXT NOT NULL DEFAULT '[]',
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS achievements (
    id TEXT PRIMARY KEY,
    candidate_id TEXT NOT NULL REFERENCES candidate_profile(id) ON DELETE CASCADE,
    category TEXT,
    headline TEXT NOT NULL,
    impact_metric TEXT,
    technologies_json TEXT NOT NULL DEFAULT '[]',
    context TEXT,
    employer TEXT,
    evidence_url TEXT,
    positioning_json TEXT NOT NULL DEFAULT '[]',
    verified INTEGER NOT NULL DEFAULT 0 CHECK (verified IN (0, 1))
);

CREATE TABLE IF NOT EXISTS positioning_profiles (
    id TEXT PRIMARY KEY,
    candidate_id TEXT NOT NULL REFERENCES candidate_profile(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    target_summary TEXT,
    core_skills_json TEXT NOT NULL DEFAULT '[]',
    highlighted_achievements_json TEXT NOT NULL DEFAULT '[]',
    pitch_angle TEXT
);

CREATE TABLE IF NOT EXISTS jobs (
    id TEXT PRIMARY KEY,
    source TEXT NOT NULL,
    source_id TEXT NOT NULL,
    company TEXT NOT NULL,
    title TEXT NOT NULL,
    location TEXT,
    description TEXT,
    apply_url TEXT,
    company_domain TEXT,
    channel TEXT NOT NULL,
    is_remote INTEGER,
    employment_type TEXT,
    comp_min REAL,
    comp_max REAL,
    comp_period TEXT,
    comp_currency TEXT,
    skills_json TEXT NOT NULL DEFAULT '[]',
    posted_at TEXT,
    stage TEXT NOT NULL DEFAULT 'discovered',
    fingerprint TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    role_key TEXT,
    UNIQUE (source, source_id),
    UNIQUE (fingerprint)
);
CREATE INDEX IF NOT EXISTS idx_jobs_stage ON jobs(stage);

CREATE TABLE IF NOT EXISTS job_evaluations (
    job_id TEXT PRIMARY KEY REFERENCES jobs(id) ON DELETE CASCADE,
    eligibility_tier TEXT NOT NULL
        CHECK (eligibility_tier IN ('confirmed', 'potentially_eligible', 'ineligible')),
    reason_codes_json TEXT NOT NULL DEFAULT '[]',
    positive_signals_json TEXT NOT NULL DEFAULT '[]',
    disqualifiers_json TEXT NOT NULL DEFAULT '[]',
    needs_b2b_investigation INTEGER NOT NULL DEFAULT 0,
    summary TEXT,
    fit_score REAL,
    best_positioning_profile TEXT,
    evaluated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS pipeline_tasks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    task_type TEXT NOT NULL,
    job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
    detail TEXT,
    status TEXT NOT NULL DEFAULT 'pending',
    created_at TEXT NOT NULL,
    UNIQUE (task_type, job_id)
);
CREATE INDEX IF NOT EXISTS idx_tasks_queue ON pipeline_tasks(task_type, status);

CREATE TABLE IF NOT EXISTS cost_telemetry (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp TEXT NOT NULL,
    provider TEXT NOT NULL,
    model TEXT NOT NULL,
    prompt_tokens INTEGER NOT NULL DEFAULT 0,
    completion_tokens INTEGER NOT NULL DEFAULT 0,
    cost_usd REAL NOT NULL DEFAULT 0,
    task_type TEXT NOT NULL,
    outcome TEXT NOT NULL,
    latency_ms INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_cost_timestamp ON cost_telemetry(timestamp);

CREATE TABLE IF NOT EXISTS quarantined_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    job_id TEXT NOT NULL,
    violation_rule TEXT NOT NULL,
    original_content TEXT NOT NULL,
    critique TEXT NOT NULL,
    retry_count INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'pending',
    created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_quarantine_status ON quarantined_items(status);

CREATE TABLE IF NOT EXISTS dispatch_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    job_id TEXT NOT NULL,
    channel TEXT NOT NULL,
    company_key TEXT NOT NULL,
    domain TEXT NOT NULL DEFAULT '',
    contact TEXT NOT NULL DEFAULT '',
    dispatched_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_dispatch_time ON dispatch_log(dispatched_at);

CREATE TABLE IF NOT EXISTS application_drafts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
    status TEXT NOT NULL,
    content_json TEXT NOT NULL,
    cop_retries INTEGER NOT NULL DEFAULT 0,
    note TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_drafts_status ON application_drafts(status);
CREATE INDEX IF NOT EXISTS idx_drafts_job ON application_drafts(job_id);

CREATE TABLE IF NOT EXISTS outcomes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    job_id TEXT NOT NULL,
    channel TEXT NOT NULL,
    kind TEXT NOT NULL,
    note TEXT NOT NULL DEFAULT '',
    monthly_value_usd REAL,
    recorded_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS standing_answers (
    question_key TEXT PRIMARY KEY,
    question TEXT NOT NULL,
    answer TEXT NOT NULL,
    options_json TEXT NOT NULL DEFAULT '[]',
    source TEXT NOT NULL CHECK (source IN ('user', 'ai')),
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS system_state (
    key TEXT PRIMARY KEY,
    value_json TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
`;

/** Columns added after the first release: [table, column, definition]. */
const ADDED_COLUMNS: ReadonlyArray<[string, string, string]> = [
  ["job_evaluations", "matched_skills_json", "TEXT NOT NULL DEFAULT '[]'"],
  ["job_evaluations", "missing_skills_json", "TEXT NOT NULL DEFAULT '[]'"],
  // Company and title without the location: how the same role is recognised across sources.
  ["jobs", "role_key", "TEXT"],
];

/**
 * Open (creating if needed) the Reygent database and bring its schema up to date.
 *
 * The data directory is created owner-only because the database holds the
 * candidate's contact details.
 */
export function openDatabase(dbPath: string): DatabaseSync {
  let file = dbPath;
  if (dbPath !== ":memory:") {
    file = path.resolve(expandHome(dbPath));
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  }
  const db = new DatabaseSync(file);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("PRAGMA busy_timeout = 5000");
  db.exec(SCHEMA_SQL);
  for (const [table, column, definition] of ADDED_COLUMNS) {
    const existing = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    if (!existing.some((info) => info.name === column)) {
      db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    }
  }
  // After the column exists on an older database. Jobs tracked before it did get their key now.
  db.exec("CREATE INDEX IF NOT EXISTS idx_jobs_role ON jobs(role_key)");
  const unkeyed = db.prepare("SELECT id, company, title FROM jobs WHERE role_key IS NULL").all() as Array<{
    id: string;
    company: string;
    title: string;
  }>;
  if (unkeyed.length > 0) {
    const setKey = db.prepare("UPDATE jobs SET role_key = ? WHERE id = ?");
    for (const job of unkeyed) setKey.run(roleKey(job.company, job.title), job.id);
  }
  // Stamp the version only when it changes. Setting it is a write, and an unconditional
  // write would make every open wait for (or fail on) another connection's transaction.
  const { user_version: version } = db.prepare("PRAGMA user_version").get() as { user_version: number };
  if (version !== SCHEMA_VERSION) db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
  return db;
}
