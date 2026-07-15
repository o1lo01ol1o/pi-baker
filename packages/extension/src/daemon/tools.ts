import { Type } from "@earendil-works/pi-ai";
import type { AgentToolResult, ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { EXTENSION_VERSION } from "../config.ts";
import { formatSessionBriefing } from "./services.ts";
import type { BakerServices } from "./services.ts";
import type { SignalBridge } from "./signal.ts";

export interface BakerToolDeps {
  services: () => BakerServices | undefined;
  signal: () => SignalBridge | undefined;
}

const SessionParam = Type.String({
  description: "Session selector: short id, 'me', or an unambiguous session-name prefix.",
});

export function registerBakerTools(pi: Pick<ExtensionAPI, "registerTool" | "on">, deps: BakerToolDeps): void {
  pi.registerTool({
    name: "baker_sessions",
    label: "Baker Sessions",
    description: "List pi-baker sessions known to the daemon registry.",
    promptSnippet: "List supervised pi sessions and their current state.",
    parameters: Type.Object({
      all: Type.Optional(Type.Boolean({ description: "Include disconnected historical sessions." })),
    }),
    async execute(_toolCallId, params) {
      const services = requireServices(deps);
      services.recordCommand("baker_sessions", "tool");
      const rows = services.rowsForTool(params.all ?? false);
      return textResult(formatJson(rows), { rows });
    },
  });

  pi.registerTool({
    name: "baker_session_status",
    label: "Baker Session Status",
    description: "Get detailed status for one pi-baker session. Uses live socket state when available.",
    parameters: Type.Object({
      session: SessionParam,
    }),
    async execute(_toolCallId, params) {
      const services = requireServices(deps);
      services.recordCommand("baker_session_status", "tool");
      const status = await services.liveStatus(params.session);
      return textResult(formatJson(status), { status });
    },
  });

  pi.registerTool({
    name: "baker_session_prompt",
    label: "Baker Session Prompt",
    description: "Send a prompt or steering message to a supervised session. Optionally wait for that session's next assistant turn.",
    parameters: Type.Object({
      session: SessionParam,
      text: Type.String({ description: "Operator prompt to inject into the target session." }),
      mode: Type.Optional(Type.Union([Type.Literal("followUp"), Type.Literal("steer")], { description: "Delivery mode. Defaults to followUp." })),
      wait: Type.Optional(Type.Boolean({ description: "Wait for the target session's next assistant turn." })),
      timeoutSec: Type.Optional(Type.Number({ description: "Wait timeout in seconds. Defaults to 300.", minimum: 1 })),
    }),
    async execute(_toolCallId, params) {
      const services = requireServices(deps);
      services.recordCommand("baker_session_prompt", "tool");
      const response = await services.sendPrompt(params.session, params.text, params.mode ?? "followUp", {
        wait: params.wait ?? false,
        timeoutSec: params.timeoutSec,
      });
      return textResult(response, { response });
    },
  });

  pi.registerTool({
    name: "baker_session_last",
    label: "Baker Session Last",
    description: "Return the most recent assistant message recorded for a pi-baker session.",
    parameters: Type.Object({
      session: SessionParam,
    }),
    async execute(_toolCallId, params) {
      const services = requireServices(deps);
      services.recordCommand("baker_session_last", "tool");
      const text = services.last(params.session);
      return textResult(text, { text });
    },
  });

  pi.registerTool({
    name: "baker_session_abort",
    label: "Baker Session Abort",
    description: "Abort the current operation in a supervised pi session.",
    parameters: Type.Object({
      session: SessionParam,
    }),
    async execute(_toolCallId, params) {
      const services = requireServices(deps);
      services.recordCommand("baker_session_abort", "tool");
      const text = await services.abort(params.session);
      return textResult(text, { text });
    },
  });

  pi.registerTool({
    name: "baker_spawn",
    label: "Baker Spawn",
    description: "Spawn a daemon-owned headless pi session in a working directory.",
    parameters: Type.Object({
      cwd: Type.String({ description: "Working directory for the new headless pi session." }),
      prompt: Type.Optional(Type.String({ description: "Optional initial prompt." })),
      model: Type.Optional(Type.String({ description: "Optional model selector." })),
      name: Type.Optional(Type.String({ description: "Optional registry name." })),
    }),
    async execute(_toolCallId, params) {
      const services = requireServices(deps);
      services.recordCommand("baker_spawn", "tool");
      const result = await services.spawn({
        cwd: params.cwd,
        prompt: params.prompt,
        model: params.model,
        name: params.name,
      });
      return textResult(`spawned #${result.shortId} ${result.name} in ${result.cwd}`, result);
    },
  });

  pi.registerTool({
    name: "baker_kill",
    label: "Baker Kill",
    description: "Terminate a daemon-owned spawned session. Refuses member and daemon sessions once the spawn subsystem is available.",
    parameters: Type.Object({
      session: SessionParam,
    }),
    async execute(_toolCallId, params) {
      const services = requireServices(deps);
      services.recordCommand("baker_kill", "tool");
      const text = await services.kill(params.session);
      return textResult(text, { text });
    },
  });

  pi.registerTool({
    name: "baker_signal_send",
    label: "Baker Signal Send",
    description: "Send a Signal message to the current authorized conversation, the linked account, or an explicitly whitelisted recipient.",
    parameters: Type.Object({
      text: Type.String({ description: "Signal message body to send." }),
      recipient: Type.Optional(Type.String({ description: "Authorized E.164 recipient. Defaults to the conversation that triggered the daemon turn." })),
    }),
    async execute(_toolCallId, params) {
      requireServices(deps).recordCommand("baker_signal_send", "tool");
      const signal = deps.signal();
      if (signal === undefined) {
        throw new Error("Signal bridge is not ready");
      }
      const text = await signal.sendFromTool(params.text, params.recipient);
      return textResult(text, { text });
    },
  });

  pi.on("before_agent_start", async (event) => {
    const services = deps.services();
    if (services === undefined) {
      return undefined;
    }

    const briefing = [
      event.systemPrompt,
      "",
      "## pi-baker orchestration",
      `pi-baker extension ${EXTENSION_VERSION} is running in daemon mode.`,
      "Use baker_* tools for session orchestration. Validate session selectors through the tools; do not assume a session exists from prose alone.",
      "Current sessions:",
      formatSessionBriefing(services.listSessions(true)),
    ].join("\n");

    return { systemPrompt: briefing };
  });
}

function requireServices(deps: BakerToolDeps): BakerServices {
  const services = deps.services();
  if (services === undefined) {
    throw new Error("pi-baker services are not ready");
  }
  return services;
}

function textResult(text: string, details: unknown): AgentToolResult<unknown> {
  return {
    content: [{ type: "text", text }],
    details,
  };
}

function formatJson(value: unknown): string {
  return JSON.stringify(value, null, 2);
}
