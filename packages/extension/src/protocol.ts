import { Buffer } from "node:buffer";

export const PROTOCOL_VERSION = 1;

export type SessionKind = "daemon" | "member" | "spawned";
export type SessionState = "idle" | "busy" | "unknown";
export type DeliverAs = "followUp" | "steer";

interface FrameBase {
  v: 1;
  type: string;
  id?: string;
}

export interface HelloFrame extends FrameBase {
  type: "hello";
  sessionId: string;
  sessionFile?: string;
  sessionName?: string;
  cwd: string;
  pid: number;
  model?: string;
  state: SessionState;
  spawned: boolean;
  spawnId?: string;
  extensionVersion: string;
}

export interface StateFrame extends FrameBase {
  type: "state";
  state: SessionState;
  model?: string;
}

export interface TurnFrame extends FrameBase {
  type: "turn";
  text: string;
  usage?: unknown;
}

export interface GoodbyeFrame extends FrameBase {
  type: "goodbye";
}

export interface ResultFrame extends FrameBase {
  type: "result";
  id: string;
  ok: boolean;
  data?: unknown;
  error?: string;
}

export interface PongFrame extends FrameBase {
  type: "pong";
  id: string;
}

export interface HelloAckFrame extends FrameBase {
  type: "hello_ack";
  shortId: number;
  name: string;
  daemonPid?: number;
}

export interface PromptFrame extends FrameBase {
  type: "prompt";
  id: string;
  text: string;
  deliverAs: DeliverAs;
}

export interface AbortFrame extends FrameBase {
  type: "abort";
  id: string;
}

export interface RenameFrame extends FrameBase {
  type: "rename";
  id: string;
  name: string;
}

export interface QueryFrame extends FrameBase {
  type: "query";
  id: string;
  what: "state";
}

export interface NotifyFrame extends FrameBase {
  type: "notify";
  text: string;
}

export interface PingFrame extends FrameBase {
  type: "ping";
  id: string;
}

export type MemberFrame = HelloFrame | StateFrame | TurnFrame | GoodbyeFrame | ResultFrame | PongFrame;
export type DaemonFrame = HelloAckFrame | PromptFrame | AbortFrame | RenameFrame | QueryFrame | NotifyFrame | PingFrame;
export type ControlFrame = MemberFrame | DaemonFrame;

export interface UnknownFrame {
  v: 1;
  type: string;
  id?: string;
  raw: Record<string, unknown>;
}

export type ParsedFrame =
  | { kind: "frame"; frame: ControlFrame }
  | { kind: "unknown"; frame: UnknownFrame }
  | { kind: "invalid"; error: string; close: boolean };

const knownTypes = new Set([
  "hello",
  "state",
  "turn",
  "goodbye",
  "result",
  "pong",
  "hello_ack",
  "prompt",
  "abort",
  "rename",
  "query",
  "notify",
  "ping",
]);

export function serializeFrame(frame: ControlFrame): string {
  return `${JSON.stringify(frame)}\n`;
}

export function parseFrameLine(line: string): ParsedFrame {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch (error) {
    return { kind: "invalid", error: error instanceof Error ? error.message : String(error), close: false };
  }

  if (!isRecord(value)) {
    return { kind: "invalid", error: "frame must be an object", close: false };
  }

  if (value.v !== PROTOCOL_VERSION) {
    return { kind: "invalid", error: "unsupported protocol version", close: true };
  }

  if (typeof value.type !== "string") {
    return { kind: "invalid", error: "frame type must be a string", close: false };
  }

  if (!knownTypes.has(value.type)) {
    return {
      kind: "unknown",
      frame: {
        v: PROTOCOL_VERSION,
        type: value.type,
        id: typeof value.id === "string" ? value.id : undefined,
        raw: value,
      },
    };
  }

  const error = validateKnownFrame(value);
  if (error !== undefined) {
    return { kind: "invalid", error, close: false };
  }

  return { kind: "frame", frame: value as unknown as ControlFrame };
}

export class FrameLineBuffer {
  private buffered = "";

  reset(): void {
    this.buffered = "";
  }

