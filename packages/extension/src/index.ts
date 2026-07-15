import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { loadConfig, registerBakerFlags } from "./config.ts";
import { registerDaemonCommands } from "./daemon/commands.ts";
import { attachDaemonRuntime, type DaemonAttachment } from "./daemon/runtime.ts";
import { registerBakerTools } from "./daemon/tools.ts";
import { MemberClient, registerMemberCommands } from "./member/client.ts";

export { scheduleStartupNotice } from "./daemon/runtime.ts";

type ExtensionRoleRuntime =
  | { readonly kind: "daemon"; readonly attachment: DaemonAttachment }
  | { readonly kind: "member"; readonly client: MemberClient };

export default function piBakerExtension(pi: ExtensionAPI): void {
  registerBakerFlags(pi);
  let roleRuntime: ExtensionRoleRuntime | undefined;

  const initializeRole = (): ExtensionRoleRuntime => {
    if (roleRuntime !== undefined) {
      return roleRuntime;
    }

    // Pi applies registered extension-flag values after factories return but
    // before session_start. Reading --baker-daemon in the factory would only
    // observe its default; defer role selection until this first lifecycle
    // event so CLI flags and environment configuration have equal semantics.
    const config = loadConfig(pi);
    if (config.role === "daemon") {
      const attachment = attachDaemonRuntime(config, pi);
      const { runtime } = attachment;
      registerDaemonCommands(pi, {
        config: runtime.config,
        registry: () => runtime.registry,
        server: () => runtime.server,
        services: () => runtime.services,
        signal: () => runtime.signal,
      });
      registerBakerTools(pi, {
        services: () => runtime.services,
        signal: () => runtime.signal,
      });
      roleRuntime = { kind: "daemon", attachment };
      return roleRuntime;
    }

    const client = new MemberClient(pi, config);
    registerMemberCommands(pi, client, config);
    roleRuntime = { kind: "member", client };
    return roleRuntime;
  };

  pi.on("session_start", async (event, ctx) => {
    const current = initializeRole();
    if (current.kind === "daemon") {
      return current.attachment.runtime.onSessionStart(current.attachment.token, ctx);
    }
    return current.client.onSessionStart(event, ctx);
  });

  pi.on("session_shutdown", async (event) => {
    const current = roleRuntime;
    if (current?.kind === "daemon") {
      return current.attachment.runtime.onSessionShutdown(current.attachment.token, event.reason);
    }
    return current?.client.onSessionShutdown(event);
  });

  pi.on("agent_start", (_event, ctx) => {
    const current = roleRuntime;
    if (current?.kind === "daemon") {
      return current.attachment.runtime.onAgentStart(current.attachment.token, ctx);
    }
    return current?.client.onAgentStart(ctx);
  });

  pi.on("agent_end", (event, ctx) => {
    const current = roleRuntime;
    if (current?.kind === "daemon") {
      return current.attachment.runtime.onAgentEnd(current.attachment.token, event.messages, ctx);
    }
    return current?.client.onAgentEnd(event, ctx);
  });

  pi.on("model_select", (event, ctx) => {
    const current = roleRuntime;
    if (current?.kind === "daemon") {
      return current.attachment.runtime.onModelSelect(current.attachment.token, ctx);
    }
    return current?.client.onModelSelect(event);
  });
}
