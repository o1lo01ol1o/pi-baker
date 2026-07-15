import { BakerRegistry, type RegistrySession, truncateText } from "./registry.ts";
import { ControlServer } from "./server.ts";
import type { SpawnManager, SpawnRequest, SpawnResult } from "./spawn.ts";
import type { DeliverAs } from "../protocol.ts";

export interface SessionPromptOptions {
  wait?: boolean;
  timeoutSec?: number;
}

export interface DaemonSessionControl {
  sendUserMessage?: (text: string, deliverAs: DeliverAs) => void | Promise<void>;
  rename?: (name: string) => string | undefined | void | Promise<string | undefined | void>;
  abort?: () => void;
}

export class BakerServices {
  private readonly registry: BakerRegistry;
  private readonly server: ControlServer;
  private readonly spawner: SpawnManager | undefined;
  private readonly daemon: DaemonSessionControl | undefined;

  constructor(registry: BakerRegistry, server: ControlServer, spawner?: SpawnManager, daemon?: DaemonSessionControl) {
    this.registry = registry;
    this.server = server;
    this.spawner = spawner;
    this.daemon = daemon;
  }

  listSessions(all = false): RegistrySession[] {
    return this.registry.listSessions({ all });
  }

  recordCommand(command: string, surface: "signal" | "tui" | "tool"): void {
    this.registry.recordEvent(0, "command", { command, surface });
  }

  resolveSelector(selector: string, options: { includeDisconnected?: boolean } = {}): RegistrySession {
    const trimmed = selector.trim();
    if (trimmed === "") {
      throw new Error("session selector is required");
    }
    const normalized = trimmed.toLowerCase();

    const includeDisconnected = options.includeDisconnected ?? false;
    const available = this.registry.listSessions({ all: includeDisconnected });

    if (normalized === "me") {
      const daemon = this.registry.getSession(0);
      if (daemon !== undefined) {
        return daemon;
      }
      throw new Error(`unknown session selector: ${selector}; ${formatSelectorCandidates(available)}`);
    }

    if (/^\d+$/.test(trimmed)) {
      const numeric = Number(trimmed);
      const session = this.registry.getSession(numeric);
      if (session !== undefined && (includeDisconnected || session.connected)) {
        return session;
      }
      throw new Error(`unknown session selector: ${selector}; ${formatSelectorCandidates(available)}`);
    }

    const candidates = available.filter((session) => session.name.toLowerCase().startsWith(normalized));

    if (candidates.length === 1) {
      return candidates[0];
    }

    if (candidates.length === 0) {
      throw new Error(`unknown session selector: ${selector}; ${formatSelectorCandidates(available)}`);
    }

    throw new Error(`ambiguous selector ${selector}: ${formatSessionCandidates(candidates)}`);
  }
  async sendPrompt(selector: string, text: string, deliverAs: DeliverAs, waitOrOptions: boolean | SessionPromptOptions = false): Promise<string> {
    const session = this.resolveSelector(selector, { includeDisconnected: true });
    const cleanText = text.trim();
    if (cleanText === "") {
      throw new Error("prompt text is required");
    }
    const options = typeof waitOrOptions === "boolean" ? { wait: waitOrOptions } : waitOrOptions;

    if (session.kind === "daemon") {
      return this.sendDaemonPrompt(session, cleanText, deliverAs, options);
    }

    if (options.wait === true) {
      const waiter = this.server.createTurnWaiter(session.shortId, (options.timeoutSec ?? 300) * 1_000);
      try {
        await this.server.prompt(session.shortId, cleanText, deliverAs);
      } catch (error) {
        waiter.cancel();
        await waiter.promise.catch(() => undefined);
        throw error;
      }
      return waiter.promise;
    }

    await this.server.prompt(session.shortId, cleanText, deliverAs);
    return `sent to #${session.shortId} ${session.name}`;
  }