  push(chunk: Buffer | string): ParsedFrame[] {
    this.buffered += Buffer.isBuffer(chunk) ? chunk.toString("utf8") : chunk;
    const frames: ParsedFrame[] = [];

    for (;;) {
      const newline = this.buffered.indexOf("\n");
      if (newline === -1) {
        return frames;
      }

      const line = this.buffered.slice(0, newline);
      this.buffered = this.buffered.slice(newline + 1);
      if (line.trim() !== "") {
        frames.push(parseFrameLine(line));
      }
    }
  }
}

export function makeRequestId(prefix = "baker"): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export function isSessionState(value: unknown): value is SessionState {
  return value === "idle" || value === "busy" || value === "unknown";
}

export function isDeliverAs(value: unknown): value is DeliverAs {
  return value === "followUp" || value === "steer";
}

function validateKnownFrame(frame: Record<string, unknown>): string | undefined {
  if (frame.id !== undefined && typeof frame.id !== "string") {
    return "frame id must be a string";
  }

  switch (frame.type) {
    case "hello":
      return validateHello(frame);
    case "state":
      return isSessionState(frame.state) ? undefined : "state frame requires state";
    case "turn":
      return typeof frame.text === "string" ? undefined : "turn frame requires text";
    case "goodbye":
      return undefined;
    case "result":
      if (typeof frame.id !== "string") {
        return "result frame requires id";
      }
      return typeof frame.ok === "boolean" ? undefined : "result frame requires ok";
    case "pong":
      return typeof frame.id === "string" ? undefined : "pong frame requires id";
    case "hello_ack":
      if (typeof frame.shortId !== "number") {
        return "hello_ack frame requires shortId";
      }
      if (typeof frame.name !== "string") {
        return "hello_ack frame requires name";
      }
      return frame.daemonPid === undefined || typeof frame.daemonPid === "number" ? undefined : "hello_ack frame daemonPid must be a number";
    case "prompt":
      if (typeof frame.id !== "string") {
        return "prompt frame requires id";
      }
      if (typeof frame.text !== "string") {
        return "prompt frame requires text";
      }
      return isDeliverAs(frame.deliverAs) ? undefined : "prompt frame requires deliverAs";
    case "abort":
      return typeof frame.id === "string" ? undefined : "abort frame requires id";
    case "rename":
      if (typeof frame.id !== "string") {
        return "rename frame requires id";
      }
      return typeof frame.name === "string" && frame.name.trim() !== "" ? undefined : "rename frame requires name";
    case "query":
      if (typeof frame.id !== "string") {
        return "query frame requires id";
      }
      return frame.what === "state" ? undefined : "query frame requires what";
    case "notify":
      return typeof frame.text === "string" ? undefined : "notify frame requires text";
    case "ping":
      return typeof frame.id === "string" ? undefined : "ping frame requires id";
    default:
      return "unknown known frame type";
  }
}

function validateHello(frame: Record<string, unknown>): string | undefined {
  if (typeof frame.sessionId !== "string" || frame.sessionId.length === 0) {
    return "hello frame requires sessionId";
  }
  if (frame.sessionFile !== undefined && typeof frame.sessionFile !== "string") {
    return "hello frame sessionFile must be a string";
  }
  if (frame.sessionName !== undefined && typeof frame.sessionName !== "string") {
    return "hello frame sessionName must be a string";
  }
  if (typeof frame.cwd !== "string" || frame.cwd.length === 0) {
    return "hello frame requires cwd";
  }
  if (typeof frame.pid !== "number") {
    return "hello frame requires pid";
  }
  if (frame.model !== undefined && typeof frame.model !== "string") {
    return "hello frame model must be a string";
  }
  if (!isSessionState(frame.state)) {
    return "hello frame requires state";
  }
  if (typeof frame.spawned !== "boolean") {
    return "hello frame requires spawned";
  }
  if (frame.spawnId !== undefined && typeof frame.spawnId !== "string") {
    return "hello frame spawnId must be a string";
  }
  if (typeof frame.extensionVersion !== "string") {
    return "hello frame requires extensionVersion";
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
