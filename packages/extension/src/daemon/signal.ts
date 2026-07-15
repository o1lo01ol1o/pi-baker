import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

import type { BakerConfig } from "../config.ts";
import { EXTENSION_VERSION } from "../config.ts";
import { formatSessionsTable } from "./server.ts";
import type { BakerServices } from "./services.ts";
import type { RegistrySession } from "./registry.ts";

export interface SignalBridgeOptions {
  config: BakerConfig;
  services: () => BakerServices | undefined;
  sendUserMessage: (text: string) => void | Promise<void>;
  getDaemonInfo?: () => {
    cwd: string;
    model?: string;
    sessionId?: string;
    sessionName?: string;
  };
  setDaemonModel?: (query: string) => Promise<string>;
  clearDaemonSession?: () => Promise<string>;
  fetchImpl?: typeof fetch;
  spawnImpl?: SignalCliSpawn;
  childKillMs?: number;
  healthDeadlineMs?: number;
  healthRetryMs?: number;
}

export interface SignalStatus {
  configured: boolean;
  running: boolean;
  connected: boolean;
  ignored: number;
  paused: boolean;
  lastError?: string;
}

export interface SignalConversation {
  recipient: string;
  sender: string;
  noteToSelf: boolean;
}

export interface SignalReactionTarget {
  recipient: string;
  targetAuthor: string;
  timestamp: number;
}

export interface AcceptedSignalMessage {
  body: string;
  conversation: SignalConversation;
  reactionTarget?: SignalReactionTarget;
}

interface PendingDaemonReply {
  conversation: SignalConversation;
  reactionTarget?: SignalReactionTarget;
  collapseKey?: string;
}

interface PendingMemberRelay {
  conversation: SignalConversation;
  reactionTarget?: SignalReactionTarget;
}

interface DeferredSignalCommandResult {
  text: string;
  deferReaction: true;
}

type SignalCommandResult = string | DeferredSignalCommandResult;
type JsonObject = Record<string, unknown>;
type SignalCliSpawn = (command: string, args: string[], options: { stdio: "pipe" }) => ChildProcessWithoutNullStreams;

const WATCHING = "\u{1F440}";
const OK = "\u{2705}";
const ERROR = "\u{274C}";
const SIGNAL_COMMAND_NAMES = new Set([
  "help",
  "sessions",
  "status",
  "tell",
  "steer",
  "ask",
  "abort",
  "watch",
  "name",
  "pause",
  "resume",
  "resend",
  "spawn",
  "kill",
  "model",
  "clear",
  "whoami",
]);

export class SignalBridge {
  private readonly config: BakerConfig;
  private readonly signalUrl: string;
  private readonly services: () => BakerServices | undefined;
  private readonly sendUserMessage: (text: string) => void | Promise<void>;
  private readonly fetchImpl: typeof fetch;
  private readonly spawnImpl: SignalCliSpawn;
  private readonly childKillMs: number;
  private readonly healthDeadlineMs: number;
  private readonly healthRetryMs: number;
  private readonly getDaemonInfo: NonNullable<SignalBridgeOptions["getDaemonInfo"]>;
  private readonly setDaemonModel: ((query: string) => Promise<string>) | undefined;
  private readonly clearDaemonSession: (() => Promise<string>) | undefined;
  private abortController: AbortController | undefined;
  private child: ChildProcessWithoutNullStreams | undefined;
  private signalRestartTimer: NodeJS.Timeout | undefined;
  private signalRestartDelayMs = 1_000;
  private eventReconnectTimer: NodeJS.Timeout | undefined;
  private eventReconnectDelayMs = 1_000;
  private eventReaderActive = false;
  private running = false;
  private connected = false;
  private ignored = 0;
  private paused = false;
  private readonly startedAt = Date.now();
  private lastError: string | undefined;
  private lastDaemonReply: string | undefined;
  private readonly pendingDaemonReplies: PendingDaemonReply[] = [];
  private readonly pendingMemberRelays = new Map<number, Map<string, PendingMemberRelay>>();
  private readonly watchTargets = new Map<number, Set<string>>();
  private currentConversation: SignalConversation | undefined;

  constructor(options: SignalBridgeOptions) {
    this.config = options.config;
    this.signalUrl = normalizeSignalUrl(options.config.signalUrl);
    this.services = options.services;
    this.sendUserMessage = options.sendUserMessage;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.spawnImpl = options.spawnImpl ?? spawn;
    this.childKillMs = options.childKillMs ?? 5_000;
    this.healthDeadlineMs = options.healthDeadlineMs ?? 15_000;
    this.healthRetryMs = options.healthRetryMs ?? 500;
    this.setDaemonModel = options.setDaemonModel;
    this.clearDaemonSession = options.clearDaemonSession;
    this.getDaemonInfo =
      options.getDaemonInfo ??
      (() => ({
        cwd: process.cwd(),
      }));
  }

  status(): SignalStatus {
    return {
      configured: this.config.signalAccount !== undefined,
      running: this.running,
      connected: this.connected,
      ignored: this.ignored,
      paused: this.paused,
      lastError: this.lastError,
    };
  }

