import { mkdirSync } from "node:fs";
import { dirname, basename } from "node:path";
import { DatabaseSync } from "node:sqlite";

import type { HelloFrame, SessionKind, SessionState } from "../protocol.ts";

export interface RegistrySession {
  shortId: number;
  sessionId: string;
  sessionFile: string | undefined;
  name: string;
  cwd: string;
  pid: number | undefined;
  kind: SessionKind;
  model: string | undefined;
  state: SessionState;
  connected: boolean;
  watch: boolean;
  lastTurn: string | undefined;
  firstSeen: string;
  lastSeen: string;
}

export interface RegistryOptions {
  storeTurns?: boolean;
  eventLimit?: number;
  pidCorrelationGraceMs?: number;
  now?: () => Date;
}

export interface RegistryEvent {
  id: number;
  shortId: number;
  ts: string;
  type: string;
  detail: unknown;
}

export interface WatchTarget {
  shortId: number;
  recipient: string;
}

type SessionRow = Record<string, unknown>;

export class BakerRegistry {
  private readonly db: DatabaseSync;
  private readonly storeTurns: boolean;
  private readonly eventLimit: number;
  private readonly pidCorrelationGraceMs: number;
  private readonly now: () => Date;

  constructor(dbPath: string, options: RegistryOptions = {}) {
    if (dbPath !== ":memory:") {
      mkdirSync(dirname(dbPath), { recursive: true, mode: 0o700 });
    }

    this.db = new DatabaseSync(dbPath, { timeout: 1_000 });
    this.storeTurns = options.storeTurns ?? true;
    this.eventLimit = options.eventLimit ?? 5_000;
    this.pidCorrelationGraceMs = options.pidCorrelationGraceMs ?? 5 * 60_000;
    this.now = options.now ?? (() => new Date());
    this.migrate();
  }

  close(): void {
    this.db.close();
  }

  markAllDisconnected(options: { updateLastSeen?: boolean } = {}): void {
    if (options.updateLastSeen === true) {
      this.db.prepare("UPDATE sessions SET connected = 0, state = 'unknown', last_seen = ?").run(this.timestamp());
      return;
    }

    this.db.prepare("UPDATE sessions SET connected = 0, state = 'unknown'").run();
  }

  upsertHello(hello: HelloFrame, kind: SessionKind): RegistrySession {
    const ts = this.timestamp();
    const existing = this.findRowBySessionId(hello.sessionId) ?? this.findRowByPid(hello.pid, ts);
    const name = existingName(existing) ?? defaultSessionName(hello.cwd, hello.sessionName);

    if (existing !== undefined) {
      this.db
        .prepare(`
          UPDATE sessions
             SET session_id = :sessionId,
                 session_file = :sessionFile,
                 name = :name,
                 cwd = :cwd,
                 pid = :pid,
                 kind = :kind,
                 model = :model,
                 state = :state,
                 connected = 1,
                 last_seen = :lastSeen
           WHERE short_id = :shortId
        `)
        .run({
          sessionId: hello.sessionId,
          sessionFile: hello.sessionFile ?? null,
          name,
          cwd: hello.cwd,
          pid: hello.pid,
          kind,
          model: hello.model ?? null,
          state: hello.state,
          lastSeen: ts,
          shortId: Number(existing.short_id),
        });
      const row = this.findRowByShortId(Number(existing.short_id));
      if (row === undefined) {
        throw new Error("registry update failed");
      }
      this.recordEvent(Number(existing.short_id), "connect", { kind });
      return rowToSession(row);
    }

    const result = this.db
      .prepare(`
        INSERT INTO sessions
          (session_id, session_file, name, cwd, pid, kind, model, state, connected, watch, first_seen, last_seen)
        VALUES
          (:sessionId, :sessionFile, :name, :cwd, :pid, :kind, :model, :state, 1, 0, :firstSeen, :lastSeen)
      `)
      .run({
        sessionId: hello.sessionId,
        sessionFile: hello.sessionFile ?? null,
        name,
        cwd: hello.cwd,
        pid: hello.pid,
        kind,
        model: hello.model ?? null,
        state: hello.state,
        firstSeen: ts,
        lastSeen: ts,
      });
    const shortId = Number(result.lastInsertRowid);
    this.recordEvent(shortId, "connect", { kind });
    const row = this.findRowByShortId(shortId);
    if (row === undefined) {
      throw new Error("registry insert failed");
    }
    return rowToSession(row);
  }

