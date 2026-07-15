import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

import type { BakerConfig } from "../config.ts";
import { formatSetupStatus } from "../config.ts";
import { BakerRegistry } from "./registry.ts";
import { BakerServices } from "./services.ts";
import type { SignalBridge } from "./signal.ts";
import { ControlServer, formatSessionsTable } from "./server.ts";

export interface DaemonCommandDeps {
  config: BakerConfig;
  registry: () => BakerRegistry | undefined;
  server: () => ControlServer | undefined;
  services: () => BakerServices | undefined;
  signal?: () => SignalBridge | undefined;
}

export interface ParsedSlashCommand {
  name: string;
  args: string[];
}

export function parseSlashCommand(input: string): ParsedSlashCommand {
  const text = input.trim();
  if (text === "") {
    return { name: "", args: [] };
  }

  const parts = text.split(/\s+/);
  const rawName = parts.shift() ?? "";
  return { name: rawName.startsWith("/") ? rawName.slice(1) : rawName, args: parts };
}

export function registerDaemonCommands(pi: Pick<ExtensionAPI, "registerCommand">, deps: DaemonCommandDeps): void {
  pi.registerCommand("baker-status", {
    description: "Show pi-baker daemon health or one registered session.",
    handler: async (args, ctx) => {
      const services = requireServices(deps);
      services.recordCommand("baker-status", "tui");
      const parsed = parseArgs(args);
      if (parsed.length > 1) {
        notify(ctx, "usage: /baker-status [session]", "warning");
        return;
      }
      const selector = parsed[0];
      if (selector !== undefined) {
        notify(ctx, await services.liveStatusText(selector));
        return;
      }

      const registry = requireRegistry(deps);
      const server = requireServer(deps);
      const signal = deps.signal?.();
      if (signal !== undefined) {
        notify(ctx, await signal.formatStatus());
        return;
      }

      const serverStatus = server.status();
      const sessions = registry.listSessions({ all: true });
      notify(
        ctx,
        [
          "pi-baker daemon",
          `socket: ${serverStatus.socketPath}`,
          `listening: ${serverStatus.listening ? "yes" : "no"}`,
          `connected members: ${serverStatus.connectedMembers}`,
          `registry rows: ${sessions.length}`,
          `signal account: ${deps.config.signalAccount ?? "-"}`,
        ].join("\n"),
      );
    },
  });

  pi.registerCommand("baker-sessions", {
    description: "List pi-baker sessions known to the daemon.",
    handler: async (args, ctx) => {
      requireServices(deps).recordCommand("baker-sessions", "tui");
      const parsed = parseArgs(args);
      if (parsed.length > 1 || (parsed.length === 1 && parsed[0] !== "all")) {
        notify(ctx, "usage: /baker-sessions [all]", "warning");
        return;
      }
      const all = parsed[0] === "all";
      const registry = requireRegistry(deps);
      notify(ctx, formatSessionsTable(registry.listSessions({ all })));
    },
  });

  pi.registerCommand("baker-setup", {
    description: "Show signal-cli setup and pi-baker configuration status.",
    handler: async (args, ctx) => {
      deps.services()?.recordCommand("baker-setup", "tui");
      if (parseArgs(args).length > 0) {
        notify(ctx, "usage: /baker-setup", "warning");
        return;
      }
      notify(ctx, formatSetupStatus(deps.config));
    },
  });

  pi.registerCommand("baker-tell", {
    description: "Send a follow-up prompt to a connected session: /baker-tell <session> <text>.",
    handler: async (args, ctx) => {
      requireServices(deps).recordCommand("baker-tell", "tui");
      await handlePromptCommand(args, ctx, deps, "followUp");
    },
  });

  pi.registerCommand("baker-steer", {
    description: "Steer a connected session: /baker-steer <session> <text>.",
    handler: async (args, ctx) => {
      requireServices(deps).recordCommand("baker-steer", "tui");
      await handlePromptCommand(args, ctx, deps, "steer");
    },
  });

  pi.registerCommand("baker-abort", {
    description: "Abort a connected session: /baker-abort <session>.",
    handler: async (args, ctx) => {
      requireServices(deps).recordCommand("baker-abort", "tui");
      const parsed = parseArgs(args);
      if (parsed.length !== 1) {
        notify(ctx, "usage: /baker-abort <session>", "warning");
        return;
      }
      const selector = parsed[0] ?? "";
      const message = await requireServices(deps).abort(selector);
      notify(ctx, message);
    },
  });

  pi.registerCommand("baker-ask", {
    description: "Show the most recent assistant message from a session: /baker-ask <session>.",
    handler: async (args, ctx) => {
      const services = requireServices(deps);
      services.recordCommand("baker-ask", "tui");
      const parsed = parseArgs(args);
      if (parsed.length !== 1) {
        notify(ctx, "usage: /baker-ask <session>", "warning");
        return;
      }
      notify(ctx, services.last(parsed[0] ?? ""));
    },
  });

  pi.registerCommand("baker-watch", {
    description: "Toggle push of every completed turn from a session: /baker-watch <session> on|off.",
    handler: async (args, ctx) => {
      const services = requireServices(deps);
      services.recordCommand("baker-watch", "tui");
      const parsed = parseArgs(args);
      if (parsed.length !== 2) {
        notify(ctx, "usage: /baker-watch <session> on|off", "warning");
        return;
      }
      const mode = parsed[1];
      if (mode !== "on" && mode !== "off") {
        notify(ctx, "usage: /baker-watch <session> on|off", "warning");
        return;
      }
      const signal = deps.signal?.();
      const signalAccount = deps.config.signalAccount;
      const selector = parsed[0] ?? "";
      const watch = mode === "on";
      const session =
        signal !== undefined && signalAccount !== undefined
          ? services.setWatch(selector, watch, signalAccount)
          : services.setWatch(selector, watch);
      if (signal !== undefined && signalAccount !== undefined) {
        signal.setWatchTarget(session.shortId, signalAccount, watch);
      }
      notify(ctx, `watch ${mode} for #${session.shortId} ${session.name}`);
    },
  });

  pi.registerCommand("baker-name", {
    description: "Rename a session in the pi-baker registry: /baker-name <session> <name>.",
    handler: async (args, ctx) => {
      const services = requireServices(deps);
      services.recordCommand("baker-name", "tui");
      const parsed = parseArgs(args);
      const selector = parsed[0];
      const name = parsed.slice(1).join(" ").trim();
      if (selector === undefined || name === "") {
        notify(ctx, "usage: /baker-name <session> <name>", "warning");
        return;
      }
      const session = await services.rename(selector, name);
      notify(ctx, `renamed #${session.shortId} ${session.name}`);
    },
  });

  pi.registerCommand("baker-spawn", {
    description: "Spawn a daemon-owned headless pi session: /baker-spawn <dir> [prompt].",
    handler: async (args, ctx) => {
      requireServices(deps).recordCommand("baker-spawn", "tui");
      const [cwd, ...promptParts] = args.trim().split(/\s+/);
      if (cwd === undefined || cwd === "") {
        notify(ctx, "usage: /baker-spawn <dir> [prompt]", "warning");
        return;
      }
      const result = await requireServices(deps).spawn({
        cwd,
        prompt: promptParts.join(" ").trim() || undefined,
      });
      notify(ctx, `spawned #${result.shortId} ${result.name} in ${result.cwd}`);
    },
  });

  pi.registerCommand("baker-kill", {
    description: "Kill a daemon-owned spawned pi session: /baker-kill <session>.",
    handler: async (args, ctx) => {
      requireServices(deps).recordCommand("baker-kill", "tui");
      const parsed = parseArgs(args);
      if (parsed.length !== 1) {
        notify(ctx, "usage: /baker-kill <session>", "warning");
        return;
      }
      const selector = parsed[0] ?? "";
      const message = await requireServices(deps).kill(selector);
      notify(ctx, message);
    },
  });

  pi.registerCommand("baker-clear", {
    description: "Start a fresh daemon session while keeping pi-baker registry and socket alive.",
    handler: async (args, ctx) => {
      requireServices(deps).recordCommand("baker-clear", "tui");
      if (parseArgs(args).length > 0) {
        notify(ctx, "usage: /baker-clear", "warning");
        return;
      }
      let notified = false;
      const result = await ctx.newSession({
        withSession: async (nextCtx) => {
          notified = true;
          nextCtx.ui.notify("daemon session cleared");
        },
      });
      if (result.cancelled) {
        notify(ctx, "daemon session clear cancelled");
      } else if (!notified) {
        notify(ctx, "daemon session cleared");
      }
    },
  });
}

