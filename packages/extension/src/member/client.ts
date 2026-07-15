import { createConnection, type Socket } from "node:net";

import type {
  AgentEndEvent,
  ExtensionAPI,
  ExtensionContext,
  SessionShutdownEvent,
  SessionStartEvent,
} from "@earendil-works/pi-coding-agent";

import { type BakerConfig, EXTENSION_VERSION, formatSetupStatus } from "../config.ts";
import {
  FrameLineBuffer,
  type ControlFrame,
  type HelloFrame,
  type ResultFrame,
  type SessionState,
  serializeFrame,
} from "../protocol.ts";

export interface MemberStatus {
  enabled: boolean;
  connected: boolean;
  shortId: number | undefined;
  name: string | undefined;
  socketPath: string;
  daemonPid: number | undefined;
  pid: number;
  cwd: string | undefined;
  sessionId: string | undefined;
  sessionFile: string | undefined;
  sessionName: string | undefined;
  state: SessionState;
  model: string | undefined;
  spawned: boolean;
  spawnId: string | undefined;
  extensionVersion: string;
}

export interface MemberClientOptions {
  debug?: (message: string) => void;
}

export class MemberClient {
  private readonly pi: ExtensionAPI;
  private readonly config: BakerConfig;
  private readonly debug: (message: string) => void;
  private readonly decoder = new FrameLineBuffer();
  private socket: Socket | undefined;
  private latestContext: ExtensionContext | undefined;
  private reconnectTimer: NodeJS.Timeout | undefined;
  private enabled = true;
  private shortId: number | undefined;
  private name: string | undefined;
  private daemonPid: number | undefined;
  private model: string | undefined;
  private state: SessionState = "unknown";
  private reconnectDelayMs = 1_000;
  private daemonUnavailableLogged = false;

  constructor(pi: ExtensionAPI, config: BakerConfig, options: MemberClientOptions = {}) {
    this.pi = pi;
    this.config = config;
    this.debug = options.debug ?? ((message) => console.debug(message));
  }

  status(): MemberStatus {
    const ctx = this.latestContext;
    return {
      enabled: this.enabled,
      connected: this.socket !== undefined && !this.socket.destroyed,
      shortId: this.shortId,
      name: this.name,
      socketPath: this.config.socketPath,
      daemonPid: this.daemonPid,
      pid: process.pid,
      cwd: ctx?.cwd,
      sessionId: ctx?.sessionManager.getSessionId(),
      sessionFile: ctx?.sessionManager.getSessionFile(),
      sessionName: ctx?.sessionManager.getSessionName(),
      state: this.state,
      model: this.model,
      spawned: this.config.spawned,
      spawnId: this.config.spawnId,
      extensionVersion: EXTENSION_VERSION,
    };
  }

  enable(ctx: ExtensionContext): void {
    this.enabled = true;
    this.connect(ctx);
  }

  disable(): void {
    this.enabled = false;
    this.clearReconnect();
    this.send({ v: 1, type: "goodbye" });
    this.socket?.end();
    this.socket = undefined;
    this.shortId = undefined;
    this.name = undefined;
    this.daemonPid = undefined;
  }

  connect(ctx: ExtensionContext): void {
    this.latestContext = ctx;
    if (!this.enabled || this.socket !== undefined) {
      return;
    }

    this.decoder.reset();
    const socket = createConnection(this.config.socketPath);
    this.socket = socket;
    socket.on("connect", () => {
      this.sendHello(ctx);
    });
    socket.on("data", (chunk) => {
      if (this.socket !== socket) {
        return;
      }
      for (const parsed of this.decoder.push(chunk)) {
        if (parsed.kind === "frame") {
          this.handleFrame(parsed.frame);
        } else if (parsed.kind === "invalid" && parsed.close) {
          socket.destroy(new Error(parsed.error));
        }
      }
    });
    socket.on("close", () => this.scheduleReconnect(socket));
    socket.on("error", (error) => {
      this.logDaemonUnavailableOnce(error);
      this.scheduleReconnect(socket);
    });
  }

  onSessionStart(_event: SessionStartEvent, ctx: ExtensionContext): void {
    this.latestContext = ctx;
    const existingSocket = this.socket;
    this.connect(ctx);
    if (existingSocket !== undefined && !existingSocket.destroyed) {
      this.sendHello(ctx);
    }
  }