  upsertDaemon(hello: HelloFrame): RegistrySession {
    const ts = this.timestamp();
    const name = hello.sessionName ?? "daemon";
    this.db
      .prepare(`
        INSERT INTO sessions
          (short_id, session_id, session_file, name, cwd, pid, kind, model, state, connected, watch, first_seen, last_seen)
        VALUES
          (0, :sessionId, :sessionFile, :name, :cwd, :pid, 'daemon', :model, :state, 1, 0, :firstSeen, :lastSeen)
        ON CONFLICT(short_id) DO UPDATE SET
          session_id = excluded.session_id,
          session_file = excluded.session_file,
          name = excluded.name,
          cwd = excluded.cwd,
          pid = excluded.pid,
          kind = 'daemon',
          model = excluded.model,
          state = excluded.state,
          connected = 1,
          last_seen = excluded.last_seen
      `)
      .run({
        sessionId: hello.sessionId,
        sessionFile: hello.sessionFile ?? null,
        name,
        cwd: hello.cwd,
        pid: hello.pid,
        model: hello.model ?? null,
        state: hello.state,
        firstSeen: ts,
        lastSeen: ts,
      });
    this.recordEvent(0, "connect", { kind: "daemon" });
    const row = this.findRowByShortId(0);
    if (row === undefined) {
      throw new Error("daemon registry insert failed");
    }
    return rowToSession(row);
  }

  updateState(shortId: number, state: SessionState, model: string | undefined): void {
    this.db
      .prepare("UPDATE sessions SET state = ?, model = ?, last_seen = ? WHERE short_id = ?")
      .run(state, model ?? null, this.timestamp(), shortId);
  }

  recordTurn(shortId: number, text: string): void {
    const stored = this.storeTurns ? truncateText(text, 3_000, shortId) : null;
    this.db
      .prepare("UPDATE sessions SET state = 'idle', last_turn = ?, last_seen = ? WHERE short_id = ?")
      .run(stored, this.timestamp(), shortId);
  }

  markDisconnected(shortId: number): void {
    this.db
      .prepare("UPDATE sessions SET connected = 0, state = 'unknown', last_seen = ? WHERE short_id = ?")
      .run(this.timestamp(), shortId);
    this.recordEvent(shortId, "disconnect");
  }

  setWatch(shortId: number, watch: boolean): void {
    this.db.prepare("UPDATE sessions SET watch = ? WHERE short_id = ?").run(watch ? 1 : 0, shortId);
    if (!watch) {
      this.db.prepare("DELETE FROM watch_targets WHERE short_id = ?").run(shortId);
    }
  }

  setWatchTarget(shortId: number, recipient: string, watch: boolean): void {
    const cleanRecipient = recipient.trim();
    if (cleanRecipient === "") {
      return;
    }

    if (watch) {
      this.db
        .prepare(
          `
          INSERT INTO watch_targets (short_id, recipient, first_seen, last_seen)
          VALUES (?, ?, ?, ?)
          ON CONFLICT(short_id, recipient) DO UPDATE SET
            last_seen = excluded.last_seen
        `,
        )
        .run(shortId, cleanRecipient, this.timestamp(), this.timestamp());
      this.db.prepare("UPDATE sessions SET watch = 1 WHERE short_id = ?").run(shortId);
      return;
    }

    this.db.prepare("DELETE FROM watch_targets WHERE short_id = ? AND recipient = ?").run(shortId, cleanRecipient);
    const row = this.db.prepare("SELECT count(*) AS count FROM watch_targets WHERE short_id = ?").get(shortId);
    this.db.prepare("UPDATE sessions SET watch = ? WHERE short_id = ?").run(Number(row?.count ?? 0) > 0 ? 1 : 0, shortId);
  }

  replaceWatchTargets(shortId: number, recipients: Iterable<string>): void {
    const cleanRecipients = [...new Set([...recipients].map((recipient) => recipient.trim()).filter((recipient) => recipient !== ""))].sort();
    const ts = this.timestamp();
    this.db.prepare("DELETE FROM watch_targets WHERE short_id = ?").run(shortId);
    const insert = this.db.prepare("INSERT INTO watch_targets (short_id, recipient, first_seen, last_seen) VALUES (?, ?, ?, ?)");
    for (const recipient of cleanRecipients) {
      insert.run(shortId, recipient, ts, ts);
    }
    this.db.prepare("UPDATE sessions SET watch = ? WHERE short_id = ?").run(cleanRecipients.length > 0 ? 1 : 0, shortId);
  }

