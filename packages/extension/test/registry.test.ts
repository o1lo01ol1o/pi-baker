import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";

import { BakerRegistry, type RegistryOptions, truncateText } from "../src/daemon/registry.ts";
import type { HelloFrame } from "../src/protocol.ts";

test("registry keeps short id stable for repeated hello and same-pid session replacement", () => {
  const { registry, cleanup } = makeRegistry();
  try {
    const first = registry.upsertHello(makeHello("session-a", 111), "member");
    const repeated = registry.upsertHello(makeHello("session-a", 111), "member");
    const replaced = registry.upsertHello(makeHello("session-b", 111), "member");

    assert.equal(first.shortId, repeated.shortId);
    assert.equal(first.shortId, replaced.shortId);
    assert.equal(replaced.sessionId, "session-b");
  } finally {
    registry.close();
    cleanup();
  }
});

test("registry reuses disconnected rows by session id and recent pid, but not by stale pid", () => {
  let now = Date.parse("2026-07-13T00:00:00.000Z");
  const advance = (ms: number) => {
    now += ms;
  };
  const { registry, cleanup } = makeRegistry({
    pidCorrelationGraceMs: 1_000,
    now: () => new Date(now),
  });
  try {
    const first = registry.upsertHello(makeHello("session-a", 111), "member");
    registry.markDisconnected(first.shortId);

    advance(100);
    const resumed = registry.upsertHello(makeHello("session-a", 222), "member");
    registry.markDisconnected(resumed.shortId);

    advance(100);
    const recentPid = registry.upsertHello(makeHello("session-b", 222), "member");
    registry.markDisconnected(recentPid.shortId);

    advance(1_500);
    const stalePid = registry.upsertHello(makeHello("session-c", 222), "member");

    assert.equal(resumed.shortId, first.shortId);
    assert.equal(recentPid.shortId, first.shortId);
    assert.notEqual(stalePid.shortId, first.shortId);
    assert.equal(stalePid.shortId, first.shortId + 1);
  } finally {
    registry.close();
    cleanup();
  }
});

test("registry startup disconnect marking does not refresh stale pid correlation", () => {
  let now = Date.parse("2026-07-13T00:00:00.000Z");
  const advance = (ms: number) => {
    now += ms;
  };
  const { registry, cleanup } = makeRegistry({
    pidCorrelationGraceMs: 1_000,
    now: () => new Date(now),
  });
  try {
    const first = registry.upsertHello(makeHello("session-a", 111), "member");
    const firstLastSeen = first.lastSeen;

    advance(2_000);
    registry.markAllDisconnected();
    const startupMarked = registry.getSession(first.shortId);
    const next = registry.upsertHello(makeHello("session-b", 111), "member");

    assert.equal(startupMarked?.lastSeen, firstLastSeen);
    assert.notEqual(next.shortId, first.shortId);
  } finally {
    registry.close();
    cleanup();
  }
});

test("registry graceful disconnect marking timestamps observed shutdown", () => {
  let now = Date.parse("2026-07-13T00:00:00.000Z");
  const { registry, cleanup } = makeRegistry({
    now: () => new Date(now),
  });
  try {
    const first = registry.upsertHello(makeHello("session-a", 111), "member");

    now += 2_000;
    registry.markAllDisconnected({ updateLastSeen: true });
    const disconnected = registry.getSession(first.shortId);

    assert.notEqual(disconnected?.lastSeen, first.lastSeen);
    assert.equal(disconnected?.lastSeen, new Date(now).toISOString());
  } finally {
    registry.close();
    cleanup();
  }
});

test("registry reserves short id zero for daemon", () => {
  const { registry, cleanup } = makeRegistry();
  try {
    const daemon = registry.upsertDaemon(makeHello("daemon-a", 222));
    const member = registry.upsertHello(makeHello("member-a", 333), "member");

    assert.equal(daemon.shortId, 0);
    assert.equal(member.shortId, 1);
  } finally {
    registry.close();
    cleanup();
  }
});

test("registry caps audit events", () => {
  const { registry, cleanup } = makeRegistry(3);
  try {
    const session = registry.upsertHello(makeHello("session-a", 111), "member");
    for (let index = 0; index < 10; index += 1) {
      registry.recordEvent(session.shortId, "command", { index });
    }
    assert.equal(registry.countEvents(), 3);
  } finally {
    registry.close();
    cleanup();
  }
});

test("registry stores watch recipients while keeping the session watch summary", () => {
  const { registry, cleanup } = makeRegistry();
  try {
    const session = registry.upsertHello(makeHello("session-a", 111), "member");

    registry.setWatchTarget(session.shortId, "+15550001", true);
    registry.setWatchTarget(session.shortId, "+15550002", true);
    assert.equal(registry.getSession(session.shortId)?.watch, true);
    assert.deepEqual(registry.listWatchTargets(), [
      { shortId: session.shortId, recipient: "+15550001" },
      { shortId: session.shortId, recipient: "+15550002" },
    ]);

    registry.setWatchTarget(session.shortId, "+15550001", false);
    assert.equal(registry.getSession(session.shortId)?.watch, true);
    assert.deepEqual(registry.listWatchTargets(), [{ shortId: session.shortId, recipient: "+15550002" }]);

    registry.setWatchTarget(session.shortId, "+15550002", false);
    assert.equal(registry.getSession(session.shortId)?.watch, false);
    assert.deepEqual(registry.listWatchTargets(), []);

    registry.replaceWatchTargets(session.shortId, ["+15550004", "  +15550001  ", "+15550004", " "]);
    assert.equal(registry.getSession(session.shortId)?.watch, true);
    assert.deepEqual(registry.listWatchTargets(), [
      { shortId: session.shortId, recipient: "+15550001" },
      { shortId: session.shortId, recipient: "+15550004" },
    ]);

    registry.replaceWatchTargets(session.shortId, []);
    assert.equal(registry.getSession(session.shortId)?.watch, false);
    assert.deepEqual(registry.listWatchTargets(), []);

    registry.setWatchTarget(session.shortId, "+15550003", true);
    registry.setWatch(session.shortId, false);
    assert.equal(registry.getSession(session.shortId)?.watch, false);
    assert.deepEqual(registry.listWatchTargets(), []);
  } finally {
    registry.close();
    cleanup();
  }
});

