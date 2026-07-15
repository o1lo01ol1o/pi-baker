import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { createConnection, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { BakerRegistry } from "../src/daemon/registry.ts";
import { BakerServices } from "../src/daemon/services.ts";
import { SpawnManager, type RpcClientLike } from "../src/daemon/spawn.ts";
import { ControlServer } from "../src/daemon/server.ts";
import type { BakerConfig } from "../src/config.ts";
import { FrameLineBuffer, serializeFrame, type HelloFrame } from "../src/protocol.ts";

test("SpawnManager starts RPC child, waits for spawned hello, sends initial prompt, and kills spawned session", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-baker-spawn-"));
  const registry = new BakerRegistry(join(dir, "baker.db"));
  const server = new ControlServer({ socketPath: join(dir, "baker.sock"), registry });
  await server.start();
  registry.upsertDaemon({
    ...makeHello("daemon"),
    sessionId: "daemon",
    sessionName: "daemon",
    pid: 1,
    spawned: false,
  });

  const clients: FakeRpcClient[] = [];
  const events: string[] = [];
  const spawnEnvs: Array<Record<string, string> | undefined> = [];
  const spawner = new SpawnManager({
    config: makeConfig(dir),
    registry,
    server,
    registrationTimeoutMs: 1_000,
    clientFactory: (options) => {
      spawnEnvs.push(options.env);
      const client = new FakeRpcClient();
      clients.push(client);
      void connectSpawnedMember(join(dir, "baker.sock"), String(options.env?.PI_BAKER_SPAWN_ID), {
        onPrompt: () => events.push("prompt"),
      });
      return client;
    },
  });

  try {
    const result = await spawner.spawn({
      cwd: dir,
      prompt: "hello child",
      name: "child",
      onRegistered: () => {
        events.push("registered");
      },
    });
    assert.equal(result.shortId, 1);
    assert.equal(registry.getSession(1)?.name, "child");
    assert.equal(clients[0]?.started, true);
    assert.equal(spawnEnvs[0]?.PI_BAKER_DIR, dir);
    assert.equal(spawnEnvs[0]?.PI_BAKER_ROLE, "member");
    assert.equal(spawnEnvs[0]?.PI_BAKER_SPAWNED, "1");
    assert.match(spawnEnvs[0]?.PI_BAKER_SPAWN_ID ?? "", /^spawn-/);
    assert.deepEqual(clients[0]?.names, []);
    assert.deepEqual(events, ["registered", "prompt"]);

    const services = new BakerServices(registry, server, spawner);
    await assert.rejects(() => services.kill("me"), /only spawned sessions/);
    assert.equal(await services.kill("child"), "killed #1 child");
    assert.equal(clients[0]?.aborted, true);
    assert.equal(clients[0]?.stopped, true);
    assert.equal(registry.getSession(1)?.connected, false);
    await assert.rejects(() => services.sendPrompt("child", "after kill", "followUp"), /session #1 is disconnected/);
  } finally {
    await server.stop();
    registry.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("SpawnManager marks registered spawned sessions disconnected on crash", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-baker-spawn-crash-"));
  const registry = new BakerRegistry(join(dir, "baker.db"));
  const server = new ControlServer({ socketPath: join(dir, "baker.sock"), registry });
  await server.start();
  const crashes: string[] = [];
  let fakeClient: FakeRpcClient | undefined;

  const spawner = new SpawnManager({
    config: makeConfig(dir),
    registry,
    server,
    registrationTimeoutMs: 1_000,
    onCrash: (_session, message) => crashes.push(message),
    clientFactory: (options) => {
      fakeClient = new FakeRpcClient();
      void connectSpawnedMember(join(dir, "baker.sock"), String(options.env?.PI_BAKER_SPAWN_ID));
      return fakeClient;
    },
  });

  try {
    const result = await spawner.spawn({ cwd: dir });
    fakeClient?.process.emit("exit", 2, null);
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(registry.getSession(result.shortId)?.connected, false);
    assert.match(crashes[0] ?? "", /crashed/);
    const services = new BakerServices(registry, server, spawner);
    await assert.rejects(() => services.sendPrompt(String(result.shortId), "after crash", "followUp"), /session #1 is disconnected/);
  } finally {
    await server.stop();
    registry.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("SpawnManager marks already-exited spawned children disconnected after registration", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-baker-spawn-already-exited-"));
  const registry = new BakerRegistry(join(dir, "baker.db"));
  const server = new ControlServer({ socketPath: join(dir, "baker.sock"), registry });
  await server.start();
  const crashes: string[] = [];

  const spawner = new SpawnManager({
    config: makeConfig(dir),
    registry,
    server,
    registrationTimeoutMs: 1_000,
    onCrash: (_session, message) => crashes.push(message),
    clientFactory: (options) => {
      void connectSpawnedMember(join(dir, "baker.sock"), String(options.env?.PI_BAKER_SPAWN_ID));
      return new AlreadyExitedRpcClient(2);
    },
  });

  try {
    const result = await spawner.spawn({ cwd: dir });
    assert.equal(spawner.hasHandle(result.shortId), false);
    assert.equal(registry.getSession(result.shortId)?.connected, false);
    assert.match(crashes[0] ?? "", /crashed \(exit 2\)/);
    const services = new BakerServices(registry, server, spawner);
    await assert.rejects(() => services.sendPrompt(String(result.shortId), "after crash", "followUp"), /session #1 is disconnected/);
  } finally {
    await server.stop();
    registry.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("SpawnManager stops all spawned children during daemon shutdown", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-baker-spawn-stop-all-"));
  const registry = new BakerRegistry(join(dir, "baker.db"));
  const server = new ControlServer({ socketPath: join(dir, "baker.sock"), registry });
  await server.start();
  const clients: FakeRpcClient[] = [];
  const sockets: Socket[] = [];
  const crashes: string[] = [];

  const spawner = new SpawnManager({
    config: makeConfig(dir),
    registry,
    server,
    registrationTimeoutMs: 1_000,
    onCrash: (_session, message) => crashes.push(message),
    clientFactory: (options) => {
      const client = new FakeRpcClient();
      clients.push(client);
      void connectSpawnedMember(join(dir, "baker.sock"), String(options.env?.PI_BAKER_SPAWN_ID)).then((socket) => sockets.push(socket));
      return client;
    },
  });

  try {
    const first = await spawner.spawn({ cwd: dir, name: "first" });
    const second = await spawner.spawn({ cwd: dir, name: "second" });

    await spawner.stopAll();

    assert.deepEqual(
      clients.map((client) => ({ aborted: client.aborted, stopped: client.stopped })),
      [
        { aborted: true, stopped: true },
        { aborted: true, stopped: true },
      ],
    );
    assert.equal(spawner.hasHandle(first.shortId), false);
    assert.equal(spawner.hasHandle(second.shortId), false);
    assert.equal(registry.getSession(first.shortId)?.connected, false);
    assert.equal(registry.getSession(second.shortId)?.connected, false);

    clients[0]?.process.emit("exit", 1, null);
    clients[1]?.process.emit("exit", null, "SIGTERM");
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.deepEqual(crashes, []);
  } finally {
    for (const socket of sockets) {
      socket.destroy();
    }
    await server.stop();
    registry.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("SpawnManager force-kills spawned children when RPC stop hangs", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-baker-spawn-hanging-stop-"));
  const registry = new BakerRegistry(join(dir, "baker.db"));
  const server = new ControlServer({ socketPath: join(dir, "baker.sock"), registry });
  await server.start();
  registry.upsertDaemon({
    ...makeHello("daemon"),
    sessionId: "daemon",
    sessionName: "daemon",
    pid: 1,
    spawned: false,
  });

  let client: HangingStopRpcClient | undefined;
  const spawner = new SpawnManager({
    config: makeConfig(dir),
    registry,
    server,
    registrationTimeoutMs: 1_000,
    stopSignalMs: 5,
    stopKillMs: 10,
    clientFactory: (options) => {
      client = new HangingStopRpcClient();
      void connectSpawnedMember(join(dir, "baker.sock"), String(options.env?.PI_BAKER_SPAWN_ID));
      return client;
    },
  });

  try {
    const result = await spawner.spawn({ cwd: dir });
    const services = new BakerServices(registry, server, spawner);

    assert.equal(await services.kill(String(result.shortId)), `killed #${result.shortId} spawned`);
    assert.equal(client?.aborted, true);
    assert.deepEqual(client?.process.signals, ["SIGTERM", "SIGKILL"]);
    assert.equal(spawner.hasHandle(result.shortId), false);
    assert.equal(registry.getSession(result.shortId)?.connected, false);
  } finally {
    await server.stop();
    registry.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("SpawnManager keeps force-kill fallback armed when RPC stop returns before child exits", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-baker-spawn-fast-stop-live-child-"));
  const registry = new BakerRegistry(join(dir, "baker.db"));
  const server = new ControlServer({ socketPath: join(dir, "baker.sock"), registry });
  await server.start();
  registry.upsertDaemon({
    ...makeHello("daemon"),
    sessionId: "daemon",
    sessionName: "daemon",
    pid: 1,
    spawned: false,
  });

  let client: FastStopLiveChildRpcClient | undefined;
  const spawner = new SpawnManager({
    config: makeConfig(dir),
    registry,
    server,
    registrationTimeoutMs: 1_000,
    stopSignalMs: 5,
    stopKillMs: 10,
    clientFactory: (options) => {
      client = new FastStopLiveChildRpcClient();
      void connectSpawnedMember(join(dir, "baker.sock"), String(options.env?.PI_BAKER_SPAWN_ID));
      return client;
    },
  });

  try {
    const result = await spawner.spawn({ cwd: dir });
    const services = new BakerServices(registry, server, spawner);

    assert.equal(await services.kill(String(result.shortId)), `killed #${result.shortId} spawned`);
    assert.equal(client?.aborted, true);
    assert.equal(client?.stopped, true);
    assert.deepEqual(client?.process.signals, ["SIGTERM", "SIGKILL"]);
    assert.equal(spawner.hasHandle(result.shortId), false);
    assert.equal(registry.getSession(result.shortId)?.connected, false);
  } finally {
    await server.stop();
    registry.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("SpawnManager cleans up killed sessions when RPC stop rejects after child exit", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-baker-spawn-stop-reject-exited-"));
  const registry = new BakerRegistry(join(dir, "baker.db"));
  const server = new ControlServer({ socketPath: join(dir, "baker.sock"), registry });
  await server.start();

  let client: RejectingStopRpcClient | undefined;
  const spawner = new SpawnManager({
    config: makeConfig(dir),
    registry,
    server,
    registrationTimeoutMs: 1_000,
    stopSignalMs: 5,
    stopKillMs: 10,
    clientFactory: (options) => {
      client = new RejectingStopRpcClient();
      void connectSpawnedMember(join(dir, "baker.sock"), String(options.env?.PI_BAKER_SPAWN_ID));
      return client;
    },
  });

  try {
    const result = await spawner.spawn({ cwd: dir });
    client!.process.exitCode = 0;
    const services = new BakerServices(registry, server, spawner);

    assert.equal(await services.kill(String(result.shortId)), `killed #${result.shortId} spawned`);
    assert.equal(client?.aborted, true);
    assert.equal(client?.stopped, true);
    assert.deepEqual(client?.process.signals, []);
    assert.equal(spawner.hasHandle(result.shortId), false);
    assert.equal(registry.getSession(result.shortId)?.connected, false);
    assert.equal(registry.listEvents().at(-1)?.type, "kill");
  } finally {
    await server.stop();
    registry.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("SpawnManager cleans up registered child when initial prompt is rejected", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-baker-spawn-prompt-reject-"));
  const registry = new BakerRegistry(join(dir, "baker.db"));
  const server = new ControlServer({ socketPath: join(dir, "baker.sock"), registry });
  await server.start();

  let client: FakeRpcClient | undefined;
  const spawner = new SpawnManager({
    config: makeConfig(dir),
    registry,
    server,
    registrationTimeoutMs: 1_000,
    clientFactory: (options) => {
      client = new FakeRpcClient();
      void connectSpawnedMember(join(dir, "baker.sock"), String(options.env?.PI_BAKER_SPAWN_ID), {
        rejectPrompt: true,
      });
      return client;
    },
  });

  try {
    await assert.rejects(() => spawner.spawn({ cwd: dir, prompt: "hello child" }), /child refused prompt/);
    assert.equal(client?.stopped, true);
    assert.equal(spawner.hasHandle(1), false);
    assert.equal(registry.getSession(1)?.connected, false);
    const services = new BakerServices(registry, server, spawner);
    await assert.rejects(() => services.sendPrompt("1", "after failed spawn", "followUp"), /session #1 is disconnected/);
  } finally {
    await server.stop();
    registry.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("SpawnManager rejects registrations that do not mark the child as spawned", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-baker-spawn-not-spawned-"));
  const registry = new BakerRegistry(join(dir, "baker.db"));
  const server = new ControlServer({ socketPath: join(dir, "baker.sock"), registry });
  await server.start();

  let client: FakeRpcClient | undefined;
  const spawner = new SpawnManager({
    config: makeConfig(dir),
    registry,
    server,
    registrationTimeoutMs: 1_000,
    clientFactory: (options) => {
      client = new FakeRpcClient();
      void connectSpawnedMember(join(dir, "baker.sock"), String(options.env?.PI_BAKER_SPAWN_ID), {
        spawned: false,
      });
      return client;
    },
  });

  try {
    await assert.rejects(() => spawner.spawn({ cwd: dir }), /registered as member; expected spawned/);
    assert.equal(client?.stopped, true);
    assert.equal(spawner.hasHandle(1), false);
    assert.equal(registry.getSession(1)?.kind, "member");
    assert.equal(registry.getSession(1)?.connected, false);
  } finally {
    await server.stop();
    registry.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("SpawnManager cancels registration wait when RPC child fails to start", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-baker-spawn-start-fail-"));
  const registry = new BakerRegistry(join(dir, "baker.db"));
  const server = new ControlServer({ socketPath: join(dir, "baker.sock"), registry });
  await server.start();

  const spawner = new SpawnManager({
    config: makeConfig(dir),
    registry,
    server,
    registrationTimeoutMs: 20,
    clientFactory: () => new FailingStartRpcClient(),
  });

  try {
    await assert.rejects(() => spawner.spawn({ cwd: dir }), /start failed/);
    await new Promise((resolve) => setTimeout(resolve, 50));
  } finally {
    await server.stop();
    registry.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

class FakeRpcClient implements RpcClientLike {
  readonly process = new EventEmitter();
  started = false;
  stopped = false;
  aborted = false;
  readonly names: string[] = [];

  async start(): Promise<void> {
    this.started = true;
  }

  async stop(): Promise<void> {
    this.stopped = true;
  }

  async abort(): Promise<void> {
    this.aborted = true;
  }

  async setSessionName(name: string): Promise<void> {
    this.names.push(name);
  }
}

class FailingStartRpcClient extends FakeRpcClient {
  override async start(): Promise<void> {
    throw new Error("start failed");
  }
}

class AlreadyExitedRpcClient extends FakeRpcClient {
  override readonly process: FakeChildProcess;

  constructor(exitCode: number) {
    super();
    this.process = new FakeChildProcess(exitCode);
  }
}

class HangingStopRpcClient extends FakeRpcClient {
  override readonly process = new FakeChildProcess();

  override async stop(): Promise<void> {
    await new Promise<never>(() => undefined);
  }
}

class FastStopLiveChildRpcClient extends FakeRpcClient {
  override readonly process = new FakeChildProcess();
}

class RejectingStopRpcClient extends FakeRpcClient {
  override readonly process = new FakeChildProcess();

  override async stop(): Promise<void> {
    this.stopped = true;
    throw new Error("stop rejected");
  }
}

class FakeChildProcess extends EventEmitter {
  exitCode: number | null;
  signalCode: NodeJS.Signals | null = null;
  readonly signals: string[] = [];

  constructor(exitCode: number | null = null) {
    super();
    this.exitCode = exitCode;
  }

  kill(signal?: NodeJS.Signals | number): boolean {
    this.signals.push(String(signal ?? "SIGTERM"));
    return true;
  }
}

async function connectSpawnedMember(
  socketPath: string,
  spawnId: string,
  options: { rejectPrompt?: boolean; onPrompt?: () => void; spawned?: boolean; pid?: number } = {},
): Promise<Socket> {
  const socket = createConnection(socketPath);
  const decoder = new FrameLineBuffer();
  socket.on("data", (chunk) => {
    for (const parsed of decoder.push(chunk)) {
      if (parsed.kind !== "frame") {
        continue;
      }
      const frame = parsed.frame;
      if (frame.type === "rename") {
        socket.write(serializeFrame({ v: 1, type: "result", id: frame.id, ok: true }));
      }
      if (frame.type === "prompt") {
        options.onPrompt?.();
        socket.write(
          serializeFrame({
            v: 1,
            type: "result",
            id: frame.id,
            ok: !options.rejectPrompt,
            error: options.rejectPrompt ? "child refused prompt" : undefined,
          }),
        );
      }
    }
  });
  await new Promise<void>((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("error", reject);
  });
  socket.write(serializeFrame(makeHello(spawnId, options.spawned ?? true, options.pid ?? nextFakePid())));
  return socket;
}

let fakePid = 41;

function nextFakePid(): number {
  fakePid += 1;
  return fakePid;
}

function makeConfig(dir: string): BakerConfig {
  return {
    role: "daemon",
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
  };
}

function makeHello(spawnId: string, spawned = true, pid = 42): HelloFrame {
  return {
    v: 1,
    type: "hello",
    sessionId: `session-${spawnId}`,
    sessionName: "spawned",
    cwd: "/tmp/spawned",
    pid,
    state: "idle",
    spawned,
    spawnId,
    extensionVersion: "0.1.0",
  };
}
