import { chmodSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export const EXTENSION_VERSION = readExtensionVersion();

export type BakerRole = "daemon" | "member";

export interface BakerConfig {
  role: BakerRole;
  bakerDir: string;
  socketPath: string;
  dbPath: string;
  signalAccount: string | undefined;
  whitelist: Set<string>;
  signalUrl: string;
  manageSignal: boolean;
  storeTurns: boolean;
  quiet: boolean;
  spawned: boolean;
  spawnId?: string;
}

export function registerBakerFlags(pi: Pick<ExtensionAPI, "registerFlag">): void {
  pi.registerFlag("baker-daemon", {
    description: "Run this pi session as the pi-baker orchestrator daemon.",
    type: "boolean",
    default: false,
  });
}

export function loadConfig(
  pi?: Pick<ExtensionAPI, "getFlag">,
  env: NodeJS.ProcessEnv = process.env,
): BakerConfig {
  const flagRole = pi?.getFlag("baker-daemon") === true ? "daemon" : undefined;
  const envRole = env.PI_BAKER_ROLE === "daemon" ? "daemon" : env.PI_BAKER_ROLE === "member" ? "member" : undefined;
  const role = flagRole ?? envRole ?? "member";
  const bakerDir = expandPath(env.PI_BAKER_DIR ?? join(homedir(), ".pi-baker"));

  return {
    role,
    bakerDir,
    socketPath: join(bakerDir, "baker.sock"),
    dbPath: join(bakerDir, "baker.db"),
    signalAccount: parseE164Number(env.PI_BAKER_SIGNAL_ACCOUNT),
    whitelist: parseWhitelist(env.PI_BAKER_WHITELIST),
    signalUrl: env.PI_BAKER_SIGNAL_URL ?? "http://127.0.0.1:51921",
    manageSignal: parseBoolean(env.PI_BAKER_MANAGE_SIGNAL, true),
    storeTurns: parseBoolean(env.PI_BAKER_STORE_TURNS, true),
    quiet: parseBoolean(env.PI_BAKER_QUIET, true),
    spawned: parseBoolean(env.PI_BAKER_SPAWNED, false),
    spawnId: emptyToUndefined(env.PI_BAKER_SPAWN_ID),
  };
}

export function ensureBakerDir(config: Pick<BakerConfig, "bakerDir">): void {
  mkdirSync(config.bakerDir, { recursive: true, mode: 0o700 });
  chmodSync(config.bakerDir, 0o700);
}

export function formatSetupStatus(config: BakerConfig): string {
  const signalReady = config.signalAccount !== undefined;
  const lines = [
    `pi-baker role: ${config.role}`,
    `state dir: ${config.bakerDir}`,
    `socket: ${config.socketPath}`,
    `database: ${config.dbPath}`,
    `signal endpoint: ${config.signalUrl}`,
    `manage signal-cli: ${config.manageSignal ? "yes" : "no"}`,
    `store last turns: ${config.storeTurns ? "yes" : "no"}`,
    `setup: ${signalReady ? "ready" : "incomplete"}`,
  ];

  if (!signalReady) {
    lines.push("signal account: missing PI_BAKER_SIGNAL_ACCOUNT");
  } else {
    lines.push(`signal account: ${config.signalAccount}`);
  }

  lines.push(`whitelisted operators: ${config.whitelist.size}`);
  lines.push("link signal-cli outside pi-baker (install qrencode first):");
  lines.push("  signal-cli link -n pi-baker | tee >(xargs -L 1 qrencode -t utf8)");
  lines.push("scan the rendered QR in Signal > Settings > Linked devices and keep the command running until linking completes.");
  lines.push("then set PI_BAKER_SIGNAL_ACCOUNT to the linked E.164 number.");
  lines.push("start the daemon with:");
  lines.push("  pi --baker-daemon");
  lines.push("for an external signal-cli daemon, set PI_BAKER_MANAGE_SIGNAL=false and PI_BAKER_SIGNAL_URL to its loopback HTTP URL.");
  return lines.join("\n");
}

function readExtensionVersion(): string {
  const metadata: unknown = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  if (!isRecord(metadata) || typeof metadata.version !== "string" || !/^\d+\.\d+\.\d+$/.test(metadata.version)) {
    throw new Error("@pi-baker/extension package.json requires a semantic version");
  }
  return metadata.version;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseBoolean(value: string | undefined, defaultValue: boolean): boolean {
  if (value === undefined || value.trim() === "") {
    return defaultValue;
  }

  switch (value.trim().toLowerCase()) {
    case "1":
    case "true":
    case "yes":
    case "on":
      return true;
    case "0":
    case "false":
    case "no":
    case "off":
      return false;
    default:
      return defaultValue;
  }
}

function parseWhitelist(value: string | undefined): Set<string> {
  if (value === undefined) {
    return new Set();
  }

  return new Set(
    value
      .split(",")
      .map((entry) => parseE164Number(entry))
      .filter((entry): entry is string => entry !== undefined),
  );
}

function parseE164Number(value: string | undefined): string | undefined {
  const trimmed = emptyToUndefined(value);
  if (trimmed === undefined) {
    return undefined;
  }
  return /^\+[1-9]\d{1,14}$/.test(trimmed) ? trimmed : undefined;
}

function expandPath(path: string): string {
  if (path === "~") {
    return homedir();
  }

  if (path.startsWith("~/")) {
    return join(homedir(), path.slice(2));
  }

  return resolve(path);
}

function emptyToUndefined(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed === "" ? undefined : trimmed;
}
