import { chmodSync, existsSync, unlinkSync } from "node:fs";
import { createConnection, createServer, type Server, type Socket } from "node:net";

import { BakerRegistry, type RegistrySession } from "./registry.ts";
import {
  FrameLineBuffer,
  type AbortFrame,
  type ControlFrame,
  type DeliverAs,
  type HelloFrame,
  type PromptFrame,
  type QueryFrame,
  type RenameFrame,
  type ResultFrame,
  makeRequestId,
  serializeFrame,
} from "../protocol.ts";

export interface ControlServerOptions {
  socketPath: string;
  registry: BakerRegistry;
  pingIntervalMs?: number;
  staleAfterMs?: number;
}

export interface ControlServerStatus {
  socketPath: string;
  listening: boolean;
  connectedMembers: number;
}

export interface TurnEvent {
  shortId: number;
  name: string | undefined;
  text: string;
}

export interface RegistrationEvent {
  session: RegistrySession;
  hello: HelloFrame;
}

export interface DisconnectEvent {
  shortId: number;
  name: string | undefined;
  reason: string;
}

export interface TurnWaiter {
  promise: Promise<string>;
  cancel: () => void;
}

interface PendingTurnWaiter {
  resolve: (text: string) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

interface PendingRequest {
  resolve: (frame: ResultFrame) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

class MemberConnection {
  readonly socket: Socket;
  readonly decoder = new FrameLineBuffer();
  shortId: number | undefined;
  name: string | undefined;
  lastPong = Date.now();
  readonly pending = new Map<string, PendingRequest>();

  constructor(socket: Socket) {
    this.socket = socket;
  }

  send(frame: ControlFrame): void {
    this.socket.write(serializeFrame(frame));
  }

  request(frame: PromptFrame | AbortFrame | RenameFrame | QueryFrame, timeoutMs: number): Promise<ResultFrame> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(frame.id);
        reject(new Error(`request ${frame.id} timed out`));
      }, timeoutMs);
      this.pending.set(frame.id, { resolve, reject, timer });
      this.send(frame);
    });
  }

  settle(frame: ResultFrame): void {
    const pending = this.pending.get(frame.id);
    if (pending === undefined) {
      return;
    }
    clearTimeout(pending.timer);
    this.pending.delete(frame.id);
    pending.resolve(frame);
  }

  rejectAll(error: Error): void {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      this.pending.delete(id);
      pending.reject(error);
    }
  }
}

export class ControlServer {
  private readonly socketPath: string;
  private readonly registry: BakerRegistry;
  private readonly pingIntervalMs: number;
  private readonly staleAfterMs: number;
  private server: Server | undefined;
  private pingTimer: NodeJS.Timeout | undefined;
  private readonly connectionsBySocket = new Map<Socket, MemberConnection>();
  private readonly connectionsByShortId = new Map<number, MemberConnection>();
  private readonly turnWaiters = new Map<number, PendingTurnWaiter[]>();
  private readonly lastTurns = new Map<number, string>();
  private readonly turnListeners = new Set<(event: TurnEvent) => void>();
  private readonly registrationListeners = new Set<(event: RegistrationEvent) => void>();
  private readonly disconnectListeners = new Set<(event: DisconnectEvent) => void>();

  constructor(options: ControlServerOptions) {
    this.socketPath = options.socketPath;
    this.registry = options.registry;
    this.pingIntervalMs = options.pingIntervalMs ?? 30_000;
    this.staleAfterMs = options.staleAfterMs ?? 90_000;
  }