test("registry migrates older database schemas in place", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-baker-registry-old-schema-"));
  const dbPath = join(dir, "baker.db");
  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE sessions (
      short_id   INTEGER PRIMARY KEY,
      session_id TEXT NOT NULL UNIQUE,
      name       TEXT,
      cwd        TEXT NOT NULL,
      kind       TEXT NOT NULL,
      state      TEXT NOT NULL DEFAULT 'unknown',
      connected  INTEGER NOT NULL DEFAULT 0,
      first_seen TEXT NOT NULL,
      last_seen  TEXT NOT NULL
    );

    CREATE TABLE events (
      id       INTEGER PRIMARY KEY,
      short_id INTEGER REFERENCES sessions(short_id),
      ts       TEXT NOT NULL,
      type     TEXT NOT NULL
    );

    INSERT INTO sessions (short_id, session_id, name, cwd, kind, state, connected, first_seen, last_seen)
    VALUES (1, 'session-a', 'old-worker', '/tmp/old-worker', 'member', 'idle', 1, '2026-07-13T00:00:00.000Z', '2026-07-13T00:00:00.000Z');

    INSERT INTO events (short_id, ts, type)
    VALUES (1, '2026-07-13T00:00:00.000Z', 'connect');
  `);
  db.close();

  const registry = new BakerRegistry(dbPath, {
    now: () => new Date("2026-07-14T00:00:00.000Z"),
  });
  try {
    const existing = registry.getSession(1);
    assert.equal(existing?.name, "old-worker");
    assert.equal(existing?.pid, undefined);
    assert.equal(existing?.watch, false);
    assert.equal(existing?.lastTurn, undefined);
    assert.equal(registry.listEvents()[0]?.detail, undefined);

    registry.setWatchTarget(1, "+15550001", true);
    registry.recordTurn(1, "migrated turn");
    registry.recordEvent(1, "command", { command: "status" });
    const updated = registry.upsertHello(
      {
        ...makeHello("session-a", 222),
        sessionFile: "/tmp/session-a.jsonl",
        sessionName: "ignored-existing-name",
      },
      "member",
    );

    assert.equal(updated.shortId, 1);
    assert.equal(updated.name, "old-worker");
    assert.equal(updated.pid, 222);
    assert.equal(updated.sessionFile, "/tmp/session-a.jsonl");
    assert.equal(registry.getSession(1)?.lastTurn, "migrated turn");
    assert.deepEqual(registry.listWatchTargets(), [{ shortId: 1, recipient: "+15550001" }]);
    assert.deepEqual(registry.listEvents().at(-2)?.detail, { command: "status" });
  } finally {
    registry.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("registry redacts message-like audit detail fields", () => {
  const { registry, cleanup } = makeRegistry();
  try {
    const session = registry.upsertHello(makeHello("session-a", 111), "member");
    registry.recordEvent(session.shortId, "command", {
      command: "tell",
      surface: "signal",
      prompt: "do the private thing",
      nested: {
        message: "private message body",
        cwd: "/tmp/project",
      },
      items: [{ text: "private turn" }, { name: "metadata" }],
    });

    const event = registry.listEvents().at(-1);
    assert.deepEqual(event?.detail, {
      command: "tell",
      surface: "signal",
      prompt: "[redacted]",
      nested: {
        message: "[redacted]",
        cwd: "/tmp/project",
      },
      items: [{ text: "[redacted]" }, { name: "metadata" }],
    });
    assert.doesNotMatch(JSON.stringify(registry.listEvents()), /private/);
  } finally {
    registry.close();
    cleanup();
  }
});

test("registry truncates stored turns within the limit with session-specific ask hints", () => {
  const { registry, cleanup } = makeRegistry();
  try {
    const session = registry.upsertHello(makeHello("session-a", 111), "member");
    registry.recordTurn(session.shortId, "x".repeat(3_100));

    const stored = registry.getSession(session.shortId)?.lastTurn;
    assert.equal(stored?.length, 3_000);
    assert.ok(stored?.endsWith("\u2026 (truncated, /ask 1 for last message)"));

    const short = truncateText("x".repeat(100), 60, 12);
    assert.equal(short.length, 60);
    assert.ok(short.endsWith("\u2026 (truncated, /ask 12 for last message)"));
  } finally {
    registry.close();
    cleanup();
  }
});

function makeRegistry(options: RegistryOptions | number = {}): { registry: BakerRegistry; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "pi-baker-registry-"));
  const registryOptions = typeof options === "number" ? { eventLimit: options } : options;
  return {
    registry: new BakerRegistry(join(dir, "baker.db"), registryOptions),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

function makeHello(sessionId: string, pid: number): HelloFrame {
  return {
    v: 1,
    type: "hello",
    sessionId,
    cwd: "/tmp/project",
    pid,
    model: "test/model",
    state: "idle",
    spawned: false,
    extensionVersion: "0.1.0",
  };
}
