import assert from "node:assert/strict";
import { test } from "node:test";

import { parseSlashCommand, registerDaemonCommands } from "../src/daemon/commands.ts";
import { BakerRegistry } from "../src/daemon/registry.ts";
import { BakerServices } from "../src/daemon/services.ts";
import { ControlServer } from "../src/daemon/server.ts";
import type { SignalBridge } from "../src/daemon/signal.ts";
import type { SpawnManager, SpawnRequest } from "../src/daemon/spawn.ts";
import { registerMemberCommands, type MemberClient } from "../src/member/client.ts";
import type { HelloFrame } from "../src/protocol.ts";

test("slash command parser strips leading slash and splits whitespace", () => {
  assert.deepEqual(parseSlashCommand("/status 12 detail"), {
    name: "status",
    args: ["12", "detail"],
  });
  assert.deepEqual(parseSlashCommand("sessions all"), {
    name: "sessions",
    args: ["all"],
  });
});

test("service selector resolves ids, me, and unambiguous name prefixes", () => {
  const registry = new BakerRegistry(":memory:");
  const server = new ControlServer({ socketPath: "/tmp/not-used.sock", registry });
  const services = new BakerServices(registry, server);

  try {
    registry.upsertDaemon(makeHello("daemon", 100, "/tmp/daemon", "daemon"));
    const member = registry.upsertHello(makeHello("abc", 101, "/tmp/refactor", "Refactor-Main"), "member");

    assert.equal(services.resolveSelector("me").shortId, 0);
    assert.equal(services.resolveSelector("ME").shortId, 0);
    assert.equal(services.resolveSelector(String(member.shortId)).sessionId, "abc");
    assert.equal(services.resolveSelector("refactor").shortId, member.shortId);
    assert.equal(services.resolveSelector("REFACTOR").shortId, member.shortId);
    registry.upsertHello(makeHello("def", 102, "/tmp/review", "review-main"), "member");
    assert.throws(() => services.resolveSelector("re"), /ambiguous selector re: #1 Refactor-Main, #2 review-main/);
    assert.throws(() => services.resolveSelector("  "), /session selector is required/);
    assert.throws(() => services.resolveSelector("1e0"), /unknown session selector: 1e0; available: #0 daemon, #1 Refactor-Main/);
    assert.throws(() => services.resolveSelector("missing"), /unknown session selector: missing; available: #0 daemon, #1 Refactor-Main, #2 review-main/);
    assert.throws(() => services.resolveSelector("99"), /unknown session selector: 99; available: #0 daemon, #1 Refactor-Main, #2 review-main/);
  } finally {
    registry.close();
  }
});

test("service selector errors include disconnected candidates when requested", () => {
  const registry = new BakerRegistry(":memory:");
  const server = new ControlServer({ socketPath: "/tmp/not-used.sock", registry });
  const services = new BakerServices(registry, server);

  try {
    registry.upsertDaemon(makeHello("daemon", 100, "/tmp/daemon", "daemon"));
    const member = registry.upsertHello(makeHello("abc", 101, "/tmp/refactor", "refactor-main"), "member");
    registry.markDisconnected(member.shortId);

    assert.throws(() => services.resolveSelector("missing"), /available: #0 daemon/);
    assert.throws(() => services.resolveSelector(String(member.shortId)), /unknown session selector: 1; available: #0 daemon/);
    assert.equal(services.resolveSelector(String(member.shortId), { includeDisconnected: true }).shortId, member.shortId);
    assert.throws(
      () => services.resolveSelector("missing", { includeDisconnected: true }),
      /available: #0 daemon, #1 refactor-main/,
    );
  } finally {
    registry.close();
  }
});

test("service last and status summaries use live memory when turn persistence is disabled", async () => {
  const registry = new BakerRegistry(":memory:", { storeTurns: false });
  const server = new ControlServer({ socketPath: "/tmp/not-used.sock", registry });
  const services = new BakerServices(registry, server);

  try {
    registry.upsertDaemon(makeHello("daemon", 100, "/tmp/daemon", "daemon"));
    registry.recordTurn(0, "persistently hidden");
    assert.equal(registry.getSession(0)?.lastTurn, undefined);

    server.rememberTurn(0, "live daemon turn");
    assert.equal(services.last("me"), "live daemon turn");
    assert.equal(services.rowsForTool().find((row) => row.id === 0)?.lastTurnSummary, "live daemon turn");

    const member = registry.upsertHello(makeHello("abc", 101, "/tmp/refactor", "worker-main"), "member");
    registry.recordTurn(member.shortId, "persistently hidden member turn");
    assert.equal(registry.getSession(member.shortId)?.lastTurn, undefined);

    server.rememberTurn(member.shortId, "live member turn");
    assert.equal(services.last("worker"), "live member turn");
    assert.equal(services.rowsForTool().find((row) => row.id === member.shortId)?.lastTurnSummary, "live member turn");
    assert.match(services.status("worker"), /last turn: live member turn/);
    assert.match(await services.liveStatusText("worker"), /last turn: live member turn/);

    registry.markDisconnected(member.shortId);
    assert.equal(services.last("worker"), `no last turn recorded for #${member.shortId} worker-main`);
  } finally {
    registry.close();
  }
});

test("service watch and rename record metadata-only audit events", async () => {
  const registry = new BakerRegistry(":memory:");
  const server = new ControlServer({ socketPath: "/tmp/not-used.sock", registry });
  const services = new BakerServices(registry, server);

  try {
    registry.upsertDaemon(makeHello("daemon", 100, "/tmp/daemon", "daemon"));
    const member = registry.upsertHello(makeHello("abc", 101, "/tmp/refactor", "refactor-main"), "member");
    registry.markDisconnected(member.shortId);

    services.setWatch(String(member.shortId), true);
    await services.rename(String(member.shortId), "renamed-refactor");

    const events = registry.listEvents().slice(-2);
    assert.deepEqual(
      events.map((event) => ({ type: event.type, detail: event.detail })),
      [
        { type: "watch", detail: { watch: true } },
        { type: "rename", detail: { name: "renamed-refactor" } },
      ],
    );
  } finally {
    registry.close();
  }
});

test("service prompt and abort report named disconnected sessions as disconnected", async () => {
  const registry = new BakerRegistry(":memory:");
  const server = new ControlServer({ socketPath: "/tmp/not-used.sock", registry });
  const services = new BakerServices(registry, server);

  try {
    registry.upsertDaemon(makeHello("daemon", 100, "/tmp/daemon", "daemon"));
    const member = registry.upsertHello(makeHello("abc", 101, "/tmp/refactor", "refactor-main"), "member");
    registry.markDisconnected(member.shortId);

    await assert.rejects(() => services.sendPrompt("refactor", "go", "followUp"), /session #1 is disconnected \(last seen /);
    await assert.rejects(() => services.abort("refactor"), /session #1 is disconnected \(last seen /);
  } finally {
    registry.close();
  }
});

test("service abort supports daemon self selector through daemon hook", async () => {
  const registry = new BakerRegistry(":memory:");
  const server = new ControlServer({ socketPath: "/tmp/not-used.sock", registry });
  let aborts = 0;
  const services = new BakerServices(registry, server, undefined, {
    abort() {
      aborts += 1;
    },
  });

  try {
    registry.upsertDaemon(makeHello("daemon", 100, "/tmp/daemon", "daemon"));

    assert.equal(await services.abort("me"), "aborted #0 daemon");
    assert.equal(aborts, 1);
    assert.equal(registry.listEvents().at(-1)?.type, "abort");
  } finally {
    registry.close();
  }
});

test("service prompt supports daemon self selector through daemon hook", async () => {
  const registry = new BakerRegistry(":memory:");
  const server = new ControlServer({ socketPath: "/tmp/not-used.sock", registry });
  const prompts: Array<{ text: string; mode: string }> = [];
  const services = new BakerServices(registry, server, undefined, {
    sendUserMessage(text, deliverAs) {
      prompts.push({ text, mode: deliverAs });
    },
  });

  try {
    registry.upsertDaemon(makeHello("daemon", 100, "/tmp/daemon", "daemon"));

    assert.equal(await services.sendPrompt("me", "  check status  ", "steer"), "sent to #0 daemon");
    assert.deepEqual(prompts, [{ text: "check status", mode: "steer" }]);
    assert.equal(registry.listEvents().at(-1)?.type, "steer");

    const waited = services.sendPrompt("0", "report back", "followUp", { wait: true, timeoutSec: 60 });
    assert.equal(server.pendingTurnWaiterCount(0), 1);
    server.resolveLocalTurn(0, "daemon done");

    assert.equal(await waited, "daemon done");
    assert.deepEqual(prompts.at(-1), { text: "report back", mode: "followUp" });
    assert.equal(server.getLastTurn(0), "daemon done");
  } finally {
    registry.close();
  }
});

test("waited daemon prompts reject when the daemon turn has no assistant text", async () => {
  const registry = new BakerRegistry(":memory:");
  const server = new ControlServer({ socketPath: "/tmp/not-used.sock", registry });
  const services = new BakerServices(registry, server, undefined, {
    sendUserMessage() {},
  });

  try {
    registry.upsertDaemon(makeHello("daemon", 100, "/tmp/daemon", "daemon"));

    const waited = services.sendPrompt("me", "report back", "followUp", { wait: true, timeoutSec: 60 });
    assert.equal(server.pendingTurnWaiterCount(0), 1);
    server.rejectLocalTurn(0, "daemon turn ended without an assistant reply");

    await assert.rejects(() => waited, /daemon turn ended without an assistant reply/);
    assert.equal(server.pendingTurnWaiterCount(0), 0);

    server.resolveLocalTurn(0, "late daemon reply");
    assert.equal(server.getLastTurn(0), "late daemon reply");
  } finally {
    registry.close();
  }
});

test("service rename supports daemon self selector through daemon hook", async () => {
  const registry = new BakerRegistry(":memory:");
  const server = new ControlServer({ socketPath: "/tmp/not-used.sock", registry });
  const names: string[] = [];
  const services = new BakerServices(registry, server, undefined, {
    rename(name) {
      names.push(name);
      return `actual-${name}`;
    },
  });

  try {
    registry.upsertDaemon(makeHello("daemon", 100, "/tmp/daemon", "daemon"));

    const renamed = await services.rename("me", "  orchestrator  ");
    assert.deepEqual(names, ["orchestrator"]);
    assert.equal(renamed.name, "actual-orchestrator");
    assert.equal(registry.getSession(0)?.name, "actual-orchestrator");
    assert.deepEqual(registry.listEvents().at(-1)?.detail, { name: "actual-orchestrator" });
  } finally {
    registry.close();
  }
});

test("service rejects empty prompt text and spawn cwd", async () => {
  const registry = new BakerRegistry(":memory:");
  const server = new ControlServer({ socketPath: "/tmp/not-used.sock", registry });
  const services = new BakerServices(registry, server);

  try {
    registry.upsertDaemon(makeHello("daemon", 100, "/tmp/daemon", "daemon"));
    registry.upsertHello(makeHello("abc", 101, "/tmp/refactor", "refactor-main"), "member");

    await assert.rejects(() => services.sendPrompt("refactor", "   ", "followUp"), /prompt text is required/);
    await assert.rejects(() => services.spawn({ cwd: "  " }), /spawn cwd is required/);
  } finally {
    registry.close();
  }
});

test("service normalizes spawn request fields before delegating", async () => {
  const registry = new BakerRegistry(":memory:");
  const server = new ControlServer({ socketPath: "/tmp/not-used.sock", registry });
  const requests: SpawnRequest[] = [];
  const spawner = {
    spawn(request: SpawnRequest) {
      requests.push(request);
      return Promise.resolve({ shortId: 1, name: request.name ?? "spawned", cwd: request.cwd });
    },
  } as unknown as SpawnManager;
  const services = new BakerServices(registry, server, spawner);

  try {
    await services.spawn({
      cwd: "  /tmp/project  ",
      prompt: "  start here  ",
      model: "  openai/gpt-5  ",
      name: "  child  ",
    });
    await services.spawn({
      cwd: "/tmp/empty-optionals",
      prompt: "  ",
      model: "\t",
      name: "",
    });

    assert.deepEqual(requests, [
      {
        cwd: "/tmp/project",
        prompt: "start here",
        model: "openai/gpt-5",
        name: "child",
      },
      {
        cwd: "/tmp/empty-optionals",
      },
    ]);
  } finally {
    registry.close();
  }
});

test("daemon TUI commands record metadata-only command audit events", async () => {
  const registry = new BakerRegistry(":memory:");
  const server = new ControlServer({ socketPath: "/tmp/not-used.sock", registry });
  const services = new BakerServices(registry, server);
  const commands = new Map<string, any>();

  try {
    registry.upsertDaemon(makeHello("daemon", 100, "/tmp/daemon", "daemon"));
    registerDaemonCommands(
      {
        registerCommand(name, options) {
          commands.set(name, options);
        },
      },
      {
        config: {
          role: "daemon",
          bakerDir: "/tmp/pi-baker",
          socketPath: "/tmp/pi-baker/baker.sock",
          dbPath: "/tmp/pi-baker/baker.db",
          signalAccount: undefined,
          whitelist: new Set(),
          signalUrl: "http://127.0.0.1:51921",
          manageSignal: false,
          storeTurns: true,
          quiet: true,
          spawned: false,
        },
        registry: () => registry,
        server: () => server,
        services: () => services,
      },
    );

    let notification = "";
    await commands.get("baker-sessions").handler("all private-argument", {
      ui: {
        notify(message: string) {
          notification = message;
        },
      },
    });
    const event = registry.listEvents().at(-1);
    assert.equal(notification, "usage: /baker-sessions [all]");
    assert.equal(event?.type, "command");
    assert.deepEqual(event?.detail, { command: "baker-sessions", surface: "tui" });
    assert.doesNotMatch(JSON.stringify(registry.listEvents()), /private-argument/);
  } finally {
    registry.close();
  }
});

test("daemon TUI baker-status uses the handler args as a session selector", async () => {
  const commands = new Map<string, any>();
  const calls: string[] = [];
  let notification = "";

  registerDaemonCommands(
    {
      registerCommand(name, options) {
        commands.set(name, options);
      },
    },
    {
      config: makeConfig(),
      registry: () => {
        throw new Error("registry should not be needed for session status");
      },
      server: () => {
        throw new Error("server should not be needed for session status");
      },
      services: () =>
        ({
          recordCommand(command: string, surface: string) {
            calls.push(`command:${surface}:${command}`);
          },
          liveStatusText(selector: string) {
            calls.push(`status:${selector}`);
            return Promise.resolve("live worker status");
          },
        }) as unknown as BakerServices,
    },
  );

  await commands.get("baker-status").handler("worker", {
    ui: {
      notify(message: string) {
        notification = message;
      },
    },
  });

  assert.equal(notification, "live worker status");
  assert.deepEqual(calls, ["command:tui:baker-status", "status:worker"]);

  await commands.get("baker-status").handler("worker ignored-extra", {
    ui: {
      notify(message: string) {
        notification = message;
      },
    },
  });

  assert.equal(notification, "usage: /baker-status [session]");
  assert.deepEqual(calls, ["command:tui:baker-status", "status:worker", "command:tui:baker-status"]);
});

test("daemon TUI ask, watch, and name commands delegate to shared services", async () => {
  const commands = new Map<string, any>();
  const calls: string[] = [];
  const notifications: string[] = [];

  registerDaemonCommands(
    {
      registerCommand(name, options) {
        commands.set(name, options);
      },
    },
    {
      config: makeConfig(),
      registry: () => {
        throw new Error("registry should not be needed");
      },
      server: () => {
        throw new Error("server should not be needed");
      },
      services: () =>
        ({
          recordCommand(command: string, surface: string) {
            calls.push(`command:${surface}:${command}`);
          },
          last(selector: string) {
            calls.push(`last:${selector}`);
            return "last worker turn";
          },
          setWatch(selector: string, watch: boolean) {
            calls.push(`watch:${selector}:${watch}`);
            return { shortId: 7, name: "worker-main" };
          },
          rename(selector: string, name: string) {
            calls.push(`rename:${selector}:${name}`);
            return Promise.resolve({ shortId: 7, name: "renamed-worker" });
          },
        }) as unknown as BakerServices,
    },
  );

  const ctx = {
    ui: {
      notify(message: string) {
        notifications.push(message);
      },
    },
  };

  await commands.get("baker-ask").handler("worker", ctx);
  await commands.get("baker-watch").handler("worker on", ctx);
  await commands.get("baker-name").handler("worker renamed worker", ctx);

  assert.deepEqual(notifications, ["last worker turn", "watch on for #7 worker-main", "renamed #7 renamed-worker"]);
  assert.deepEqual(calls, [
    "command:tui:baker-ask",
    "last:worker",
    "command:tui:baker-watch",
    "watch:worker:true",
    "command:tui:baker-name",
    "rename:worker:renamed worker",
  ]);
});

test("daemon TUI watch updates the running Signal bridge for Note-to-Self", async () => {
  const commands = new Map<string, any>();
  const calls: string[] = [];
  const runtimeWatch: Array<{ shortId: number; recipient: string; watch: boolean }> = [];
  const notifications: string[] = [];

  registerDaemonCommands(
    {
      registerCommand(name, options) {
        commands.set(name, options);
      },
    },
    {
      config: {
        ...makeConfig(),
        signalAccount: "+15550001",
      },
      registry: () => undefined,
      server: () => undefined,
      services: () =>
        ({
          recordCommand(command: string, surface: string) {
            calls.push(`command:${surface}:${command}`);
          },
          setWatch(selector: string, watch: boolean, recipient?: string) {
            calls.push(`watch:${selector}:${watch}:${recipient ?? "-"}`);
            return { shortId: 7, name: "worker-main" };
          },
        }) as unknown as BakerServices,
      signal: () =>
        ({
          setWatchTarget(shortId: number, recipient: string, watch: boolean) {
            runtimeWatch.push({ shortId, recipient, watch });
          },
        }) as SignalBridge,
    },
  );

  const ctx = {
    ui: {
      notify(message: string) {
        notifications.push(message);
      },
    },
  };

  await commands.get("baker-watch").handler("worker on", ctx);
  await commands.get("baker-watch").handler("worker off", ctx);

  assert.deepEqual(notifications, ["watch on for #7 worker-main", "watch off for #7 worker-main"]);
  assert.deepEqual(calls, [
    "command:tui:baker-watch",
    "watch:worker:true:+15550001",
    "command:tui:baker-watch",
    "watch:worker:false:+15550001",
  ]);
  assert.deepEqual(runtimeWatch, [
    { shortId: 7, recipient: "+15550001", watch: true },
    { shortId: 7, recipient: "+15550001", watch: false },
  ]);
});

test("daemon TUI fixed-form session commands reject usage errors before delegation", async () => {
  const commands = new Map<string, any>();
  const calls: string[] = [];
  const notifications: string[] = [];

  registerDaemonCommands(
    {
      registerCommand(name, options) {
        commands.set(name, options);
      },
    },
    {
      config: makeConfig(),
      registry: () => undefined,
      server: () => undefined,
      services: () =>
        ({
          recordCommand(command: string, surface: string) {
            calls.push(`command:${surface}:${command}`);
          },
          last(selector: string) {
            calls.push(`last:${selector}`);
            return "last";
          },
          setWatch(selector: string, watch: boolean) {
            calls.push(`watch:${selector}:${watch}`);
            return { shortId: 1, name: "worker" };
          },
          rename(selector: string, name: string) {
            calls.push(`rename:${selector}:${name}`);
            return Promise.resolve({ shortId: 1, name });
          },
        }) as unknown as BakerServices,
    },
  );

  const ctx = {
    ui: {
      notify(message: string) {
        notifications.push(message);
      },
    },
  };

  await commands.get("baker-ask").handler("", ctx);
  await commands.get("baker-watch").handler("worker maybe", ctx);
  await commands.get("baker-name").handler("worker", ctx);

  assert.deepEqual(notifications, [
    "usage: /baker-ask <session>",
    "usage: /baker-watch <session> on|off",
    "usage: /baker-name <session> <name>",
  ]);
  assert.deepEqual(calls, ["command:tui:baker-ask", "command:tui:baker-watch", "command:tui:baker-name"]);
});

test("member TUI fixed-form commands reject extra args", async () => {
  const commands = new Map<string, any>();
  const calls: string[] = [];
  const client = {
    status() {
      calls.push("status");
      return {
        enabled: true,
        connected: false,
        shortId: undefined,
        name: undefined,
        socketPath: "/tmp/pi-baker/baker.sock",
        daemonPid: undefined,
        pid: 123,
        cwd: "/tmp/project",
        sessionId: "session",
        sessionFile: undefined,
        sessionName: "member",
        state: "idle",
        model: undefined,
        spawned: false,
        spawnId: undefined,
        extensionVersion: "0.1.0",
      };
    },
    disable() {
      calls.push("disable");
    },
    enable() {
      calls.push("enable");
    },
  } as unknown as MemberClient;
  registerMemberCommands(
    {
      registerCommand(name, options) {
        commands.set(name, options);
      },
    },
    client,
    { ...makeConfig(), role: "member" },
  );

  const notifications: string[] = [];
  const ctx = {
    ui: {
      notify(message: string) {
        notifications.push(message);
      },
    },
  };

  await commands.get("baker-status").handler("extra", ctx);
  await commands.get("baker-setup").handler("extra", ctx);
  await commands.get("baker-disconnect").handler("extra", ctx);
  await commands.get("baker-connect").handler("extra", ctx);

  assert.deepEqual(notifications, ["usage: /baker-status", "usage: /baker-setup", "usage: /baker-disconnect", "usage: /baker-connect"]);
  assert.deepEqual(calls, []);
});

function makeConfig() {
  return {
    role: "daemon",
    bakerDir: "/tmp/pi-baker",
    socketPath: "/tmp/pi-baker/baker.sock",
    dbPath: "/tmp/pi-baker/baker.db",
    signalAccount: undefined,
    whitelist: new Set<string>(),
    signalUrl: "http://127.0.0.1:51921",
    manageSignal: false,
    storeTurns: true,
    quiet: true,
    spawned: false,
  } as const;
}

function makeHello(sessionId: string, pid: number, cwd: string, name: string): HelloFrame {
  return {
    v: 1,
    type: "hello",
    sessionId,
    sessionName: name,
    cwd,
    pid,
    state: "idle",
    spawned: false,
    extensionVersion: "0.1.0",
  };
}