  listWatchTargets(): WatchTarget[] {
    const rows = this.db.prepare("SELECT short_id, recipient FROM watch_targets ORDER BY short_id ASC, recipient ASC").all();
    return rows.map((row) => ({
      shortId: Number(row.short_id),
      recipient: String(row.recipient),
    }));
  }

  rename(shortId: number, name: string): void {
    this.db.prepare("UPDATE sessions SET name = ? WHERE short_id = ?").run(name, shortId);
  }

  getSession(shortId: number): RegistrySession | undefined {
    const row = this.findRowByShortId(shortId);
    return row === undefined ? undefined : rowToSession(row);
  }

  listSessions(options: { all?: boolean } = {}): RegistrySession[] {
    const rows = this.db
      .prepare(`
        SELECT *
          FROM sessions
         WHERE (:all = 1 OR connected = 1)
         ORDER BY short_id ASC
      `)
      .all({ all: options.all ? 1 : 0 });
    return rows.map(rowToSession);
  }

  countEvents(): number {
    const row = this.db.prepare("SELECT count(*) AS count FROM events").get();
    return Number(row?.count ?? 0);
  }

  listEvents(): RegistryEvent[] {
    const rows = this.db.prepare("SELECT * FROM events ORDER BY id ASC").all();
    return rows.map(rowToEvent);
  }

  recordEvent(shortId: number, type: string, detail?: unknown): void {
    const sanitized = sanitizeEventDetail(detail);
    this.db
      .prepare("INSERT INTO events (short_id, ts, type, detail) VALUES (?, ?, ?, ?)")
      .run(shortId, this.timestamp(), type, sanitized === undefined ? null : JSON.stringify(sanitized));
    this.db
      .prepare("DELETE FROM events WHERE id NOT IN (SELECT id FROM events ORDER BY id DESC LIMIT ?)")
      .run(this.eventLimit);
  }

