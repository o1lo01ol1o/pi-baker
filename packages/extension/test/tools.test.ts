import assert from "node:assert/strict";
import { test } from "node:test";

import { registerBakerTools } from "../src/daemon/tools.ts";
import type { BakerServices } from "../src/daemon/services.ts";
import type { SignalBridge } from "../src/daemon/signal.ts";

type Tool = any;
type Handler = (event: { systemPrompt: string }, ctx?: unknown) => unknown;

test("baker tools register the M3 tool surface", () => {
  const { tools } = registerWithFakes();
  assert.deepEqual(
    tools.map((tool) => tool.name).sort(),
    [
      "baker_kill",
      "baker_session_abort",
      "baker_session_last",
      "baker_session_prompt",
      "baker_session_status",
      "baker_sessions",
      "baker_signal_send",
      "baker_spawn",
    ].sort(),
  );
});

test("baker tools delegate to shared services and Signal bridge", async () => {
  const calls: string[] = [];
  const { tools } = registerWithFakes({
    service: {
      recordCommand(command: string, surface: string) {
        calls.push(`command:${surface}:${command}`);
      },
      rowsForTool(all: boolean) {
        calls.push(`rows:${all}`);
        return [{ id: 1, name: "worker" }];
      },
      liveStatus(session: string) {
        calls.push(`status:${session}`);
        return Promise.resolve({ id: session, state: "idle" });
      },
      sendPrompt(session: string, text: string, mode: string, options: unknown) {
        calls.push(`prompt:${session}:${text}:${mode}:${JSON.stringify(options)}`);
        return Promise.resolve("turn done");
      },
      last(session: string) {
        calls.push(`last:${session}`);
        return "last turn";
      },
      abort(session: string) {
        calls.push(`abort:${session}`);
        return Promise.resolve("aborted");
      },
      spawn(request: { cwd: string; prompt?: string; model?: string; name?: string }) {
        calls.push(`spawn:${JSON.stringify(request)}`);
        return Promise.resolve({ shortId: 9, name: request.name ?? "spawned", cwd: request.cwd });
      },
      kill(session: string) {
        calls.push(`kill:${session}`);
        return Promise.resolve("killed");
      },
      listSessions() {
        return [];
      },
    },
    signal: {
      sendFromTool(text: string, recipient?: string) {
        calls.push(`signal:${recipient ?? "default"}:${text}`);
        return Promise.resolve("sent");
      },
    },
  });

  assert.match(await runTool(tools, "baker_sessions", { all: true }), /worker/);
  assert.match(await runTool(tools, "baker_session_status", { session: "worker" }), /idle/);
  assert.equal(await runTool(tools, "baker_session_prompt", { session: "worker", text: "go", mode: "steer", wait: true, timeoutSec: 7 }), "turn done");
  assert.equal(await runTool(tools, "baker_session_last", { session: "worker" }), "last turn");
  assert.equal(await runTool(tools, "baker_session_abort", { session: "worker" }), "aborted");
  assert.equal(await runTool(tools, "baker_spawn", { cwd: "/tmp/project", prompt: "start", model: "openai/gpt", name: "child" }), "spawned #9 child in /tmp/project");
  assert.equal(await runTool(tools, "baker_kill", { session: "child" }), "killed");
  assert.equal(await runTool(tools, "baker_signal_send", { text: "hello", recipient: "+15550001" }), "sent");

  assert.deepEqual(calls, [
    "command:tool:baker_sessions",
    "rows:true",
    "command:tool:baker_session_status",
    "status:worker",
    "command:tool:baker_session_prompt",
    'prompt:worker:go:steer:{"wait":true,"timeoutSec":7}',
    "command:tool:baker_session_last",
    "last:worker",
    "command:tool:baker_session_abort",
    "abort:worker",
    "command:tool:baker_spawn",
    'spawn:{"cwd":"/tmp/project","prompt":"start","model":"openai/gpt","name":"child"}',
    "command:tool:baker_kill",
    "kill:child",
    "command:tool:baker_signal_send",
    "signal:+15550001:hello",
  ]);
});

test("before_agent_start injects current session briefing", async () => {
  const { handlers } = registerWithFakes({
    service: {
      listSessions() {
        return [
          {
            shortId: 1,
            sessionId: "session-worker",
            sessionFile: undefined,
            name: "worker",
            pid: 123,
            kind: "member",
            state: "idle",
            connected: true,
            watch: false,
            cwd: "/tmp/project",
            model: "provider/model",
            lastTurn: undefined,
            firstSeen: "2026-07-13T00:00:00.000Z",
            lastSeen: "2026-07-13T00:00:00.000Z",
          },
        ];
      },
    },
  });

  const handler = handlers.get("before_agent_start");
  assert.ok(handler);
  const result = (await handler({ systemPrompt: "base prompt" })) as { systemPrompt: string };
  assert.match(result.systemPrompt, /base prompt/);
  assert.match(result.systemPrompt, /pi-baker orchestration/);
  assert.match(result.systemPrompt, /#1 worker: member, idle, connected/);
});

function registerWithFakes(options: { service?: Partial<BakerServices>; signal?: Partial<SignalBridge> } = {}): {
  tools: Tool[];
  handlers: Map<string, Handler>;
} {
  const tools: Tool[] = [];
  const handlers = new Map<string, Handler>();
  registerBakerTools(
    {
      registerTool(tool) {
        tools.push(tool);
      },
      on(event, handler) {
        handlers.set(event, handler as Handler);
      },
    },
    {
      services: () => options.service as BakerServices,
      signal: () => options.signal as SignalBridge,
    },
  );
  return { tools, handlers };
}

async function runTool(tools: Tool[], name: string, params: Record<string, unknown>): Promise<string> {
  const tool = tools.find((candidate) => candidate.name === name);
  assert.ok(tool, `tool ${name} not registered`);
  const result = await tool.execute("test-call", params as never, undefined, undefined, {} as never);
  const first = result.content[0];
  assert.equal(first?.type, "text");
  return first.text;
}