  async start(): Promise<void> {
    if (this.running) {
      return;
    }

    if (this.config.signalAccount === undefined) {
      this.connected = false;
      this.lastError = "missing PI_BAKER_SIGNAL_ACCOUNT";
      throw new Error(this.lastError);
    }

    this.running = true;
    this.abortController = new AbortController();
    try {
      if (this.config.manageSignal) {
        this.startSignalCli();
        await this.waitForHealth(this.abortController.signal);
      } else {
        await this.checkHealth(this.abortController.signal);
      }

      this.lastError = undefined;
      this.restorePersistentWatchTargets();
      this.startEventReader();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.stop();
      this.lastError = message;
      throw error;
    }
  }

  async stop(): Promise<void> {
    this.running = false;
    this.connected = false;
    if (this.signalRestartTimer !== undefined) {
      clearTimeout(this.signalRestartTimer);
      this.signalRestartTimer = undefined;
    }
    if (this.eventReconnectTimer !== undefined) {
      clearTimeout(this.eventReconnectTimer);
      this.eventReconnectTimer = undefined;
    }
    this.abortController?.abort();
    this.abortController = undefined;
    if (this.child !== undefined) {
      const child = this.child;
      this.child = undefined;
      await stopSignalCliChild(child, this.childKillMs);
    }
  }

  async handleDaemonTurn(text: string): Promise<void> {
    const pending = this.pendingDaemonReplies.shift();
    const targets = this.watchTargets.get(0);
    const reply = truncateSignalText(text);
    this.lastDaemonReply = reply;
    const sent = new Set<string>();

    if (pending !== undefined) {
      sent.add(pending.conversation.recipient);
      if (await this.safeSendText(pending.conversation.recipient, reply)) {
        await this.safeReact(pending.reactionTarget, OK);
      } else {
        await this.safeReact(pending.reactionTarget, ERROR);
      }
    }
    for (const recipient of targets ?? []) {
      if (sent.has(recipient)) {
        continue;
      }
      await this.safeSendText(recipient, reply);
    }
    this.currentConversation = this.pendingDaemonReplies[0]?.conversation;
  }

  async handleDaemonTurnMissing(reason = "daemon turn ended without an assistant reply"): Promise<void> {
    const pending = this.pendingDaemonReplies.shift();
    if (pending !== undefined) {
      await this.safeSendText(pending.conversation.recipient, `error: ${reason}`);
      await this.safeReact(pending.reactionTarget, ERROR);
    }
    this.currentConversation = this.pendingDaemonReplies[0]?.conversation;
  }

  async handleMemberTurn(shortId: number, name: string | undefined, text: string): Promise<void> {
    const targets = this.watchTargets.get(shortId);
    const pending = this.pendingMemberRelays.get(shortId);
    if ((targets === undefined || targets.size === 0) && (pending === undefined || pending.size === 0)) {
      return;
    }

    const message = prefixSessionReply(shortId, name, text);
    const sent = new Set<string>();
    if (pending !== undefined) {
      this.pendingMemberRelays.delete(shortId);
      for (const relay of pending.values()) {
        sent.add(relay.conversation.recipient);
        if (await this.safeSendText(relay.conversation.recipient, message)) {
          await this.safeReact(relay.reactionTarget, OK);
        } else {
          await this.safeReact(relay.reactionTarget, ERROR);
        }
      }
    }

    for (const recipient of targets ?? []) {
      if (sent.has(recipient)) {
        continue;
      }
      await this.safeSendText(recipient, message);
    }
  }

  async handleMemberDisconnect(shortId: number, name: string | undefined, reason: string): Promise<void> {
    const pending = this.pendingMemberRelays.get(shortId);
    if (pending === undefined || pending.size === 0) {
      return;
    }

    this.pendingMemberRelays.delete(shortId);
    const message = prefixSessionReply(shortId, name, `error: ${reason}`);
    for (const relay of pending.values()) {
      await this.safeSendText(relay.conversation.recipient, message);
      await this.safeReact(relay.reactionTarget, ERROR);
    }
  }

  async handleSpawnCrash(shortId: number, name: string | undefined, message: string): Promise<void> {
    const targets = this.watchTargets.get(shortId);
    if (targets === undefined || targets.size === 0) {
      return;
    }

    const text = prefixSessionReply(shortId, name, message);
    for (const recipient of targets) {
      await this.safeSendText(recipient, text);
    }
  }

  async sendFromTool(text: string, recipient?: string): Promise<string> {
    if (this.config.signalAccount === undefined) {
      throw new Error("Signal account is not configured");
    }
    const body = text.trim();
    if (body === "") {
      throw new Error("Signal message text is required");
    }
    const target = cleanOptionalString(recipient) ?? this.currentConversation?.recipient ?? this.config.signalAccount;
    if (target !== this.config.signalAccount && !this.config.whitelist.has(target)) {
      throw new Error("recipient is not authorized");
    }
    await this.sendText(target, truncateSignalText(body));
    return `sent Signal message to ${target}`;
  }

  setWatchTarget(shortId: number, recipient: string, watch: boolean): void {
    this.replaceWatchTargets(shortId, this.nextWatchTargets(shortId, recipient, watch));
  }

  private nextWatchTargets(shortId: number, recipient: string, watch: boolean): Set<string> {
    const targets = new Set(this.watchTargets.get(shortId) ?? []);
    const cleanRecipient = recipient.trim();
    if (cleanRecipient !== "") {
      if (watch) {
        targets.add(cleanRecipient);
      } else {
        targets.delete(cleanRecipient);
      }
    }
    return targets;
  }

