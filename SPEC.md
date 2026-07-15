# pi-baker — Signal Orchestrator Daemon for pi Sessions

**Status:** Draft v0.1 (2026-07-13)
**Package:** `@pi-baker/extension` (pi package, entry `packages/extension/src/index.ts`)
**Prior art:** [pi-signal](https://github.com/aalzubidy/pi-signal) (Signal ⇄ single pi session bridge, MPL-2.0)

## 1. Summary

pi-baker is a pi extension that turns one pi session into an **orchestrator daemon** and every other pi session on the host into a **supervised member**. The daemon:

- bridges Signal Messenger (via `signal-cli` in daemon mode) to its own pi session — plain texts become prompts, `/commands` become deterministic control operations;
- maintains a SQLite **registry** of every pi session on the host that has the extension loaded;
- exposes a local **control plane** (Unix domain socket) that member sessions connect to, so the operator can list, inspect, prompt, steer, and abort any running pi session from their phone;
- can **spawn and kill** headless pi sessions on request.

The daemon is itself a normal pi session: its LLM is reachable by texting it, and it is given orchestration tools so natural-language requests ("check on the refactor session, nudge it if it's stuck") work alongside exact slash commands.

## 2. Goals and non-goals

### Goals (v1)

- Single-host operation: daemon and all supervised sessions run on one machine.
- Two authorized Signal ingress paths: **Note-to-Self** on the linked account, and direct messages from an explicit **whitelist** of E.164 numbers. Everything else is ignored silently.
- Zero-configuration member enrollment: any pi session loading the extension auto-registers with the daemon if one is running, and runs standalone (no-op) otherwise.
- Deterministic slash-command control plane that never invokes an LLM.
- LLM path: plain texts prompt the daemon session, whose model has tools mirroring the control plane.
- Spawn/kill of daemon-owned headless sessions via pi's RPC mode.
- Durable registry (SQLite) surviving daemon restarts; message bodies **not** persisted by default.

### Non-goals (v1)

- Multi-host / networked members (future: TCP + auth over a tailnet; see §17).
- Signal group chats, attachments, reactions-as-commands, voice notes.
- Multiple concurrent daemons per host.
- Supervising non-pi processes.
- Any web UI.

## 3. Background and constraints

Facts about the platform that shape this design (verified against `@earendil-works/pi-coding-agent` 0.80.2):

- **Extension API** (`dist/core/extensions/types.d.ts`): extensions are default-exported factories `(pi: ExtensionAPI) => void`. Relevant surface: `pi.on(...)` for lifecycle events (`session_start`, `session_shutdown`, `agent_start`, `agent_end`, `model_select`, `input`), `pi.registerCommand` (TUI slash commands), `pi.registerTool` (LLM tools), `pi.registerFlag`, `pi.sendUserMessage(text, { deliverAs: "steer" | "followUp" })`, `ctx.isIdle()`, `ctx.abort()`, `ctx.sessionManager` (session id/file/name/cwd), `ctx.ui.notify`, `pi.exec`.
- **No cross-process IPC exists in pi.** `pi.events` is in-process only. Cross-session communication must be built (our Unix socket) or use pi's child-process RPC mode.
- **RPC mode** (`pi --mode rpc`, `dist/modes/rpc/rpc-client.d.ts`): JSONL over stdio with commands `prompt`, `steer`, `abort`, `get_state`, etc., and a typed `RpcClient` that spawns and drives a child pi. This is how the daemon spawns sessions.
- **Sessions** are JSONL trees under `~/.pi/agent/sessions/`; `ctx.sessionManager.getSessionId()` / `getSessionFile()` give stable identity, but the id changes on `/clear`, resume, and fork — members must re-register on every `session_start`.
- **signal-cli** daemon mode with `--http` exposes `POST /api/v1/rpc` (JSON-RPC: `send`, `sendReaction`, `listContacts`, `version`), `GET /api/v1/events?account=…` (SSE stream of incoming envelopes), and `GET /api/v1/check` (health). Note-to-Self arrives as `envelope.syncMessage.sentMessage` with `destinationNumber === account`; direct messages arrive as `envelope.dataMessage` with `envelope.sourceNumber`.
- **Runtime:** Node ≥ 24 (provided by pi), so `node:sqlite` is available — no native dependencies.

pi-signal validates the Signal side of this design (SSE receive, JSON-RPC send, 👀/✅/❌ reaction lifecycle, note-to-self filtering, `agent_end` reply capture). pi-baker generalizes it from "bridge to one session" to "control plane over many sessions."

## 4. Architecture

```
 Phone (Signal)
   │  Note-to-Self / whitelisted DM
   ▼
 signal-cli daemon ── --http 127.0.0.1:51921 (loopback only)
   │ SSE /api/v1/events            ▲ JSON-RPC /api/v1/rpc (send, sendReaction)
   ▼                               │
 ┌─────────────────────────────────┴───────────────────────┐
 │ DAEMON pi session (extension, role=daemon)              │
 │  • Signal ingress: parse → /command or LLM prompt       │
 │  • Registry: SQLite  ~/.pi-baker/baker.db               │
 │  • Control server: UDS ~/.pi-baker/baker.sock (JSONL)   │
 │  • Orchestration tools on its own LLM                   │
 │  • Spawner: RpcClient children (pi --mode rpc)          │
 └───────┬──────────────────┬──────────────────┬───────────┘
         │ UDS              │ UDS              │ UDS + stdio (lifecycle)
 ┌───────┴───────┐  ┌───────┴───────┐  ┌───────┴────────────┐
 │ MEMBER session│  │ MEMBER session│  │ SPAWNED session    │
 │ (human's TUI) │  │ (human's TUI) │  │ (headless, child)  │
 └───────────────┘  └───────────────┘  └────────────────────┘
```

One extension, two roles, one control path: **all** session control (prompt, steer, abort, status) flows over the Unix socket, uniformly for members and spawned children. The RPC stdio channel to spawned children is used only for process lifecycle (spawn, detect crash, kill).

## 5. Roles and lifecycle

### 5.1 Role selection

- `role = "daemon"` when the pi session was started with `--baker-daemon` (via `pi.registerFlag("baker-daemon")`) or `PI_BAKER_ROLE=daemon`.
- `role = "member"` otherwise (the default; includes spawned children, which additionally see `PI_BAKER_SPAWNED=1`).

Exactly one daemon per host. On startup the daemon:

1. Ensures `$PI_BAKER_DIR` (default `~/.pi-baker/`, mode `0700`) exists.
2. If `baker.sock` exists, attempts a connection: live socket → fatal error "daemon already running"; dead socket → unlink and continue.
3. Opens/migrates `baker.db`, marks all previously-connected rows `connected = 0`.
4. Starts the control server (socket mode `0600`).
5. Starts or verifies signal-cli (§6.1), then subscribes to the SSE stream.
6. Registers its own row in the registry (`kind = 'daemon'`, short id `0`).
7. Sends a startup notice to the owner over Signal ("baker up, N sessions reconnected").

On `session_shutdown` with `reason: "quit"`, the daemon: notifies members (`notify` frame), stops spawned children gracefully (§11), sends a Signal notice, closes the socket, and marks rows disconnected. On `reload`/`new`/`resume` (same process, new session), it keeps the server and registry alive and re-registers its own row with the new session id.

### 5.2 Member lifecycle

On `session_start`, a member dials `baker.sock`. Connection refused → log once at debug level, retry with exponential backoff (1 s → 60 s cap, forever); the extension is otherwise inert. On connect it sends `hello` (§9) and thereafter:

- pushes `state` on `agent_start` / `agent_end` / `model_select`;
- pushes `turn` (final assistant text of the turn) on `agent_end`;
- re-sends `hello` on any subsequent `session_start` (id changed by clear/resume/fork);
- sends `goodbye` on `session_shutdown`, then closes.

Members apply daemon-initiated operations using the extension API: `prompt` → `pi.sendUserMessage(text, { deliverAs })`; `abort` → `ctx.abort()`; `notify` → `ctx.ui.notify(...)` (TUI only). A member session's human user sees injected prompts as ordinary user messages in their transcript — supervision is visible, never silent.

## 6. Signal transport

### 6.1 signal-cli management

- If `PI_BAKER_MANAGE_SIGNAL=true` (default), the daemon spawns `signal-cli -a $PI_BAKER_SIGNAL_ACCOUNT daemon --http 127.0.0.1:51921` as a supervised child, waits for `/api/v1/check`, and restarts it with backoff if it dies.
- If `false`, an externally managed daemon (systemd/launchd) is expected at `PI_BAKER_SIGNAL_URL`; the extension only health-checks it.
- Account linking is out of scope for the extension. `signal-cli link` prints a `sgnl://linkdevice…` provisioning URI, not a user-facing URL; render it as a QR code (for example, `signal-cli link -n pi-baker | tee >(xargs -L 1 qrencode -t utf8)`), scan it from Signal's **Settings → Linked devices**, and keep the command running until linking completes. The `/baker-setup` TUI command prints these instructions.

### 6.2 Ingress filter

For each SSE envelope, in order:

1. `syncMessage.sentMessage` present and `destinationNumber === PI_BAKER_SIGNAL_ACCOUNT` → accept as **Note-to-Self**; reply target = self.
2. `dataMessage` present and `sourceNumber ∈ PI_BAKER_WHITELIST` → accept; reply target = that number.
3. Anything else → drop silently (no reply, no reaction, no persistent log; counted in an in-memory `ignored` counter shown by `/status`).

Accepted messages get a 👀 reaction immediately (`sendReaction`), then ✅ when fully handled or ❌ on error — the pi-signal convention.

### 6.3 Dispatch

- Body starts with `/` → parse and run as a **slash command** (§7). Never touches an LLM.
- Otherwise → `pi.sendUserMessage(body, { deliverAs: "followUp" })` into the daemon's own session (pi queues it if the daemon is mid-turn). The daemon's reply is captured on `agent_end` (assistant text of the finished turn) and sent to the reply target, truncated per §12.
- While paused (`/pause`): slash commands still work; plain texts are rejected with a short notice.

Each accepted message records the reply target so concurrent conversations (self + whitelisted numbers) route responses back to their origin.

## 7. Signal slash commands (control plane)

Grammar: `/cmd [args…]`, whitespace-separated. `<sel>` selects a session by **short id** (small integer assigned by the registry, shown in `/sessions`) or unambiguous **name prefix**; ambiguous or unknown selectors produce an error listing candidates. `0`/`me` selects the daemon session itself where meaningful.

| Command | Effect |
|---|---|
| `/help` | Command list. |
| `/sessions` | Registry table: `#id name state kind cwd model last-activity`. Disconnected sessions shown dimmed with last-seen; `/sessions all` includes history. |
| `/status` | Daemon health: signal-cli check, uptime, model, connected/spawned counts, ignored-message counter. |
| `/status <sel>` | One session in detail (state, cwd, model, session file, last turn summary, watch flag). |
| `/tell <sel> <text…>` | Inject `<text>` into the session as `deliverAs: "followUp"`. The session's next `turn` frame is relayed back prefixed `[#id name]`. |
| `/steer <sel> <text…>` | Same but `deliverAs: "steer"` (interrupts the current turn). |
| `/ask <sel>` | Relay the session's most recent assistant message without prompting it. |
| `/abort <sel>` | `ctx.abort()` in the target session. |
| `/watch <sel> on\|off` | Toggle push of every completed turn's summary from that session to the caller. |
| `/spawn <dir> [prompt…]` | Spawn a headless pi session in `<dir>` (§11); optional initial prompt. Replies with its new `#id`. |
| `/kill <sel>` | Terminate a **spawned** session (graceful stop → SIGTERM → SIGKILL). Refused for members and the daemon — humans own those. |
| `/name <sel> <name>` | Rename in the registry (and `setSessionName` on the target). |
| `/pause` / `/resume` | Suspend / resume LLM processing of plain texts (control plane stays live). |
| `/model [name]` | Show or fuzzy-switch the daemon session's model. |
| `/clear` | Start a fresh daemon session (registry and socket survive). |
| `/resend` | Re-send the daemon's last reply. |
| `/whoami` | Daemon model, cwd, session name/id, version. |

Unknown `/commands` return an error with `/help` hint (they are **not** forwarded to the LLM, to keep the command namespace predictable).

**Accepted v1 host-API limitation:** `/baker-clear` performs session replacement from the daemon TUI. Signal `/clear` returns an explicit instruction to use `/baker-clear` because current Pi exposes `newSession()` only on `ExtensionCommandContext`; Signal ingress runs with `ExtensionContext`. Extension-origin `sendUserMessage()` deliberately skips command expansion, so forwarding `/baker-clear` would invoke the LLM rather than the command and is not a safe workaround. This fallback is deterministic and covered by tests; Signal-driven replacement remains pending a Pi host API.

## 8. Orchestration tools (daemon LLM)

Registered via `pi.registerTool` only in the daemon role, so plain-text requests can operate the same machinery the slash commands use (shared service layer — one implementation, two front ends):

| Tool | Parameters | Returns |
|---|---|---|
| `baker_sessions` | `{ all?: boolean }` | Registry rows (id, name, kind, state, cwd, model, last activity, last turn summary). |
| `baker_session_status` | `{ session }` | Detailed live status (queried over the socket, falls back to registry). |
| `baker_session_prompt` | `{ session, text, mode?: "followUp"\|"steer", wait?: boolean, timeoutSec?: number }` | If `wait`, blocks until that session's next `turn` frame (default timeout 300 s) and returns the assistant text; else acks. |
| `baker_session_last` | `{ session }` | Most recent assistant message. |
| `baker_session_abort` | `{ session }` | Ack. |
| `baker_spawn` | `{ cwd, prompt?, model?, name? }` | New session's id. |
| `baker_kill` | `{ session }` | Ack (spawned sessions only). |
| `baker_signal_send` | `{ text, recipient? }` | Sends a Signal message (recipient must be self or whitelisted; defaults to the conversation that triggered the turn). |

Guardrail: tools enforce the same rules as commands (`baker_kill` only on spawned sessions; `baker_signal_send` only to authorized targets). The system prompt is extended with a short orchestration briefing (current session table) via the `before_agent_start` event so the model doesn't need a tool call just to know what exists.

## 9. Control-plane protocol (daemon ⇄ member)

Transport: Unix domain socket, newline-delimited JSON frames (same style as pi's RPC mode). All frames: `{ "v": 1, "type": string, "id"?: string, ... }`. `id` correlates request/response; unsolicited frames omit it. Unknown frame types are ignored (forward compatibility); unknown `v` closes the connection.

**Member → daemon**

| Frame | Payload | When |
|---|---|---|
| `hello` | `sessionId, sessionFile, sessionName?, cwd, pid, model, state, spawned: boolean, extensionVersion` | On connect and on every `session_start`. Daemon upserts the registry row (keyed by `sessionId`, correlated by `pid` across clears) and replies `hello_ack { shortId, name }`. |
| `state` | `state: "idle"\|"busy", model` | On `agent_start` / `agent_end` / `model_select`. |
| `turn` | `text` (final assistant text), `usage?` | On `agent_end`. Drives `/tell` reply relay and `/watch`. |
| `goodbye` | — | On `session_shutdown`. |
| `result` | `id, ok, data? \| error?` | Response to a daemon request. |
| `pong` | `id` | Response to `ping`. |

**Daemon → member**

| Frame | Payload | Effect |
|---|---|---|
| `hello_ack` | `shortId, name` | Registration confirmed. |
| `prompt` | `id, text, deliverAs` | `pi.sendUserMessage(text, { deliverAs })`; `result` acks acceptance (not completion — completion arrives as the next `turn`). |
| `abort` | `id` | `ctx.abort()`. |
| `query` | `id, what: "state"` | Member replies `result` with live state detail. |
| `notify` | `text` | `ctx.ui.notify` in TUI sessions; ignored headless. |
| `ping` | `id` | Liveness. |

Liveness: daemon pings every 30 s; a connection with no pong for 90 s is closed and the row marked disconnected. Members reconnect with backoff. Both sides must tolerate the peer vanishing at any point; every daemon-side operation on a disconnected session fails fast with "session #N is disconnected (last seen …)".

## 10. Registry database

SQLite via `node:sqlite`, file `$PI_BAKER_DIR/baker.db`, WAL mode.

```sql
CREATE TABLE sessions (
  short_id     INTEGER PRIMARY KEY,          -- monotonically assigned, never reused
  session_id   TEXT NOT NULL UNIQUE,         -- pi session id (current)
  session_file TEXT,
  name         TEXT,                         -- registry name (defaults to pi session name or cwd basename)
  cwd          TEXT NOT NULL,
  pid          INTEGER,
  kind         TEXT NOT NULL CHECK (kind IN ('daemon','member','spawned')),
  model        TEXT,
  state        TEXT NOT NULL DEFAULT 'unknown',   -- idle | busy | unknown
  connected    INTEGER NOT NULL DEFAULT 0,
  watch        INTEGER NOT NULL DEFAULT 0,
  last_turn    TEXT,                          -- truncated last assistant text (see privacy note)
  first_seen   TEXT NOT NULL,                 -- ISO-8601
  last_seen    TEXT NOT NULL
);

CREATE TABLE events (                          -- lightweight audit trail, capped
  id         INTEGER PRIMARY KEY,
  short_id   INTEGER REFERENCES sessions(short_id),
  ts         TEXT NOT NULL,
  type       TEXT NOT NULL,                    -- connect|disconnect|prompt|abort|spawn|kill|command
  detail     TEXT                              -- metadata only, never message bodies
);
```

Retention: `events` capped at 5 000 rows (trim oldest on insert). **Privacy default:** Signal message bodies and prompt texts are never written to disk by pi-baker; `last_turn` storage is opt-out via `PI_BAKER_STORE_TURNS=false` (then `/ask` works only for connected sessions, from memory). Session transcripts themselves live in pi's own session files, as always.

## 11. Spawned sessions

- `POST /spawn` path: daemon uses pi's `RpcClient` (`{ cwd, env: { PI_BAKER_SPAWNED: "1" }, args }`) to launch `pi --mode rpc` as a child process.
- The child loads this same extension (installed globally), sees `PI_BAKER_SPAWNED=1`, and registers over the socket like any member with `spawned: true` — control stays uniform on the one socket path.
- The `RpcClient` handle is retained **only** for lifecycle: crash detection (process exit → row marked `disconnected`, Signal notice if watched), `/kill` (RPC `abort` + graceful stop, then SIGTERM after 10 s, SIGKILL after 20 s), and daemon shutdown (all spawned children are stopped; v1 does not orphan children).
- Spawned sessions run with pi's default permission posture in the target `cwd`. The spec flags (future hardening, §17) gating their tools via a `tool_call` handler.
- The initial `/spawn` prompt, if given, is delivered over the socket after `hello_ack` (not via RPC) so the reply-relay path is identical to `/tell`.

## 12. Reply routing and formatting

- Every relayed reply is prefixed with its source: `[#3 refactor]` for session output, no prefix for the daemon's own replies.
- Messages are truncated to 3 000 characters with `… (truncated, /ask 3 for last message)`.
- `/tell` and `/steer` create a one-shot **pending relay** (caller ⇄ session): the session's next `turn` frame is delivered to that caller, then the relay clears. `/watch` is the persistent variant. Multiple pending relays to different callers are allowed; duplicates to the same caller collapse.
- Turn frames arriving with no pending relay and `watch = 0` go nowhere (the daemon does not narrate unprompted, except spawn-crash notices).
- Errors are always reported to the caller in plain text plus the ❌ reaction.

## 13. Security model

- **Authorization boundary = the ingress whitelist.** Note-to-Self (the linked account owner) and `PI_BAKER_WHITELIST` numbers have full operator power: they can prompt any session, spawn sessions, and thereby execute code as the daemon's user. Whitelisted numbers must be treated as root on this host. There is no per-command ACL in v1.
- signal-cli HTTP binds loopback only and is unauthenticated (upstream limitation) — the host must be single-user/trusted, port never exposed.
- Unix socket `0600` inside `$PI_BAKER_DIR` `0700`: same-user processes only. Any local process of the same user can therefore register or issue frames — acceptable on a single-user host, revisited for multi-host (§17).
- Sender identity comes from signal-cli's envelope (`sourceNumber` is verified by the Signal protocol); contact display names are never used for authorization and are sanitized before inclusion in prompts.
- Prompt-injection surface: text relayed **from** member sessions back to Signal is display-only; text sent **to** sessions is deliberate operator input. The daemon LLM's tools are the guarded surface — they validate targets and recipients server-side, never trusting model-supplied strings beyond the schema.
- No message bodies on disk (§10). `PI_BAKER_QUIET=true` (default) keeps envelope contents out of stdout/stderr logs.

## 14. Configuration

| Variable / flag | Default | Meaning |
|---|---|---|
| `--baker-daemon` / `PI_BAKER_ROLE=daemon` | member | Run this pi session as the orchestrator daemon. |
| `PI_BAKER_SIGNAL_ACCOUNT` | — (required for daemon) | Linked account, E.164. |
| `PI_BAKER_WHITELIST` | empty | Comma-separated E.164 numbers with operator access (Note-to-Self always allowed). |
| `PI_BAKER_SIGNAL_URL` | `http://127.0.0.1:51921` | signal-cli HTTP endpoint (high private-use port to avoid common service collisions). |
| `PI_BAKER_MANAGE_SIGNAL` | `true` | Daemon spawns/supervises signal-cli itself. |
| `PI_BAKER_DIR` | `~/.pi-baker` | Socket, database, runtime state. |
| `PI_BAKER_STORE_TURNS` | `true` | Persist truncated last-turn text per session in the registry. |
| `PI_BAKER_QUIET` | `true` | Suppress message contents in daemon logs. |
| `PI_BAKER_SPAWNED` | (set by daemon) | Marks a spawned child; not user-set. |

## 15. In-TUI commands (both roles)

- `/baker-status` — member: connection state, daemon pid, own short id; daemon: same as Signal `/status`.
- `/baker-sessions` — daemon only: registry table in the TUI.
- `/baker-setup` — prints signal-cli linking instructions and validates configuration.
- `/baker-disconnect` / `/baker-connect` — member opt-out/in for this session.

## 16. Package layout, testing, milestones

```
packages/extension/src/
  index.ts            # entry: role detection, wiring
  config.ts           # env/flag parsing, defaults
  protocol.ts         # frame types + (de)serialization, shared by both roles
  member/client.ts    # socket client, event → frame plumbing
  daemon/
    server.ts         # UDS server, connection & liveness management
    registry.ts       # node:sqlite schema, queries, short-id assignment
    signal.ts         # signal-cli supervision, SSE ingress, JSON-RPC egress, reactions
    commands.ts       # Signal slash-command parser + handlers
    tools.ts          # baker_* tool registrations
    services.ts       # shared operations layer (commands + tools both call this)
    spawn.ts          # RpcClient lifecycle management
```

Testing (`node --test`, no network):
- `protocol.ts` round-trip and forward-compat (unknown fields/types) unit tests.
- Registry unit tests against a temp SQLite file (upsert on re-hello, short-id stability, event capping).
- Command-parser table tests (selector resolution, ambiguity, argument edge cases).
- Integration: real UDS with a fake member (scripted frames) exercising hello/state/turn/relay/liveness; fake signal-cli HTTP server (SSE + `/api/v1/rpc` recorder) exercising ingress filtering and reaction lifecycle.
- Spawn tests behind an env guard (require a real `pi` binary), skipped in CI by default.

Milestones:
1. **M1 — Control plane:** protocol, registry, daemon server, member client, TUI commands. Verifiable with two local pi sessions, no Signal.
2. **M2 — Signal supervise:** signal-cli integration, ingress filter, slash commands, reply relay, reactions.
3. **M3 — LLM orchestration:** `baker_*` tools, plain-text path, system-prompt briefing, wait-for-turn.
4. **M4 — Spawn/kill:** RpcClient lifecycle, crash notices, shutdown semantics.

## 17. Future work / open questions

- **Multi-host:** TCP listener with per-host tokens (or mTLS) over a tailnet; registry gains a `host` column; heartbeats become mandatory. The frame protocol is versioned (`v`) to allow this without breaking members.
- **Attachments:** Signal images → `sendUserMessage` image content (pi supports image parts); needs attachment download via signal-cli.
- **Spawned-session hardening:** per-spawn tool allowlists via a `tool_call` gate; cwd allowlist for `/spawn`.
- **Group-chat mode:** one Signal group per session as dedicated conversation channels.
- **Digest mode:** periodic `/watch` batching instead of per-turn pushes.
- **Open:** short-id presentation once ids grow large (names-first?); whether `/tell` to a busy session should warn that the reply may be delayed behind the current turn; whether the daemon should auto-`/watch` sessions it spawned (leaning yes).
