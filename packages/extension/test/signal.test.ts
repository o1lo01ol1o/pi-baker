import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";

import { BakerRegistry } from "../src/daemon/registry.ts";
import { BakerServices } from "../src/daemon/services.ts";
import {
  SignalBridge,
  acceptSignalEnvelope,
  normalizeManagedSignalUrl,
  parseSignalEventData,
  parseSseMessages,
  prefixSessionReply,
  signalCliHttpAddress,
  truncateSignalCommandText,
  truncateSignalText,
} from "../src/daemon/signal.ts";
import { ControlServer } from "../src/daemon/server.ts";
import type { BakerConfig } from "../src/config.ts";
import type { HelloFrame } from "../src/protocol.ts";

test("acceptSignalEnvelope accepts Note-to-Self and whitelisted direct messages only", () => {
  const config = makeConfig("http://127.0.0.1:1");

  const note = acceptSignalEnvelope(
    {
      syncMessage: {
        sentMessage: {
          destinationNumber: "+15550001",
          message: "/status",
          timestamp: 10,
        },
      },
    },
    config,
  );
  assert.equal(note?.body, "/status");
  assert.equal(note?.conversation.noteToSelf, true);

  const wrappedNote = acceptSignalEnvelope(
    {
      account: "+15550001",
      envelope: {
        syncMessage: {
          sentMessage: {
            destination: "+15550001",
            message: "/help",
            timestamp: "11",
            attachments: [],
            contacts: [],
          },
        },
      },
    },
    config,
  );
  assert.equal(wrappedNote?.body, "/help");
  assert.equal(wrappedNote?.conversation.noteToSelf, true);
  assert.equal(wrappedNote?.reactionTarget?.timestamp, 11);

  const paddedNote = acceptSignalEnvelope(
    {
      syncMessage: {
        sentMessage: {
          destinationNumber: "+15550001",
          message: "  /status  ",
          timestamp: 12,
        },
      },
    },
    config,
  );
  assert.equal(paddedNote?.body, "/status");

  const noteGroup = acceptSignalEnvelope(
    {
      syncMessage: {
        sentMessage: {
          destinationNumber: "+15550001",
          message: "/status",
          timestamp: 15,
          groupInfo: { groupId: "group-1" },
        },
      },
    },
    config,
  );
  assert.equal(noteGroup, undefined);

  const noteWithAttachment = acceptSignalEnvelope(
    {
      syncMessage: {
        sentMessage: {
          destinationNumber: "+15550001",
          message: "/status",
          timestamp: 16,
          attachments: [{ id: "attachment-1" }],
        },
      },
    },
    config,
  );
  assert.equal(noteWithAttachment, undefined);

  const noteWithSticker = acceptSignalEnvelope(
    {
      syncMessage: {
        sentMessage: {
          destinationNumber: "+15550001",
          message: "/status",
          timestamp: 17,
          sticker: { id: "sticker-1" },
        },
      },
    },
    config,
  );
  assert.equal(noteWithSticker, undefined);

  const direct = acceptSignalEnvelope(
    {
      sourceNumber: "+15550002",
      dataMessage: {
        message: "/sessions",
        timestamp: 20,
      },
    },
    config,
  );
  assert.equal(direct?.body, "/sessions");
  assert.equal(direct?.conversation.recipient, "+15550002");

  const directWithCanonicalEmptyCollections = acceptSignalEnvelope(
    {
      envelope: {
        source: "+15550002",
        dataMessage: {
          message: "/status",
          timestamp: 21,
          attachments: [],
          contacts: [],
          mentions: [],
        },
      },
    },
    config,
  );
  assert.equal(directWithCanonicalEmptyCollections?.body, "/status");
  assert.equal(directWithCanonicalEmptyCollections?.conversation.recipient, "+15550002");

  const rejected = acceptSignalEnvelope(
    {
      sourceNumber: "+15559999",
      dataMessage: {
        message: "/sessions",
        timestamp: 30,
      },
    },
    config,
  );
  assert.equal(rejected, undefined);

  const groupWithDataMessageMetadata = acceptSignalEnvelope(
    {
      sourceNumber: "+15550002",
      dataMessage: {
        message: "/status",
        timestamp: 40,
        groupInfo: { groupId: "group-1" },
      },
    },
    config,
  );
  assert.equal(groupWithDataMessageMetadata, undefined);

  const groupWithEnvelopeMetadata = acceptSignalEnvelope(
    {
      sourceNumber: "+15550002",
      groupV2: { masterKey: "group-key" },
      dataMessage: {
        message: "/status",
        timestamp: 50,
      },
    },
    config,
  );
  assert.equal(groupWithEnvelopeMetadata, undefined);

  const directWithAttachment = acceptSignalEnvelope(
    {
      sourceNumber: "+15550002",
      dataMessage: {
        message: "/status",
        timestamp: 60,
        attachments: [{ id: "attachment-1", contentType: "text/plain" }],
      },
    },
    config,
  );
  assert.equal(directWithAttachment, undefined);

  const directWithVoiceNote = acceptSignalEnvelope(
    {
      sourceNumber: "+15550002",
      dataMessage: {
        message: "/status",
        timestamp: 70,
        attachments: [{ id: "voice-1", contentType: "audio/aac", voiceNote: true }],
      },
    },
    config,
  );
  assert.equal(directWithVoiceNote, undefined);

  const directWithReactionPayload = acceptSignalEnvelope(
    {
      sourceNumber: "+15550002",
      dataMessage: {
        message: "/status",
        timestamp: 80,
        reaction: { targetSentTimestamp: 10 },
      },
    },
    config,
  );
  assert.equal(directWithReactionPayload, undefined);

  const directWithEnvelopeAttachment = acceptSignalEnvelope(
    {
      sourceNumber: "+15550002",
      attachments: [{ id: "envelope-attachment" }],
      dataMessage: {
        message: "/status",
        timestamp: 90,
      },
    },
    config,
  );
  assert.equal(directWithEnvelopeAttachment, undefined);
});

test("parseSseMessages extracts data events and keeps incomplete remainder", () => {
  const parsed = parseSseMessages('event: message\ndata: {"a":1}\n\n: keepalive\n\ndata: {"b":');
  assert.deepEqual(parsed.messages, ['{"a":1}']);
  assert.equal(parsed.remainder, 'data: {"b":');

  const crlf = parseSseMessages('event: message\r\ndata: {"c":3}\r\n\r\ndata: {"d":');
  assert.deepEqual(crlf.messages, ['{"c":3}']);
  assert.equal(crlf.remainder, 'data: {"d":');
});

test("parseSignalEventData normalizes signal-cli event wrappers and ignores malformed bodies", () => {
  assert.deepEqual(parseSignalEventData('{"ok":true}'), { ok: true });
  assert.deepEqual(parseSignalEventData('{"account":"+15550001","envelope":{"syncMessage":{}}}'), { syncMessage: {} });
  assert.deepEqual(parseSignalEventData('{"method":"receive","params":{"envelope":{"dataMessage":{"message":"hi"}}}}'), {
    dataMessage: { message: "hi" },
  });
  assert.deepEqual(
    parseSignalEventData('{"method":"receive","params":{"result":{"envelope":{"dataMessage":{"message":"subscribed"}}}}}'),
    { dataMessage: { message: "subscribed" } },
  );
  assert.equal(parseSignalEventData('{"bad"'), undefined);
});

test("Signal reply truncation stays within the limit and includes recovery commands", () => {
  const sessionReply = prefixSessionReply(3, "worker", "x".repeat(4_000));
  assert.equal(sessionReply.length, 3_000);
  assert.ok(sessionReply.endsWith("\u2026 (truncated, /ask 3 for last message)"));

  const daemonReply = truncateSignalText("x".repeat(200), 80);
  assert.equal(daemonReply.length, 80);
  assert.ok(daemonReply.endsWith("\u2026 (truncated, /resend for last reply)"));

  const commandReply = truncateSignalCommandText("x".repeat(200), 80);
  assert.equal(commandReply.length, 80);
  assert.ok(commandReply.endsWith("\u2026 (truncated)"));
});

test("managed signal-cli URLs bind to loopback", () => {
  assert.equal(normalizeManagedSignalUrl("http://0.0.0.0:9090"), "http://127.0.0.1:9090/");
  assert.equal(normalizeManagedSignalUrl("http://192.0.2.1:51921"), "http://127.0.0.1:51921/");
  assert.equal(normalizeManagedSignalUrl("http://localhost:51921"), "http://localhost:51921/");
  assert.equal(signalCliHttpAddress(normalizeManagedSignalUrl("http://0.0.0.0:9090")), "127.0.0.1:9090");
});

test("SignalBridge force-kills managed signal-cli child on stop when it ignores SIGTERM", async () => {
  const fake = await startFakeSignalCli();
  const child = new FakeSignalCliChild();
  const spawns: Array<{ command: string; args: string[] }> = [];
  const bridge = new SignalBridge({
    config: { ...makeConfig(fake.url), manageSignal: true },
    services: () => undefined,
    sendUserMessage() {},
    spawnImpl(command, args) {
      spawns.push({ command, args });
      return child as any;
    },
    childKillMs: 10,
  });

  try {
    await bridge.start();
    assert.equal(spawns[0]?.command, "signal-cli");
    assert.deepEqual(spawns[0]?.args, ["-a", "+15550001", "daemon", "--http", signalCliHttpAddress(fake.url)]);

    await bridge.stop();

    assert.deepEqual(child.signals, ["SIGTERM", "SIGKILL"]);
    assert.equal(bridge.status().running, false);
    assert.notEqual(bridge.status().lastError, "signal-cli exited");
  } finally {
    await bridge.stop();
    await fake.stop();
  }
});

test("SignalBridge force-kills a restarted signal-cli child when health never comes up", async () => {
  const fake = await startFakeSignalCli();
  const children: FakeSignalCliChild[] = [];
  const bridge = new SignalBridge({
    config: { ...makeConfig(fake.url), manageSignal: true },
    services: () => undefined,
    sendUserMessage() {},
    spawnImpl() {
      const child = new FakeSignalCliChild();
      children.push(child);
      return child as any;
    },
    childKillMs: 5,
    healthDeadlineMs: 20,
    healthRetryMs: 1,
  });
  (bridge as any).signalRestartDelayMs = 1;

  try {
    await bridge.start();
    assert.equal(children.length, 1);

    fake.setCheckStatus(503);
    children[0]?.emit("exit", 1, null);

    await waitFor(() => children.length >= 2);
    await waitFor(() => children[1]?.signals.includes("SIGKILL") === true);

    assert.deepEqual(children[1]?.signals, ["SIGTERM", "SIGKILL"]);
    assert.equal(bridge.status().running, true);
    assert.equal(bridge.status().connected, false);
    assert.match(bridge.status().lastError ?? "", /signal-cli health check failed: 503/);
  } finally {
    await bridge.stop();
    await fake.stop();
  }
});