async function handlePromptCommand(
  args: string,
  ctx: ExtensionCommandContext,
  deps: DaemonCommandDeps,
  deliverAs: "followUp" | "steer",
): Promise<void> {
  const [selector, ...textParts] = args.trim().split(/\s+/);
  const text = textParts.join(" ");
  if (selector === undefined || selector === "" || text === "") {
    notify(ctx, deliverAs === "steer" ? "usage: /baker-steer <session> <text>" : "usage: /baker-tell <session> <text>", "warning");
    return;
  }
  const message = await requireServices(deps).sendPrompt(selector, text, deliverAs);
  notify(ctx, message);
}

function requireServices(deps: DaemonCommandDeps): BakerServices {
  const services = deps.services();
  if (services === undefined) {
    throw new Error("pi-baker daemon is not started yet");
  }
  return services;
}

function requireRegistry(deps: DaemonCommandDeps): BakerRegistry {
  const registry = deps.registry();
  if (registry === undefined) {
    throw new Error("pi-baker registry is not started yet");
  }
  return registry;
}

function requireServer(deps: DaemonCommandDeps): ControlServer {
  const server = deps.server();
  if (server === undefined) {
    throw new Error("pi-baker control server is not started yet");
  }
  return server;
}

function parseArgs(args: string): string[] {
  const trimmed = args.trim();
  return trimmed === "" ? [] : trimmed.split(/\s+/);
}

function notify(ctx: ExtensionCommandContext, message: string, type: "info" | "warning" | "error" = "info"): void {
  ctx.ui.notify(message, type);
}