  async start(): Promise<void> {
    if (this.server !== undefined) {
      return;
    }

    await prepareControlSocket(this.socketPath);
    const server = createServer((socket) => this.accept(socket));
    try {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(this.socketPath, () => {
          server.off("error", reject);
          chmodSync(this.socketPath, 0o600);
          resolve();
        });
      });
    } catch (error) {
      server.close(() => undefined);
      throw error;
    }

    this.server = server;
    this.pingTimer = setInterval(() => this.pingMembers(), this.pingIntervalMs);
    this.pingTimer.unref();
  }

  async stop(options: { notify?: boolean } = {}): Promise<void> {
    if (this.pingTimer !== undefined) {
      clearInterval(this.pingTimer);
      this.pingTimer = undefined;
    }

    if (options.notify ?? true) {
      this.notifyAll("pi-baker daemon shutting down");
    }

    for (const connection of this.connectionsBySocket.values()) {
      connection.rejectAll(new Error("control server stopped"));
      connection.socket.end();
    }
    this.connectionsBySocket.clear();
    this.connectionsByShortId.clear();
    this.rejectAllTurnWaiters(new Error("control server stopped"));

    const server = this.server;
    this.server = undefined;
    if (server !== undefined) {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error === undefined ? resolve() : reject(error)));
      });
    }

    if (existsSync(this.socketPath)) {
      unlinkSync(this.socketPath);
    }
  }

  status(): ControlServerStatus {
    return {
      socketPath: this.socketPath,
      listening: this.server !== undefined,
      connectedMembers: this.connectionsByShortId.size,
    };
  }

  async prompt(shortId: number, text: string, deliverAs: DeliverAs, timeoutMs = 5_000): Promise<void> {
    const connection = this.requireConnection(shortId);
    const id = makeRequestId("prompt");
    const result = await connection.request({ v: 1, type: "prompt", id, text, deliverAs }, timeoutMs);
    if (!result.ok) {
      throw new Error(result.error ?? "prompt rejected");
    }
    this.registry.recordEvent(shortId, deliverAs === "steer" ? "steer" : "prompt");
  }

  waitForNextTurn(shortId: number, timeoutMs = 300_000): Promise<string> {
    return this.createTurnWaiter(shortId, timeoutMs).promise;
  }

  createTurnWaiter(shortId: number, timeoutMs = 300_000): TurnWaiter {
    let entry: PendingTurnWaiter | undefined;

    const promise = new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (entry !== undefined) {
          this.removeTurnWaiter(shortId, entry);
          entry = undefined;
        }
        reject(new Error(`timed out waiting for session #${shortId}`));
      }, timeoutMs);
      timer.unref();

      entry = { resolve, reject, timer };
      const waiters = this.turnWaiters.get(shortId) ?? [];
      waiters.push(entry);
      this.turnWaiters.set(shortId, waiters);
    });

    return {
      promise,
      cancel: () => {
        if (entry === undefined) {
          return;
        }
        clearTimeout(entry.timer);
        this.removeTurnWaiter(shortId, entry);
        entry.reject(new Error(`cancelled waiting for session #${shortId}`));
        entry = undefined;
      },
    };
  }

  pendingTurnWaiterCount(shortId: number): number {
    return this.turnWaiters.get(shortId)?.length ?? 0;
  }

  async abort(shortId: number, timeoutMs = 5_000): Promise<void> {
    const connection = this.requireConnection(shortId);
    const id = makeRequestId("abort");
    const result = await connection.request({ v: 1, type: "abort", id }, timeoutMs);
    if (!result.ok) {
      throw new Error(result.error ?? "abort rejected");
    }
    this.registry.recordEvent(shortId, "abort");
  }

  async rename(shortId: number, name: string, timeoutMs = 5_000): Promise<string | undefined> {
    const connection = this.requireConnection(shortId);
    const id = makeRequestId("rename");
    const result = await connection.request({ v: 1, type: "rename", id, name }, timeoutMs);
    if (!result.ok) {
      throw new Error(result.error ?? "rename rejected");
    }
    return resultName(result.data);
  }

  async queryState(shortId: number, timeoutMs = 5_000): Promise<unknown> {
    const connection = this.requireConnection(shortId);
    const id = makeRequestId("query");
    const result = await connection.request({ v: 1, type: "query", id, what: "state" }, timeoutMs);
    if (!result.ok) {
      throw new Error(result.error ?? "query rejected");
    }
    return result.data;
  }

  notify(shortId: number, text: string): void {
    this.requireConnection(shortId).send({ v: 1, type: "notify", text });
  }

  notifyAll(text: string): void {
    for (const connection of this.connectionsBySocket.values()) {
      connection.send({ v: 1, type: "notify", text });
    }
  }

  disconnect(shortId: number, reason = `session #${shortId} disconnected`): void {
    const error = new Error(reason);
    const connection = this.connectionsByShortId.get(shortId);
    if (connection === undefined) {
      const session = this.registry.getSession(shortId);
      if (session?.connected) {
        this.registry.markDisconnected(shortId);
        this.emitDisconnect({ shortId, name: session.name, reason });
      }
      this.rejectTurnWaiters(shortId, error);
      return;
    }

    connection.socket.destroy(error);
    this.dropConnection(connection, error);
  }

  rememberTurn(shortId: number, text: string): void {
    this.lastTurns.set(shortId, text);
  }

  resolveLocalTurn(shortId: number, text: string): void {
    this.rememberTurn(shortId, text);
    this.resolveTurnWaiters(shortId, text);
  }

  rejectLocalTurn(shortId: number, reason: string | Error): void {
    this.rejectTurnWaiters(shortId, reason instanceof Error ? reason : new Error(reason));
  }

  getLastTurn(shortId: number): string | undefined {
    return this.lastTurns.get(shortId);
  }

  onTurn(listener: (event: TurnEvent) => void): () => void {
    this.turnListeners.add(listener);
    return () => this.turnListeners.delete(listener);
  }

  onRegistration(listener: (event: RegistrationEvent) => void): () => void {
    this.registrationListeners.add(listener);
    return () => this.registrationListeners.delete(listener);
  }

  onDisconnect(listener: (event: DisconnectEvent) => void): () => void {
    this.disconnectListeners.add(listener);
    return () => this.disconnectListeners.delete(listener);
  }

  private accept(socket: Socket): void {
    const connection = new MemberConnection(socket);
    this.connectionsBySocket.set(socket, connection);

    socket.on("data", (chunk) => {
      for (const parsed of connection.decoder.push(chunk)) {
        if (parsed.kind === "invalid") {
          if (parsed.close) {
            socket.destroy(new Error(parsed.error));
            return;
          }
          continue;
        }
        if (parsed.kind === "unknown") {
          continue;
        }
        this.handleFrame(connection, parsed.frame);
      }
    });
    socket.on("close", () => this.dropConnection(connection));
    socket.on("error", (error) => this.dropConnection(connection, error));
  }

  private handleFrame(connection: MemberConnection, frame: ControlFrame): void {
    if (!this.connectionsBySocket.has(connection.socket)) {
      return;
    }

    switch (frame.type) {
      case "hello":
        this.handleHello(connection, frame);
        break;
      case "state":
        if (connection.shortId !== undefined) {
          this.registry.updateState(connection.shortId, frame.state, frame.model);
        }
        break;
      case "turn":
        if (connection.shortId !== undefined) {
          this.rememberTurn(connection.shortId, frame.text);
          this.registry.recordTurn(connection.shortId, frame.text);
          for (const listener of this.turnListeners) {
            listener({ shortId: connection.shortId, name: connection.name, text: frame.text });
          }
          this.resolveTurnWaiters(connection.shortId, frame.text);
        }
        break;
      case "goodbye":
        connection.socket.end();
        break;
      case "result":
        connection.settle(frame);
        break;
      case "pong":
        connection.lastPong = Date.now();
        break;
      default:
        break;
    }
  }

  private handleHello(connection: MemberConnection, frame: HelloFrame): void {
    const kind = frame.spawned ? "spawned" : "member";
    const session = this.registry.upsertHello(frame, kind);
    if (connection.shortId !== undefined) {
      this.connectionsByShortId.delete(connection.shortId);
    }
    const previous = this.connectionsByShortId.get(session.shortId);
    if (previous !== undefined && previous !== connection) {
      this.connectionsBySocket.delete(previous.socket);
      previous.rejectAll(new Error(`session #${session.shortId} reconnected`));
      previous.socket.end();
    }
    connection.shortId = session.shortId;
    connection.name = session.name;
    this.connectionsByShortId.set(session.shortId, connection);
    connection.send({ v: 1, type: "hello_ack", shortId: session.shortId, name: session.name, daemonPid: process.pid });
    for (const listener of this.registrationListeners) {
      listener({ session, hello: frame });
    }
  }

  private dropConnection(connection: MemberConnection, error?: Error): void {
    const disconnectError = error ?? new Error(connection.shortId === undefined ? "member disconnected" : `session #${connection.shortId} disconnected`);
    this.connectionsBySocket.delete(connection.socket);
    connection.rejectAll(disconnectError);
    if (connection.shortId !== undefined && this.connectionsByShortId.get(connection.shortId) === connection) {
      this.connectionsByShortId.delete(connection.shortId);
      this.registry.markDisconnected(connection.shortId);
      this.rejectTurnWaiters(connection.shortId, disconnectError);
      this.emitDisconnect({ shortId: connection.shortId, name: connection.name, reason: disconnectError.message });
    }
  }

  private emitDisconnect(event: DisconnectEvent): void {
    for (const listener of this.disconnectListeners) {
      listener(event);
    }
  }

  private pingMembers(): void {
    const now = Date.now();
    for (const connection of this.connectionsByShortId.values()) {
      if (now - connection.lastPong > this.staleAfterMs) {
        connection.socket.destroy(new Error("member liveness timed out"));
        continue;
      }
      connection.send({ v: 1, type: "ping", id: makeRequestId("ping") });
    }
  }

  private requireConnection(shortId: number): MemberConnection {
    const connection = this.connectionsByShortId.get(shortId);
    if (connection === undefined) {
      const row = this.registry.getSession(shortId);
      const suffix = row === undefined ? "" : ` (last seen ${row.lastSeen})`;
      throw new Error(`session #${shortId} is disconnected${suffix}`);
    }
    return connection;
  }

  private removeTurnWaiter(shortId: number, entry: PendingTurnWaiter): void {
    const current = this.turnWaiters.get(shortId) ?? [];
    const next = current.filter((candidate) => candidate !== entry);
    if (next.length === 0) {
      this.turnWaiters.delete(shortId);
    } else {
      this.turnWaiters.set(shortId, next);
    }
  }

  private resolveTurnWaiters(shortId: number, text: string): void {
    const waiters = this.turnWaiters.get(shortId) ?? [];
    this.turnWaiters.delete(shortId);
    for (const waiter of waiters) {
      clearTimeout(waiter.timer);
      waiter.resolve(text);
    }
  }

  private rejectTurnWaiters(shortId: number, error: Error): void {
    const waiters = this.turnWaiters.get(shortId) ?? [];
    this.turnWaiters.delete(shortId);
    for (const waiter of waiters) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
  }

  private rejectAllTurnWaiters(error: Error): void {
    for (const shortId of [...this.turnWaiters.keys()]) {
      this.rejectTurnWaiters(shortId, error);
    }
  }
}

function resultName(data: unknown): string | undefined {
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    return undefined;
  }
  const name = (data as Record<string, unknown>).name;
  return typeof name === "string" && name.trim() !== "" ? name.trim() : undefined;
}

export async function prepareControlSocket(socketPath: string): Promise<void> {
  if (!existsSync(socketPath)) {
    return;
  }

  const live = await new Promise<boolean>((resolve) => {
    const socket = createConnection(socketPath);
    socket.once("connect", () => {
      socket.end();
      resolve(true);
    });
    socket.once("error", () => resolve(false));
  });

  if (live) {
    throw new Error(`pi-baker daemon already running at ${socketPath}`);
  }

  unlinkSync(socketPath);
}

export function formatSessionsTable(sessions: RegistrySession[]): string {
  if (sessions.length === 0) {
    return "no sessions";
  }

  return sessions
    .map((session) => {
      const connected = session.connected ? "up" : "down";
      const model = session.model ?? "-";
      return `#${session.shortId} ${session.name} ${session.state} ${session.kind} ${connected} cwd=${session.cwd} model=${model} last=${session.lastSeen}`;
    })
    .join("\n");
}