test("SignalBridge restarts managed signal-cli after exit and reconnects", async () => {
  const fake = await startFakeSignalCli();
  const children: FakeSignalCliChild[] = [];
  const bridge = new SignalBridge({
    config: { ...makeConfig(fake.url), manageSignal: true },
    services: () => undefined,
    sendUserMessage() {},
    spawnImpl() {
      const child = new FakeSignalCliChild();
      children.push(child);
      return child as any;
    },
    childKillMs: 5,
    healthDeadlineMs: 50,
    healthRetryMs: 1,
  });
  (bridge as any).signalRestartDelayMs = 1;

  try {
    await bridge.start();
    assert.equal(children.length, 1);
    assert.equal(bridge.status().connected, true);

    children[0]?.emit("exit", 0, null);

    await waitFor(() => children.length >= 2);
    await waitFor(() => bridge.status().connected === true);

    assert.equal(bridge.status().running, true);
    assert.equal(bridge.status().lastError, undefined);
    assert.equal((bridge as any).signalRestartDelayMs, 1_000);
  } finally {
    await bridge.stop();
    await fake.stop();
  }
});

test("SignalBridge keeps externally managed signal-cli URLs on loopback", async () => {
  const urls: string[] = [];
  const bridge = new SignalBridge({
    config: makeConfig("http://192.0.2.44:9090"),
    services: () => undefined,
    sendUserMessage() {},
    fetchImpl(input) {
      urls.push(String(input));
      return Promise.resolve(new Response(null, { status: 200 }));
    },
  });

  try {
    await bridge.start();
    assert.equal(urls[0], "http://127.0.0.1:9090/api/v1/check");
  } finally {
    await bridge.stop();
  }
});

