import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import type { AgentEndEvent, ExtensionAPI, ExtensionContext, SessionShutdownEvent, SessionStartEvent } from "@earendil-works/pi-coding-agent";

import type { BakerConfig } from "../src/config.ts";
import { BakerRegistry } from "../src/daemon/registry.ts";
import { ControlServer } from "../src/daemon/server.ts";
import { MemberClient } from "../src/member/client.ts";
import { serializeFrame } from "../src/protocol.ts";

test("MemberClient sends goodbye and closes its socket on session shutdown", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-baker-member-"));
  const registry = new BakerRegistry(join(dir, "baker.db"));
  const server = new ControlServer({
    socketPath: join(dir, "baker.sock"),
    registry,
    pingIntervalMs: 60_000,
    staleAfterMs: 120_000,
  });
  await server.start();

  const client = new MemberClient(makePi(), makeConfig(dir));
  try {
    client.onSessionStart({ type: "session_start", reason: "startup" } satisfies SessionStartEvent, makeContext("member-session"));
    await waitFor(() => registry.getSession(1)?.connected === true);
    assert.equal(client.status().connected, true);

    setReconnectDelay(client, 10);
    client.onSessionShutdown({ type: "session_shutdown", reason: "new", targetSessionFile: "/tmp/next.jsonl" } satisfies SessionShutdownEvent);
    await waitFor(() => registry.getSession(1)?.connected === false);
    assert.equal(client.status().connected, false);
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(registry.getSession(1)?.connected, false);

    client.onSessionStart({ type: "session_start", reason: "startup" } satisfies SessionStartEvent, makeContext("member-session-next"));
    await waitFor(() => registry.getSession(1)?.sessionId === "member-session-next" && registry.getSession(1)?.connected === true);
    assert.equal(client.status().connected, true);
  } finally {
    client.disable();
    await server.stop();
    registry.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("MemberClient ignores stale close events from a replaced socket", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-baker-member-stale-close-"));
  const registry = new BakerRegistry(join(dir, "baker.db"));
  const server = new ControlServer({
    socketPath: join(dir, "baker.sock"),
    registry,
    pingIntervalMs: 60_000,
    staleAfterMs: 120_000,
  });
  await server.start();

  const client = new MemberClient(makePi(), makeConfig(dir));
  try {
    client.onSessionStart({ type: "session_start", reason: "startup" } satisfies SessionStartEvent, makeContext("member-session"));
    await waitFor(() => registry.getSession(1)?.connected === true);
    const oldSocket = getClientSocket(client);
    assert.ok(oldSocket);

    client.onSessionShutdown({ type: "session_shutdown", reason: "new", targetSessionFile: "/tmp/next.jsonl" } satisfies SessionShutdownEvent);
    client.onSessionStart({ type: "session_start", reason: "startup" } satisfies SessionStartEvent, makeContext("member-session-next"));
    await waitFor(() => client.status().sessionId === "member-session-next" && client.status().connected && client.status().shortId === 1);

    oldSocket.emit("close");
    await new Promise((resolve) => setTimeout(resolve, 20));

    assert.equal(client.status().connected, true);
    assert.equal(client.status().shortId, 1);
    assert.equal(client.status().sessionId, "member-session-next");
  } finally {
    client.disable();
    await server.stop();
    registry.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("MemberClient ignores stale data frames from a replaced socket", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-baker-member-stale-data-"));
  const registry = new BakerRegistry(join(dir, "baker.db"));
  const server = new ControlServer({
    socketPath: join(dir, "baker.sock"),
    registry,
    pingIntervalMs: 60_000,
    staleAfterMs: 120_000,
  });
  await server.start();

  const prompts: Array<{ text: string; deliverAs: string }> = [];
  const client = new MemberClient(makePi(prompts), makeConfig(dir));
  try {
    client.onSessionStart({ type: "session_start", reason: "startup" } satisfies SessionStartEvent, makeContext("member-session"));
    await waitFor(() => registry.getSession(1)?.connected === true);
    const oldSocket = getClientSocket(client);
    assert.ok(oldSocket);

    client.onSessionShutdown({ type: "session_shutdown", reason: "new", targetSessionFile: "/tmp/next.jsonl" } satisfies SessionShutdownEvent);
    client.onSessionStart({ type: "session_start", reason: "startup" } satisfies SessionStartEvent, makeContext("member-session-next"));
    await waitFor(() => client.status().sessionId === "member-session-next" && client.status().connected && client.status().shortId === 1);
    const currentSocket = getClientSocket(client);
    assert.ok(currentSocket);
    assert.notEqual(currentSocket, oldSocket);

    oldSocket.emit("data", Buffer.from(serializeFrame({ v: 1, type: "prompt", id: "stale", text: "old prompt", deliverAs: "followUp" })));
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.deepEqual(prompts, []);

    currentSocket.emit("data", Buffer.from(serializeFrame({ v: 1, type: "prompt", id: "current", text: "new prompt", deliverAs: "steer" })));
    await waitFor(() => prompts.length === 1);
    assert.deepEqual(prompts, [{ text: "new prompt", deliverAs: "steer" }]);
  } finally {
    client.disable();
    await server.stop();
    registry.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("MemberClient reports async prompt delivery failures", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-baker-member-async-prompt-"));
  const registry = new BakerRegistry(join(dir, "baker.db"));
  const server = new ControlServer({
    socketPath: join(dir, "baker.sock"),
    registry,
    pingIntervalMs: 60_000,
    staleAfterMs: 120_000,
  });
  await server.start();

  const client = new MemberClient(
    makePi([], {
      sendUserMessage() {
        return Promise.reject(new Error("async prompt delivery failed"));
      },
    }),
    makeConfig(dir),
  );
  try {
    client.onSessionStart({ type: "session_start", reason: "startup" } satisfies SessionStartEvent, makeContext("member-session"));
    await waitFor(() => registry.getSession(1)?.connected === true);

    await assert.rejects(() => server.prompt(1, "new prompt", "followUp"), /async prompt delivery failed/);
  } finally {
    client.disable();
    await server.stop();
    registry.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("MemberClient reports abort failures", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-baker-member-abort-failure-"));
  const registry = new BakerRegistry(join(dir, "baker.db"));
  const server = new ControlServer({
    socketPath: join(dir, "baker.sock"),
    registry,
    pingIntervalMs: 60_000,
    staleAfterMs: 120_000,
  });
  await server.start();

  const client = new MemberClient(makePi(), makeConfig(dir));
  try {
    client.onSessionStart(
      { type: "session_start", reason: "startup" } satisfies SessionStartEvent,
      makeContext("member-session", [], {
        abort() {
          throw new Error("abort failed");
        },
      }),
    );
    await waitFor(() => registry.getSession(1)?.connected === true);

    await assert.rejects(() => server.abort(1), /abort failed/);
  } finally {
    client.disable();
    await server.stop();
    registry.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("MemberClient answers state queries with live session detail", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-baker-member-"));
  const registry = new BakerRegistry(join(dir, "baker.db"));
  const server = new ControlServer({
    socketPath: join(dir, "baker.sock"),
    registry,
    pingIntervalMs: 60_000,
    staleAfterMs: 120_000,
  });
  await server.start();

  const client = new MemberClient(makePi(), makeConfig(dir));
  try {
    client.onSessionStart({ type: "session_start", reason: "startup" } satisfies SessionStartEvent, makeContext("member-session"));
    await waitFor(() => registry.getSession(1)?.connected === true);

    const state = (await server.queryState(1)) as Record<string, unknown>;
    assert.equal(state.connected, true);
    assert.equal(state.shortId, 1);
    assert.equal(state.name, "member");
    assert.equal(state.cwd, "/tmp/project");
    assert.equal(state.sessionId, "member-session");
    assert.equal(state.sessionFile, "/tmp/member-session.jsonl");
    assert.equal(state.sessionName, "member");
    assert.equal(state.state, "idle");
    assert.equal(state.model, undefined);
    assert.equal(state.spawned, false);
    assert.equal(typeof state.pid, "number");
    assert.equal(typeof state.extensionVersion, "string");
  } finally {
    client.disable();
    await server.stop();
    registry.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("MemberClient reports current context model on agent start and end", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-baker-member-model-state-"));
  const registry = new BakerRegistry(join(dir, "baker.db"));
  const server = new ControlServer({
    socketPath: join(dir, "baker.sock"),
    registry,
    pingIntervalMs: 60_000,
    staleAfterMs: 120_000,
  });
  await server.start();

  const client = new MemberClient(makePi(), makeConfig(dir));
  try {
    client.onSessionStart(
      { type: "session_start", reason: "startup" } satisfies SessionStartEvent,
      makeContext("member-session", [], { model: { provider: "provider", id: "old-model" } }),
    );
    await waitFor(() => registry.getSession(1)?.model === "provider/old-model");

    client.onAgentStart(makeContext("member-session", [], { idle: false, model: { provider: "provider", id: "busy-model" } }));
    await waitFor(() => registry.getSession(1)?.state === "busy" && registry.getSession(1)?.model === "provider/busy-model");

    client.onAgentEnd(
      { type: "agent_end", messages: [{ role: "assistant", content: [{ type: "text", text: "done" }] }] } as unknown as AgentEndEvent,
      makeContext("member-session", [], { model: { provider: "provider", id: "done-model" } }),
    );
    await waitFor(() => registry.getSession(1)?.state === "idle" && registry.getSession(1)?.model === "provider/done-model");
    assert.equal(registry.getSession(1)?.lastTurn, "done");
  } finally {
    client.disable();
    await server.stop();
    registry.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("MemberClient ignores notify frames for spawned headless sessions", async () => {
  const tuiNotifications: string[] = [];
  const spawnedNotifications: string[] = [];
  const tui = await startMemberHarness("tui-session", false, tuiNotifications);
  try {
    tui.server.notify(1, "visible notice");
    await waitFor(() => tuiNotifications.length === 1);
    assert.deepEqual(tuiNotifications, ["visible notice"]);
  } finally {
    await tui.cleanup();
  }

  const spawned = await startMemberHarness("spawned-session", true, spawnedNotifications);
  try {
    spawned.server.notify(1, "headless notice");
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.deepEqual(spawnedNotifications, []);
  } finally {
    await spawned.cleanup();
  }
});

test("MemberClient discards partial frames before reconnecting", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-baker-member-partial-"));
  const socketPath = join(dir, "baker.sock");
  const sockets: Socket[] = [];
  let connectionCount = 0;
  const server = createServer((socket) => {
    sockets.push(socket);
    connectionCount += 1;
    if (connectionCount === 1) {
      socket.write('{"v":1,"type":"notify","text":"partial');
      socket.destroy();
      return;
    }

    socket.once("data", () => {
      socket.write('{"v":1,"type":"hello_ack","shortId":7,"name":"reconnected","daemonPid":1234}\n');
    });
  });

  await listen(server, socketPath);
  const client = new MemberClient(makePi(), makeConfig(dir));
  setReconnectDelay(client, 10);
  try {
    client.onSessionStart({ type: "session_start", reason: "startup" } satisfies SessionStartEvent, makeContext("member-session"));

    await waitFor(() => client.status().shortId === 7);
    assert.equal(client.status().name, "reconnected");
    assert.equal(client.status().daemonPid, 1234);
    assert.ok(connectionCount >= 2);
  } finally {
    client.disable();
    for (const socket of sockets) {
      socket.destroy();
    }
    await closeServer(server);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("MemberClient logs daemon unavailability once while reconnecting", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-baker-member-unavailable-"));
  const logs: string[] = [];
  const client = new MemberClient(makePi(), makeConfig(dir), {
    debug(message) {
      logs.push(message);
    },
  });
  setReconnectDelay(client, 10);

  try {
    client.onSessionStart({ type: "session_start", reason: "startup" } satisfies SessionStartEvent, makeContext("member-session"));

    await waitFor(() => logs.length === 1);
    assert.match(logs[0], /daemon unavailable .* retrying in background/);
    await new Promise((resolve) => setTimeout(resolve, 80));
    assert.equal(logs.length, 1);
    assert.equal(client.status().connected, false);
  } finally {
    client.disable();
    rmSync(dir, { recursive: true, force: true });
  }
});

function makeConfig(dir: string, overrides: Partial<BakerConfig> = {}): BakerConfig {
  return {
    role: "member",
    bakerDir: dir,
    socketPath: join(dir, "baker.sock"),
    dbPath: join(dir, "baker.db"),
    signalAccount: undefined,
    whitelist: new Set(),
    signalUrl: "http://127.0.0.1:51921",
    manageSignal: false,
    storeTurns: true,
    quiet: true,
    spawned: false,
    ...overrides,
  };
}

function makePi(
  prompts: Array<{ text: string; deliverAs: string }> = [],
  overrides: {
    sendUserMessage?: (text: string, options: { deliverAs: string }) => void | Promise<void>;
  } = {},
): ExtensionAPI {
  let sessionName: string | undefined;
  return {
    sendUserMessage(text: string, options: { deliverAs: string }) {
      if (overrides.sendUserMessage !== undefined) {
        return overrides.sendUserMessage(text, options);
      }
      prompts.push({ text, deliverAs: options.deliverAs });
    },
    setSessionName(name: string) {
      sessionName = name;
    },
    getSessionName() {
      return sessionName;
    },
  } as unknown as ExtensionAPI;
}

async function startMemberHarness(
  sessionId: string,
  spawned: boolean,
  notifications: string[],
): Promise<{
  server: ControlServer;
  cleanup: () => Promise<void>;
}> {
  const dir = mkdtempSync(join(tmpdir(), "pi-baker-member-notify-"));
  const registry = new BakerRegistry(join(dir, "baker.db"));
  const server = new ControlServer({
    socketPath: join(dir, "baker.sock"),
    registry,
    pingIntervalMs: 60_000,
    staleAfterMs: 120_000,
  });
  await server.start();
  const client = new MemberClient(makePi(), makeConfig(dir, { spawned }));
  client.onSessionStart(
    { type: "session_start", reason: "startup" } satisfies SessionStartEvent,
    makeContext(sessionId, notifications),
  );
  await waitFor(() => registry.getSession(1)?.connected === true);

  return {
    server,
    cleanup: async () => {
      client.disable();
      await server.stop();
      registry.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

function makeContext(
  sessionId: string,
  notifications: string[] = [],
  overrides: {
    abort?: () => void;
    idle?: boolean;
    model?: { provider: string; id: string };
  } = {},
): ExtensionContext {
  return {
    cwd: "/tmp/project",
    model: overrides.model === undefined ? undefined : { ...overrides.model, name: overrides.model.id },
    isIdle: () => overrides.idle ?? true,
    sessionManager: {
      getSessionId: () => sessionId,
      getSessionFile: () => `/tmp/${sessionId}.jsonl`,
      getSessionName: () => "member",
    },
    ui: {
      notify(message: string) {
        notifications.push(message);
      },
    },
    abort: overrides.abort ?? (() => {}),
  } as unknown as ExtensionContext;
}

function setReconnectDelay(client: MemberClient, delayMs: number): void {
  (client as unknown as { reconnectDelayMs: number }).reconnectDelayMs = delayMs;
}

function getClientSocket(client: MemberClient): Socket | undefined {
  return (client as unknown as { socket: Socket | undefined }).socket;
}

async function waitFor(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.ok(predicate(), "timed out waiting for condition");
}

async function listen(server: Server, socketPath: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => {
      server.off("error", reject);
      resolve();
    });
  });
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => server.close((error) => (error === undefined ? resolve() : reject(error))));
}