  private replaceWatchTargets(shortId: number, targets: Set<string>): void {
    if (targets.size === 0) {
      this.watchTargets.delete(shortId);
    } else {
      this.watchTargets.set(shortId, targets);
    }
  }

  async sendStartupNotice(reconnected: number): Promise<void> {
    if (this.config.signalAccount === undefined || !this.connected) {
      return;
    }
    await this.safeSendText(this.config.signalAccount, `baker up, ${reconnected} sessions reconnected`);
  }

  async sendShutdownNotice(): Promise<void> {
    if (this.config.signalAccount === undefined || !this.connected) {
      return;
    }
    await this.safeSendText(this.config.signalAccount, "baker shutting down");
  }

  async handleEnvelope(envelope: unknown): Promise<void> {
    const accepted = acceptSignalEnvelope(envelope, this.config);
    if (accepted === undefined) {
      this.ignored += 1;
      return;
    }

    await this.safeReact(accepted.reactionTarget, WATCHING);
    try {
      await this.dispatchMessage(accepted);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.lastError = message;
      try {
        const body = accepted.body.startsWith("/") ? truncateSignalCommandText(`error: ${message}`) : `error: ${message}`;
        await this.sendText(accepted.conversation.recipient, body);
      } catch (sendError) {
        this.lastError = sendError instanceof Error ? sendError.message : String(sendError);
      }
      await this.safeReact(accepted.reactionTarget, ERROR);
    }
  }

  private async dispatchMessage(message: AcceptedSignalMessage): Promise<void> {
    if (message.body.startsWith("/")) {
      const result = await this.runSignalCommand(message.body, message);
      await this.sendText(message.conversation.recipient, truncateSignalCommandText(signalCommandText(result)));
      if (!isDeferredSignalCommandResult(result)) {
        await this.safeReact(message.reactionTarget, OK);
      }
      return;
    }

    if (this.paused) {
      await this.sendText(message.conversation.recipient, "pi-baker is paused; slash commands still work.");
      await this.safeReact(message.reactionTarget, ERROR);
      return;
    }

    const pending: PendingDaemonReply = {
      conversation: message.conversation,
      reactionTarget: message.reactionTarget,
    };
    this.addPendingDaemonReply(pending);
    try {
      await this.sendUserMessage(message.body);
    } catch (error) {
      this.removePendingDaemonReply(pending);
      throw error;
    }
  }

  private async runSignalCommand(input: string, message: AcceptedSignalMessage): Promise<SignalCommandResult> {
    const { name, args } = parseSignalCommand(input);
    const services = this.services();
    if (SIGNAL_COMMAND_NAMES.has(name)) {
      services?.recordCommand?.(name, "signal");
    }
    const conversation = message.conversation;

    switch (name) {
      case "help":
        requireArgCount(args, 0, "usage: /help");
        return [
          "/help",
          "/sessions [all]",
          "/status [session]",
          "/tell <session> <text>",
          "/steer <session> <text>",
          "/ask <session>",
          "/abort <session>",
          "/watch <session> on|off",
          "/spawn <dir> [prompt]",
          "/kill <session>",
          "/name <session> <name>",
          "/pause",
          "/resume",
          "/model [name]",
          "/clear (current Pi: use /baker-clear in daemon TUI)",
          "/resend",
          "/whoami",
        ].join("\n");
      case "sessions":
        if (args.length === 0) {
          return formatSessionsTable(requireServices(services).listSessions(false));
        }
        if (args.length === 1 && args[0] === "all") {
          return formatSessionsTable(requireServices(services).listSessions(true));
        }
        throw new Error("usage: /sessions [all]");
      case "status":
        requireArgCountAtMost(args, 1, "usage: /status [session]");
        if (args.length > 0) {
          return requireServices(services).liveStatusText(args[0] ?? "");
        }
        return this.formatStatus();
      case "tell":
        return this.promptFromCommand(args, "followUp", message);
      case "steer":
        return this.promptFromCommand(args, "steer", message);
      case "ask":
        return this.askFromCommand(args);
      case "abort":
        requireArgCount(args, 1, "usage: /abort <session>");
        return requireServices(services).abort(requireArg(args, 0, "usage: /abort <session>"));
      case "watch":
        return this.watchFromCommand(args, conversation);
      case "name":
        return this.renameFromCommand(args);
      case "pause":
        requireArgCount(args, 0, "usage: /pause");
        this.paused = true;
        return "paused";
      case "resume":
        requireArgCount(args, 0, "usage: /resume");
        this.paused = false;
        return "resumed";
      case "resend":
        requireArgCount(args, 0, "usage: /resend");
        return this.lastDaemonReply ?? "no previous daemon reply is available yet";
      case "spawn":
        return this.spawnFromCommand(args, message);
      case "kill":
        requireArgCount(args, 1, "usage: /kill <session>");
        return requireServices(services).kill(requireArg(args, 0, "usage: /kill <session>"));
      case "model":
        if (args.length === 0) {
          return this.getDaemonInfo().model ?? "no daemon model selected";
        }
        if (this.setDaemonModel === undefined) {
          return "model switching is not available";
        }
        return this.setDaemonModel(args.join(" "));
      case "clear":
        requireArgCount(args, 0, "usage: /clear");
        if (this.clearDaemonSession === undefined) {
          return "/clear is only available in the daemon TUI as /baker-clear; Pi does not expose session replacement to Signal event handlers.";
        }
        return this.clearDaemonSession();
      case "whoami":
        requireArgCount(args, 0, "usage: /whoami");
        return this.formatWhoami();
      default:
        throw new Error(`unknown command /${name}; try /help`);
    }
  }