test("SignalBridge handles slash commands with reactions over fake signal-cli HTTP", async () => {
  const fake = await startFakeSignalCli();
  const registry = new BakerRegistry(":memory:");
  const server = new ControlServer({ socketPath: "/tmp/pi-baker-unused.sock", registry });
  const services = new BakerServices(registry, server);
  registry.upsertDaemon(makeHello("daemon", 1, "daemon"));
  registry.upsertHello(makeHello("member", 2, "refactor"), "member");

  const bridge = new SignalBridge({
    config: makeConfig(fake.url),
    services: () => services,
    sendUserMessage() {
      throw new Error("slash command should not prompt daemon");
    },
  });

  try {
    await bridge.start();
    await fake.send({
      sourceNumber: "+15550002",
      dataMessage: {
        message: "/sessions all",
        timestamp: 101,
      },
    });

    await waitFor(() => fake.posts.length === 3);
    const methods = fake.posts.map((post) => post.method);
    assert.deepEqual(methods, ["sendReaction", "send", "sendReaction"]);
    const send = fake.posts.find((post) => post.method === "send");
    assert.match(String(send?.params.message), /#1 refactor/);
    assert.equal(bridge.status().ignored, 0);
    const commandEvent = registry.listEvents().at(-1);
    assert.equal(commandEvent?.type, "command");
    assert.deepEqual(commandEvent?.detail, { command: "sessions", surface: "signal" });

    const beforeErrorPosts = fake.posts.length;
    await fake.send({
      sourceNumber: "+15550002",
      dataMessage: {
        message: "/sessions all secret-argument",
        timestamp: 102,
      },
    });
    await waitFor(() => fake.posts.length === beforeErrorPosts + 3);
    const errorPosts = fake.posts.slice(beforeErrorPosts);
    assert.deepEqual(
      errorPosts.map((post) => post.method),
      ["sendReaction", "send", "sendReaction"],
    );
    const errorSend = errorPosts.find((post) => post.method === "send");
    assert.equal(errorSend?.params.message, "error: usage: /sessions [all]");
    const errorCommandEvent = registry.listEvents().at(-1);
    assert.equal(errorCommandEvent?.type, "command");
    assert.deepEqual(errorCommandEvent?.detail, { command: "sessions", surface: "signal" });
    assert.doesNotMatch(JSON.stringify(registry.listEvents()), /secret-argument/);

    await fake.send({
      sourceNumber: "+15559999",
      dataMessage: {
        message: "/status",
        timestamp: 103,
      },
    });
    await waitFor(() => bridge.status().ignored === 1);
    assert.equal(fake.posts.length, 6);

    await fake.send({
      sourceNumber: "+15550002",
      dataMessage: {
        message: "/status",
        timestamp: 104,
        attachments: [{ id: "attachment-1" }],
      },
    });
    await waitFor(() => bridge.status().ignored === 2);
    assert.equal(fake.posts.length, 6);
  } finally {
    await bridge.stop();
    registry.close();
    await fake.stop();
  }
});

test("SignalBridge truncates long slash command responses before sending to Signal", async () => {
  const fake = await startFakeSignalCli();
  const registry = new BakerRegistry(":memory:");
  const server = new ControlServer({ socketPath: "/tmp/pi-baker-unused.sock", registry });
  const services = new BakerServices(registry, server);
  registry.upsertDaemon(makeHello("daemon", 1, "daemon"));
  for (let index = 0; index < 90; index += 1) {
    registry.upsertHello(
      {
        ...makeHello(`member-${index}`, 100 + index, `worker-${index}`),
        cwd: `/tmp/pi-baker-long-command-response/${index}/` + "x".repeat(60),
        model: `provider/model-${index}`,
      },
      "member",
    );
  }
  const bridge = new SignalBridge({
    config: makeConfig(fake.url),
    services: () => services,
    sendUserMessage() {
      throw new Error("slash command should not prompt daemon");
    },
  });

  try {
    await bridge.start();
    await bridge.handleEnvelope({
      sourceNumber: "+15550002",
      dataMessage: {
        message: "/sessions all",
        timestamp: 104,
      },
    });

    await waitFor(() => fake.posts.some((post) => post.method === "send"));
    const send = fake.posts.find((post) => post.method === "send");
    assert.equal(send?.params.message.length, 3_000);
    assert.ok(String(send?.params.message).endsWith("\u2026 (truncated)"));
  } finally {
    await bridge.stop();
    registry.close();
    await fake.stop();
  }
});

test("SignalBridge keeps the event stream alive after malformed SSE data", async () => {
  const fake = await startFakeSignalCli();
  const bridge = new SignalBridge({
    config: makeConfig(fake.url),
    services: () => undefined,
    sendUserMessage() {
      throw new Error("slash command should not prompt daemon");
    },
    getDaemonInfo: () => ({
      cwd: "/tmp/project",
      model: "provider/current",
    }),
  });

  try {
    await bridge.start();
    await fake.sendRaw('data: {"bad"\n\n');
    await waitFor(() => bridge.status().ignored === 1);
    assert.equal(bridge.status().connected, true);
    assert.equal(bridge.status().lastError, "ignored malformed signal-cli event");

    await fake.send({
      sourceNumber: "+15550002",
      dataMessage: {
        message: "/whoami",
        timestamp: 104,
      },
    });

    await waitFor(() => fake.posts.some((post) => post.method === "send"));
    const send = fake.posts.find((post) => post.method === "send");
    assert.match(String(send?.params.message), /model: provider\/current/);
  } finally {
    await bridge.stop();
    await fake.stop();
  }
});

test("SignalBridge start cleans up running state when health verification fails", async () => {
  const fake = await startFakeSignalCli();
  fake.setCheckStatus(503);
  const bridge = new SignalBridge({
    config: makeConfig(fake.url),
    services: () => undefined,
    sendUserMessage() {},
  });

  try {
    await assert.rejects(() => bridge.start(), /signal-cli health check failed: 503/);
    assert.equal(bridge.status().running, false);
    assert.equal(bridge.status().connected, false);
    assert.equal(bridge.status().lastError, "signal-cli health check failed: 503");
  } finally {
    await bridge.stop();
    await fake.stop();
  }
});

test("SignalBridge start requires a configured Signal account", async () => {
  const bridge = new SignalBridge({
    config: {
      ...makeConfig("http://127.0.0.1:1"),
      signalAccount: undefined,
    },
    services: () => undefined,
    sendUserMessage() {},
  });

  await assert.rejects(() => bridge.start(), /missing PI_BAKER_SIGNAL_ACCOUNT/);
  assert.equal(bridge.status().running, false);
  assert.equal(bridge.status().connected, false);
  assert.equal(bridge.status().lastError, "missing PI_BAKER_SIGNAL_ACCOUNT");
});

test("SignalBridge sendFromTool requires a configured Signal account", async () => {
  const bridge = new SignalBridge({
    config: {
      ...makeConfig("http://127.0.0.1:1"),
      signalAccount: undefined,
    },
    services: () => undefined,
    sendUserMessage() {},
  });

  await assert.rejects(() => bridge.sendFromTool("hello", "+15550002"), /Signal account is not configured/);
});

test("SignalBridge sendFromTool normalizes authorized sends and rejects unsafe inputs", async () => {
  const fake = await startFakeSignalCli();
  const bridge = new SignalBridge({
    config: makeConfig(fake.url),
    services: () => undefined,
    sendUserMessage() {},
  });

  try {
    await bridge.start();

    assert.equal(await bridge.sendFromTool("  hello operator  ", " +15550002 "), "sent Signal message to +15550002");
    await waitFor(() => fake.posts.some((post) => post.method === "send"));
    const send = fake.posts.find((post) => post.method === "send");
    assert.equal(send?.params.recipients?.[0], "+15550002");
    assert.equal(send?.params.message, "hello operator");

    await assert.rejects(() => bridge.sendFromTool("   ", "+15550002"), /Signal message text is required/);
    await assert.rejects(() => bridge.sendFromTool("hello", " +15559999 "), /recipient is not authorized/);
    assert.equal(fake.posts.filter((post) => post.method === "send").length, 1);
  } finally {
    await bridge.stop();
    await fake.stop();
  }
});

test("SignalBridge sendFromTool defaults to the conversation driving the daemon turn", async () => {
  const fake = await startFakeSignalCli();
  const prompts: string[] = [];
  const bridge = new SignalBridge({
    config: {
      ...makeConfig(fake.url),
      whitelist: new Set(["+15550002", "+15550003"]),
    },
    services: () => undefined,
    sendUserMessage(text) {
      prompts.push(text);
    },
  });

  try {
    await bridge.handleEnvelope({
      sourceNumber: "+15550002",
      dataMessage: {
        message: "first operator prompt",
        timestamp: 10,
      },
    });
    await bridge.handleEnvelope({
      sourceNumber: "+15550003",
      dataMessage: {
        message: "second operator prompt",
        timestamp: 20,
      },
    });
    assert.deepEqual(prompts, ["first operator prompt", "second operator prompt"]);

    assert.equal(await bridge.sendFromTool("tool reply for first"), "sent Signal message to +15550002");
    await bridge.handleDaemonTurn("daemon reply for first");
    assert.equal(await bridge.sendFromTool("tool reply for second"), "sent Signal message to +15550003");
    await bridge.handleDaemonTurn("daemon reply for second");
    assert.equal(await bridge.sendFromTool("tool reply after queue"), "sent Signal message to +15550001");

    const sendForFirst = fake.posts.find((post) => post.method === "send" && post.params.message === "tool reply for first");
    const sendForSecond = fake.posts.find((post) => post.method === "send" && post.params.message === "tool reply for second");
    const sendAfterQueue = fake.posts.find((post) => post.method === "send" && post.params.message === "tool reply after queue");
    assert.equal(sendForFirst?.params.recipients?.[0], "+15550002");
    assert.equal(sendForSecond?.params.recipients?.[0], "+15550003");
    assert.equal(sendAfterQueue?.params.recipients?.[0], "+15550001");
  } finally {
    await bridge.stop();
    await fake.stop();
  }
});

test("SignalBridge status command uses live session detail for a selector", async () => {
  const fake = await startFakeSignalCli();
  const calls: string[] = [];
  const services = {
    recordCommand(command: string, surface: string) {
      calls.push(`command:${surface}:${command}`);
    },
    liveStatusText(selector: string) {
      calls.push(`status:${selector}`);
      return Promise.resolve("#1 worker\nstate: busy\nwatch: on");
    },
  } as unknown as BakerServices;
  const bridge = new SignalBridge({
    config: makeConfig(fake.url),
    services: () => services,
    sendUserMessage() {
      throw new Error("slash command should not prompt daemon");
    },
  });

  try {
    await bridge.start();
    await bridge.handleEnvelope({
      sourceNumber: "+15550002",
      dataMessage: {
        message: "  /status worker  ",
        timestamp: 151,
      },
    });

    await waitFor(() => fake.posts.some((post) => post.method === "send"));
    const send = fake.posts.find((post) => post.method === "send");
    assert.equal(send?.params.message, "#1 worker\nstate: busy\nwatch: on");
    assert.deepEqual(calls, ["command:signal:status", "status:worker"]);
  } finally {
    await bridge.stop();
    await fake.stop();
  }
});

test("SignalBridge name command delegates session rename", async () => {
  const fake = await startFakeSignalCli();
  const calls: string[] = [];
  const services = {
    recordCommand(command: string, surface: string) {
      calls.push(`command:${surface}:${command}`);
    },
    rename(selector: string, name: string) {
      calls.push(`rename:${selector}:${name}`);
      return Promise.resolve({
        shortId: 4,
        sessionId: "worker-session",
        sessionFile: undefined,
        name: "renamed-worker",
        cwd: "/tmp/worker",
        pid: 123,
        kind: "member",
        model: undefined,
        state: "idle",
        connected: true,
        watch: false,
        lastTurn: undefined,
        firstSeen: "2026-07-13T00:00:00.000Z",
        lastSeen: "2026-07-13T00:00:00.000Z",
      });
    },
  } as unknown as BakerServices;
  const bridge = new SignalBridge({
    config: makeConfig(fake.url),
    services: () => services,
    sendUserMessage() {
      throw new Error("slash command should not prompt daemon");
    },
  });

  try {
    await bridge.start();
    await bridge.handleEnvelope({
      sourceNumber: "+15550002",
      dataMessage: {
        message: "/name worker renamed worker",
        timestamp: 161,
      },
    });

    await waitFor(() => fake.posts.some((post) => post.method === "send"));
    assert.deepEqual(fake.posts.map((post) => post.method), ["sendReaction", "send", "sendReaction"]);
    const send = fake.posts.find((post) => post.method === "send");
    assert.equal(send?.params.message, "renamed #4 renamed-worker");
    assert.deepEqual(calls, ["command:signal:name", "rename:worker:renamed worker"]);
  } finally {
    await bridge.stop();
    await fake.stop();
  }
});

test("SignalBridge treats unknown slash commands as errors", async () => {
  const fake = await startFakeSignalCli();
  const bridge = new SignalBridge({
    config: makeConfig(fake.url),
    services: () => undefined,
    sendUserMessage() {
      throw new Error("slash command should not prompt daemon");
    },
  });

  try {
    await bridge.start();
    await bridge.handleEnvelope({
      sourceNumber: "+15550002",
      dataMessage: {
        message: "/bogus",
        timestamp: 181,
      },
    });

    await waitFor(() => fake.posts.filter((post) => post.method === "send").length === 1);
    assert.deepEqual(fake.posts.map((post) => post.method), ["sendReaction", "send", "sendReaction"]);
    const send = fake.posts.find((post) => post.method === "send");
    assert.equal(send?.params.message, "error: unknown command /bogus; try /help");
    const reactions = fake.posts.filter((post) => post.method === "sendReaction");
    assert.equal(reactions[0]?.params.emoji, "\u{1F440}");
    assert.equal(reactions[1]?.params.emoji, "\u{274C}");
  } finally {
    await bridge.stop();
    await fake.stop();
  }
});

test("SignalBridge does not persist unknown slash command names", async () => {
  const fake = await startFakeSignalCli();
  const registry = new BakerRegistry(":memory:");
  const server = new ControlServer({ socketPath: "/tmp/pi-baker-unused.sock", registry });
  const services = new BakerServices(registry, server);
  registry.upsertDaemon(makeHello("daemon", 1, "daemon"));
  const beforeEvents = registry.countEvents();
  const bridge = new SignalBridge({
    config: makeConfig(fake.url),
    services: () => services,
    sendUserMessage() {
      throw new Error("slash command should not prompt daemon");
    },
  });

  try {
    await bridge.start();
    await bridge.handleEnvelope({
      sourceNumber: "+15550002",
      dataMessage: {
        message: "/super-secret-token",
        timestamp: 182,
      },
    });

    await waitFor(() => fake.posts.some((post) => post.method === "send"));
    const send = fake.posts.find((post) => post.method === "send");
    assert.equal(send?.params.message, "error: unknown command /super-secret-token; try /help");
    assert.equal(registry.countEvents(), beforeEvents);
    assert.doesNotMatch(JSON.stringify(registry.listEvents()), /super-secret-token/);
  } finally {
    await bridge.stop();
    registry.close();
    await fake.stop();
  }
});

test("SignalBridge rejects extra args for fixed-form slash commands", async () => {
  const fake = await startFakeSignalCli();
  const calls: string[] = [];
  const services = {
    recordCommand(command: string, surface: string) {
      calls.push(`command:${surface}:${command}`);
    },
    resolveSelector() {
      calls.push("resolve");
      throw new Error("selector should not be resolved after usage failure");
    },
    last() {
      calls.push("last");
      return "last";
    },
    setWatchTargets() {
      calls.push("watch");
    },
  } as unknown as BakerServices;
  const clearCalls: string[] = [];
  const bridge = new SignalBridge({
    config: makeConfig(fake.url),
    services: () => services,
    sendUserMessage() {
      throw new Error("slash command should not prompt daemon");
    },
    clearDaemonSession: async () => {
      clearCalls.push("clear");
      return "cleared";
    },
  });

  try {
    await bridge.start();
    await bridge.handleEnvelope({
      sourceNumber: "+15550002",
      dataMessage: {
        message: "/ask me extra",
        timestamp: 183,
      },
    });

    await waitFor(() => fake.posts.filter((post) => post.method === "send").length === 1);
    const askSend = fake.posts.find((post) => post.method === "send");
    assert.equal(askSend?.params.message, "error: usage: /ask <session>");

    const beforeWatchPosts = fake.posts.length;
    await bridge.handleEnvelope({
      sourceNumber: "+15550002",
      dataMessage: {
        message: "/watch me on extra",
        timestamp: 184,
      },
    });

    await waitFor(() => fake.posts.length === beforeWatchPosts + 3);
    const watchPosts = fake.posts.slice(beforeWatchPosts);
    const watchSend = watchPosts.find((post) => post.method === "send");
    assert.equal(watchSend?.params.message, "error: usage: /watch <session> on|off");
    assert.deepEqual(calls, ["command:signal:ask", "command:signal:watch"]);

    const beforePausePosts = fake.posts.length;
    await bridge.handleEnvelope({
      sourceNumber: "+15550002",
      dataMessage: {
        message: "/pause extra",
        timestamp: 185,
      },
    });

    await waitFor(() => fake.posts.length === beforePausePosts + 3);
    const pausePosts = fake.posts.slice(beforePausePosts);
    const pauseSend = pausePosts.find((post) => post.method === "send");
    assert.equal(pauseSend?.params.message, "error: usage: /pause");
    assert.equal(bridge.status().paused, false);

    const beforeClearPosts = fake.posts.length;
    await bridge.handleEnvelope({
      sourceNumber: "+15550002",
      dataMessage: {
        message: "/clear extra",
        timestamp: 186,
      },
    });

    await waitFor(() => fake.posts.length === beforeClearPosts + 3);
    const clearPosts = fake.posts.slice(beforeClearPosts);
    const clearSend = clearPosts.find((post) => post.method === "send");
    assert.equal(clearSend?.params.message, "error: usage: /clear");
    assert.deepEqual(clearCalls, []);
    assert.deepEqual(calls, ["command:signal:ask", "command:signal:watch", "command:signal:pause", "command:signal:clear"]);
  } finally {
    await bridge.stop();
    await fake.stop();
  }
});

test("SignalBridge still attempts error reactions when error text send fails", async () => {
  const fake = await startFakeSignalCli();
  fake.setRpcFailure("send", 503);
  const bridge = new SignalBridge({
    config: makeConfig(fake.url),
    services: () => undefined,
    sendUserMessage() {
      throw new Error("slash command should not prompt daemon");
    },
  });

  try {
    await bridge.start();
    await assert.doesNotReject(() =>
      bridge.handleEnvelope({
        sourceNumber: "+15550002",
        dataMessage: {
          message: "/bogus",
          timestamp: 182,
        },
      }),
    );

    await waitFor(() => fake.posts.filter((post) => post.method === "sendReaction").length === 2);
    assert.deepEqual(fake.posts.map((post) => post.method), ["sendReaction", "send", "sendReaction"]);
    const reactions = fake.posts.filter((post) => post.method === "sendReaction");
    assert.equal(reactions[0]?.params.emoji, "\u{1F440}");
    assert.equal(reactions[1]?.params.emoji, "\u{274C}");
    assert.equal(bridge.status().lastError, "signal-cli rpc send failed: 503");
  } finally {
    await bridge.stop();
    await fake.stop();
  }
});

test("SignalBridge keeps handling commands when reaction RPCs fail", async () => {
  const fake = await startFakeSignalCli();
  fake.setRpcFailure("sendReaction", 503);
  const registry = new BakerRegistry(":memory:");
  const server = new ControlServer({ socketPath: "/tmp/pi-baker-unused.sock", registry });
  const services = new BakerServices(registry, server);
  registry.upsertDaemon(makeHello("daemon", 1, "daemon"));

  const bridge = new SignalBridge({
    config: makeConfig(fake.url),
    services: () => services,
    sendUserMessage() {
      throw new Error("slash command should not prompt daemon");
    },
  });

  try {
    await bridge.start();
    await bridge.handleEnvelope({
      sourceNumber: "+15550002",
      dataMessage: {
        message: "/sessions",
        timestamp: 171,
      },
    });

    await waitFor(() => fake.posts.some((post) => post.method === "send"));
    const send = fake.posts.find((post) => post.method === "send");
    assert.match(String(send?.params.message), /#0 daemon/);
    assert.equal(bridge.status().lastError, "signal-cli rpc sendReaction failed: 503");
  } finally {
    await bridge.stop();
    registry.close();
    await fake.stop();
  }
});

test("SignalBridge ask me returns daemon replies without a session prefix", async () => {
  const fake = await startFakeSignalCli();
  const calls: string[] = [];
  const services = {
    recordCommand(command: string, surface: string) {
      calls.push(`command:${surface}:${command}`);
    },
    resolveSelector(selector: string) {
      calls.push(`resolve:${selector}`);
      return {
        shortId: 0,
        sessionId: "daemon",
        sessionFile: undefined,
        name: "daemon",
        cwd: "/tmp/daemon",
        pid: 1,
        kind: "daemon",
        model: undefined,
        state: "idle",
        connected: true,
        watch: false,
        lastTurn: "daemon last reply",
        firstSeen: "2026-07-13T00:00:00.000Z",
        lastSeen: "2026-07-13T00:00:00.000Z",
      };
    },
    last(selector: string) {
      calls.push(`last:${selector}`);
      return "daemon last reply";
    },
  } as unknown as BakerServices;
  const bridge = new SignalBridge({
    config: makeConfig(fake.url),
    services: () => services,
    sendUserMessage() {
      throw new Error("slash command should not prompt daemon");
    },
  });

  try {
    await bridge.start();
    await bridge.handleEnvelope({
      syncMessage: {
        sentMessage: {
          destinationNumber: "+15550001",
          message: "/ask me",
          timestamp: 191,
        },
      },
    });

    await waitFor(() => fake.posts.filter((post) => post.method === "send").length === 1);
    const send = fake.posts.find((post) => post.method === "send");
    assert.equal(send?.params.message, "daemon last reply");
    assert.deepEqual(calls, ["command:signal:ask", "resolve:me", "last:0"]);
  } finally {
    await bridge.stop();
    await fake.stop();
  }
});

test("SignalBridge watches daemon turns without duplicating pending replies", async () => {
  const fake = await startFakeSignalCli();
  const prompts: string[] = [];
  const calls: string[] = [];
  const services = {
    recordCommand(command: string, surface: string) {
      calls.push(`command:${surface}:${command}`);
    },
    resolveSelector(selector: string) {
      calls.push(`resolve:${selector}`);
      return {
        shortId: 0,
        sessionId: "daemon",
        sessionFile: undefined,
        name: "daemon",
        cwd: "/tmp/daemon",
        pid: 1,
        kind: "daemon",
        model: undefined,
        state: "idle",
        connected: true,
        watch: false,
        lastTurn: undefined,
        firstSeen: "2026-07-13T00:00:00.000Z",
        lastSeen: "2026-07-13T00:00:00.000Z",
      };
    },
    setWatchTargets(selector: string, recipients: Iterable<string>) {
      calls.push(`watch:${selector}:${[...recipients].join(",")}`);
    },
  } as unknown as BakerServices;
  const bridge = new SignalBridge({
    config: makeConfig(fake.url),
    services: () => services,
    sendUserMessage(text) {
      prompts.push(text);
    },
  });

  try {
    await bridge.start();
    await bridge.handleEnvelope({
      sourceNumber: "+15550002",
      dataMessage: {
        message: "/watch me on",
        timestamp: 211,
      },
    });

    await waitFor(() => fake.posts.filter((post) => post.method === "send").length === 1);
    assert.equal(fake.posts.filter((post) => post.method === "send")[0]?.params.message, "watch on for #0 daemon");

    await bridge.handleDaemonTurn("unprompted daemon turn");
    await waitFor(() => fake.posts.filter((post) => post.method === "send").length === 2);
    assert.equal(fake.posts.filter((post) => post.method === "send")[1]?.params.message, "unprompted daemon turn");

    await bridge.handleEnvelope({
      sourceNumber: "+15550002",
      dataMessage: {
        message: "plain daemon prompt",
        timestamp: 212,
      },
    });
    await waitFor(() => prompts.length === 1);
    await bridge.handleDaemonTurn("pending daemon reply");
    await waitFor(() => fake.posts.filter((post) => post.method === "send").length === 3);
    await new Promise((resolve) => setTimeout(resolve, 20));
    const sends = fake.posts.filter((post) => post.method === "send");
    assert.deepEqual(
      sends.map((send) => send.params.message),
      ["watch on for #0 daemon", "unprompted daemon turn", "pending daemon reply"],
    );
    assert.deepEqual(calls, ["command:signal:watch", "resolve:me", "watch:0:+15550002"]);
  } finally {
    await bridge.stop();
    await fake.stop();
  }
});

test("SignalBridge routes plain text to daemon and replies on agent_end", async () => {
  const fake = await startFakeSignalCli();
  const prompts: string[] = [];
  const bridge = new SignalBridge({
    config: makeConfig(fake.url),
    services: () => undefined,
    sendUserMessage(text) {
      prompts.push(text);
    },
  });

  try {
    await bridge.start();
    await fake.send({
      syncMessage: {
        sentMessage: {
          destinationNumber: "+15550001",
          message: "check the sessions",
          timestamp: 201,
        },
      },
    });

    await waitFor(() => prompts.length === 1);
    assert.deepEqual(prompts, ["check the sessions"]);
    assert.deepEqual(fake.posts.map((post) => post.method), ["sendReaction"]);

    await bridge.handleDaemonTurn("all quiet");
    await waitFor(() => fake.posts.length === 3);
    assert.deepEqual(fake.posts.map((post) => post.method), ["sendReaction", "send", "sendReaction"]);
    assert.equal(fake.posts[1]?.params.message, "all quiet");
    assert.equal(fake.posts[1]?.params.recipients?.[0], "+15550001");
  } finally {
    await bridge.stop();
    await fake.stop();
  }
});

test("SignalBridge runtime watch targets take effect immediately", async () => {
  const fake = await startFakeSignalCli();
  const bridge = new SignalBridge({
    config: makeConfig(fake.url),
    services: () => undefined,
    sendUserMessage() {},
  });

  try {
    await bridge.start();
    bridge.setWatchTarget(3, "+15550002", true);

    await bridge.handleMemberTurn(3, "worker", "watched turn");
    await waitFor(() => fake.posts.some((post) => post.method === "send"));
    const firstSend = fake.posts.find((post) => post.method === "send");
    assert.equal(firstSend?.params.recipients?.[0], "+15550002");
    assert.equal(firstSend?.params.message, "[#3 worker] watched turn");

    bridge.setWatchTarget(3, "+15550002", false);
    await bridge.handleMemberTurn(3, "worker", "unwatched turn");
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(fake.posts.filter((post) => post.method === "send").length, 1);
  } finally {
    await bridge.stop();
    await fake.stop();
  }
});

test("SignalBridge clears pending daemon replies when a turn has no assistant text", async () => {
  const fake = await startFakeSignalCli();
  const prompts: string[] = [];
  const bridge = new SignalBridge({
    config: makeConfig(fake.url),
    services: () => undefined,
    sendUserMessage(text) {
      prompts.push(text);
    },
  });

  try {
    await bridge.start();
    await fake.send({
      sourceNumber: "+15550002",
      dataMessage: {
        message: "this turn will produce no assistant message",
        timestamp: 213,
      },
    });

    await waitFor(() => prompts.length === 1);
    assert.deepEqual(prompts, ["this turn will produce no assistant message"]);
    assert.deepEqual(fake.posts.map((post) => post.method), ["sendReaction"]);

    await bridge.handleDaemonTurnMissing();
    await waitFor(() => fake.posts.length === 3);
    assert.deepEqual(fake.posts.map((post) => post.method), ["sendReaction", "send", "sendReaction"]);
    assert.equal(fake.posts[1]?.params.recipients?.[0], "+15550002");
    assert.equal(fake.posts[1]?.params.message, "error: daemon turn ended without an assistant reply");
    assert.equal(fake.posts[2]?.params.emoji, "\u{274C}");

    await bridge.handleDaemonTurn("late daemon reply");
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(fake.posts.filter((post) => post.method === "send").length, 1);
  } finally {
    await bridge.stop();
    await fake.stop();
  }
});

test("SignalBridge rejects plain text while paused but keeps slash commands live", async () => {
  const fake = await startFakeSignalCli();
  const prompts: string[] = [];
  const bridge = new SignalBridge({
    config: makeConfig(fake.url),
    services: () => undefined,
    sendUserMessage(text) {
      prompts.push(text);
    },
  });

  try {
    await bridge.start();
    await fake.send({
      sourceNumber: "+15550002",
      dataMessage: {
        message: "/pause",
        timestamp: 221,
      },
    });
    await waitFor(
      () =>
        fake.posts.filter((post) => post.method === "send").length === 1 &&
        fake.posts.filter((post) => post.method === "sendReaction").length === 2,
    );
    assert.equal(fake.posts.filter((post) => post.method === "send")[0]?.params.message, "paused");
    assert.equal(bridge.status().paused, true);

    await fake.send({
      sourceNumber: "+15550002",
      dataMessage: {
        message: "please run this",
        timestamp: 222,
      },
    });
    await waitFor(
      () =>
        fake.posts.filter((post) => post.method === "send").length === 2 &&
        fake.posts.filter((post) => post.method === "sendReaction").length === 4,
    );
    const sends = fake.posts.filter((post) => post.method === "send");
    assert.equal(sends[1]?.params.message, "pi-baker is paused; slash commands still work.");
    assert.deepEqual(prompts, []);
    assert.equal(fake.posts.filter((post) => post.method === "sendReaction").at(-1)?.params.emoji, "\u{274C}");

    await fake.send({
      sourceNumber: "+15550002",
      dataMessage: {
        message: "/resume",
        timestamp: 223,
      },
    });
    await waitFor(
      () =>
        fake.posts.filter((post) => post.method === "send").length === 3 &&
        fake.posts.filter((post) => post.method === "sendReaction").length === 6,
    );
    assert.equal(fake.posts.filter((post) => post.method === "send")[2]?.params.message, "resumed");
    assert.equal(bridge.status().paused, false);
  } finally {
    await bridge.stop();
    await fake.stop();
  }
});

test("SignalBridge rolls back pending daemon replies when prompt injection fails", async () => {
  const fake = await startFakeSignalCli();
  const bridge = new SignalBridge({
    config: makeConfig(fake.url),
    services: () => undefined,
    sendUserMessage() {
      throw new Error("daemon refused prompt");
    },
  });

  try {
    await bridge.start();
    await fake.send({
      syncMessage: {
        sentMessage: {
          destinationNumber: "+15550001",
          message: "this will fail",
          timestamp: 221,
        },
      },
    });

    await waitFor(() => fake.posts.length === 3);
    assert.deepEqual(fake.posts.map((post) => post.method), ["sendReaction", "send", "sendReaction"]);
    const sendsAfterFailure = fake.posts.filter((post) => post.method === "send");
    assert.equal(sendsAfterFailure[0]?.params.message, "error: daemon refused prompt");

    await bridge.handleDaemonTurn("late daemon reply");
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(fake.posts.filter((post) => post.method === "send").length, 1);
  } finally {
    await bridge.stop();
    await fake.stop();
  }
});

test("SignalBridge rolls back pending daemon replies when async prompt injection fails", async () => {
  const fake = await startFakeSignalCli();
  const bridge = new SignalBridge({
    config: makeConfig(fake.url),
    services: () => undefined,
    sendUserMessage() {
      return Promise.reject(new Error("async daemon refused prompt"));
    },
  });

  try {
    await bridge.start();
    await fake.send({
      syncMessage: {
        sentMessage: {
          destinationNumber: "+15550001",
          message: "this will fail asynchronously",
          timestamp: 222,
        },
      },
    });

    await waitFor(() => fake.posts.length === 3);
    assert.deepEqual(fake.posts.map((post) => post.method), ["sendReaction", "send", "sendReaction"]);
    const sendsAfterFailure = fake.posts.filter((post) => post.method === "send");
    assert.equal(sendsAfterFailure[0]?.params.message, "error: async daemon refused prompt");

    await bridge.handleDaemonTurn("late daemon reply");
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(fake.posts.filter((post) => post.method === "send").length, 1);
  } finally {
    await bridge.stop();
    await fake.stop();
  }
});

test("SignalBridge acknowledges tell and relays the next member turn once", async () => {
  const fake = await startFakeSignalCli();
  const calls: string[] = [];
  const services = {
    resolveSelector(selector: string) {
      calls.push(`resolve:${selector}`);
      return {
        shortId: 1,
        sessionId: "member",
        sessionFile: undefined,
        name: "worker",
        cwd: "/tmp/worker",
        pid: 2,
        kind: "member",
        model: undefined,
        state: "idle",
        connected: true,
        watch: false,
        lastTurn: undefined,
        firstSeen: "2026-07-13T00:00:00.000Z",
        lastSeen: "2026-07-13T00:00:00.000Z",
      };
    },
    sendPrompt(selector: string, text: string, mode: string, wait: boolean) {
      calls.push(`prompt:${selector}:${text}:${mode}:${wait}`);
      return Promise.resolve("sent");
    },
  } as unknown as BakerServices;
  const bridge = new SignalBridge({
    config: makeConfig(fake.url),
    services: () => services,
    sendUserMessage() {
      throw new Error("slash command should not prompt daemon");
    },
  });

  try {
    await bridge.start();
    await bridge.handleEnvelope({
      sourceNumber: "+15550002",
      dataMessage: {
        message: "/tell worker go now",
        timestamp: 251,
      },
    });

    await waitFor(() => fake.posts.filter((post) => post.method === "send").length === 1);
    const sendsAfterTell = fake.posts.filter((post) => post.method === "send");
    assert.equal(sendsAfterTell[0]?.params.message, "sent to #1 worker; next turn will be relayed");
    assert.deepEqual(calls, ["resolve:worker", "prompt:worker:go now:followUp:false"]);
    assert.deepEqual(
      fake.posts.filter((post) => post.method === "sendReaction").map((post) => post.params.emoji),
      ["\u{1F440}"],
    );

    await bridge.handleMemberTurn(1, "worker", "done");
    await waitFor(() => fake.posts.filter((post) => post.method === "send").length === 2);
    const sendsAfterTurn = fake.posts.filter((post) => post.method === "send");
    assert.equal(sendsAfterTurn[1]?.params.message, "[#1 worker] done");
    assert.deepEqual(
      fake.posts.filter((post) => post.method === "sendReaction").map((post) => post.params.emoji),
      ["\u{1F440}", "\u{2705}"],
    );

    await bridge.handleMemberTurn(1, "worker", "again");
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(fake.posts.filter((post) => post.method === "send").length, 2);
  } finally {
    await bridge.stop();
    await fake.stop();
  }
});

test("SignalBridge collapses duplicate tell relays to a member for the same caller", async () => {
  const fake = await startFakeSignalCli();
  const calls: string[] = [];
  const services = {
    resolveSelector(selector: string) {
      calls.push(`resolve:${selector}`);
      return {
        shortId: 1,
        sessionId: "member",
        sessionFile: undefined,
        name: "worker",
        cwd: "/tmp/worker",
        pid: 2,
        kind: "member",
        model: undefined,
        state: "idle",
        connected: true,
        watch: false,
        lastTurn: undefined,
        firstSeen: "2026-07-13T00:00:00.000Z",
        lastSeen: "2026-07-13T00:00:00.000Z",
      };
    },
    sendPrompt(selector: string, text: string, mode: string, wait: boolean) {
      calls.push(`prompt:${selector}:${text}:${mode}:${wait}`);
      return Promise.resolve("sent");
    },
  } as unknown as BakerServices;
  const bridge = new SignalBridge({
    config: makeConfig(fake.url),
    services: () => services,
    sendUserMessage() {
      throw new Error("slash command should not prompt daemon");
    },
  });

  try {
    await bridge.start();
    await bridge.handleEnvelope({
      sourceNumber: "+15550002",
      dataMessage: {
        message: "/tell worker first nudge",
        timestamp: 261,
      },
    });
    await waitFor(() => fake.posts.filter((post) => post.method === "send").length === 1);

    await bridge.handleEnvelope({
      sourceNumber: "+15550002",
      dataMessage: {
        message: "/tell worker second nudge",
        timestamp: 262,
      },
    });
    await waitFor(() => fake.posts.filter((post) => post.method === "send").length === 2);

    await bridge.handleMemberTurn(1, "worker", "done once");
    await waitFor(() => fake.posts.filter((post) => post.method === "send").length === 3);

    const sends = fake.posts.filter((post) => post.method === "send").map((post) => post.params.message);
    assert.deepEqual(sends, [
      "sent to #1 worker; next turn will be relayed",
      "sent to #1 worker; next turn will be relayed",
      "[#1 worker] done once",
    ]);
    assert.deepEqual(calls, [
      "resolve:worker",
      "prompt:worker:first nudge:followUp:false",
      "resolve:worker",
      "prompt:worker:second nudge:followUp:false",
    ]);
    assert.deepEqual(
      fake.posts.filter((post) => post.method === "sendReaction").map((post) => post.params.emoji),
      ["\u{1F440}", "\u{1F440}", "\u{2705}", "\u{2705}"],
    );

    await bridge.handleMemberTurn(1, "worker", "would duplicate");
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(fake.posts.filter((post) => post.method === "send").length, 3);
  } finally {
    await bridge.stop();
    await fake.stop();
  }
});

test("SignalBridge delivers one member turn to multiple pending callers", async () => {
  const fake = await startFakeSignalCli();
  const calls: string[] = [];
  const services = {
    resolveSelector(selector: string) {
      calls.push(`resolve:${selector}`);
      return {
        shortId: 1,
        sessionId: "member",
        sessionFile: undefined,
        name: "worker",
        cwd: "/tmp/worker",
        pid: 2,
        kind: "member",
        model: undefined,
        state: "idle",
        connected: true,
        watch: false,
        lastTurn: undefined,
        firstSeen: "2026-07-13T00:00:00.000Z",
        lastSeen: "2026-07-13T00:00:00.000Z",
      };
    },
    sendPrompt(selector: string, text: string, mode: string, wait: boolean) {
      calls.push(`prompt:${selector}:${text}:${mode}:${wait}`);
      return Promise.resolve("sent");
    },
  } as unknown as BakerServices;
  const bridge = new SignalBridge({
    config: {
      ...makeConfig(fake.url),
      whitelist: new Set(["+15550002", "+15550003"]),
    },
    services: () => services,
    sendUserMessage() {
      throw new Error("slash command should not prompt daemon");
    },
  });

  try {
    await bridge.start();
    await bridge.handleEnvelope({
      sourceNumber: "+15550002",
      dataMessage: {
        message: "/tell worker first caller",
        timestamp: 271,
      },
    });
    await bridge.handleEnvelope({
      sourceNumber: "+15550003",
      dataMessage: {
        message: "/tell worker second caller",
        timestamp: 272,
      },
    });
    await waitFor(() => fake.posts.filter((post) => post.method === "send").length === 2);

    await bridge.handleMemberTurn(1, "worker", "shared result");
    await waitFor(() => fake.posts.filter((post) => post.method === "send").length === 4);

    const turnSends = fake.posts.filter((post) => post.method === "send" && post.params.message === "[#1 worker] shared result");
    assert.deepEqual(
      turnSends.map((post) => post.params.recipients?.[0]).sort(),
      ["+15550002", "+15550003"],
    );
    assert.deepEqual(calls, [
      "resolve:worker",
      "prompt:worker:first caller:followUp:false",
      "resolve:worker",
      "prompt:worker:second caller:followUp:false",
    ]);
    assert.deepEqual(
      fake.posts.filter((post) => post.method === "sendReaction").map((post) => post.params.emoji),
      ["\u{1F440}", "\u{1F440}", "\u{2705}", "\u{2705}"],
    );

    await bridge.handleMemberTurn(1, "worker", "late duplicate");
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(fake.posts.filter((post) => post.method === "send").length, 4);
  } finally {
    await bridge.stop();
    await fake.stop();
  }
});

test("SignalBridge marks pending member relay reactions when final delivery fails", async () => {
  const fake = await startFakeSignalCli();
  const services = {
    resolveSelector() {
      return {
        shortId: 1,
        sessionId: "member",
        sessionFile: undefined,
        name: "worker",
        cwd: "/tmp/worker",
        pid: 2,
        kind: "member",
        model: undefined,
        state: "idle",
        connected: true,
        watch: false,
        lastTurn: undefined,
        firstSeen: "2026-07-13T00:00:00.000Z",
        lastSeen: "2026-07-13T00:00:00.000Z",
      };
    },
    sendPrompt() {
      return Promise.resolve("sent");
    },
  } as unknown as BakerServices;
  const bridge = new SignalBridge({
    config: makeConfig(fake.url),
    services: () => services,
    sendUserMessage() {
      throw new Error("slash command should not prompt daemon");
    },
  });

  try {
    await bridge.start();
    await bridge.handleEnvelope({
      sourceNumber: "+15550002",
      dataMessage: {
        message: "/tell worker go now",
        timestamp: 259,
      },
    });

    await waitFor(() => fake.posts.filter((post) => post.method === "send").length === 1);
    assert.deepEqual(
      fake.posts.filter((post) => post.method === "sendReaction").map((post) => post.params.emoji),
      ["\u{1F440}"],
    );
    fake.setRpcFailure("send", 503);

    await bridge.handleMemberTurn(1, "worker", "done");
    await waitFor(() => fake.posts.filter((post) => post.method === "sendReaction").at(-1)?.params.emoji === "\u{274C}");
    assert.equal(bridge.status().lastError, "signal-cli rpc send failed: 503");

    fake.setRpcFailure("send", undefined);
    await bridge.handleMemberTurn(1, "worker", "late unrelated turn");
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(fake.posts.filter((post) => post.method === "send").length, 2);
  } finally {
    await bridge.stop();
    await fake.stop();
  }
});

test("SignalBridge clears pending member relays when the target disconnects", async () => {
  const fake = await startFakeSignalCli();
  const calls: string[] = [];
  const services = {
    resolveSelector(selector: string) {
      calls.push(`resolve:${selector}`);
      return {
        shortId: 1,
        sessionId: "member",
        sessionFile: undefined,
        name: "worker",
        cwd: "/tmp/worker",
        pid: 2,
        kind: "member",
        model: undefined,
        state: "idle",
        connected: true,
        watch: false,
        lastTurn: undefined,
        firstSeen: "2026-07-13T00:00:00.000Z",
        lastSeen: "2026-07-13T00:00:00.000Z",
      };
    },
    sendPrompt(selector: string, text: string, mode: string, wait: boolean) {
      calls.push(`prompt:${selector}:${text}:${mode}:${wait}`);
      return Promise.resolve("sent");
    },
  } as unknown as BakerServices;
  const bridge = new SignalBridge({
    config: makeConfig(fake.url),
    services: () => services,
    sendUserMessage() {
      throw new Error("slash command should not prompt daemon");
    },
  });

  try {
    await bridge.start();
    await bridge.handleEnvelope({
      sourceNumber: "+15550002",
      dataMessage: {
        message: "/tell worker go now",
        timestamp: 258,
      },
    });

    await waitFor(() => fake.posts.filter((post) => post.method === "send").length === 1);
    assert.deepEqual(calls, ["resolve:worker", "prompt:worker:go now:followUp:false"]);

    await bridge.handleMemberDisconnect(1, "worker", "session #1 disconnected before the next turn");
    await waitFor(() => fake.posts.filter((post) => post.method === "send").length === 2);
    const sends = fake.posts.filter((post) => post.method === "send");
    assert.equal(sends[0]?.params.message, "sent to #1 worker; next turn will be relayed");
    assert.equal(sends[1]?.params.recipients?.[0], "+15550002");
    assert.equal(sends[1]?.params.message, "[#1 worker] error: session #1 disconnected before the next turn");
    assert.equal(fake.posts.filter((post) => post.method === "sendReaction").at(-1)?.params.emoji, "\u{274C}");

    await bridge.handleMemberTurn(1, "worker", "late unrelated turn");
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(fake.posts.filter((post) => post.method === "send").length, 2);
  } finally {
    await bridge.stop();
    await fake.stop();
  }
});

test("SignalBridge tell to daemon relays the next daemon turn once", async () => {
  const fake = await startFakeSignalCli();
  const calls: string[] = [];
  const services = {
    resolveSelector(selector: string) {
      calls.push(`resolve:${selector}`);
      return {
        shortId: 0,
        sessionId: "daemon",
        sessionFile: undefined,
        name: "daemon",
        cwd: "/tmp/daemon",
        pid: 1,
        kind: "daemon",
        model: undefined,
        state: "idle",
        connected: true,
        watch: false,
        lastTurn: undefined,
        firstSeen: "2026-07-13T00:00:00.000Z",
        lastSeen: "2026-07-13T00:00:00.000Z",
      };
    },
    sendPrompt(selector: string, text: string, mode: string, wait: boolean) {
      calls.push(`prompt:${selector}:${text}:${mode}:${wait}`);
      return Promise.resolve("sent");
    },
  } as unknown as BakerServices;
  const bridge = new SignalBridge({
    config: makeConfig(fake.url),
    services: () => services,
    sendUserMessage() {
      throw new Error("slash command should use services");
    },
  });

  try {
    await bridge.start();
    await bridge.handleEnvelope({
      sourceNumber: "+15550002",
      dataMessage: {
        message: "/tell me inspect daemon",
        timestamp: 255,
      },
    });

    await waitFor(() => fake.posts.filter((post) => post.method === "send").length === 1);
    const sendsAfterTell = fake.posts.filter((post) => post.method === "send");
    assert.equal(sendsAfterTell[0]?.params.message, "sent to #0 daemon; next turn will be relayed");
    assert.deepEqual(calls, ["resolve:me", "prompt:0:inspect daemon:followUp:false"]);
    assert.deepEqual(
      fake.posts.filter((post) => post.method === "sendReaction").map((post) => post.params.emoji),
      ["\u{1F440}"],
    );

    await bridge.handleDaemonTurn("daemon finished");
    await waitFor(() => fake.posts.filter((post) => post.method === "send").length === 2);
    const sendsAfterTurn = fake.posts.filter((post) => post.method === "send");
    assert.equal(sendsAfterTurn[1]?.params.message, "daemon finished");
    assert.deepEqual(
      fake.posts.filter((post) => post.method === "sendReaction").map((post) => post.params.emoji),
      ["\u{1F440}", "\u{2705}"],
    );

    await bridge.handleDaemonTurn("late daemon turn");
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(fake.posts.filter((post) => post.method === "send").length, 2);
  } finally {
    await bridge.stop();
    await fake.stop();
  }
});

test("SignalBridge collapses duplicate tell relays to daemon for the same caller", async () => {
  const fake = await startFakeSignalCli();
  const calls: string[] = [];
  const services = {
    resolveSelector(selector: string) {
      calls.push(`resolve:${selector}`);
      return {
        shortId: 0,
        sessionId: "daemon",
        sessionFile: undefined,
        name: "daemon",
        cwd: "/tmp/daemon",
        pid: 1,
        kind: "daemon",
        model: undefined,
        state: "idle",
        connected: true,
        watch: false,
        lastTurn: undefined,
        firstSeen: "2026-07-13T00:00:00.000Z",
        lastSeen: "2026-07-13T00:00:00.000Z",
      };
    },
    sendPrompt(selector: string, text: string, mode: string, wait: boolean) {
      calls.push(`prompt:${selector}:${text}:${mode}:${wait}`);
      return Promise.resolve("sent");
    },
  } as unknown as BakerServices;
  const bridge = new SignalBridge({
    config: makeConfig(fake.url),
    services: () => services,
    sendUserMessage() {
      throw new Error("slash command should use services");
    },
  });

  try {
    await bridge.start();
    await bridge.handleEnvelope({
      sourceNumber: "+15550002",
      dataMessage: {
        message: "/tell me first",
        timestamp: 256,
      },
    });
    await bridge.handleEnvelope({
      sourceNumber: "+15550002",
      dataMessage: {
        message: "/tell me second",
        timestamp: 257,
      },
    });

    await waitFor(() => fake.posts.filter((post) => post.method === "send").length === 2);
    assert.deepEqual(calls, [
      "resolve:me",
      "prompt:0:first:followUp:false",
      "resolve:me",
      "prompt:0:second:followUp:false",
    ]);
    assert.deepEqual(
      fake.posts.filter((post) => post.method === "sendReaction").map((post) => post.params.emoji),
      ["\u{1F440}", "\u{1F440}", "\u{2705}"],
    );

    await bridge.handleDaemonTurn("first daemon turn");
    await waitFor(() => fake.posts.filter((post) => post.method === "send").length === 3);
    assert.equal(fake.posts.filter((post) => post.method === "send")[2]?.params.message, "first daemon turn");
    assert.deepEqual(
      fake.posts.filter((post) => post.method === "sendReaction").map((post) => post.params.emoji),
      ["\u{1F440}", "\u{1F440}", "\u{2705}", "\u{2705}"],
    );

    await bridge.handleDaemonTurn("second daemon turn");
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(fake.posts.filter((post) => post.method === "send").length, 3);
  } finally {
    await bridge.stop();
    await fake.stop();
  }
});

test("SignalBridge spawn prompt uses the one-shot member relay path", async () => {
  const fake = await startFakeSignalCli();
  const calls: string[] = [];
  const services = {
    spawn(request: { cwd: string; prompt?: string; onRegistered?: (result: { shortId: number; name: string; cwd: string }) => void }) {
      calls.push(`spawn:${JSON.stringify(request)}`);
      const result = { shortId: 5, name: "child", cwd: request.cwd };
      request.onRegistered?.(result);
      return Promise.resolve(result);
    },
  } as unknown as BakerServices;
  const bridge = new SignalBridge({
    config: makeConfig(fake.url),
    services: () => services,
    sendUserMessage() {
      throw new Error("slash command should not prompt daemon");
    },
  });

  try {
    await bridge.start();
    await bridge.handleEnvelope({
      sourceNumber: "+15550002",
      dataMessage: {
        message: "/spawn /tmp/project start work",
        timestamp: 261,
      },
    });

    await waitFor(() => fake.posts.filter((post) => post.method === "send").length === 1);
    const sendsAfterSpawn = fake.posts.filter((post) => post.method === "send");
    assert.equal(sendsAfterSpawn[0]?.params.message, "spawned #5 child in /tmp/project; next turn will be relayed");
    assert.deepEqual(calls, ['spawn:{"cwd":"/tmp/project","prompt":"start work"}']);
    assert.deepEqual(
      fake.posts.filter((post) => post.method === "sendReaction").map((post) => post.params.emoji),
      ["\u{1F440}"],
    );

    await bridge.handleMemberTurn(5, "child", "spawned turn");
    await waitFor(() => fake.posts.filter((post) => post.method === "send").length === 2);
    const sendsAfterTurn = fake.posts.filter((post) => post.method === "send");
    assert.equal(sendsAfterTurn[1]?.params.message, "[#5 child] spawned turn");
    assert.deepEqual(
      fake.posts.filter((post) => post.method === "sendReaction").map((post) => post.params.emoji),
      ["\u{1F440}", "\u{2705}"],
    );

    await bridge.handleMemberTurn(5, "child", "late turn");
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(fake.posts.filter((post) => post.method === "send").length, 2);
  } finally {
    await bridge.stop();
    await fake.stop();
  }
});

test("SignalBridge clears the one-shot relay when the initial spawn prompt is rejected", async () => {
  const fake = await startFakeSignalCli();
  const calls: string[] = [];
  const services = {
    spawn(request: { cwd: string; prompt?: string; onRegistered?: (result: { shortId: number; name: string; cwd: string }) => void }) {
      calls.push(`spawn:${JSON.stringify(request)}`);
      request.onRegistered?.({ shortId: 5, name: "child", cwd: request.cwd });
      return Promise.reject(new Error("child refused prompt"));
    },
  } as unknown as BakerServices;
  const bridge = new SignalBridge({
    config: makeConfig(fake.url),
    services: () => services,
    sendUserMessage() {
      throw new Error("slash command should not prompt daemon");
    },
  });

  try {
    await bridge.start();
    await bridge.handleEnvelope({
      sourceNumber: "+15550002",
      dataMessage: {
        message: "/spawn /tmp/project start work",
        timestamp: 262,
      },
    });

    await waitFor(() => fake.posts.some((post) => post.method === "send"));
    assert.deepEqual(calls, ['spawn:{"cwd":"/tmp/project","prompt":"start work"}']);
    const send = fake.posts.find((post) => post.method === "send");
    assert.equal(send?.params.message, "error: child refused prompt");

    await bridge.handleMemberTurn(5, "child", "late turn after rejected prompt");
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(fake.posts.filter((post) => post.method === "send").length, 1);
  } finally {
    await bridge.stop();
    await fake.stop();
  }
});

test("SignalBridge restores persisted watch flags to Note-to-Self on startup", async () => {
  const fake = await startFakeSignalCli();
  const registry = new BakerRegistry(":memory:");
  const server = new ControlServer({ socketPath: "/tmp/pi-baker-unused.sock", registry });
  const services = new BakerServices(registry, server);
  registry.upsertDaemon(makeHello("daemon", 1, "daemon"));
  const member = registry.upsertHello(makeHello("member", 2, "worker"), "member");
  registry.setWatch(member.shortId, true);

  const bridge = new SignalBridge({
    config: makeConfig(fake.url),
    services: () => services,
    sendUserMessage() {},
  });

  try {
    await bridge.start();
    await bridge.handleMemberTurn(member.shortId, "worker", "watched turn");

    await waitFor(() => fake.posts.some((post) => post.method === "send"));
    const send = fake.posts.find((post) => post.method === "send");
    assert.equal(send?.params.recipients?.[0], "+15550001");
    assert.equal(send?.params.message, "[#1 worker] watched turn");
  } finally {
    await bridge.stop();
    registry.close();
    await fake.stop();
  }
});

test("SignalBridge restores persisted watch recipients to the original caller on startup", async () => {
  const registry = new BakerRegistry(":memory:");
  const server = new ControlServer({ socketPath: "/tmp/pi-baker-unused.sock", registry });
  const services = new BakerServices(registry, server);
  registry.upsertDaemon(makeHello("daemon", 1, "daemon"));
  const member = registry.upsertHello(makeHello("member", 2, "worker"), "member");
  const firstFake = await startFakeSignalCli();

  const firstBridge = new SignalBridge({
    config: makeConfig(firstFake.url),
    services: () => services,
    sendUserMessage() {},
  });

  try {
    await firstBridge.start();
    await firstBridge.handleEnvelope({
      sourceNumber: "+15550002",
      dataMessage: {
        message: "/watch worker on",
        timestamp: 901,
      },
    });

    await waitFor(() => firstFake.posts.some((post) => post.method === "send"));
    assert.deepEqual(registry.listWatchTargets(), [{ shortId: member.shortId, recipient: "+15550002" }]);
  } finally {
    await firstBridge.stop();
    await firstFake.stop();
  }

  const secondFake = await startFakeSignalCli();
  const secondBridge = new SignalBridge({
    config: makeConfig(secondFake.url),
    services: () => services,
    sendUserMessage() {},
  });

  try {
    await secondBridge.start();
    await secondBridge.handleMemberTurn(member.shortId, "worker", "watched turn after restart");

    await waitFor(() => secondFake.posts.some((post) => post.method === "send"));
    const send = secondFake.posts.find((post) => post.method === "send");
    assert.equal(send?.params.recipients?.[0], "+15550002");
    assert.equal(send?.params.message, "[#1 worker] watched turn after restart");
  } finally {
    await secondBridge.stop();
    registry.close();
    await secondFake.stop();
  }
});

test("SignalBridge preserves restored legacy watch targets when another caller turns watch off", async () => {
  const registry = new BakerRegistry(":memory:");
  const server = new ControlServer({ socketPath: "/tmp/pi-baker-unused.sock", registry });
  const services = new BakerServices(registry, server);
  registry.upsertDaemon(makeHello("daemon", 1, "daemon"));
  const member = registry.upsertHello(makeHello("member", 2, "worker"), "member");
  registry.setWatch(member.shortId, true);
  const firstFake = await startFakeSignalCli();

  const firstBridge = new SignalBridge({
    config: makeConfig(firstFake.url),
    services: () => services,
    sendUserMessage() {},
  });

  try {
    await firstBridge.start();
    await firstBridge.handleEnvelope({
      sourceNumber: "+15550002",
      dataMessage: {
        message: "/watch worker off",
        timestamp: 902,
      },
    });

    await waitFor(() => firstFake.posts.some((post) => post.method === "send"));
    assert.equal(registry.getSession(member.shortId)?.watch, true);
    assert.deepEqual(registry.listWatchTargets(), [{ shortId: member.shortId, recipient: "+15550001" }]);
  } finally {
    await firstBridge.stop();
    await firstFake.stop();
  }

  const secondFake = await startFakeSignalCli();
  const secondBridge = new SignalBridge({
    config: makeConfig(secondFake.url),
    services: () => services,
    sendUserMessage() {},
  });

  try {
    await secondBridge.start();
    await secondBridge.handleMemberTurn(member.shortId, "worker", "still watched");

    await waitFor(() => secondFake.posts.some((post) => post.method === "send"));
    const send = secondFake.posts.find((post) => post.method === "send");
    assert.equal(send?.params.recipients?.[0], "+15550001");
    assert.equal(send?.params.message, "[#1 worker] still watched");
  } finally {
    await secondBridge.stop();
    registry.close();
    await secondFake.stop();
  }
});

test("SignalBridge sends watched spawned-session crash notices", async () => {
  const fake = await startFakeSignalCli();
  const registry = new BakerRegistry(":memory:");
  const server = new ControlServer({ socketPath: "/tmp/pi-baker-unused.sock", registry });
  const services = new BakerServices(registry, server);
  registry.upsertDaemon(makeHello("daemon", 1, "daemon"));
  const child = registry.upsertHello({ ...makeHello("spawned", 2, "child"), spawned: true }, "spawned");
  registry.setWatch(child.shortId, true);

  const bridge = new SignalBridge({
    config: makeConfig(fake.url),
    services: () => services,
    sendUserMessage() {},
  });

  try {
    await bridge.start();
    await bridge.handleSpawnCrash(child.shortId, "child", `spawned session #${child.shortId} child crashed (exit 2)`);

    await waitFor(() => fake.posts.some((post) => post.method === "send"));
    const send = fake.posts.find((post) => post.method === "send");
    assert.equal(send?.params.recipients?.[0], "+15550001");
    assert.equal(send?.params.message, `[#${child.shortId} child] spawned session #${child.shortId} child crashed (exit 2)`);
  } finally {
    await bridge.stop();
    registry.close();
    await fake.stop();
  }
});

test("SignalBridge records watched member turn send failures without rejecting", async () => {
  const fake = await startFakeSignalCli();
  const registry = new BakerRegistry(":memory:");
  const server = new ControlServer({ socketPath: "/tmp/pi-baker-unused.sock", registry });
  const services = new BakerServices(registry, server);
  registry.upsertDaemon(makeHello("daemon", 1, "daemon"));
  const member = registry.upsertHello(makeHello("member", 2, "worker"), "member");
  registry.setWatch(member.shortId, true);

  const bridge = new SignalBridge({
    config: makeConfig(fake.url),
    services: () => services,
    sendUserMessage() {},
  });

  try {
    await bridge.start();
    fake.setRpcFailure("send", 503);

    await assert.doesNotReject(() => bridge.handleMemberTurn(member.shortId, "worker", "watched turn"));
    await waitFor(() => fake.posts.some((post) => post.method === "send"));
    const send = fake.posts.find((post) => post.method === "send");
    assert.equal(send?.params.recipients?.[0], "+15550001");
    assert.equal(send?.params.message, "[#1 worker] watched turn");
    assert.equal(bridge.status().lastError, "signal-cli rpc send failed: 503");
  } finally {
    await bridge.stop();
    registry.close();
    await fake.stop();
  }
});

test("SignalBridge supports resend and startup/shutdown notices", async () => {
  const fake = await startFakeSignalCli();
  const bridge = new SignalBridge({
    config: makeConfig(fake.url),
    services: () => undefined,
    sendUserMessage() {},
  });

  try {
    await bridge.start();
    await bridge.sendStartupNotice(2);
    await bridge.handleEnvelope({
      syncMessage: {
        sentMessage: {
          destinationNumber: "+15550001",
          message: "plain",
          timestamp: 301,
        },
      },
    });
    await bridge.handleDaemonTurn("daemon reply");
    await fake.send({
      syncMessage: {
        sentMessage: {
          destinationNumber: "+15550001",
          message: "/resend",
          timestamp: 302,
        },
      },
    });
    await waitFor(() => fake.posts.filter((post) => post.method === "send").length >= 3);
    const sends = fake.posts.filter((post) => post.method === "send");
    assert.equal(sends[0]?.params.message, "baker up, 2 sessions reconnected");
    assert.equal(sends[1]?.params.message, "daemon reply");
    assert.equal(sends[2]?.params.message, "daemon reply");

    await bridge.sendShutdownNotice();
    await waitFor(() => fake.posts.filter((post) => post.method === "send").length >= 4);
    assert.equal(fake.posts.filter((post) => post.method === "send")[3]?.params.message, "baker shutting down");
  } finally {
    await bridge.stop();
    await fake.stop();
  }
});

test("SignalBridge treats lifecycle notice sends as best effort", async () => {
  const fake = await startFakeSignalCli();
  const bridge = new SignalBridge({
    config: makeConfig(fake.url),
    services: () => undefined,
    sendUserMessage() {},
  });

  try {
    await bridge.start();
    fake.setRpcFailure("send", 503);

    await assert.doesNotReject(() => bridge.sendShutdownNotice());
    await waitFor(() => fake.posts.some((post) => post.method === "send"));
    const send = fake.posts.find((post) => post.method === "send");
    assert.equal(send?.params.message, "baker shutting down");
    assert.equal(bridge.status().lastError, "signal-cli rpc send failed: 503");
  } finally {
    await bridge.stop();
    await fake.stop();
  }
});

test("SignalBridge model command delegates switching callback", async () => {
  const fake = await startFakeSignalCli();
  const queries: string[] = [];
  const bridge = new SignalBridge({
    config: makeConfig(fake.url),
    services: () => undefined,
    sendUserMessage() {},
    getDaemonInfo: () => ({
      cwd: "/tmp/project",
      model: "provider/current",
    }),
    setDaemonModel: async (query) => {
      queries.push(query);
      return `model set to ${query}`;
    },
  });

  try {
    await bridge.start();
    await fake.send({
      sourceNumber: "+15550002",
      dataMessage: {
        message: "/model next model",
        timestamp: 401,
      },
    });
    await waitFor(() => fake.posts.some((post) => post.method === "send"));
    assert.deepEqual(queries, ["next model"]);
    const send = fake.posts.find((post) => post.method === "send");
    assert.equal(send?.params.message, "model set to next model");
  } finally {
    await bridge.stop();
    await fake.stop();
  }
});

test("SignalBridge status command performs a live signal-cli health check", async () => {
  const fake = await startFakeSignalCli();
  const bridge = new SignalBridge({
    config: makeConfig(fake.url),
    services: () => undefined,
    sendUserMessage() {},
    getDaemonInfo: () => ({
      cwd: "/tmp/project",
      model: "provider/current",
    }),
  });

  try {
    await bridge.start();
    fake.setCheckStatus(503);
    await fake.send({
      syncMessage: {
        sentMessage: {
          destinationNumber: "+15550001",
          message: "/status",
          timestamp: 451,
        },
      },
    });

    await waitFor(() => fake.posts.some((post) => post.method === "send"));
    const send = fake.posts.find((post) => post.method === "send");
    assert.match(String(send?.params.message), /signal check: failed/);
    assert.match(String(send?.params.message), /signal connected: no/);
    assert.match(String(send?.params.message), /last error: signal-cli health check failed: 503/);
  } finally {
    await bridge.stop();
    await fake.stop();
  }
});

test("SignalBridge clear command is explicit when no session replacement hook is available", async () => {
  const fake = await startFakeSignalCli();
  const bridge = new SignalBridge({
    config: makeConfig(fake.url),
    services: () => undefined,
    sendUserMessage() {},
  });

  try {
    await bridge.start();
    await fake.send({
      syncMessage: {
        sentMessage: {
          destinationNumber: "+15550001",
          message: "/clear",
          timestamp: 501,
        },
      },
    });
    await waitFor(() => fake.posts.some((post) => post.method === "send"));
    const send = fake.posts.find((post) => post.method === "send");
    assert.match(String(send?.params.message), /only available in the daemon TUI/);
  } finally {
    await bridge.stop();
    await fake.stop();
  }
});

test("SignalBridge clear command delegates when a session replacement hook is supplied", async () => {
  const fake = await startFakeSignalCli();
  let calls = 0;
  const bridge = new SignalBridge({
    config: makeConfig(fake.url),
    services: () => undefined,
    sendUserMessage() {},
    clearDaemonSession: async () => {
      calls += 1;
      return "daemon session cleared";
    },
  });

  try {
    await bridge.start();
    await fake.send({
      syncMessage: {
        sentMessage: {
          destinationNumber: "+15550001",
          message: "/clear",
          timestamp: 502,
        },
      },
    });
    await waitFor(() => fake.posts.some((post) => post.method === "send"));
    const send = fake.posts.find((post) => post.method === "send");
    assert.equal(send?.params.message, "daemon session cleared");
    assert.equal(calls, 1);
  } finally {
    await bridge.stop();
    await fake.stop();
  }
});

interface RecordedRpc {
  method: string;
  params: Record<string, any>;
}

class FakeSignalCliChild extends EventEmitter {
  readonly stdout = new EventEmitter();
  readonly stderr = new EventEmitter();
  readonly signals: string[] = [];
  exitCode: number | null = null;

  kill(signal?: NodeJS.Signals | number): boolean {
    const value = String(signal ?? "SIGTERM");
    this.signals.push(value);
    if (value === "SIGKILL") {
      this.exitCode = 137;
      queueMicrotask(() => this.emit("exit", null, "SIGKILL"));
    }
    return true;
  }
}

async function startFakeSignalCli(): Promise<{
  url: string;
  posts: RecordedRpc[];
  setCheckStatus: (status: number) => void;
  setRpcFailure: (method: string, status: number | undefined) => void;
  send: (envelope: unknown) => Promise<void>;
  sendRaw: (payload: string) => Promise<void>;
  stop: () => Promise<void>;
}> {
  const posts: RecordedRpc[] = [];
  const clients = new Set<ServerResponse>();
  let checkStatus = 200;
  const rpcFailures = new Map<string, number>();
  const server = createServer(async (req, res) => {
    if (req.method === "GET" && req.url?.startsWith("/api/v1/check")) {
      res.writeHead(checkStatus, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: checkStatus >= 200 && checkStatus < 300 }));
      return;
    }

    if (req.method === "GET" && req.url?.startsWith("/api/v1/events")) {
      clients.add(res);
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });
      res.write(": connected\n\n");
      req.on("close", () => clients.delete(res));
      return;
    }

    if (req.method === "POST" && req.url === "/api/v1/rpc") {
      const body = await readBody(req);
      const payload = JSON.parse(body) as { method: string; params: Record<string, any> };
      posts.push({ method: payload.method, params: payload.params });
      const failureStatus = rpcFailures.get(payload.method);
      if (failureStatus !== undefined) {
        res.writeHead(failureStatus, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "forced failure" }));
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", id: "ok", result: {} }));
      return;
    }

    res.writeHead(404);
    res.end();
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(isAddressInfo(address));

  return {
    url: `http://127.0.0.1:${address.port}`,
    posts,
    setCheckStatus: (status) => {
      checkStatus = status;
    },
    setRpcFailure: (method, status) => {
      if (status === undefined) {
        rpcFailures.delete(method);
      } else {
        rpcFailures.set(method, status);
      }
    },
    send: async (envelope: unknown) => {
      await waitFor(() => clients.size > 0);
      for (const client of clients) {
        client.write(`data: ${JSON.stringify(envelope)}\n\n`);
      }
    },
    sendRaw: async (payload: string) => {
      await waitFor(() => clients.size > 0);
      for (const client of clients) {
        client.write(payload);
      }
    },
    stop: async () => {
      for (const client of clients) {
        client.end();
      }
      await new Promise<void>((resolve, reject) => server.close((error) => (error === undefined ? resolve() : reject(error))));
    },
  };
}

function isAddressInfo(address: ReturnType<typeof createServer>["address"] extends () => infer T ? T : never): address is AddressInfo {
  return typeof address === "object" && address !== null;
}

function makeConfig(signalUrl: string): BakerConfig {
  return {
    role: "daemon",
    bakerDir: "/tmp/pi-baker",
    socketPath: "/tmp/pi-baker/baker.sock",
    dbPath: "/tmp/pi-baker/baker.db",
    signalAccount: "+15550001",
    whitelist: new Set(["+15550002"]),
    signalUrl,
    manageSignal: false,
    storeTurns: true,
    quiet: true,
    spawned: false,
  };
}

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

async function readBody(req: NodeJS.ReadableStream): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  }
  return Buffer.concat(chunks).toString("utf8");
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
