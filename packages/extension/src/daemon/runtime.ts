import type { Model } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { ensureBakerDir, EXTENSION_VERSION, type BakerConfig } from "../config.ts";
import type { HelloFrame } from "../protocol.ts";
import { BakerRegistry } from "./registry.ts";
import { BakerServices } from "./services.ts";
import { SignalBridge } from "./signal.ts";
import { SpawnManager } from "./spawn.ts";
import { ControlServer, prepareControlSocket } from "./server.ts";

const RUNTIME_STORE_SYMBOL = Symbol.for("@pi-baker/extension.daemon-runtimes.v1");

type SessionShutdownReason = "quit" | "reload" | "new" | "resume" | "fork";

interface DaemonBinding {
  readonly token: symbol;
  readonly pi: ExtensionAPI;
  context: ExtensionContext | undefined;
}

export interface DaemonAttachment {
  readonly token: symbol;
  readonly runtime: DaemonRuntime;
}

/**
 * Process-owned daemon resources.
 *
 * Pi creates a fresh extension instance when replacing a session. The socket,
 * registry, Signal bridge, and spawned children belong to the process rather
 * than to any one extension instance, while `pi` and `ctx` belong to exactly
 * one current session. This runtime keeps those lifetimes separate and routes
 * every session-bound operation through the current binding.
 */
export class DaemonRuntime {
  readonly key: string;
  readonly config: BakerConfig;

  private binding: DaemonBinding | undefined;
  private startup: Promise<void> | undefined;
  private shutdown: Promise<void> | undefined;
  private activeRegistry: BakerRegistry | undefined;
  private activeServer: ControlServer | undefined;
  private activeServices: BakerServices | undefined;
  private activeSignal: SignalBridge | undefined;
  private activeSpawner: SpawnManager | undefined;
  private removeTurnListener: (() => void) | undefined;
  private removeDisconnectListener: (() => void) | undefined;
  private startupNoticeTimer: NodeJS.Timeout | undefined;

  constructor(config: BakerConfig) {
    this.key = config.socketPath;
    this.config = config;
  }

  get registry(): BakerRegistry | undefined {
    return this.activeRegistry;
  }

  get server(): ControlServer | undefined {
    return this.activeServer;
  }

  get services(): BakerServices | undefined {
    return this.activeServices;
  }

  get signal(): SignalBridge | undefined {
    return this.activeSignal;
  }

  attach(pi: ExtensionAPI): DaemonAttachment {
    const token = Symbol("pi-baker daemon extension instance");
    this.binding = { token, pi, context: undefined };
    return { token, runtime: this };
  }

  async onSessionStart(token: symbol, ctx: ExtensionContext): Promise<void> {
    if (!this.bindContext(token, ctx)) {
      return;
    }
    if (this.config.signalAccount === undefined) {
      throw new Error("missing PI_BAKER_SIGNAL_ACCOUNT");
    }

    await this.ensureStarted();
    if (!this.isCurrent(token)) {
      return;
    }
    this.activeRegistry?.upsertDaemon(makeHelloFrame(ctx));
  }

  onModelSelect(token: symbol, ctx: ExtensionContext): void {
    if (!this.bindContext(token, ctx)) {
      return;
    }
    this.activeRegistry?.updateState(0, ctx.isIdle() ? "idle" : "busy", formatModel(ctx));
  }

  onAgentStart(token: symbol, ctx: ExtensionContext): void {
    if (!this.bindContext(token, ctx)) {
      return;
    }
    this.activeRegistry?.updateState(0, "busy", formatModel(ctx));
  }

  onAgentEnd(token: symbol, messages: unknown[], ctx: ExtensionContext): void {
    if (!this.bindContext(token, ctx)) {
      return;
    }

    const text = extractLastAssistantText(messages);
    if (text !== undefined) {
      this.activeServer?.resolveLocalTurn(0, text);
      this.activeRegistry?.recordTurn(0, text);
      this.activeRegistry?.updateState(0, "idle", formatModel(ctx));
      void this.activeSignal?.handleDaemonTurn(text);
      return;
    }

    this.activeServer?.rejectLocalTurn(0, "daemon turn ended without an assistant reply");
    this.activeRegistry?.updateState(0, "idle", formatModel(ctx));
    void this.activeSignal?.handleDaemonTurnMissing();
  }

  async onSessionShutdown(token: symbol, reason: SessionShutdownReason): Promise<void> {
    if (!this.isCurrent(token)) {
      return;
    }
    if (reason !== "quit") {
      // The old API/context become invalid before the replacement instance is
      // started. Drop them so asynchronous ingress cannot accidentally use a
      // stale session-bound object during that short handoff window.
      this.binding = undefined;
      return;
    }

    if (this.shutdown === undefined) {
      this.shutdown = this.stopResources();
    }
    try {
      await this.shutdown;
    } finally {
      if (this.isCurrent(token)) {
        this.binding = undefined;
      }
      forgetRuntime(this);
      this.shutdown = undefined;
    }
  }