  onSessionShutdown(_event: SessionShutdownEvent): void {
    this.clearReconnect();
    this.latestContext = undefined;
    this.send({ v: 1, type: "goodbye" });
    this.socket?.end();
    this.socket = undefined;
    this.shortId = undefined;
    this.name = undefined;
    this.daemonPid = undefined;
    this.state = "unknown";
  }

  onAgentStart(ctx: ExtensionContext): void {
    this.latestContext = ctx;
    this.state = "busy";
    this.model = modelName(ctx) ?? this.model;
    this.send({ v: 1, type: "state", state: "busy", model: this.model });
  }

  onAgentEnd(event: AgentEndEvent, ctx: ExtensionContext): void {
    this.latestContext = ctx;
    this.state = "idle";
    this.model = modelName(ctx) ?? this.model;
    this.send({ v: 1, type: "state", state: "idle", model: this.model });
    const text = extractLastAssistantText(event.messages);
    if (text !== undefined) {
      this.send({ v: 1, type: "turn", text });
    }
  }

  onModelSelect(event: ModelSelectEvent): void {
    this.model = `${event.model.provider}/${event.model.id}`;
    this.send({ v: 1, type: "state", state: this.state, model: this.model });
  }

  private handleFrame(frame: ControlFrame): void {
    switch (frame.type) {
      case "hello_ack":
        this.reconnectDelayMs = 1_000;
        this.shortId = frame.shortId;
        this.name = frame.name;
        this.daemonPid = frame.daemonPid;
        break;
      case "prompt":
        void this.handlePrompt(frame.id, frame.text, frame.deliverAs);
        break;
      case "abort":
        this.handleAbort(frame.id);
        break;
      case "rename":
        this.handleRename(frame.id, frame.name);
        break;
      case "query":
        this.sendResult(frame.id, true, this.status());
        break;
      case "notify":
        if (!this.config.spawned) {
          this.latestContext?.ui.notify(frame.text);
        }
        break;
      case "ping":
        this.send({ v: 1, type: "pong", id: frame.id });
        break;
      default:
        break;
    }
  }

  private async handlePrompt(id: string, text: string, deliverAs: "followUp" | "steer"): Promise<void> {
    try {
      await this.pi.sendUserMessage(text, { deliverAs });
      this.sendResult(id, true);
    } catch (error) {
      this.sendResult(id, false, undefined, error instanceof Error ? error.message : String(error));
    }
  }

  private handleAbort(id: string): void {
    try {
      const ctx = this.latestContext;
      if (ctx === undefined) {
        throw new Error("member session context is not available");
      }
      ctx.abort();
      this.sendResult(id, true);
    } catch (error) {
      this.sendResult(id, false, undefined, error instanceof Error ? error.message : String(error));
    }
  }

  private handleRename(id: string, name: string): void {
    try {
      this.pi.setSessionName(name);
      this.name = this.pi.getSessionName() ?? name;
      this.sendResult(id, true, { name: this.name });
    } catch (error) {
      this.sendResult(id, false, undefined, error instanceof Error ? error.message : String(error));
    }
  }

  private sendHello(ctx: ExtensionContext): void {
    const frame: HelloFrame = {
      v: 1,
      type: "hello",
      sessionId: ctx.sessionManager.getSessionId(),
      sessionFile: ctx.sessionManager.getSessionFile(),
      sessionName: ctx.sessionManager.getSessionName(),
      cwd: ctx.cwd,
      pid: process.pid,
      model: modelName(ctx) ?? this.model,
      state: ctx.isIdle() ? "idle" : "busy",
      spawned: this.config.spawned,
      spawnId: this.config.spawnId,
      extensionVersion: EXTENSION_VERSION,
    };
    this.model = frame.model;
    this.state = frame.state;
    this.send(frame);
  }

  private sendResult(id: string, ok: boolean, data?: unknown, error?: string): void {
    const frame: ResultFrame = { v: 1, type: "result", id, ok };
    if (data !== undefined) {
      frame.data = data;
    }
    if (error !== undefined) {
      frame.error = error;
    }
    this.send(frame);
  }

  private send(frame: ControlFrame): void {
    if (this.socket === undefined || this.socket.destroyed) {
      return;
    }
    this.socket.write(serializeFrame(frame));
  }