  private async promptFromCommand(args: string[], mode: "followUp" | "steer", message: AcceptedSignalMessage): Promise<SignalCommandResult> {
    const conversation = message.conversation;
    const selector = requireArg(args, 0, mode === "followUp" ? "usage: /tell <session> <text>" : "usage: /steer <session> <text>");
    const text = args.slice(1).join(" ").trim();
    if (text === "") {
      throw new Error(mode === "followUp" ? "usage: /tell <session> <text>" : "usage: /steer <session> <text>");
    }

    const services = requireServices(this.services());
    const session = services.resolveSelector(selector, { includeDisconnected: true });
    if (session.kind === "daemon") {
      const pending: PendingDaemonReply = {
        conversation,
        reactionTarget: message.reactionTarget,
        collapseKey: daemonCommandRelayKey(session.shortId, conversation),
      };
      const superseded = this.addPendingDaemonReply(pending);
      await this.safeReact(superseded?.reactionTarget, OK);
      try {
        await services.sendPrompt(String(session.shortId), text, mode, false);
      } catch (error) {
        this.removePendingDaemonReply(pending);
        throw error;
      }
      return deferSignalCommandReaction(`sent to #${session.shortId} ${session.name}; next turn will be relayed`);
    }

    const superseded = this.addPendingMemberRelay(session.shortId, { conversation, reactionTarget: message.reactionTarget });
    await this.safeReact(superseded?.reactionTarget, OK);
    try {
      await services.sendPrompt(selector, text, mode, false);
    } catch (error) {
      this.removePendingMemberRelay(session.shortId, conversation.recipient);
      throw error;
    }
    return deferSignalCommandReaction(`sent to #${session.shortId} ${session.name}; next turn will be relayed`);
  }

  private askFromCommand(args: string[]): string {
    requireArgCount(args, 1, "usage: /ask <session>");
    const selector = requireArg(args, 0, "usage: /ask <session>");
    const services = requireServices(this.services());
    const session = services.resolveSelector(selector, { includeDisconnected: true });
    const text = services.last(String(session.shortId));
    return session.kind === "daemon" ? truncateSignalText(text) : prefixSessionReply(session.shortId, session.name, text);
  }

  private watchFromCommand(args: string[], conversation: SignalConversation): string {
    requireArgCount(args, 2, "usage: /watch <session> on|off");
    const selector = requireArg(args, 0, "usage: /watch <session> on|off");
    const rawMode = requireArg(args, 1, "usage: /watch <session> on|off");
    if (rawMode !== "on" && rawMode !== "off") {
      throw new Error("usage: /watch <session> on|off");
    }

    const services = requireServices(this.services());
    const session = services.resolveSelector(selector, { includeDisconnected: true });
    const targets = this.nextWatchTargets(session.shortId, conversation.recipient, rawMode === "on");
    services.setWatchTargets(String(session.shortId), targets);
    this.replaceWatchTargets(session.shortId, targets);
    return `watch ${rawMode} for #${session.shortId} ${session.name}`;
  }

  private async renameFromCommand(args: string[]): Promise<string> {
    const selector = requireArg(args, 0, "usage: /name <session> <name>");
    const name = args.slice(1).join(" ").trim();
    if (name === "") {
      throw new Error("usage: /name <session> <name>");
    }
    const session = await requireServices(this.services()).rename(selector, name);
    return `renamed #${session.shortId} ${session.name}`;
  }

  private async spawnFromCommand(args: string[], message: AcceptedSignalMessage): Promise<SignalCommandResult> {
    const conversation = message.conversation;
    const cwd = requireArg(args, 0, "usage: /spawn <dir> [prompt]");
    const prompt = args.slice(1).join(" ").trim();
    const services = requireServices(this.services());
    if (prompt === "") {
      const result = await services.spawn({ cwd });
      return `spawned #${result.shortId} ${result.name} in ${result.cwd}`;
    }

    let relayShortId: number | undefined;
    try {
      const result = await services.spawn({
        cwd,
        prompt,
        onRegistered: async (registered) => {
          relayShortId = registered.shortId;
          const superseded = this.addPendingMemberRelay(registered.shortId, { conversation, reactionTarget: message.reactionTarget });
          await this.safeReact(superseded?.reactionTarget, OK);
        },
      });
      return deferSignalCommandReaction(`spawned #${result.shortId} ${result.name} in ${result.cwd}; next turn will be relayed`);
    } catch (error) {
      if (relayShortId !== undefined) {
        this.removePendingMemberRelay(relayShortId, conversation.recipient);
      }
      throw error;
    }
  }

