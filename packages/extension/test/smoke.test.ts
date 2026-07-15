import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server, type ServerResponse } from "node:http";
import { createConnection, createServer as createNetServer, type AddressInfo, type Server as NetServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { BakerRegistry } from "../src/daemon/registry.ts";
import piBakerExtension, { scheduleStartupNotice } from "../src/index.ts";
import { FrameLineBuffer, serializeFrame, type ControlFrame, type HelloFrame } from "../src/protocol.ts";

test("extension loads", () => {
  assert.equal(typeof piBakerExtension, "function");
  assert.doesNotThrow(() => {
    piBakerExtension({
      registerFlag() {},
      getFlag() {
        return false;
      },
      registerCommand() {},
      on() {},
    } as unknown as Parameters<typeof piBakerExtension>[0]);
  });
});

test("daemon role selection waits for Pi to apply extension flags before session_start", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-baker-daemon-deferred-flag-"));
  const fakeSignal = await startFakeSignalCli();
  const previousEnv = snapshotEnv(["PI_BAKER_DIR", "PI_BAKER_MANAGE_SIGNAL", "PI_BAKER_SIGNAL_ACCOUNT", "PI_BAKER_SIGNAL_URL"]);
  const handlers = new Map<string, (...args: any[]) => unknown>();
  const commands = new Map<string, unknown>();
  let flagApplied = false;

  process.env.PI_BAKER_DIR = dir;
  process.env.PI_BAKER_MANAGE_SIGNAL = "false";
  process.env.PI_BAKER_SIGNAL_ACCOUNT = "+15550001";
  process.env.PI_BAKER_SIGNAL_URL = fakeSignal.url;

  try {
    piBakerExtension({
      registerFlag() {},
      getFlag(name: string) {
        return name === "baker-daemon" && flagApplied;
      },
      registerCommand(name: string, options: unknown) {
        commands.set(name, options);
      },
      registerTool() {},
      on(event: string, handler: (...args: any[]) => unknown) {
        handlers.set(event, handler);
      },
      sendUserMessage() {},
      setSessionName() {},
      getSessionName() {
        return "daemon";
      },
    } as unknown as Parameters<typeof piBakerExtension>[0]);

    assert.equal(commands.size, 0);
    flagApplied = true;
    await handlers.get("session_start")?.(
      { type: "session_start", reason: "startup" },
      makeContext("daemon-session", "provider/model", true),
    );

    assert.equal(existsSync(join(dir, "baker.sock")), true);
    assert.equal(commands.has("baker-sessions"), true);
    assert.equal(commands.has("baker-clear"), true);
  } finally {
    await handlers.get("session_shutdown")?.({ type: "session_shutdown", reason: "quit" });
    await fakeSignal.stop();
    restoreEnv(previousEnv);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("startup notice counts sessions connected after daemon socket starts", async () => {
  const registry = new BakerRegistry(":memory:");
  const notices: number[] = [];
  try {
    const timer = scheduleStartupNotice(
      registry,
      {
        async sendStartupNotice(reconnected: number) {
          notices.push(reconnected);
        },
      },
      10,
    );
    assert.ok(timer);
    registry.upsertDaemon(makeHello("daemon", 100, "daemon"));
    registry.upsertHello(makeHello("member-a", 101, "worker-a"), "member");
    registry.upsertHello(makeHello("member-b", 102, "worker-b"), "member");

    await waitFor(() => notices.length === 1);
    assert.deepEqual(notices, [2]);
  } finally {
    registry.close();
  }
});

test("daemon startup rejects missing Signal account before creating a socket", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-baker-daemon-missing-signal-"));
  const previousEnv = snapshotEnv(["PI_BAKER_DIR", "PI_BAKER_MANAGE_SIGNAL", "PI_BAKER_SIGNAL_ACCOUNT", "PI_BAKER_SIGNAL_URL"]);
  const handlers = new Map<string, (...args: any[]) => unknown>();

  process.env.PI_BAKER_DIR = dir;
  process.env.PI_BAKER_MANAGE_SIGNAL = "false";
  delete process.env.PI_BAKER_SIGNAL_ACCOUNT;
  delete process.env.PI_BAKER_SIGNAL_URL;

  try {
    piBakerExtension({
      registerFlag() {},
      getFlag(name: string) {
        return name === "baker-daemon";
      },
      registerCommand() {},
      registerTool() {},
      on(event: string, handler: (...args: any[]) => unknown) {
        handlers.set(event, handler);
      },
    } as unknown as Parameters<typeof piBakerExtension>[0]);

    await assert.rejects(
      async () => {
        await handlers.get("session_start")?.({ type: "session_start", reason: "startup" }, makeContext("daemon-session", "provider/model", true));
      },
      /missing PI_BAKER_SIGNAL_ACCOUNT/,
    );
    assert.equal(existsSync(join(dir, "baker.sock")), false);
  } finally {
    restoreEnv(previousEnv);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("daemon startup checks for an existing daemon before opening the registry", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-baker-daemon-live-socket-"));
  const socketPath = join(dir, "baker.sock");
  const owner = createNetServer((socket) => socket.end());
  await listenUnix(owner, socketPath);
  const fakeSignal = await startFakeSignalCli();
  const previousEnv = snapshotEnv(["PI_BAKER_DIR", "PI_BAKER_MANAGE_SIGNAL", "PI_BAKER_SIGNAL_ACCOUNT", "PI_BAKER_SIGNAL_URL"]);
  const handlers = new Map<string, (...args: any[]) => unknown>();

  process.env.PI_BAKER_DIR = dir;
  process.env.PI_BAKER_MANAGE_SIGNAL = "false";
  process.env.PI_BAKER_SIGNAL_ACCOUNT = "+15550001";
  process.env.PI_BAKER_SIGNAL_URL = fakeSignal.url;

  try {
    piBakerExtension({
      registerFlag() {},
      getFlag(name: string) {
        return name === "baker-daemon";
      },
      registerCommand() {},
      registerTool() {},
      on(event: string, handler: (...args: any[]) => unknown) {
        handlers.set(event, handler);
      },
      sendUserMessage() {},
      setSessionName() {},
      getSessionName() {
        return "daemon";
      },
    } as unknown as Parameters<typeof piBakerExtension>[0]);

    await assert.rejects(
      async () => {
        await handlers.get("session_start")?.({ type: "session_start", reason: "startup" }, makeContext("daemon-session", "provider/model", true));
      },
      /pi-baker daemon already running/,
    );
    assert.equal(existsSync(join(dir, "baker.db")), false);

    await closeNetServer(owner);
    await handlers.get("session_start")?.({ type: "session_start", reason: "startup" }, makeContext("daemon-session", "provider/model", true));

    assert.equal(existsSync(join(dir, "baker.db")), true);
    assert.equal(existsSync(socketPath), true);
  } finally {
    await handlers.get("session_shutdown")?.({ type: "session_shutdown", reason: "quit" });
    await closeNetServer(owner).catch(() => undefined);
    await fakeSignal.stop();
    restoreEnv(previousEnv);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("daemon startup cleans up socket when Signal health verification fails", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-baker-daemon-signal-fail-"));
  const fakeSignal = await startFakeSignalCli({ checkStatus: 503 });
  const previousEnv = snapshotEnv(["PI_BAKER_DIR", "PI_BAKER_MANAGE_SIGNAL", "PI_BAKER_SIGNAL_ACCOUNT", "PI_BAKER_SIGNAL_URL"]);
  const handlers = new Map<string, (...args: any[]) => unknown>();

  process.env.PI_BAKER_DIR = dir;
  process.env.PI_BAKER_MANAGE_SIGNAL = "false";
  process.env.PI_BAKER_SIGNAL_ACCOUNT = "+15550001";
  process.env.PI_BAKER_SIGNAL_URL = fakeSignal.url;

  try {
    piBakerExtension({
      registerFlag() {},
      getFlag(name: string) {
        return name === "baker-daemon";
      },
      registerCommand() {},
      registerTool() {},
      on(event: string, handler: (...args: any[]) => unknown) {
        handlers.set(event, handler);
      },
    } as unknown as Parameters<typeof piBakerExtension>[0]);

    await assert.rejects(
      async () => {
        await handlers.get("session_start")?.({ type: "session_start", reason: "startup" }, makeContext("daemon-session", "provider/model", true));
      },
      /signal-cli health check failed: 503/,
    );
    assert.equal(existsSync(join(dir, "baker.sock")), false);
  } finally {
    await fakeSignal.stop();
    restoreEnv(previousEnv);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("daemon startup failure disconnects members that registered during startup", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-baker-daemon-startup-member-"));
  const healthGate = deferred<void>();
  const fakeSignal = await startFakeSignalCli({ checkStatus: 503, checkDelay: healthGate.promise });
  const previousEnv = snapshotEnv(["PI_BAKER_DIR", "PI_BAKER_MANAGE_SIGNAL", "PI_BAKER_SIGNAL_ACCOUNT", "PI_BAKER_SIGNAL_URL"]);
  const handlers = new Map<string, (...args: any[]) => unknown>();
  let member: Awaited<ReturnType<typeof connectFakeMember>> | undefined;

  process.env.PI_BAKER_DIR = dir;
  process.env.PI_BAKER_MANAGE_SIGNAL = "false";
  process.env.PI_BAKER_SIGNAL_ACCOUNT = "+15550001";
  process.env.PI_BAKER_SIGNAL_URL = fakeSignal.url;

  try {
    piBakerExtension({
      registerFlag() {},
      getFlag(name: string) {
        return name === "baker-daemon";
      },
      registerCommand() {},
      registerTool() {},
      on(event: string, handler: (...args: any[]) => unknown) {
        handlers.set(event, handler);
      },
    } as unknown as Parameters<typeof piBakerExtension>[0]);

    const startup = Promise.resolve(
      handlers.get("session_start")?.({ type: "session_start", reason: "startup" }, makeContext("daemon-session", "provider/model", true)),
    );

    await waitFor(() => existsSync(join(dir, "baker.sock")));
    member = await connectFakeMember(join(dir, "baker.sock"));
    member.send(makeHello("member-during-startup", 101, "worker"));
    const ack = await member.next();
    assert.equal(ack.type, "hello_ack");

    healthGate.resolve();
    await assert.rejects(startup, /signal-cli health check failed: 503/);

    const registry = new BakerRegistry(join(dir, "baker.db"));
    try {
      const row = registry.listSessions({ all: true }).find((session) => session.sessionId === "member-during-startup");
      assert.equal(row?.connected, false);
      assert.equal(registry.getSession(0), undefined);
    } finally {
      registry.close();
    }
  } finally {
    member?.close();
    healthGate.resolve();
    await fakeSignal.stop();
    restoreEnv(previousEnv);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("daemon agent_end with text refreshes self status model and idle state", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-baker-daemon-agent-end-"));
  const fakeSignal = await startFakeSignalCli();
  const previousEnv = snapshotEnv(["PI_BAKER_DIR", "PI_BAKER_MANAGE_SIGNAL", "PI_BAKER_SIGNAL_ACCOUNT", "PI_BAKER_SIGNAL_URL"]);
  const handlers = new Map<string, (...args: any[]) => unknown>();
  const commands = new Map<string, any>();

  process.env.PI_BAKER_DIR = dir;
  process.env.PI_BAKER_MANAGE_SIGNAL = "false";
  process.env.PI_BAKER_SIGNAL_ACCOUNT = "+15550001";
  process.env.PI_BAKER_SIGNAL_URL = fakeSignal.url;

  try {
    piBakerExtension({
      registerFlag() {},
      getFlag(name: string) {
        return name === "baker-daemon";
      },
      registerCommand(name: string, options: unknown) {
        commands.set(name, options);
      },
      registerTool() {},
      on(event: string, handler: (...args: any[]) => unknown) {
        handlers.set(event, handler);
      },
      sendUserMessage() {},
      setSessionName() {},
      getSessionName() {
        return "daemon";
      },
    } as unknown as Parameters<typeof piBakerExtension>[0]);

    await handlers.get("session_start")?.({ type: "session_start", reason: "startup" }, makeContext("daemon-session", "provider/old-model", true));
    await handlers.get("agent_start")?.({ type: "agent_start" }, makeContext("daemon-session", "provider/old-model", false));
    await handlers.get("agent_end")?.(
      {
        type: "agent_end",
        messages: [{ role: "assistant", content: "daemon done" }],
      },
      makeContext("daemon-session", "provider/new-model", true),
    );

    let notification = "";
    await commands.get("baker-status").handler("me", {
      ui: {
        notify(message: string) {
          notification = message;
        },
      },
    });

    assert.match(notification, /state: idle/);
    assert.match(notification, /model: provider\/new-model/);
    assert.match(notification, /last turn: daemon done/);
  } finally {
    await handlers.get("session_shutdown")?.({ type: "session_shutdown", reason: "quit" });
    await fakeSignal.stop();
    restoreEnv(previousEnv);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("daemon session replacement rebinds a new extension instance while keeping members connected", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-baker-daemon-replace-session-"));
  const fakeSignal = await startFakeSignalCli();
  const previousEnv = snapshotEnv(["PI_BAKER_DIR", "PI_BAKER_MANAGE_SIGNAL", "PI_BAKER_SIGNAL_ACCOUNT", "PI_BAKER_SIGNAL_URL"]);
  const firstHandlers = new Map<string, (...args: any[]) => unknown>();
  const secondHandlers = new Map<string, (...args: any[]) => unknown>();
  const firstCommands = new Map<string, any>();
  const secondCommands = new Map<string, any>();
  const replacementPrompts: string[] = [];
  let replacementNotice = "";
  let firstApiStale = false;
  let member: Awaited<ReturnType<typeof connectFakeMember>> | undefined;

  process.env.PI_BAKER_DIR = dir;
  process.env.PI_BAKER_MANAGE_SIGNAL = "false";
  process.env.PI_BAKER_SIGNAL_ACCOUNT = "+15550001";
  process.env.PI_BAKER_SIGNAL_URL = fakeSignal.url;

  try {
    piBakerExtension({
      registerFlag() {},
      getFlag(name: string) {
        return name === "baker-daemon";
      },
      registerCommand(name: string, options: unknown) {
        firstCommands.set(name, options);
      },
      registerTool() {},
      on(event: string, handler: (...args: any[]) => unknown) {
        firstHandlers.set(event, handler);
      },
      sendUserMessage() {
        if (firstApiStale) {
          throw new Error("stale first ExtensionAPI used after replacement");
        }
      },
      setSessionName() {},
      getSessionName() {
        return "daemon";
      },
    } as unknown as Parameters<typeof piBakerExtension>[0]);

    await firstHandlers.get("session_start")?.(
      { type: "session_start", reason: "startup" },
      makeContext("daemon-session-a", "provider/model", true),
    );
    member = await connectFakeMember(join(dir, "baker.sock"));
    member.send(makeHello("member-session", 101, "worker"));
    const ack = await member.next();
    assert.equal(ack.type, "hello_ack");
    assert.equal(ack.shortId, 1);

    await firstCommands.get("baker-clear").handler("", {
      ui: { notify() {} },
      async newSession(options: { withSession?: (ctx: unknown) => Promise<void> }) {
        // This is Pi's replacement order: old shutdown, fresh extension
        // factory, replacement start, then the old command's callback.
        await firstHandlers.get("session_shutdown")?.({ type: "session_shutdown", reason: "new" });
        firstApiStale = true;
        piBakerExtension({
          registerFlag() {},
          getFlag(name: string) {
            return name === "baker-daemon";
          },
          registerCommand(name: string, commandOptions: unknown) {
            secondCommands.set(name, commandOptions);
          },
          registerTool() {},
          on(event: string, handler: (...args: any[]) => unknown) {
            secondHandlers.set(event, handler);
          },
          sendUserMessage(text: string) {
            replacementPrompts.push(text);
          },
          setSessionName() {},
          getSessionName() {
            return "daemon";
          },
        } as unknown as Parameters<typeof piBakerExtension>[0]);
        await secondHandlers.get("session_start")?.(
          { type: "session_start", reason: "new", previousSessionFile: "/tmp/daemon-session-a.jsonl" },
          makeContext("daemon-session-b", "provider/model", true),
        );
        await options.withSession?.({
          ui: {
            notify(message: string) {
              replacementNotice = message;
            },
          },
        });
        return { cancelled: false };
      },
    });
    assert.equal(replacementNotice, "daemon session cleared");

    let daemonStatus = "";
    await secondCommands.get("baker-status").handler("me", {
      ui: {
        notify(message: string) {
          daemonStatus = message;
        },
      },
    });
    assert.match(daemonStatus, /session: daemon-session-b/);

    await secondCommands.get("baker-tell").handler("me use the replacement session", { ui: { notify() {} } });
    assert.deepEqual(replacementPrompts, ["use the replacement session"]);

    member.send({ v: 1, type: "turn", text: "member survived daemon session replacement" });
    await new Promise((resolve) => setTimeout(resolve, 10));

    let memberStatus = "";
    const status = secondCommands.get("baker-status").handler("worker", {
      ui: {
        notify(message: string) {
          memberStatus = message;
        },
      },
    });
    const query = await member.next();
    assert.equal(query.type, "query");
    member.send({
      v: 1,
      type: "result",
      id: query.id ?? "",
      ok: true,
      data: {
        connected: true,
        sessionId: "member-session",
        sessionName: "worker",
        state: "idle",
      },
    });
    await status;
    assert.match(memberStatus, /session: member-session/);
    assert.match(memberStatus, /last turn: member survived daemon session replacement/);
  } finally {
    member?.close();
    await secondHandlers.get("session_shutdown")?.({ type: "session_shutdown", reason: "quit" });
    await firstHandlers.get("session_shutdown")?.({ type: "session_shutdown", reason: "quit" });
    await fakeSignal.stop();
    restoreEnv(previousEnv);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("daemon agent_end without assistant text rejects waiting self prompt tools", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-baker-daemon-agent-end-empty-"));
  const fakeSignal = await startFakeSignalCli();
  const previousEnv = snapshotEnv(["PI_BAKER_DIR", "PI_BAKER_MANAGE_SIGNAL", "PI_BAKER_SIGNAL_ACCOUNT", "PI_BAKER_SIGNAL_URL"]);
  const handlers = new Map<string, (...args: any[]) => unknown>();
  const tools: any[] = [];
  const prompts: string[] = [];

  process.env.PI_BAKER_DIR = dir;
  process.env.PI_BAKER_MANAGE_SIGNAL = "false";
  process.env.PI_BAKER_SIGNAL_ACCOUNT = "+15550001";
  process.env.PI_BAKER_SIGNAL_URL = fakeSignal.url;

  try {
    piBakerExtension({
      registerFlag() {},
      getFlag(name: string) {
        return name === "baker-daemon";
      },
      registerCommand() {},
      registerTool(tool: any) {
        tools.push(tool);
      },
      on(event: string, handler: (...args: any[]) => unknown) {
        handlers.set(event, handler);
      },
      sendUserMessage(text: string) {
        prompts.push(text);
      },
      setSessionName() {},
      getSessionName() {
        return "daemon";
      },
    } as unknown as Parameters<typeof piBakerExtension>[0]);

    await handlers.get("session_start")?.({ type: "session_start", reason: "startup" }, makeContext("daemon-session", "provider/model", true));

    const tool = tools.find((candidate) => candidate.name === "baker_session_prompt");
    assert.ok(tool);
    const waited = tool.execute("test-call", { session: "me", text: "report back", wait: true }, undefined, undefined, {});
    await waitFor(() => prompts.length === 1);
    assert.deepEqual(prompts, ["report back"]);

    const rejected = assert.rejects(() => waited, /daemon turn ended without an assistant reply/);
    await handlers.get("agent_end")?.({ type: "agent_end", messages: [] }, makeContext("daemon-session", "provider/model", true));
    await rejected;
  } finally {
    await handlers.get("session_shutdown")?.({ type: "session_shutdown", reason: "quit" });
    await fakeSignal.stop();
    restoreEnv(previousEnv);
    rmSync(dir, { recursive: true, force: true });
  }
});

function makeHello(sessionId: string, pid: number, name: string): HelloFrame {
  return {
    v: 1,
    type: "hello",
    sessionId,
    sessionName: name,
    cwd: `/tmp/${name}`,
    pid,
    state: "idle",
    spawned: false,
    extensionVersion: "0.1.0",
  };
}

function makeContext(sessionId: string, model: string, idle: boolean): Record<string, unknown> {
  const [provider, id] = model.split("/", 2);
  return {
    cwd: "/tmp/daemon",
    model: { provider, id, name: id },
    modelRegistry: {
      getAvailable() {
        return [];
      },
      getAll() {
        return [];
      },
    },
    sessionManager: {
      getSessionId() {
        return sessionId;
      },
      getSessionFile() {
        return `/tmp/${sessionId}.jsonl`;
      },
      getSessionName() {
        return "daemon";
      },
    },
    ui: {
      notify() {},
    },
    isIdle() {
      return idle;
    },
    isProjectTrusted() {
      return true;
    },
    abort() {},
    shutdown() {},
    hasPendingMessages() {
      return false;
    },
    getContextUsage() {
      return undefined;
    },
    compact() {},
    getSystemPrompt() {
      return "";
    },
  };
}

function snapshotEnv(keys: string[]): Map<string, string | undefined> {
  return new Map(keys.map((key) => [key, process.env[key]]));
}

function restoreEnv(snapshot: Map<string, string | undefined>): void {
  for (const [key, value] of snapshot) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}

async function startFakeSignalCli(options: { checkStatus?: number; checkDelay?: Promise<void> } = {}): Promise<{ url: string; stop: () => Promise<void> }> {
  const checkStatus = options.checkStatus ?? 200;
  const eventResponses = new Set<ServerResponse>();
  const server = createServer(async (request, response) => {
    if (request.method === "GET" && request.url?.startsWith("/api/v1/check")) {
      await options.checkDelay;
      response.writeHead(checkStatus).end(checkStatus === 200 ? "OK" : "unhealthy");
      return;
    }

    if (request.method === "GET" && request.url?.startsWith("/api/v1/events")) {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write("\n");
      eventResponses.add(response);
      response.on("close", () => eventResponses.delete(response));
      return;
    }

    if (request.method === "POST" && request.url === "/api/v1/rpc") {
      request.resume();
      request.on("end", () => {
        response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", result: {} }));
      });
      return;
    }

    response.writeHead(404).end();
  });

  await listen(server);
  const address = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${address.port}`,
    async stop() {
      for (const response of eventResponses) {
        response.end();
      }
      await closeServer(server);
    },
  };
}

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
    send(frame) {
      socket.write(serializeFrame(frame));
    },
    next() {
      const frame = frames.shift();
      if (frame !== undefined) {
        return Promise.resolve(frame);
      }
      return new Promise<ControlFrame>((resolve) => waiters.push(resolve));
    },
    close() {
      socket.end();
    },
  };
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T | PromiseLike<T>) => void; reject: (error: unknown) => void } {
  let resolve: (value: T | PromiseLike<T>) => void = () => undefined;
  let reject: (error: unknown) => void = () => undefined;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}

async function listen(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
}

async function listenUnix(server: NetServer, socketPath: string): Promise<void> {
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

async function closeNetServer(server: NetServer): Promise<void> {
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
