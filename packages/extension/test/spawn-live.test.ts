import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import type { BakerConfig } from "../src/config.ts";
import { BakerRegistry } from "../src/daemon/registry.ts";
import { BakerServices } from "../src/daemon/services.ts";
import { SpawnManager } from "../src/daemon/spawn.ts";
import { ControlServer } from "../src/daemon/server.ts";

const runLiveSpawn = process.env.PI_BAKER_RUN_LIVE_SPAWN === "1";

test(
  "SpawnManager can spawn and kill a real pi RPC child",
  {
    skip: runLiveSpawn ? false : "set PI_BAKER_RUN_LIVE_SPAWN=1 to run the real pi spawn integration test",
  },
  async () => {
    const dir = mkdtempSync(join(liveTempRoot(), "pi-baker-live-spawn-"));
    const registry = new BakerRegistry(join(dir, "baker.db"));
    const server = new ControlServer({ socketPath: join(dir, "baker.sock"), registry });
    await server.start();
    const previousEnv = snapshotEnv(["PATH", "PI_OFFLINE", "PI_SKIP_VERSION_CHECK"]);
    process.env.PATH = [dirname(process.execPath), process.env.PATH].filter(Boolean).join(delimiter);
    process.env.PI_OFFLINE = "1";
    process.env.PI_SKIP_VERSION_CHECK = "1";

    const spawner = new SpawnManager({
      config: makeConfig(dir),
      registry,
      server,
      cliPath: liveCliPath(),
      cliArgs: ["--offline", "--extension", extensionPath()],
      registrationTimeoutMs: liveTimeoutMs(),
      stopSignalMs: 1_000,
      stopKillMs: 2_000,
    });

    try {
      const result = await spawner.spawn({ cwd: dir });
      const session = registry.getSession(result.shortId);
      assert.equal(session?.kind, "spawned");
      assert.equal(session?.connected, true);
      assert.equal(session === undefined ? undefined : realpathSync(session.cwd), realpathSync(dir));
      assert.equal(spawner.hasHandle(result.shortId), true);

      const services = new BakerServices(registry, server, spawner);
      assert.equal(await services.kill(String(result.shortId)), `killed #${result.shortId} ${result.name}`);
      assert.equal(spawner.hasHandle(result.shortId), false);
      assert.equal(registry.getSession(result.shortId)?.connected, false);
    } finally {
      await spawner.stopAll().catch(() => undefined);
      await server.stop({ notify: false }).catch(() => undefined);
      registry.close();
      restoreEnv(previousEnv);
      rmSync(dir, { recursive: true, force: true });
    }
  },
);

function liveCliPath(): string {
  return process.env.PI_BAKER_LIVE_PI_CLI_PATH ?? fileURLToPath(new URL("../../../node_modules/@earendil-works/pi-coding-agent/dist/cli.js", import.meta.url));
}

function extensionPath(): string {
  return process.env.PI_BAKER_LIVE_EXTENSION_PATH ?? fileURLToPath(new URL("../src/index.ts", import.meta.url));
}

function liveTimeoutMs(): number {
  const raw = process.env.PI_BAKER_LIVE_SPAWN_TIMEOUT_MS;
  if (raw === undefined) {
    return 30_000;
  }
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 30_000;
}

function liveTempRoot(): string {
  return process.env.PI_BAKER_LIVE_TMPDIR ?? tmpdir();
}

function makeConfig(dir: string): BakerConfig {
  return {
    role: "daemon",
    bakerDir: dir,
    socketPath: join(dir, "baker.sock"),
    dbPath: join(dir, "baker.db"),
    signalAccount: undefined,
    whitelist: new Set(),
    signalUrl: "http://127.0.0.1:51921",
    manageSignal: false,
    storeTurns: true,
    quiet: true,
    spawned: false,
  };
}

function snapshotEnv(keys: string[]): Map<string, string | undefined> {
  return new Map(keys.map((key) => [key, process.env[key]]));
}

function restoreEnv(snapshot: Map<string, string | undefined>): void {
  for (const [key, value] of snapshot) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}