  async formatStatus(): Promise<string> {
    const signalCheck = await this.checkHealthForStatus();
    const status = this.status();
    const sessions = this.services()?.listSessions(true) ?? [];
    const connected = sessions.filter((session) => session.connected && session.kind !== "daemon").length;
    const spawned = sessions.filter((session) => session.connected && session.kind === "spawned").length;
    const info = this.getDaemonInfo();
    return [
      "pi-baker daemon",
      `signal configured: ${status.configured ? "yes" : "no"}`,
      `signal check: ${signalCheck.ok ? "ok" : "failed"}`,
      `signal connected: ${status.connected ? "yes" : "no"}`,
      `uptime: ${formatDuration(Date.now() - this.startedAt)}`,
      `model: ${info.model ?? "-"}`,
      `paused: ${status.paused ? "yes" : "no"}`,
      `ignored messages: ${status.ignored}`,
      `connected sessions: ${connected}`,
      `spawned sessions: ${spawned}`,
      `last error: ${signalCheck.error ?? status.lastError ?? "-"}`,
    ].join("\n");
  }

  private addPendingMemberRelay(shortId: number, relay: PendingMemberRelay): PendingMemberRelay | undefined {
    const recipient = relay.conversation.recipient;
    if (recipient === "") {
      return undefined;
    }
    const relays = this.pendingMemberRelays.get(shortId) ?? new Map<string, PendingMemberRelay>();
    const superseded = relays.get(recipient);
    relays.set(recipient, relay);
    this.pendingMemberRelays.set(shortId, relays);
    return superseded;
  }

  private removePendingMemberRelay(shortId: number, recipient: string): void {
    const relays = this.pendingMemberRelays.get(shortId);
    if (relays === undefined) {
      return;
    }
    relays.delete(recipient);
    if (relays.size === 0) {
      this.pendingMemberRelays.delete(shortId);
    }
  }

  private addPendingDaemonReply(pending: PendingDaemonReply): PendingDaemonReply | undefined {
    const wasEmpty = this.pendingDaemonReplies.length === 0;
    if (pending.collapseKey !== undefined) {
      const existingIndex = this.pendingDaemonReplies.findIndex((candidate) => candidate.collapseKey === pending.collapseKey);
      if (existingIndex !== -1) {
        const superseded = this.pendingDaemonReplies[existingIndex];
        this.pendingDaemonReplies[existingIndex] = pending;
        this.currentConversation = this.pendingDaemonReplies[0]?.conversation;
        return superseded;
      }
    }
    this.pendingDaemonReplies.push(pending);
    if (wasEmpty) {
      this.currentConversation = pending.conversation;
    }
    return undefined;
  }

  private removePendingDaemonReply(pending: PendingDaemonReply): void {
    const index = this.pendingDaemonReplies.indexOf(pending);
    if (index !== -1) {
      this.pendingDaemonReplies.splice(index, 1);
    }
    this.currentConversation = this.pendingDaemonReplies[0]?.conversation;
  }

  private restorePersistentWatchTargets(): void {
    if (this.config.signalAccount === undefined) {
      return;
    }
    this.watchTargets.clear();
    const services = this.services();
    const targetsBySession = new Map<number, Set<string>>();
    for (const target of services?.listWatchTargets?.() ?? []) {
      const targets = targetsBySession.get(target.shortId) ?? new Set<string>();
      targets.add(target.recipient);
      targetsBySession.set(target.shortId, targets);
    }

    for (const session of services?.listSessions?.(true) ?? []) {
      if (!session.watch) {
        continue;
      }
      const restoredTargets = targetsBySession.get(session.shortId);
      if (restoredTargets !== undefined && restoredTargets.size > 0) {
        this.watchTargets.set(session.shortId, new Set(restoredTargets));
        continue;
      }
      this.watchTargets.set(session.shortId, new Set([this.config.signalAccount]));
    }
  }

  private formatWhoami(): string {
    const info = this.getDaemonInfo();
    return [
      `pi-baker ${EXTENSION_VERSION}`,
      `cwd: ${info.cwd}`,
      `model: ${info.model ?? "-"}`,
      `session: ${info.sessionId ?? "-"}`,
      `name: ${info.sessionName ?? "-"}`,
    ].join("\n");
  }

  private async checkHealth(signal: AbortSignal): Promise<void> {
    const response = await this.fetchImpl(new URL("/api/v1/check", this.signalUrl), { signal });
    if (!response.ok) {
      throw new Error(`signal-cli health check failed: ${response.status}`);
    }
    this.connected = true;
  }