  private bindContext(token: symbol, ctx: ExtensionContext): boolean {
    if (!this.isCurrent(token)) {
      return false;
    }
    this.binding!.context = ctx;
    return true;
  }

  private isCurrent(token: symbol): boolean {
    return this.binding?.token === token;
  }

  private async ensureStarted(): Promise<void> {
    if (this.startup !== undefined) {
      await this.startup;
      return;
    }
    if (this.activeServer !== undefined) {
      return;
    }

    const startup = this.startResources();
    this.startup = startup;
    try {
      await startup;
    } finally {
      if (this.startup === startup) {
        this.startup = undefined;
      }
    }
  }

  private async startResources(): Promise<void> {
    ensureBakerDir(this.config);
    await prepareControlSocket(this.config.socketPath);

    const registry = new BakerRegistry(this.config.dbPath, { storeTurns: this.config.storeTurns });
    registry.markAllDisconnected();
    const server = new ControlServer({ socketPath: this.config.socketPath, registry });
    let serverStarted = false;

    try {
      await server.start();
      serverStarted = true;

      const spawner = new SpawnManager({
        config: this.config,
        registry,
        server,
        onCrash: (session, message) => {
          void this.activeSignal?.handleSpawnCrash(session.shortId, session.name, message);
        },
      });
      const services = new BakerServices(registry, server, spawner, {
        sendUserMessage: (text, deliverAs) => this.requireBinding().pi.sendUserMessage(text, { deliverAs }),
        rename: (name) => {
          const pi = this.requireBinding().pi;
          pi.setSessionName(name);
          return pi.getSessionName() ?? name;
        },
        abort: () => this.requireContext().abort(),
      });
      const signal = new SignalBridge({
        config: this.config,
        services: () => this.activeServices,
        sendUserMessage: (text) => this.requireBinding().pi.sendUserMessage(text, { deliverAs: "followUp" }),
        setDaemonModel: async (query) => this.switchDaemonModel(query),
        getDaemonInfo: () => {
          const context = this.binding?.context;
          return {
            cwd: context?.cwd ?? process.cwd(),
            model: context === undefined ? undefined : formatModel(context),
            sessionId: context?.sessionManager.getSessionId(),
            sessionName: context?.sessionManager.getSessionName(),
          };
        },
      });

      this.activeRegistry = registry;
      this.activeServer = server;
      this.activeSpawner = spawner;
      this.activeServices = services;
      this.activeSignal = signal;
      this.removeTurnListener = server.onTurn((event) => {
        void this.activeSignal?.handleMemberTurn(event.shortId, event.name, event.text);
      });
      this.removeDisconnectListener = server.onDisconnect((event) => {
        void this.activeSignal?.handleMemberDisconnect(event.shortId, event.name, event.reason);
      });

      await signal.start();
      this.startupNoticeTimer = scheduleStartupNotice(registry, signal);
    } catch (error) {
      this.clearStartupNotice();
      this.removeResourceListeners();
      await this.activeSpawner?.stopAll().catch(() => undefined);
      await this.activeSignal?.stop().catch(() => undefined);
      if (serverStarted) {
        await server.stop({ notify: false }).catch(() => undefined);
        registry.markAllDisconnected({ updateLastSeen: true });
      }
      registry.close();
      this.clearResources();
      throw error;
    }
  }

  private async stopResources(): Promise<void> {
    if (this.startup !== undefined) {
      await this.startup.catch(() => undefined);
    }

    this.clearStartupNotice();
    this.removeResourceListeners();
    this.activeServer?.notifyAll("pi-baker daemon shutting down");

    const errors: unknown[] = [];
    await captureCleanupError(errors, () => this.activeSpawner?.stopAll());
    await captureCleanupError(errors, () => this.activeSignal?.sendShutdownNotice());
    await captureCleanupError(errors, () => this.activeSignal?.stop());
    await captureCleanupError(errors, () => this.activeServer?.stop({ notify: false }));
    try {
      this.activeRegistry?.markAllDisconnected({ updateLastSeen: true });
    } catch (error) {
      errors.push(error);
    }
    try {
      this.activeRegistry?.close();
    } catch (error) {
      errors.push(error);
    }
    this.clearResources();

    if (errors.length > 0) {
      throw new AggregateError(errors, "failed to stop one or more pi-baker daemon resources");
    }
  }

  private requireBinding(): DaemonBinding {
    if (this.binding === undefined) {
      throw new Error("daemon session replacement is in progress");
    }
    return this.binding;
  }