  private async sendDaemonPrompt(session: RegistrySession, text: string, deliverAs: DeliverAs, options: SessionPromptOptions): Promise<string> {
    if (this.daemon?.sendUserMessage === undefined) {
      throw new Error("daemon session prompt is not available");
    }

    if (options.wait === true) {
      const waiter = this.server.createTurnWaiter(session.shortId, (options.timeoutSec ?? 300) * 1_000);
      try {
        await this.daemon.sendUserMessage(text, deliverAs);
        this.registry.recordEvent(session.shortId, deliverAs === "steer" ? "steer" : "prompt");
      } catch (error) {
        waiter.cancel();
        await waiter.promise.catch(() => undefined);
        throw error;
      }
      return waiter.promise;
    }

    await this.daemon.sendUserMessage(text, deliverAs);
    this.registry.recordEvent(session.shortId, deliverAs === "steer" ? "steer" : "prompt");
    return `sent to #${session.shortId} ${session.name}`;
  }

  async abort(selector: string): Promise<string> {
    const session = this.resolveSelector(selector, { includeDisconnected: true });
    if (session.kind === "daemon") {
      if (this.daemon?.abort === undefined) {
        throw new Error("daemon session abort is not available");
      }
      this.daemon.abort();
      this.registry.recordEvent(session.shortId, "abort");
      return `aborted #${session.shortId} ${session.name}`;
    }
    await this.server.abort(session.shortId);
    return `aborted #${session.shortId} ${session.name}`;
  }

  async spawn(request: SpawnRequest): Promise<SpawnResult> {
    const cwd = request.cwd.trim();
    if (cwd === "") {
      throw new Error("spawn cwd is required");
    }
    if (this.spawner === undefined) {
      throw new Error("spawn manager is not available");
    }
    const cleaned: SpawnRequest = { cwd };
    const prompt = cleanOptionalString(request.prompt);
    const model = cleanOptionalString(request.model);
    const name = cleanOptionalString(request.name);
    if (prompt !== undefined) {
      cleaned.prompt = prompt;
    }
    if (model !== undefined) {
      cleaned.model = model;
    }
    if (name !== undefined) {
      cleaned.name = name;
    }
    if (request.onRegistered !== undefined) {
      cleaned.onRegistered = request.onRegistered;
    }
    return this.spawner.spawn(cleaned);
  }

  async kill(selector: string): Promise<string> {
    if (this.spawner === undefined) {
      throw new Error("spawn manager is not available");
    }
    const session = this.resolveSelector(selector, { includeDisconnected: true });
    await this.spawner.kill(session);
    return `killed #${session.shortId} ${session.name}`;
  }

  setWatch(selector: string, watch: boolean, recipient?: string): RegistrySession {
    const session = this.resolveSelector(selector, { includeDisconnected: true });
    if (recipient === undefined) {
      this.registry.setWatch(session.shortId, watch);
      this.registry.recordEvent(session.shortId, "watch", { watch });
    } else {
      this.registry.setWatchTarget(session.shortId, recipient, watch);
      this.registry.recordEvent(session.shortId, "watch", { watch, target: "signal" });
    }
    return this.registry.getSession(session.shortId) ?? { ...session, watch };
  }

  setWatchTargets(selector: string, recipients: Iterable<string>): RegistrySession {
    const session = this.resolveSelector(selector, { includeDisconnected: true });
    const cleanRecipients = [...new Set([...recipients].map((recipient) => recipient.trim()).filter((recipient) => recipient !== ""))];
    this.registry.replaceWatchTargets(session.shortId, cleanRecipients);
    this.registry.recordEvent(session.shortId, "watch", { watch: cleanRecipients.length > 0, target: "signal", targetCount: cleanRecipients.length });
    return this.registry.getSession(session.shortId) ?? { ...session, watch: cleanRecipients.length > 0 };
  }

  listWatchTargets(): Array<{ shortId: number; recipient: string }> {
    return this.registry.listWatchTargets();
  }

