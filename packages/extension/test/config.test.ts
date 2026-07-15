import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { ensureBakerDir, EXTENSION_VERSION, formatSetupStatus, loadConfig } from "../src/config.ts";

test("extension version comes from package metadata and matches the lockfile", () => {
  const packageMetadata = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
    version?: unknown;
    engines?: { node?: unknown };
    peerDependencies?: Record<string, unknown>;
    devDependencies?: Record<string, unknown>;
  };
  const rootPackage = JSON.parse(readFileSync(new URL("../../../package.json", import.meta.url), "utf8")) as {
    engines?: { node?: unknown };
  };
  const lockfile = JSON.parse(readFileSync(new URL("../../../package-lock.json", import.meta.url), "utf8")) as {
    packages?: Record<string, { version?: unknown; engines?: { node?: unknown } }>;
  };
  const lockedRoot = lockfile.packages?.[""];
  const locked = lockfile.packages?.["packages/extension"];

  assert.equal(EXTENSION_VERSION, "0.1.0");
  assert.equal(packageMetadata.version, EXTENSION_VERSION);
  assert.equal(locked?.version, EXTENSION_VERSION);
  assert.equal(packageMetadata.engines?.node, ">=24");
  assert.equal(rootPackage.engines?.node, ">=24");
  assert.equal(locked?.engines?.node, ">=24");
  assert.equal(lockedRoot?.engines?.node, ">=24");
  assert.deepEqual(packageMetadata.peerDependencies, {
    "@earendil-works/pi-ai": "*",
    "@earendil-works/pi-coding-agent": "*",
  });
  assert.equal(packageMetadata.devDependencies?.["@earendil-works/pi-ai"], "0.80.2");
  assert.equal(packageMetadata.devDependencies?.["@earendil-works/pi-coding-agent"], "0.80.2");
});

test("ensureBakerDir enforces owner-only permissions on existing directories", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-baker-config-"));
  try {
    chmodSync(dir, 0o755);
    ensureBakerDir({ bakerDir: dir });

    assert.equal(statSync(dir).mode & 0o777, 0o700);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("loadConfig accepts only E.164 Signal account and whitelist numbers", () => {
  const config = loadConfig(undefined, {
    PI_BAKER_SIGNAL_ACCOUNT: " +15550001 ",
    PI_BAKER_WHITELIST: "+15550002,not-a-number,+15550003,+0,+1234567890123456",
  });

  assert.equal(config.signalAccount, "+15550001");
  assert.equal(config.signalUrl, "http://127.0.0.1:51921");
  assert.deepEqual([...config.whitelist], ["+15550002", "+15550003"]);

  const invalidAccount = loadConfig(undefined, {
    PI_BAKER_SIGNAL_ACCOUNT: "15550001",
    PI_BAKER_WHITELIST: "",
  });
  assert.equal(invalidAccount.signalAccount, undefined);
});

test("formatSetupStatus includes validation and concrete setup instructions", () => {
  const missing = formatSetupStatus(
    loadConfig(undefined, {
      PI_BAKER_DIR: "/tmp/pi-baker-setup",
      PI_BAKER_MANAGE_SIGNAL: "true",
    }),
  );

  assert.match(missing, /setup: incomplete/);
  assert.match(missing, /signal account: missing PI_BAKER_SIGNAL_ACCOUNT/);
  assert.match(missing, /signal-cli link -n pi-baker/);
  assert.match(missing, /qrencode -t utf8/);
  assert.match(missing, /Settings > Linked devices/);
  assert.match(missing, /pi --baker-daemon/);

  const ready = formatSetupStatus(
    loadConfig(undefined, {
      PI_BAKER_SIGNAL_ACCOUNT: "+15550001",
      PI_BAKER_WHITELIST: "+15550002,+15550003",
      PI_BAKER_MANAGE_SIGNAL: "false",
      PI_BAKER_SIGNAL_URL: "http://127.0.0.1:9090",
    }),
  );

  assert.match(ready, /setup: ready/);
  assert.match(ready, /signal account: \+15550001/);
  assert.match(ready, /whitelisted operators: 2/);
  assert.match(ready, /PI_BAKER_MANAGE_SIGNAL=false/);
  assert.match(ready, /PI_BAKER_SIGNAL_URL/);
});