  private requireContext(): ExtensionContext {
    const context = this.requireBinding().context;
    if (context === undefined) {
      throw new Error("daemon context is not ready");
    }
    return context;
  }

  private async switchDaemonModel(query: string): Promise<string> {
    const binding = this.binding;
    const ctx = binding?.context;
    if (binding === undefined || ctx === undefined) {
      return "daemon context is not ready";
    }

    const match = findModel(ctx.modelRegistry.getAvailable(), query) ?? findModel(ctx.modelRegistry.getAll(), query);
    if (match === undefined) {
      return `no model matching ${query}`;
    }

    const switched = await binding.pi.setModel(match);
    if (!switched) {
      return `model ${match.provider}/${match.id} is not available; check authentication`;
    }
    return `model set to ${match.provider}/${match.id}`;
  }

  private clearStartupNotice(): void {
    if (this.startupNoticeTimer !== undefined) {
      clearTimeout(this.startupNoticeTimer);
      this.startupNoticeTimer = undefined;
    }
  }

  private removeResourceListeners(): void {
    this.removeTurnListener?.();
    this.removeTurnListener = undefined;
    this.removeDisconnectListener?.();
    this.removeDisconnectListener = undefined;
  }

  private clearResources(): void {
    this.activeSignal = undefined;
    this.activeSpawner = undefined;
    this.activeServer = undefined;
    this.activeServices = undefined;
    this.activeRegistry = undefined;
  }
}

export function attachDaemonRuntime(config: BakerConfig, pi: ExtensionAPI): DaemonAttachment {
  const runtimes = runtimeStore();
  let runtime = runtimes.get(config.socketPath);
  if (runtime === undefined) {
    runtime = new DaemonRuntime(config);
    runtimes.set(config.socketPath, runtime);
  }
  return runtime.attach(pi);
}

export function scheduleStartupNotice(
  registry: BakerRegistry,
  signal: Pick<SignalBridge, "sendStartupNotice">,
  delayMs = 2_000,
): NodeJS.Timeout {
  const timer = setTimeout(() => {
    const reconnected = registry.listSessions().filter((session) => session.kind !== "daemon").length;
    void signal.sendStartupNotice(reconnected);
  }, delayMs);
  timer.unref();
  return timer;
}

function runtimeStore(): Map<string, DaemonRuntime> {
  const globalRecord = globalThis as typeof globalThis & Record<symbol, unknown>;
  const existing = globalRecord[RUNTIME_STORE_SYMBOL];
  if (existing instanceof Map) {
    return existing as Map<string, DaemonRuntime>;
  }

  const created = new Map<string, DaemonRuntime>();
  globalRecord[RUNTIME_STORE_SYMBOL] = created;
  return created;
}

function forgetRuntime(runtime: DaemonRuntime): void {
  const runtimes = runtimeStore();
  if (runtimes.get(runtime.key) === runtime) {
    runtimes.delete(runtime.key);
  }
}

async function captureCleanupError(errors: unknown[], cleanup: () => Promise<unknown> | undefined): Promise<void> {
  try {
    await cleanup();
  } catch (error) {
    errors.push(error);
  }
}

function formatModel(ctx: ExtensionContext): string | undefined {
  return ctx.model === undefined ? undefined : `${ctx.model.provider}/${ctx.model.id}`;
}

function makeHelloFrame(ctx: ExtensionContext): HelloFrame {
  return {
    v: 1,
    type: "hello",
    sessionId: ctx.sessionManager.getSessionId(),
    sessionFile: ctx.sessionManager.getSessionFile(),
    sessionName: ctx.sessionManager.getSessionName() ?? "daemon",
    cwd: ctx.cwd,
    pid: process.pid,
    model: formatModel(ctx),
    state: ctx.isIdle() ? "idle" : "busy",
    spawned: false,
    extensionVersion: EXTENSION_VERSION,
  };
}

function findModel(models: Model<any>[], query: string): Model<any> | undefined {
  const normalized = query.trim().toLowerCase();
  if (normalized === "") {
    return undefined;
  }

  const scored = models
    .map((model) => {
      const full = `${model.provider}/${model.id}`.toLowerCase();
      const id = model.id.toLowerCase();
      const name = model.name.toLowerCase();
      const provider = model.provider.toLowerCase();
      let score = 0;
      if (full === normalized || id === normalized || name === normalized) {
        score = 100;
      } else if (full.startsWith(normalized) || id.startsWith(normalized) || name.startsWith(normalized)) {
        score = 50;
      } else if (full.includes(normalized) || id.includes(normalized) || name.includes(normalized) || provider.includes(normalized)) {
        score = 10;
      }
      return { model, score };
    })
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || a.model.id.localeCompare(b.model.id));

  return scored[0]?.model;
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
