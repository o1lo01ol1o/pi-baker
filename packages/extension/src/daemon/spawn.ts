import type { ChildProcess } from "node:child_process";

import { RpcClient, type RpcClientOptions } from "@earendil-works/pi-coding-agent";

import type { BakerConfig } from "../config.ts";
import { makeRequestId } from "../protocol.ts";
import { BakerRegistry, type RegistrySession } from "./registry.ts";
import type { ControlServer, RegistrationEvent } from "./server.ts";

export interface SpawnRequest {
  cwd: string;
  prompt?: string;
  model?: string;
  name?: string;
  onRegistered?: (result: SpawnResult) => void | Promise<void>;
}

export interface SpawnResult {
  shortId: number;
  name: string;
  cwd: string;
}

export interface RpcClientLike {
  start(): Promise<void>;
  stop(): Promise<void>;
  abort(): Promise<void>;
  setSessionName?(name: string): Promise<void>;
  getStderr?(): string;
}

export type RpcClientFactory = (options: RpcClientOptions) => RpcClientLike;

export interface SpawnManagerOptions {
  config: BakerConfig;
  registry: BakerRegistry;
  server: ControlServer;
  clientFactory?: RpcClientFactory;
  cliPath?: string;
  cliArgs?: string[];
  registrationTimeoutMs?: number;
  stopSignalMs?: number;
  stopKillMs?: number;
  onCrash?: (session: RegistrySession, message: string) => void;
}

interface SpawnHandle {
  client: RpcClientLike;
  session: RegistrySession;
  stopping: boolean;
}

interface RegistrationWaiter {
  promise: Promise<RegistrySession>;
  cancel: () => void;
}

export class SpawnManager {
  private readonly config: BakerConfig;
  private readonly registry: BakerRegistry;
  private readonly server: ControlServer;
  private readonly clientFactory: RpcClientFactory;
  private readonly cliPath: string | undefined;
  private readonly cliArgs: string[] | undefined;
  private readonly registrationTimeoutMs: number;
  private readonly stopSignalMs: number;
  private readonly stopKillMs: number;
  private readonly onCrash: ((session: RegistrySession, message: string) => void) | undefined;
  private readonly handles = new Map<number, SpawnHandle>();

  constructor(options: SpawnManagerOptions) {
    this.config = options.config;
    this.registry = options.registry;
    this.server = options.server;
    this.clientFactory = options.clientFactory ?? ((clientOptions) => new RpcClient(clientOptions));
    this.cliPath = options.cliPath ?? process.argv[1];
    this.cliArgs = options.cliArgs;
    this.registrationTimeoutMs = options.registrationTimeoutMs ?? 30_000;
    this.stopSignalMs = options.stopSignalMs ?? 10_000;
    this.stopKillMs = options.stopKillMs ?? 20_000;
    this.onCrash = options.onCrash;
  }

  async spawn(request: SpawnRequest): Promise<SpawnResult> {
    const spawnId = makeRequestId("spawn");
    const client = this.clientFactory({
      cliPath: this.cliPath,
      cwd: request.cwd,
      args: this.cliArgs,
      env: {
        PI_BAKER_DIR: this.config.bakerDir,
        PI_BAKER_ROLE: "member",
        PI_BAKER_SPAWNED: "1",
        PI_BAKER_SPAWN_ID: spawnId,
      },
      ...modelOptions(request.model),
    });

    const registered = this.waitForRegistration(spawnId);
    let session: RegistrySession | undefined;
    try {
      await client.start();
      session = await registered.promise;
      if (session.kind !== "spawned") {
        throw new Error(`spawned child registered as ${session.kind}; expected spawned`);
      }
      if (request.name !== undefined && request.name.trim() !== "") {
        const renamed = (await this.server.rename(session.shortId, request.name.trim())) ?? request.name.trim();
        this.registry.rename(session.shortId, renamed);
        session = this.registry.getSession(session.shortId) ?? { ...session, name: renamed };
      }

      this.handles.set(session.shortId, { client, session, stopping: false });
      this.attachCrashWatcher(client, session.shortId);

      const result = {
        shortId: session.shortId,
        name: session.name,
        cwd: session.cwd,
      };
      await request.onRegistered?.(result);

      if (request.prompt !== undefined && request.prompt.trim() !== "") {
        await this.server.prompt(session.shortId, request.prompt, "followUp");
      }

      this.registry.recordEvent(session.shortId, "spawn", { cwd: request.cwd, name: request.name });
      return result;
    } catch (error) {
      registered.cancel();
      await registered.promise.catch(() => undefined);
      if (session !== undefined) {
        const handle = this.handles.get(session.shortId);
        if (handle !== undefined) {
          handle.stopping = true;
          this.handles.delete(session.shortId);
        }
        this.server.disconnect(session.shortId, `spawned session #${session.shortId} ${session.name} failed during startup`);
      }
      await this.stopClient(client).catch(() => undefined);
      throw error;
    }
  }