  private async checkHealthForStatus(timeoutMs = 2_000): Promise<{ ok: boolean; error?: string }> {
    if (this.config.signalAccount === undefined) {
      return { ok: false, error: "missing PI_BAKER_SIGNAL_ACCOUNT" };
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    timer.unref();
    try {
      await this.checkHealth(controller.signal);
      return { ok: true };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.connected = false;
      this.lastError = message;
      return { ok: false, error: message };
    } finally {
      clearTimeout(timer);
    }
  }

  private async waitForHealth(signal: AbortSignal): Promise<void> {
    const deadline = Date.now() + this.healthDeadlineMs;
    let lastError: unknown;
    while (Date.now() < deadline) {
      try {
        await this.checkHealth(signal);
        return;
      } catch (error) {
        lastError = error;
        await delay(this.healthRetryMs, signal);
      }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }

  private startSignalCli(): void {
    if (this.config.signalAccount === undefined) {
      return;
    }
    if (this.child !== undefined) {
      return;
    }
    const httpAddress = signalCliHttpAddress(this.signalUrl);
    const child = this.spawnImpl("signal-cli", ["-a", this.config.signalAccount, "daemon", "--http", httpAddress], {
      stdio: "pipe",
    });
    this.child = child;
    child.stdout.on("data", (chunk) => {
      if (!this.config.quiet) {
        process.stdout.write(String(chunk));
      }
    });
    child.stderr.on("data", (chunk) => {
      if (!this.config.quiet) {
        process.stderr.write(String(chunk));
      }
    });
    child.once("error", (error) => {
      if (this.child !== child) {
        return;
      }
      this.child = undefined;
      this.connected = false;
      if (!this.running) {
        return;
      }
      this.lastError = error.message;
      this.scheduleSignalCliRestart();
    });
    child.once("exit", () => {
      if (this.child !== child) {
        return;
      }
      this.child = undefined;
      this.connected = false;
      if (!this.running) {
        return;
      }
      this.lastError = "signal-cli exited";
      this.scheduleSignalCliRestart();
    });
  }

  private startEventReader(): void {
    if (this.abortController === undefined || this.eventReaderActive) {
      return;
    }
    this.eventReaderActive = true;
    void this.readEvents(this.abortController.signal).finally(() => {
      this.eventReaderActive = false;
    });
  }

  private scheduleSignalCliRestart(): void {
    if (!this.running || !this.config.manageSignal || this.abortController === undefined || this.signalRestartTimer !== undefined) {
      return;
    }

    const delayMs = this.signalRestartDelayMs;
    this.signalRestartDelayMs = Math.min(this.signalRestartDelayMs * 2, 60_000);
    this.signalRestartTimer = setTimeout(() => {
      this.signalRestartTimer = undefined;
      if (!this.running || this.abortController === undefined) {
        return;
      }

      this.startSignalCli();
      void this.waitForHealth(this.abortController.signal)
        .then(() => {
          this.signalRestartDelayMs = 1_000;
          this.lastError = undefined;
          this.startEventReader();
        })
        .catch(async (error) => {
          const child = this.child;
          if (child !== undefined) {
            this.child = undefined;
            await stopSignalCliChild(child, this.childKillMs).catch((killError) => {
              this.lastError = killError instanceof Error ? killError.message : String(killError);
            });
          }
          this.connected = false;
          this.lastError = error instanceof Error ? error.message : String(error);
          this.scheduleSignalCliRestart();
        });
    }, delayMs);
    this.signalRestartTimer.unref();
  }

  private scheduleEventReconnect(): void {
    if (!this.running || this.abortController === undefined || this.eventReconnectTimer !== undefined) {
      return;
    }

    const delayMs = this.eventReconnectDelayMs;
    this.eventReconnectDelayMs = Math.min(this.eventReconnectDelayMs * 2, 60_000);
    this.eventReconnectTimer = setTimeout(() => {
      this.eventReconnectTimer = undefined;
      this.startEventReader();
    }, delayMs);
    this.eventReconnectTimer.unref();
  }

  private async readEvents(signal: AbortSignal): Promise<void> {
    if (this.config.signalAccount === undefined) {
      return;
    }

    try {
      const url = new URL("/api/v1/events", this.signalUrl);
      url.searchParams.set("account", this.config.signalAccount);
      const response = await this.fetchImpl(url, { signal });
      if (!response.ok || response.body === null) {
        throw new Error(`signal-cli events stream failed: ${response.status}`);
      }
      this.connected = true;
      this.eventReconnectDelayMs = 1_000;
      const decoder = new TextDecoder();
      let buffered = "";
      for await (const chunk of response.body as AsyncIterable<Uint8Array>) {
        buffered += decoder.decode(chunk, { stream: true });
        const parsed = parseSseMessages(buffered);
        buffered = parsed.remainder;
        for (const data of parsed.messages) {
          const envelope = parseSignalEventData(data);
          if (envelope === undefined) {
            this.ignored += 1;
            this.lastError = "ignored malformed signal-cli event";
            continue;
          }
          await this.handleEnvelope(envelope);
        }
      }
      if (!signal.aborted) {
        throw new Error("signal-cli events stream ended");
      }
    } catch (error) {
      if (!signal.aborted) {
        this.connected = false;
        this.lastError = error instanceof Error ? error.message : String(error);
        this.scheduleEventReconnect();
      }
    }
  }

  private async sendText(recipient: string, text: string): Promise<void> {
    await this.rpc("send", {
      account: this.config.signalAccount,
      recipients: [recipient],
      message: text,
    });
  }

  private async react(target: SignalReactionTarget | undefined, emoji: string): Promise<void> {
    if (target === undefined) {
      return;
    }
    await this.rpc("sendReaction", {
      account: this.config.signalAccount,
      recipient: target.recipient,
      targetAuthor: target.targetAuthor,
      timestamp: target.timestamp,
      emoji,
    });
  }

  private async safeReact(target: SignalReactionTarget | undefined, emoji: string): Promise<void> {
    try {
      await this.react(target, emoji);
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error);
    }
  }

  private async safeSendText(recipient: string, text: string): Promise<boolean> {
    try {
      await this.sendText(recipient, text);
      return true;
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error);
      return false;
    }
  }

