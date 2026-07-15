import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createConnection, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { BakerRegistry } from "../src/daemon/registry.ts";
import { BakerServices } from "../src/daemon/services.ts";
import { ControlServer } from "../src/daemon/server.ts";
import { FrameLineBuffer, serializeFrame, type ControlFrame, type HelloFrame, type PromptFrame, type QueryFrame, type RenameFrame } from "../src/protocol.ts";

test("control server removes dead socket files and creates owner-only sockets", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-baker-server-socket-"));
  const socketPath = join(dir, "baker.sock");
  writeFileSync(socketPath, "");
  const registry = new BakerRegistry(join(dir, "baker.db"));
  const server = new ControlServer({
    socketPath,
    registry,
    pingIntervalMs: 60_000,
    staleAfterMs: 120_000,
  });

  try {
    await server.start();
    assert.equal(statSync(socketPath).mode & 0o777, 0o600);
  } finally {
    await server.stop().catch(() => undefined);
    registry.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("control server refuses to start when another daemon owns the socket", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-baker-server-live-socket-"));
  const socketPath = join(dir, "baker.sock");
  const owner = createServer((socket) => socket.end());
  await listen(owner, socketPath);
  const registry = new BakerRegistry(join(dir, "baker.db"));
  const server = new ControlServer({ socketPath, registry });

  try {
    await assert.rejects(() => server.start(), /pi-baker daemon already running/);
  } finally {
    await closeServer(owner);
    await server.stop().catch(() => undefined);
    registry.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("control server can retry after listen fails before binding", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-baker-server-retry-listen-"));
  const socketDir = join(dir, "missing");
  const socketPath = join(socketDir, "baker.sock");
  const registry = new BakerRegistry(join(dir, "baker.db"));
  const server = new ControlServer({
    socketPath,
    registry,
    pingIntervalMs: 60_000,
    staleAfterMs: 120_000,
  });

  try {
    await assert.rejects(() => server.start(), /ENOENT|EACCES/);
    assert.equal(server.status().listening, false);

    mkdirSync(socketDir);
    await server.start();
    assert.equal(server.status().listening, true);
    assert.equal(statSync(socketPath).mode & 0o777, 0o600);
  } finally {
    await server.stop().catch(() => undefined);
    registry.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("control server registers a fake member and can send a prompt", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-baker-server-"));
  const registry = new BakerRegistry(join(dir, "baker.db"));
  const server = new ControlServer({
    socketPath: join(dir, "baker.sock"),
    registry,
    pingIntervalMs: 60_000,
    staleAfterMs: 120_000,
  });

  await server.start();
  try {
    const services = new BakerServices(registry, server);
    const fake = await connectFakeMember(join(dir, "baker.sock"));
    fake.send(makeHello());
    const ack = await fake.next();
    assert.equal(ack.type, "hello_ack");
    assert.equal(ack.shortId, 1);

    const sessions = registry.listSessions();
    assert.equal(sessions.length, 1);
    assert.equal(sessions[0]?.name, "fake-member");

    const promptPromise = server.prompt(1, "hello member", "followUp");
    const prompt = await fake.next();
    assert.equal(prompt.type, "prompt");
    assert.equal((prompt as PromptFrame).text, "hello member");
    fake.send({ v: 1, type: "result", id: (prompt as PromptFrame).id, ok: true });
    await promptPromise;

    const renamePromise = services.rename("1", "renamed-member");
    const rename = await fake.next();
    assert.equal(rename.type, "rename");
    assert.equal((rename as RenameFrame).name, "renamed-member");
    fake.send({ v: 1, type: "result", id: (rename as RenameFrame).id, ok: true, data: { name: "actual-member" } });
    assert.equal((await renamePromise).name, "actual-member");
    assert.equal(registry.getSession(1)?.name, "actual-member");

    fake.send({ v: 1, type: "turn", text: "done" });
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(server.getLastTurn(1), "done");
    assert.equal(registry.getSession(1)?.lastTurn, "done");

    fake.close();
  } finally {
    await server.stop();
    registry.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("waited prompts cancel their turn waiter when prompt delivery is rejected", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-baker-server-reject-"));
  const registry = new BakerRegistry(join(dir, "baker.db"));
  const server = new ControlServer({
    socketPath: join(dir, "baker.sock"),
    registry,
    pingIntervalMs: 60_000,
    staleAfterMs: 120_000,
  });
  const services = new BakerServices(registry, server);

  await server.start();
  try {
    const fake = await connectFakeMember(join(dir, "baker.sock"));
    fake.send(makeHello());
    await fake.next();

    const rejected = services.sendPrompt("1", "hello member", "followUp", { wait: true, timeoutSec: 60 });
    const prompt = await fake.next();
    assert.equal(prompt.type, "prompt");
    fake.send({ v: 1, type: "result", id: (prompt as PromptFrame).id, ok: false, error: "member refused" });

    await assert.rejects(() => rejected, /member refused/);
    assert.equal(server.pendingTurnWaiterCount(1), 0);

    fake.send({ v: 1, type: "turn", text: "late turn" });
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(server.pendingTurnWaiterCount(1), 0);

    fake.close();
  } finally {
    await server.stop();
    registry.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("control server ignores stale frames from a superseded member connection", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-baker-server-supersede-"));
  const registry = new BakerRegistry(join(dir, "baker.db"));
  const server = new ControlServer({
    socketPath: join(dir, "baker.sock"),
    registry,
    pingIntervalMs: 60_000,
    staleAfterMs: 120_000,
  });

  await server.start();
  try {
    const first = await connectFakeMember(join(dir, "baker.sock"));
    first.send(makeHello("same-session", "fake-member", 456));
    const firstAck = await first.next();
    assert.equal(firstAck.type, "hello_ack");
    assert.equal(firstAck.shortId, 1);

    const second = await connectFakeMember(join(dir, "baker.sock"));
    second.send(makeHello("same-session", "fake-member", 456));
    const secondAck = await second.next();
    assert.equal(secondAck.type, "hello_ack");
    assert.equal(secondAck.shortId, 1);

    first.send({ v: 1, type: "turn", text: "stale turn" });
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(server.getLastTurn(1), undefined);

    second.send({ v: 1, type: "turn", text: "fresh turn" });
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(server.getLastTurn(1), "fresh turn");

    first.close();
    second.close();
  } finally {
    await server.stop();
    registry.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("waited prompts reject when the member disconnects before the next turn", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-baker-server-disconnect-"));
  const registry = new BakerRegistry(join(dir, "baker.db"));
  const server = new ControlServer({
    socketPath: join(dir, "baker.sock"),
    registry,
    pingIntervalMs: 60_000,
    staleAfterMs: 120_000,
  });
  const services = new BakerServices(registry, server);
  const disconnects: Array<{ shortId: number; name: string | undefined; reason: string }> = [];
  server.onDisconnect((event) => disconnects.push(event));

  await server.start();
  try {
    const fake = await connectFakeMember(join(dir, "baker.sock"));
    fake.send(makeHello());
    await fake.next();

    const waited = services.sendPrompt("1", "hello member", "followUp", { wait: true, timeoutSec: 60 });
    const prompt = await fake.next();
    assert.equal(prompt.type, "prompt");
    fake.send({ v: 1, type: "result", id: (prompt as PromptFrame).id, ok: true });

    fake.close();
    await assert.rejects(() => waited, /session #1 disconnected/);
    await waitFor(() => disconnects.length === 1);
    assert.deepEqual(disconnects[0], {
      shortId: 1,
      name: "fake-member",
      reason: "session #1 disconnected",
    });
    assert.equal(server.pendingTurnWaiterCount(1), 0);
  } finally {
    await server.stop();
    registry.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("service liveStatus merges live query data with registry detail", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-baker-server-status-"));
  const registry = new BakerRegistry(join(dir, "baker.db"));
  const server = new ControlServer({
    socketPath: join(dir, "baker.sock"),
    registry,
    pingIntervalMs: 60_000,
    staleAfterMs: 120_000,
  });
  const services = new BakerServices(registry, server);

  await server.start();
  try {
    const fake = await connectFakeMember(join(dir, "baker.sock"));
    fake.send(makeHello());
    await fake.next();
    registry.setWatch(1, true);
    registry.recordTurn(1, "last assistant turn");

    const statusPromise = services.liveStatus("1");
    const query = await fake.next();
    assert.equal(query.type, "query");
    assert.equal((query as QueryFrame).what, "state");
    fake.send({
      v: 1,
      type: "result",
      id: (query as QueryFrame).id,
      ok: true,
      data: {
        connected: true,
        state: "busy",
        cwd: "/tmp/live-project",
        model: "provider/live-model",
        pid: 789,
        sessionId: "fake-session",
        sessionFile: "/tmp/fake-session.jsonl",
        sessionName: "fake-member",
        extensionVersion: "0.1.0",
        socketPath: join(dir, "baker.sock"),
      },
    });

    const status = await statusPromise;
    assert.equal(status.kind, "member");
    assert.equal(status.watch, true);
    assert.equal(status.lastTurn, "last assistant turn");
    assert.equal(status.lastTurnSummary, "last assistant turn");
    assert.equal(status.state, "busy");
    assert.equal(status.cwd, "/tmp/live-project");
    assert.equal(status.model, "provider/live-model");
    assert.equal(status.pid, 789);
    assert.equal(status.sessionFile, "/tmp/fake-session.jsonl");
    assert.equal(status.extensionVersion, "0.1.0");
    assert.equal((status.live as Record<string, unknown>).sessionName, "fake-member");

    const textPromise = services.liveStatusText("1");
    const textQuery = await fake.next();
    assert.equal(textQuery.type, "query");
    fake.send({
      v: 1,
      type: "result",
      id: (textQuery as QueryFrame).id,
      ok: true,
      data: {
        connected: true,
        state: "busy",
        cwd: "/tmp/live-project",
        model: "provider/live-model",
        pid: 789,
        sessionId: "fake-session",
        sessionFile: "/tmp/fake-session.jsonl",
        sessionName: "fake-member",
        extensionVersion: "0.1.0",
      },
    });
    const text = await textPromise;
    assert.match(text, /state: busy/);
    assert.match(text, /watch: on/);
    assert.match(text, /last turn: last assistant turn/);
    assert.match(text, /extension: 0\.1\.0/);

    fake.close();
  } finally {
    await server.stop();
    registry.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("control server marks members disconnected when liveness pongs stop", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-baker-server-liveness-"));
  const registry = new BakerRegistry(join(dir, "baker.db"));
  const server = new ControlServer({
    socketPath: join(dir, "baker.sock"),
    registry,
    pingIntervalMs: 20,
    staleAfterMs: 100,
  });

  await server.start();
  try {
    const fake = await connectFakeMember(join(dir, "baker.sock"));
    fake.send(makeHello());
    await fake.next();
    await waitFor(() => registry.getSession(1)?.connected === true);

    await waitFor(() => registry.getSession(1)?.connected === false);
    assert.equal(server.status().connectedMembers, 0);
    fake.close();
  } finally {
    await server.stop();
    registry.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("control server can broadcast a shutdown notify to all connected members", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-baker-server-notify-"));
  const registry = new BakerRegistry(join(dir, "baker.db"));
  const server = new ControlServer({
    socketPath: join(dir, "baker.sock"),
    registry,
    pingIntervalMs: 60_000,
    staleAfterMs: 120_000,
  });

  await server.start();
  try {
    const first = await connectFakeMember(join(dir, "baker.sock"));
    const second = await connectFakeMember(join(dir, "baker.sock"));
    first.send(makeHello("fake-session-1", "fake-member-1", 456));
    second.send(makeHello("fake-session-2", "fake-member-2", 457));
    await first.next();
    await second.next();

    server.notifyAll("pi-baker daemon shutting down");

    const firstNotify = await first.next();
    const secondNotify = await second.next();
    assert.equal(firstNotify.type, "notify");
    assert.equal(secondNotify.type, "notify");
    assert.equal(firstNotify.text, "pi-baker daemon shutting down");
    assert.equal(secondNotify.text, "pi-baker daemon shutting down");

    first.close();
    second.close();
  } finally {
    await server.stop({ notify: false });
    registry.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

async function connectFakeMember(socketPath: string): Promise<{
  send: (frame: ControlFrame) => void;
  next: () => Promise<ControlFrame>;
  close: () => void;
}> {
  const socket = createConnection(socketPath);
  const decoder = new FrameLineBuffer();
  const frames: ControlFrame[] = [];
  const waiters: Array<(frame: ControlFrame) => void> = [];

  socket.on("data", (chunk) => {
    for (const parsed of decoder.push(chunk)) {
      if (parsed.kind !== "frame") {
        continue;
      }
      const waiter = waiters.shift();
      if (waiter === undefined) {
        frames.push(parsed.frame);
      } else {
        waiter(parsed.frame);
      }
    }
  });

  await new Promise<void>((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("error", reject);
  });

  return {
    send: (frame) => socket.write(serializeFrame(frame)),
    next: () => {
      const frame = frames.shift();
      if (frame !== undefined) {
        return Promise.resolve(frame);
      }
      return new Promise((resolve) => waiters.push(resolve));
    },
    close: () => socket.end(),
  };
}

function makeHello(sessionId = "fake-session", sessionName = "fake-member", pid = 456): HelloFrame {
  return {
    v: 1,
    type: "hello",
    sessionId,
    sessionName,
    cwd: "/tmp/project",
    pid,
    state: "idle",
    spawned: false,
    extensionVersion: "0.1.0",
  };
}

async function listen(server: ReturnType<typeof createServer>, socketPath: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => {
      server.off("error", reject);
      resolve();
    });
  });
}

async function closeServer(server: ReturnType<typeof createServer>): Promise<void> {
  await new Promise<void>((resolve, reject) => server.close((error) => (error === undefined ? resolve() : reject(error))));
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