  async kill(session: RegistrySession): Promise<void> {
    if (session.kind !== "spawned") {
      throw new Error(`session #${session.shortId} is ${session.kind}; only spawned sessions can be killed`);
    }

    const handle = this.handles.get(session.shortId);
    if (handle === undefined) {
      throw new Error(`no lifecycle handle for spawned session #${session.shortId}`);
    }

    handle.stopping = true;
    try {
      await handle.client.abort().catch(() => undefined);
      await this.stopClient(handle.client);
    } finally {
      this.handles.delete(session.shortId);
      this.server.disconnect(session.shortId, `spawned session #${session.shortId} ${session.name} killed`);
      this.registry.recordEvent(session.shortId, "kill");
    }
  }

  async stopAll(): Promise<void> {
    const handles = [...this.handles.values()];
    await Promise.all(
      handles.map(async (handle) => {
        handle.stopping = true;
        await handle.client.abort().catch(() => undefined);
        await this.stopClient(handle.client).catch(() => undefined);
        this.server.disconnect(handle.session.shortId, `spawned session #${handle.session.shortId} ${handle.session.name} stopped`);
      }),
    );
    this.handles.clear();
  }

  hasHandle(shortId: number): boolean {
    return this.handles.has(shortId);
  }

  private stopClient(client: RpcClientLike): Promise<void> {
    return stopWithForceFallback(client, {
      signalMs: this.stopSignalMs,
      killMs: this.stopKillMs,
    });
  }

  private waitForRegistration(spawnId: string): RegistrationWaiter {
    let rejectRegistration: (error: Error) => void = () => undefined;
    let settled = false;
    let cleanup: () => void = () => undefined;

    const promise = new Promise<RegistrySession>((resolve, reject) => {
      rejectRegistration = reject;
      const timer = setTimeout(() => {
        settled = true;
        cleanup();
        reject(new Error(`spawned session did not register within ${this.registrationTimeoutMs}ms`));
      }, this.registrationTimeoutMs);
      timer.unref();

      const removeListener = this.server.onRegistration((event: RegistrationEvent) => {
        if (event.hello.spawnId !== spawnId) {
          return;
        }
        cleanup();
        settled = true;
        resolve(event.session);
      });

      cleanup = (): void => {
        clearTimeout(timer);
        removeListener();
      };
    });

    return {
      promise,
      cancel: () => {
        if (settled) {
          return;
        }
        settled = true;
        cleanup();
        rejectRegistration(new Error("spawn cancelled before registration"));
      },
    };
  }

  private attachCrashWatcher(client: RpcClientLike, shortId: number): void {
    const child = getChildProcess(client);
    if (child === undefined) {
      return;
    }

    const handleExit = (code: number | null, signal: NodeJS.Signals | null): void => {
      const handle = this.handles.get(shortId);
      if (handle === undefined || handle.stopping) {
        return;
      }
      this.handles.delete(shortId);
      const reason = signal === null ? `exit ${code ?? "unknown"}` : `signal ${signal}`;
      this.server.disconnect(shortId, `spawned session #${shortId} ${handle.session.name} crashed (${reason})`);
      const session = this.registry.getSession(shortId) ?? handle.session;
      this.onCrash?.(session, `spawned session #${shortId} ${session.name} crashed (${reason})`);
    };

    child.once("exit", handleExit);
    const signalCode = (child as { signalCode?: NodeJS.Signals | null }).signalCode;
    if (child.exitCode !== null && child.exitCode !== undefined) {
      child.off("exit", handleExit);
      handleExit(child.exitCode, null);
    } else if (signalCode !== null && signalCode !== undefined) {
      child.off("exit", handleExit);
      handleExit(null, signalCode);
    }
  }
}

function modelOptions(model: string | undefined): Pick<RpcClientOptions, "provider" | "model"> {
  if (model === undefined || model.trim() === "") {
    return {};
  }

  const trimmed = model.trim();
  const slash = trimmed.indexOf("/");
  if (slash > 0 && slash < trimmed.length - 1) {
    return {
      provider: trimmed.slice(0, slash),
      model: trimmed.slice(slash + 1),
    };
  }

  return { model: trimmed };
}

function getChildProcess(client: RpcClientLike): ChildProcess | undefined {
  const candidate = (client as { process?: ChildProcess | null }).process;
  return candidate ?? undefined;
}

interface StopFallbackOptions {
  signalMs: number;
  killMs: number;
}

async function stopWithForceFallback(client: RpcClientLike, options: StopFallbackOptions): Promise<void> {
  const child = getChildProcess(client);
  if (child === undefined || child.exitCode !== null) {
    await client.stop().catch(() => undefined);
    return;
  }

  let termTimer: NodeJS.Timeout | undefined;
  let killTimer: NodeJS.Timeout | undefined;
  let exited = false;
  const childExit = new Promise<void>((resolve) => {
    child.once("exit", () => {
      exited = true;
      resolve();
    });
  });
  const forceFallback = new Promise<void>((resolve) => {
    termTimer = setTimeout(() => child.kill("SIGTERM"), options.signalMs);
    killTimer = setTimeout(() => {
      child.kill("SIGKILL");
      resolve();
    }, options.killMs);
    termTimer.unref();
    killTimer.unref();
  });

  try {
    const stopAttempt = client.stop().catch(() => undefined);
    await Promise.race([stopAttempt, childExit, forceFallback]);
    if (!exited) {
      await Promise.race([childExit, forceFallback]);
    }
  } finally {
    if (termTimer !== undefined) {
      clearTimeout(termTimer);
    }
    if (killTimer !== undefined) {
      clearTimeout(killTimer);
    }
  }
}
