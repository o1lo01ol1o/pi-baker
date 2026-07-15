import assert from "node:assert/strict";
import { test } from "node:test";

import { FrameLineBuffer, parseFrameLine, serializeFrame, type HelloFrame, type RenameFrame } from "../src/protocol.ts";

test("protocol round-trips known frames", () => {
  const frame: HelloFrame = {
    v: 1,
    type: "hello",
    sessionId: "session-a",
    cwd: "/tmp/project",
    pid: 123,
    state: "idle",
    spawned: false,
    extensionVersion: "0.1.0",
  };

  const parsed = parseFrameLine(serializeFrame(frame).trimEnd());
  assert.equal(parsed.kind, "frame");
  if (parsed.kind === "frame") {
    assert.deepEqual(parsed.frame, frame);
  }

  const rename: RenameFrame = { v: 1, type: "rename", id: "rename-1", name: "new-name" };
  const parsedRename = parseFrameLine(serializeFrame(rename).trimEnd());
  assert.equal(parsedRename.kind, "frame");
  if (parsedRename.kind === "frame") {
    assert.deepEqual(parsedRename.frame, rename);
  }
});

test("protocol ignores unknown frame types but closes on unknown versions", () => {
  const unknown = parseFrameLine(JSON.stringify({ v: 1, type: "future", payload: true }));
  assert.equal(unknown.kind, "unknown");

  const badVersion = parseFrameLine(JSON.stringify({ v: 99, type: "hello" }));
  assert.equal(badVersion.kind, "invalid");
  if (badVersion.kind === "invalid") {
    assert.equal(badVersion.close, true);
  }
});

test("line buffer handles chunked JSONL", () => {
  const buffer = new FrameLineBuffer();
  assert.deepEqual(buffer.push('{"v":1,"type":"ping","id":"'), []);
  const parsed = buffer.push('a"}\n{"v":1,"type":"pong","id":"a"}\n');
  assert.equal(parsed.length, 2);
  assert.equal(parsed[0]?.kind, "frame");
  assert.equal(parsed[1]?.kind, "frame");
});