  async rename(selector: string, name: string): Promise<RegistrySession> {
    const cleanName = name.trim();
    if (cleanName === "") {
      throw new Error("name must not be empty");
    }
    const session = this.resolveSelector(selector, { includeDisconnected: true });
    let effectiveName = cleanName;
    if (session.kind === "daemon" && this.daemon?.rename !== undefined) {
      const renamed = await this.daemon.rename(cleanName);
      if (typeof renamed === "string" && renamed.trim() !== "") {
        effectiveName = renamed.trim();
      }
    }
    if (session.connected && session.kind !== "daemon") {
      const renamed = await this.server.rename(session.shortId, cleanName);
      if (renamed !== undefined) {
        effectiveName = renamed;
      }
    }
    this.registry.rename(session.shortId, effectiveName);
    this.registry.recordEvent(session.shortId, "rename", { name: effectiveName });
    return { ...session, name: effectiveName };
  }

  last(selector: string): string {
    const session = this.resolveSelector(selector, { includeDisconnected: true });
    const liveTurn = session.connected ? this.server.getLastTurn(session.shortId) : undefined;
    return liveTurn ?? session.lastTurn ?? `no last turn recorded for #${session.shortId} ${session.name}`;
  }

  status(selector: string): string {
    const session = this.resolveSelector(selector, { includeDisconnected: true });
    return formatSessionDetail(this.withLiveTurn(session));
  }

  async liveStatusText(selector: string): Promise<string> {
    return formatSessionStatusDetail(await this.liveStatus(selector));
  }

  async liveStatus(selector: string): Promise<Record<string, unknown>> {
    const session = this.resolveSelector(selector, { includeDisconnected: true });
    const status = sessionStatusDetail(this.withLiveTurn(session));
    if (!session.connected || session.kind === "daemon") {
      return status;
    }

    try {
      return mergeLiveStatus(status, await this.server.queryState(session.shortId));
    } catch {
      return status;
    }
  }

  rowsForTool(all = false): Array<Record<string, unknown>> {
    return this.listSessions(all).map((session) => {
      const lastTurn = this.lastTurnForSession(session);
      return {
        id: session.shortId,
        name: session.name,
        kind: session.kind,
        state: session.state,
        connected: session.connected,
        cwd: session.cwd,
        model: session.model,
        lastActivity: session.lastSeen,
        lastTurnSummary: lastTurn === undefined ? undefined : truncateText(lastTurn, 500, session.shortId),
        watch: session.watch,
      };
    });
  }

  private lastTurnForSession(session: RegistrySession): string | undefined {
    return session.connected ? (this.server.getLastTurn(session.shortId) ?? session.lastTurn) : session.lastTurn;
  }

  private withLiveTurn(session: RegistrySession): RegistrySession {
    const lastTurn = this.lastTurnForSession(session);
    return lastTurn === session.lastTurn ? session : { ...session, lastTurn };
  }
}

function formatSelectorCandidates(sessions: RegistrySession[]): string {
  if (sessions.length === 0) {
    return "no sessions are registered";
  }
  return `available: ${formatSessionCandidates(sessions)}`;
}

function formatSessionCandidates(sessions: RegistrySession[]): string {
  return sessions.map((session) => `#${session.shortId} ${session.name}`).join(", ");
}

function sessionStatusDetail(session: RegistrySession): Record<string, unknown> {
  const lastTurn = session.lastTurn;
  return {
    id: session.shortId,
    shortId: session.shortId,
    name: session.name,
    kind: session.kind,
    state: session.state,
    connected: session.connected,
    cwd: session.cwd,
    model: session.model,
    pid: session.pid,
    sessionId: session.sessionId,
    sessionFile: session.sessionFile,
    watch: session.watch,
    firstSeen: session.firstSeen,
    lastSeen: session.lastSeen,
    lastTurn,
    lastTurnSummary: lastTurn === undefined ? undefined : truncateText(lastTurn, 500, session.shortId),
  };
}