  private async rpc(method: string, params: JsonObject): Promise<unknown> {
    const response = await this.fetchImpl(new URL("/api/v1/rpc", this.signalUrl), {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: `pi-baker-${Date.now()}`,
        method,
        params,
      }),
    });
    if (!response.ok) {
      throw new Error(`signal-cli rpc ${method} failed: ${response.status}`);
    }
    const body = (await response.json()) as JsonObject;
    if (body.error !== undefined) {
      throw new Error(`signal-cli rpc ${method} failed: ${JSON.stringify(body.error)}`);
    }
    return body.result;
  }
}

export function acceptSignalEnvelope(envelope: unknown, config: Pick<BakerConfig, "signalAccount" | "whitelist">): AcceptedSignalMessage | undefined {
  const event = unwrapSignalEnvelope(envelope);
  if (config.signalAccount === undefined || !isRecord(event)) {
    return undefined;
  }

  const syncMessage = asRecord(event.syncMessage);
  const sentMessage = asRecord(syncMessage?.sentMessage);
  const destinationNumber =
    typeof sentMessage?.destinationNumber === "string"
      ? sentMessage.destinationNumber
      : typeof sentMessage?.destination === "string"
        ? sentMessage.destination
        : undefined;
  if (sentMessage !== undefined && destinationNumber === config.signalAccount) {
    if (
      hasGroupMetadata(sentMessage) ||
      hasGroupMetadata(event) ||
      hasUnsupportedMessagePayload(sentMessage) ||
      hasUnsupportedMessagePayload(event)
    ) {
      return undefined;
    }
    const body = messageBody(sentMessage);
    if (body === undefined) {
      return undefined;
    }
    const timestamp = numericTimestamp(sentMessage.timestamp ?? sentMessage.serverTimestamp ?? event.timestamp);
    return {
      body,
      conversation: {
        recipient: config.signalAccount,
        sender: config.signalAccount,
        noteToSelf: true,
      },
      reactionTarget:
        timestamp === undefined
          ? undefined
          : {
              recipient: config.signalAccount,
              targetAuthor: config.signalAccount,
              timestamp,
            },
    };
  }

  const dataMessage = asRecord(event.dataMessage);
  const sourceNumber =
    typeof event.sourceNumber === "string" ? event.sourceNumber : typeof event.source === "string" ? event.source : undefined;
  if (dataMessage !== undefined && sourceNumber !== undefined && config.whitelist.has(sourceNumber)) {
    if (
      hasGroupMetadata(dataMessage) ||
      hasGroupMetadata(event) ||
      hasUnsupportedMessagePayload(dataMessage) ||
      hasUnsupportedMessagePayload(event)
    ) {
      return undefined;
    }
    const body = messageBody(dataMessage);
    if (body === undefined) {
      return undefined;
    }
    const timestamp = numericTimestamp(dataMessage.timestamp ?? event.timestamp);
    return {
      body,
      conversation: {
        recipient: sourceNumber,
        sender: sourceNumber,
        noteToSelf: false,
      },
      reactionTarget:
        timestamp === undefined
          ? undefined
          : {
              recipient: sourceNumber,
              targetAuthor: sourceNumber,
              timestamp,
            },
    };
  }

  return undefined;
}

export function parseSignalCommand(input: string): { name: string; args: string[] } {
  const trimmed = input.trim();
  const parts = trimmed.split(/\s+/);
  const rawName = parts.shift() ?? "";
  return {
    name: rawName.startsWith("/") ? rawName.slice(1) : rawName,
    args: parts,
  };
}

export function parseSseMessages(input: string): { messages: string[]; remainder: string } {
  const normalized = input.replace(/\r\n/g, "\n");
  const messages: string[] = [];
  let start = 0;
  for (;;) {
    const boundary = normalized.indexOf("\n\n", start);
    if (boundary === -1) {
      break;
    }
    const event = normalized.slice(start, boundary);
    start = boundary + 2;
    const dataLines = event
      .split(/\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice("data:".length).trimStart());
    if (dataLines.length > 0) {
      messages.push(dataLines.join("\n"));
    }
  }

  return {
    messages,
    remainder: normalized.slice(start),
  };
}

export function parseSignalEventData(data: string): unknown | undefined {
  try {
    return unwrapSignalEnvelope(JSON.parse(data));
  } catch {
    return undefined;
  }
}

export function truncateSignalText(text: string, maxLength = 3_000, shortId?: number): string {
  if (text.length <= maxLength) {
    return text;
  }
  const suffix = shortId === undefined ? "\u2026 (truncated, /resend for last reply)" : `\u2026 (truncated, /ask ${shortId} for last message)`;
  return truncateWithSuffix(text, maxLength, suffix);
}

export function truncateSignalCommandText(text: string, maxLength = 3_000): string {
  if (text.length <= maxLength) {
    return text;
  }
  return truncateWithSuffix(text, maxLength, "\u2026 (truncated)");
}

export function prefixSessionReply(shortId: number, name: string | undefined, text: string): string {
  return truncateSignalText(`[#${shortId} ${name ?? "session"}] ${text}`, 3_000, shortId);
}

