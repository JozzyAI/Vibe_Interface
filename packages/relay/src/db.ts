import { createRequire } from "node:module";

const _require = createRequire(import.meta.url);

// Minimal typing surface for better-sqlite3 operations we use.
interface Stmt {
  run(...params: unknown[]): { changes: number };
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
}
interface Db {
  pragma(s: string): void;
  exec(sql: string): void;
  prepare(sql: string): Stmt;
}
interface DbConstructor {
  new (path: string): Db;
}

const BetterSqlite3 = _require("better-sqlite3") as DbConstructor;

let _db: Db | null = null;

export function getDb(): Db {
  if (_db) return _db;
  const dbPath = (process.env["VI_RELAY_DB_PATH"] ?? "./vi-relay.db").trim();
  _db = new BetterSqlite3(dbPath);
  _db.pragma("journal_mode = WAL");
  _db.pragma("foreign_keys = ON");
  _db.pragma("busy_timeout = 5000");
  initSchema(_db);
  return _db;
}

export function initSchema(db: Db): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS owners (
      owner_id   TEXT PRIMARY KEY DEFAULT 'default',
      name       TEXT NOT NULL DEFAULT 'owner',
      token      TEXT UNIQUE NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS agents (
      agent_id             TEXT PRIMARY KEY,
      owner_id             TEXT NOT NULL DEFAULT 'default',
      display_name         TEXT NOT NULL,
      project_label        TEXT NOT NULL,
      tool_type            TEXT,
      host_label           TEXT NOT NULL DEFAULT '',
      repo_root            TEXT,
      branch               TEXT,
      worktree             TEXT,
      state_file           TEXT,
      log_file             TEXT,
      status               TEXT NOT NULL DEFAULT 'running',
      permission_mode      TEXT NOT NULL DEFAULT 'manual',
      timeout_seconds      INTEGER NOT NULL DEFAULT 10,
      connection_state     TEXT NOT NULL DEFAULT 'disconnected',
      consecutive_failures INTEGER NOT NULL DEFAULT 0,
      last_error           TEXT,
      next_retry_at        TEXT,
      relay_url            TEXT,
      relay_connected      INTEGER NOT NULL DEFAULT 0,
      relay_last_hello_at  TEXT,
      relay_last_error     TEXT,
      session_history      TEXT NOT NULL DEFAULT '[]',
      auth_connectors      TEXT NOT NULL DEFAULT '[]',
      last_seen_at         TEXT NOT NULL,
      created_at           TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_agents_owner ON agents(owner_id);

    CREATE TABLE IF NOT EXISTS enrollments (
      enrollment_id TEXT PRIMARY KEY,
      owner_id      TEXT NOT NULL DEFAULT 'default',
      code          TEXT UNIQUE NOT NULL,
      display_name  TEXT NOT NULL,
      project_label TEXT NOT NULL,
      tool_type     TEXT,
      relay_url     TEXT,
      relay_token   TEXT,
      consumed_at   TEXT,
      revoked_at    TEXT,
      expires_at    TEXT NOT NULL,
      created_at    TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS jobs (
      job_id                  TEXT PRIMARY KEY,
      agent_id                TEXT NOT NULL,
      owner_id                TEXT NOT NULL DEFAULT 'default',
      provider                TEXT NOT NULL DEFAULT 'other',
      title                   TEXT NOT NULL DEFAULT '',
      command                 TEXT NOT NULL DEFAULT '[]',
      cwd                     TEXT,
      env                     TEXT,
      model                   TEXT,
      reasoning_effort        TEXT,
      status                  TEXT NOT NULL DEFAULT 'queued',
      error                   TEXT,
      ralph_enabled           INTEGER NOT NULL DEFAULT 0,
      auto_resume_usage_limit INTEGER NOT NULL DEFAULT 0,
      auto_restart_codex      INTEGER NOT NULL DEFAULT 0,
      auto_resume_attempts    INTEGER NOT NULL DEFAULT 0,
      auto_restart_attempts   INTEGER NOT NULL DEFAULT 0,
      next_resume_at          TEXT,
      restart_required_at     TEXT,
      restarted_as_job_id     TEXT,
      continued_as_job_id     TEXT,
      parent_job_id           TEXT,
      codex_session_id        TEXT,
      tmux_session            TEXT,
      exit_code               INTEGER,
      pid                     INTEGER,
      log_file                TEXT,
      log_tail                TEXT,
      provider_state          TEXT,
      handoff                 TEXT,
      artifacts_dir           TEXT,
      archived_at             TEXT,
      started_at              TEXT,
      completed_at            TEXT,
      created_at              TEXT NOT NULL,
      updated_at              TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_jobs_agent  ON jobs(agent_id);
    CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status);

    CREATE TABLE IF NOT EXISTS approval_requests (
      request_id     TEXT PRIMARY KEY,
      agent_id       TEXT NOT NULL,
      owner_id       TEXT NOT NULL DEFAULT 'default',
      parent_job_id  TEXT,
      created_job_id TEXT,
      title          TEXT NOT NULL DEFAULT '',
      message        TEXT NOT NULL DEFAULT '',
      risk_level     TEXT NOT NULL DEFAULT 'low',
      command        TEXT,
      action_kind    TEXT,
      event_type     TEXT,
      primary_action TEXT,
      status         TEXT NOT NULL DEFAULT 'open',
      response       TEXT,
      decided_at     TEXT,
      created_at     TEXT NOT NULL,
      updated_at     TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_approvals_agent  ON approval_requests(agent_id);
    CREATE INDEX IF NOT EXISTS idx_approvals_status ON approval_requests(status);

    CREATE TABLE IF NOT EXISTS control_commands (
      command_id   TEXT PRIMARY KEY,
      agent_id     TEXT NOT NULL,
      type         TEXT NOT NULL DEFAULT 'restart_daemon',
      status       TEXT NOT NULL DEFAULT 'pending',
      created_at   TEXT NOT NULL,
      delivered_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_commands_agent ON control_commands(agent_id, status);

    CREATE TABLE IF NOT EXISTS removed_agents (
      agent_id   TEXT PRIMARY KEY,
      removed_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS removed_jobs (
      job_id     TEXT PRIMARY KEY,
      agent_id   TEXT,
      removed_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS job_inputs (
      input_id   TEXT PRIMARY KEY,
      job_id     TEXT NOT NULL,
      agent_id   TEXT NOT NULL,
      text       TEXT NOT NULL DEFAULT '',
      submit     INTEGER NOT NULL DEFAULT 1,
      key        TEXT,
      status     TEXT NOT NULL DEFAULT 'pending',
      created_at TEXT NOT NULL,
      sent_at    TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_job_inputs_job ON job_inputs(job_id, status);
    CREATE INDEX IF NOT EXISTS idx_job_inputs_agent ON job_inputs(agent_id, status);
  `);
}

/** Bootstrap the default owner row if VI_RELAY_OWNER_TOKEN is configured. */
export function bootstrapOwner(db: Db): void {
  const ownerToken = process.env["VI_RELAY_OWNER_TOKEN"]?.trim();
  if (!ownerToken) return;
  const existing = db.prepare("SELECT owner_id FROM owners WHERE owner_id = 'default'").get();
  if (!existing) {
    db.prepare(
      "INSERT INTO owners (owner_id, name, token, created_at) VALUES ('default', 'owner', ?, ?)",
    ).run(ownerToken, new Date().toISOString());
    console.log("[DB] Default owner bootstrapped from VI_RELAY_OWNER_TOKEN");
  }
}