function mergeLiveStatus(base: Record<string, unknown>, live: unknown): Record<string, unknown> {
  if (!isRecord(live)) {
    return { ...base, live };
  }

  const merged: Record<string, unknown> = { ...base, live };
  copyString(live, merged, "cwd");
  copyString(live, merged, "state");
  copyString(live, merged, "sessionId");
  copyString(live, merged, "sessionFile");
  copyString(live, merged, "sessionName");
  copyString(live, merged, "extensionVersion");
  copyString(live, merged, "socketPath");
  copyString(live, merged, "spawnId");
  copyBoolean(live, merged, "connected");
  copyBoolean(live, merged, "enabled");
  copyBoolean(live, merged, "spawned");
  copyNumber(live, merged, "shortId");
  copyNumber(live, merged, "pid");
  copyNumber(live, merged, "daemonPid");

  if (Object.hasOwn(live, "model")) {
    merged.model = typeof live.model === "string" ? live.model : undefined;
  }
  if (typeof merged.shortId === "number") {
    merged.id = merged.shortId;
  }

  return merged;
}

function copyString(source: Record<string, unknown>, target: Record<string, unknown>, key: string): void {
  if (typeof source[key] === "string") {
    target[key] = source[key];
  }
}

function copyBoolean(source: Record<string, unknown>, target: Record<string, unknown>, key: string): void {
  if (typeof source[key] === "boolean") {
    target[key] = source[key];
  }
}

function copyNumber(source: Record<string, unknown>, target: Record<string, unknown>, key: string): void {
  if (typeof source[key] === "number") {
    target[key] = source[key];
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function cleanOptionalString(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed === "" ? undefined : trimmed;
}

export function formatSessionDetail(session: RegistrySession): string {
  return formatSessionStatusDetail(sessionStatusDetail(session));
}

export function formatSessionStatusDetail(status: Record<string, unknown>): string {
  return [
    `#${display(status.shortId ?? status.id)} ${display(status.name)}`,
    `kind: ${display(status.kind)}`,
    `state: ${display(status.state)}`,
    `connected: ${yesNo(status.connected)}`,
    `cwd: ${display(status.cwd)}`,
    `model: ${display(status.model)}`,
    `pid: ${display(status.pid)}`,
    `session: ${display(status.sessionId)}`,
    `file: ${display(status.sessionFile)}`,
    `session name: ${display(status.sessionName)}`,
    `extension: ${display(status.extensionVersion)}`,
    `watch: ${onOff(status.watch)}`,
    `last seen: ${display(status.lastSeen)}`,
    `last turn: ${typeof status.lastTurn === "string" ? truncateText(status.lastTurn, 220, statusShortId(status)) : "-"}`,
  ].join("\n");
}

function display(value: unknown): string {
  if (typeof value === "string") {
    return value === "" ? "-" : value;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return "-";
}

function yesNo(value: unknown): string {
  if (typeof value === "boolean") {
    return value ? "yes" : "no";
  }
  return "-";
}

function onOff(value: unknown): string {
  if (typeof value === "boolean") {
    return value ? "on" : "off";
  }
  return "-";
}

function statusShortId(status: Record<string, unknown>): number | undefined {
  const value = status.shortId ?? status.id;
  return typeof value === "number" ? value : undefined;
}

export function formatSessionBriefing(sessions: RegistrySession[]): string {
  if (sessions.length === 0) {
    return "No pi-baker sessions are registered yet.";
  }

  return sessions
    .map((session) => {
      const connected = session.connected ? "connected" : "disconnected";
      const model = session.model ?? "-";
      return `#${session.shortId} ${session.name}: ${session.kind}, ${session.state}, ${connected}, cwd=${session.cwd}, model=${model}`;
    })
    .join("\n");
}