  private migrate(): void {
    this.db.exec(`
      PRAGMA journal_mode = WAL;

      CREATE TABLE IF NOT EXISTS sessions (
        short_id     INTEGER PRIMARY KEY,
        session_id   TEXT NOT NULL UNIQUE,
        session_file TEXT,
        name         TEXT,
        cwd          TEXT NOT NULL,
        pid          INTEGER,
        kind         TEXT NOT NULL CHECK (kind IN ('daemon','member','spawned')),
        model        TEXT,
        state        TEXT NOT NULL DEFAULT 'unknown',
        connected    INTEGER NOT NULL DEFAULT 0,
        watch        INTEGER NOT NULL DEFAULT 0,
        last_turn    TEXT,
        first_seen   TEXT NOT NULL,
        last_seen    TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS events (
        id         INTEGER PRIMARY KEY,
        short_id   INTEGER REFERENCES sessions(short_id),
        ts         TEXT NOT NULL,
        type       TEXT NOT NULL,
        detail     TEXT
      );
    `);

    this.ensureColumn("sessions", "session_id", "TEXT");
    this.ensureColumn("sessions", "session_file", "TEXT");
    this.ensureColumn("sessions", "name", "TEXT");
    this.ensureColumn("sessions", "cwd", "TEXT NOT NULL DEFAULT ''");
    this.ensureColumn("sessions", "pid", "INTEGER");
    this.ensureColumn("sessions", "kind", "TEXT NOT NULL DEFAULT 'member' CHECK (kind IN ('daemon','member','spawned'))");
    this.ensureColumn("sessions", "model", "TEXT");
    this.ensureColumn("sessions", "state", "TEXT NOT NULL DEFAULT 'unknown'");
    this.ensureColumn("sessions", "connected", "INTEGER NOT NULL DEFAULT 0");
    this.ensureColumn("sessions", "watch", "INTEGER NOT NULL DEFAULT 0");
    this.ensureColumn("sessions", "last_turn", "TEXT");
    this.ensureColumn("sessions", "first_seen", "TEXT NOT NULL DEFAULT ''");
    this.ensureColumn("sessions", "last_seen", "TEXT NOT NULL DEFAULT ''");
    this.ensureColumn("events", "detail", "TEXT");

    this.db.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS sessions_session_id_unique
        ON sessions(session_id)
        WHERE session_id IS NOT NULL;

      CREATE TABLE IF NOT EXISTS watch_targets (
        short_id   INTEGER NOT NULL REFERENCES sessions(short_id) ON DELETE CASCADE,
        recipient  TEXT NOT NULL,
        first_seen TEXT NOT NULL,
        last_seen  TEXT NOT NULL,
        PRIMARY KEY (short_id, recipient)
      );
    `);
  }

  private ensureColumn(table: "sessions" | "events", column: string, definition: string): void {
    const columns = this.db.prepare(`PRAGMA table_info(${table})`).all();
    if (columns.some((row) => row.name === column)) {
      return;
    }
    this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }

  private findRowByShortId(shortId: number): SessionRow | undefined {
    return this.db.prepare("SELECT * FROM sessions WHERE short_id = ?").get(shortId);
  }

  private findRowBySessionId(sessionId: string): SessionRow | undefined {
    return this.db.prepare("SELECT * FROM sessions WHERE session_id = ?").get(sessionId);
  }

  private findRowByPid(pid: number, now: string): SessionRow | undefined {
    const cutoff = new Date(Date.parse(now) - this.pidCorrelationGraceMs).toISOString();
    return this.db
      .prepare(`
        SELECT *
          FROM sessions
         WHERE pid = ?
           AND (connected = 1 OR last_seen >= ?)
         ORDER BY connected DESC, last_seen DESC
         LIMIT 1
      `)
      .get(pid, cutoff);
  }

  private timestamp(): string {
    return this.now().toISOString();
  }
}

function rowToEvent(row: SessionRow): RegistryEvent {
  const detail = nullableString(row.detail);
  return {
    id: Number(row.id),
    shortId: Number(row.short_id),
    ts: String(row.ts),
    type: String(row.type),
    detail: detail === undefined ? undefined : JSON.parse(detail),
  };
}

export function truncateText(text: string, maxLength = 3_000, shortId?: number): string {
  if (text.length <= maxLength) {
    return text;
  }

  const suffix = shortId === undefined ? "\u2026 (truncated, /ask for last message)" : `\u2026 (truncated, /ask ${shortId} for last message)`;
  return truncateWithSuffix(text, maxLength, suffix);
}

function truncateWithSuffix(text: string, maxLength: number, suffix: string): string {
  if (maxLength <= 0) {
    return "";
  }
  if (suffix.length >= maxLength) {
    return suffix.slice(0, maxLength);
  }
  return `${text.slice(0, maxLength - suffix.length)}${suffix}`;
}

function rowToSession(row: SessionRow): RegistrySession {
  return {
    shortId: Number(row.short_id),
    sessionId: String(row.session_id),
    sessionFile: nullableString(row.session_file),
    name: nullableString(row.name) ?? `session-${String(row.short_id)}`,
    cwd: String(row.cwd),
    pid: row.pid === null ? undefined : Number(row.pid),
    kind: String(row.kind) as SessionKind,
    model: nullableString(row.model),
    state: String(row.state) as SessionState,
    connected: Number(row.connected) === 1,
    watch: Number(row.watch) === 1,
    lastTurn: nullableString(row.last_turn),
    firstSeen: String(row.first_seen),
    lastSeen: String(row.last_seen),
  };
}

function existingName(row: SessionRow | undefined): string | undefined {
  if (row === undefined) {
    return undefined;
  }
  return nullableString(row.name);
}

function defaultSessionName(cwd: string, sessionName: string | undefined): string {
  const trimmed = sessionName?.trim();
  if (trimmed !== undefined && trimmed.length > 0) {
    return trimmed;
  }

  return basename(cwd) || "session";
}

function nullableString(value: unknown): string | undefined {
  return value === null || value === undefined ? undefined : String(value);
}

const sensitiveDetailKeys = new Set(["arg", "args", "argument", "arguments", "body", "content", "input", "message", "messages", "prompt", "reply", "text", "turn"]);

function sanitizeEventDetail(value: unknown, key?: string, depth = 0): unknown {
  if (key !== undefined && sensitiveDetailKeys.has(key.toLowerCase())) {
    return "[redacted]";
  }
  if (value === undefined || value === null || typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "string") {
    return value;
  }
  if (depth >= 6) {
    return "[redacted]";
  }
  if (Array.isArray(value)) {
    return value.map((entry) => sanitizeEventDetail(entry, undefined, depth + 1));
  }
  if (typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [entryKey, entryValue] of Object.entries(value)) {
      const sanitized = sanitizeEventDetail(entryValue, entryKey, depth + 1);
      if (sanitized !== undefined) {
        result[entryKey] = sanitized;
      }
    }
    return result;
  }
  return String(value);
}