  private scheduleReconnect(socket: Socket): void {
    if (this.socket !== socket) {
      return;
    }
    this.socket = undefined;
    this.shortId = undefined;
    this.name = undefined;
    this.daemonPid = undefined;
    if (!this.enabled || this.latestContext === undefined || this.reconnectTimer !== undefined) {
      return;
    }

    const delay = this.reconnectDelayMs;
    this.reconnectDelayMs = Math.min(this.reconnectDelayMs * 2, 60_000);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      const ctx = this.latestContext;
      if (ctx !== undefined) {
        this.connect(ctx);
      }
    }, delay);
    this.reconnectTimer.unref();
  }

  private clearReconnect(): void {
    if (this.reconnectTimer !== undefined) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
  }

  private logDaemonUnavailableOnce(error: Error): void {
    if (this.daemonUnavailableLogged || !isDaemonUnavailableError(error)) {
      return;
    }
    this.daemonUnavailableLogged = true;
    this.debug(`[pi-baker] daemon unavailable at ${this.config.socketPath}; retrying in background`);
  }
}

interface ModelSelectEvent {
  model: {
    provider: string;
    id: string;
  };
}

function isDaemonUnavailableError(error: Error): boolean {
  if (!("code" in error)) {
    return false;
  }
  const code = (error as NodeJS.ErrnoException).code;
  return code === "ECONNREFUSED" || code === "ENOENT";
}

function modelName(ctx: ExtensionContext): string | undefined {
  return ctx.model === undefined ? undefined : `${ctx.model.provider}/${ctx.model.id}`;
}

export function registerMemberCommands(pi: Pick<ExtensionAPI, "registerCommand">, client: MemberClient, config: BakerConfig): void {
  pi.registerCommand("baker-status", {
    description: "Show this session's pi-baker member connection state.",
    handler: async (args, ctx) => {
      if (hasArgs(args)) {
        ctx.ui.notify("usage: /baker-status", "warning");
        return;
      }
      const status = client.status();
      ctx.ui.notify(
        [
          "pi-baker member",
          `enabled: ${status.enabled ? "yes" : "no"}`,
          `connected: ${status.connected ? "yes" : "no"}`,
          `short id: ${status.shortId ?? "-"}`,
          `name: ${status.name ?? "-"}`,
          `state: ${status.state}`,
          `cwd: ${status.cwd ?? "-"}`,
          `model: ${status.model ?? "-"}`,
          `session: ${status.sessionId ?? "-"}`,
          `file: ${status.sessionFile ?? "-"}`,
          `daemon pid: ${status.daemonPid ?? "-"}`,
          `socket: ${status.socketPath}`,
        ].join("\n"),
      );
    },
  });

  pi.registerCommand("baker-setup", {
    description: "Show pi-baker configuration status.",
    handler: async (args, ctx) => {
      if (hasArgs(args)) {
        ctx.ui.notify("usage: /baker-setup", "warning");
        return;
      }
      ctx.ui.notify(formatSetupStatus(config));
    },
  });

  pi.registerCommand("baker-disconnect", {
    description: "Opt this session out of pi-baker supervision.",
    handler: async (args, ctx) => {
      if (hasArgs(args)) {
        ctx.ui.notify("usage: /baker-disconnect", "warning");
        return;
      }
      client.disable();
      ctx.ui.notify("pi-baker disconnected");
    },
  });

  pi.registerCommand("baker-connect", {
    description: "Reconnect this session to the pi-baker daemon.",
    handler: async (args, ctx) => {
      if (hasArgs(args)) {
        ctx.ui.notify("usage: /baker-connect", "warning");
        return;
      }
      client.enable(ctx);
      ctx.ui.notify("pi-baker connecting");
    },
  });
}

function hasArgs(args: string): boolean {
  return args.trim() !== "";
}

function extractLastAssistantText(messages: unknown[]): string | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!isRecord(message) || message.role !== "assistant") {
      continue;
    }
    const content = message.content;
    if (typeof content === "string") {
      return content;
    }
    if (Array.isArray(content)) {
      const text = content
        .map((part) => (isRecord(part) && typeof part.text === "string" ? part.text : ""))
        .join("");
      return text === "" ? undefined : text;
    }
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