function requireServices(services: BakerServices | undefined): BakerServices {
  if (services === undefined) {
    throw new Error("pi-baker services are not ready");
  }
  return services;
}

function daemonCommandRelayKey(shortId: number, conversation: SignalConversation): string {
  return `${shortId}:${conversation.recipient}`;
}

function deferSignalCommandReaction(text: string): DeferredSignalCommandResult {
  return { text, deferReaction: true };
}

function isDeferredSignalCommandResult(result: SignalCommandResult): result is DeferredSignalCommandResult {
  return typeof result !== "string";
}

function signalCommandText(result: SignalCommandResult): string {
  return typeof result === "string" ? result : result.text;
}

function truncateWithSuffix(text: string, maxLength: number, suffix: string): string {
  if (maxLength <= 0) {
    return "";
  }
  if (suffix.length >= maxLength) {
    return suffix.slice(0, maxLength);
  }
  return `${text.slice(0, maxLength - suffix.length)}${suffix}`;
}

function requireArg(args: string[], index: number, usage: string): string {
  const value = args[index];
  if (value === undefined || value.trim() === "") {
    throw new Error(usage);
  }
  return value;
}

function requireArgCount(args: string[], count: number, usage: string): void {
  if (args.length !== count) {
    throw new Error(usage);
  }
}

function requireArgCountAtMost(args: string[], max: number, usage: string): void {
  if (args.length > max) {
    throw new Error(usage);
  }
}

function cleanOptionalString(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed === "" ? undefined : trimmed;
}

function messageBody(message: JsonObject): string | undefined {
  for (const key of ["message", "body", "text"]) {
    const value = message[key];
    if (typeof value === "string") {
      const trimmed = value.trim();
      if (trimmed !== "") {
        return trimmed;
      }
    }
  }
  return undefined;
}

function hasGroupMetadata(message: JsonObject): boolean {
  return ["groupInfo", "groupV2", "groupV1", "groupId", "groupContext", "groupMasterKey"].some((key) => message[key] !== undefined);
}

function hasUnsupportedMessagePayload(message: JsonObject): boolean {
  for (const key of ["attachments", "contacts"] as const) {
    const value = message[key];
    if (Array.isArray(value)) {
      if (value.length > 0) {
        return true;
      }
    } else if (value !== undefined && value !== null) {
      return true;
    }
  }

  return ["attachment", "sticker", "contact", "voiceMessage", "voiceNote", "reaction", "remoteDelete"].some(
    (key) => message[key] !== undefined && message[key] !== null,
  );
}

/** Normalize the wire shapes emitted by signal-cli HTTP SSE and JSON-RPC. */
function unwrapSignalEnvelope(value: unknown): unknown {
  if (!isRecord(value)) {
    return value;
  }

  const directEnvelope = asRecord(value.envelope);
  if (directEnvelope !== undefined) {
    return directEnvelope;
  }

  const params = asRecord(value.params);
  const paramsEnvelope = asRecord(params?.envelope);
  if (paramsEnvelope !== undefined) {
    return paramsEnvelope;
  }

  const subscriptionResult = asRecord(params?.result);
  return asRecord(subscriptionResult?.envelope) ?? value;
}

function numericTimestamp(value: unknown): number | undefined {
  if (typeof value === "number") {
    return value;
  }
  if (typeof value === "string" && /^\d+$/.test(value)) {
    return Number(value);
  }
  return undefined;
}

export function normalizeManagedSignalUrl(signalUrl: string): string {
  return normalizeSignalUrl(signalUrl);
}

export function normalizeSignalUrl(signalUrl: string): string {
  const url = new URL(signalUrl);
  if (!isLoopbackHost(url.hostname)) {
    url.hostname = "127.0.0.1";
  }
  return url.toString();
}

export function signalCliHttpAddress(signalUrl: string): string {
  const url = new URL(signalUrl);
  return `${url.hostname}:${url.port || (url.protocol === "https:" ? "443" : "80")}`;
}

function isLoopbackHost(hostname: string): boolean {
  return hostname === "localhost" || hostname === "::1" || hostname === "[::1]" || hostname.startsWith("127.");
}

function formatDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1_000));
  const hours = Math.floor(totalSeconds / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) {
    return `${hours}h ${minutes}m ${seconds}s`;
  }
  if (minutes > 0) {
    return `${minutes}m ${seconds}s`;
  }
  return `${seconds}s`;
}

function asRecord(value: unknown): JsonObject | undefined {
  return isRecord(value) ? value : undefined;
}

function isRecord(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function stopSignalCliChild(child: ChildProcessWithoutNullStreams, killMs: number): Promise<void> {
  if (child.exitCode !== null) {
    return;
  }

  let killTimer: NodeJS.Timeout | undefined;
  const childExit = new Promise<void>((resolve) => {
    child.once("exit", () => resolve());
  });
  const forceKill = new Promise<void>((resolve) => {
    killTimer = setTimeout(() => {
      child.kill("SIGKILL");
      resolve();
    }, killMs);
    killTimer.unref();
  });

  try {
    child.kill("SIGTERM");
    await Promise.race([childExit, forceKill]);
  } finally {
    if (killTimer !== undefined) {
      clearTimeout(killTimer);
    }
  }
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new Error("aborted"));
      return;
    }
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(new Error("aborted"));
      },
      { once: true },
    );
  });
}
