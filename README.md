# pi-baker

`pi-baker` is a [Pi](https://github.com/earendil-works/pi-mono) extension that turns one Pi session into a single-host orchestration daemon and other Pi sessions into supervised members.

From Signal you can:

- prompt the daemon's LLM with ordinary text;
- list and inspect active Pi sessions;
- prompt, steer, watch, or abort a member session;
- spawn and terminate daemon-owned headless Pi sessions;
- receive completed turns back on your phone.

The daemon and members communicate through an owner-only Unix socket. Session metadata is stored in SQLite; Signal message bodies and injected prompt text are not persisted by pi-baker.

## Status

Version `0.1.0`. Single-host operation only.

Supported Signal ingress:

- Note to Self on the linked account;
- direct messages from explicitly whitelisted E.164 numbers.

Groups, attachments, reactions as commands, and voice notes are intentionally ignored.

## Architecture

```text
Signal phone
    |
    v
signal-cli HTTP/SSE on 127.0.0.1:51921
    |
    v
Pi daemon session
    |-- SQLite registry: ~/.pi-baker/baker.db
    |-- Unix socket:     ~/.pi-baker/baker.sock
    |
    +---- member Pi sessions
    +---- daemon-spawned RPC Pi sessions
```

## Requirements

- Pi
- Node.js 24 or newer (normally supplied by Pi)
- `signal-cli` with HTTP daemon support; `0.14.5` is tested
- A Signal account linked to signal-cli as a secondary device

Make sure `signal-cli` is available on `PATH` when using the default managed mode.

## Install

### From GitHub

```bash
pi install git:github.com/o1lo01ol1o/pi-baker
```

Confirm that Pi loaded the package:

```bash
pi list
pi --help | grep baker-daemon
```

To remove it:

```bash
pi remove git:github.com/o1lo01ol1o/pi-baker
```

### From a local checkout

```bash
git clone https://github.com/o1lo01ol1o/pi-baker.git
cd pi-baker
pi install "$PWD"
```

To try the extension for one invocation without installing it:

```bash
pi -e "$PWD"
```

When using `-e`, pass it to every daemon and member invocation that should load pi-baker.

## Link signal-cli

Link signal-cli to your existing Signal account:

```bash
signal-cli link -n pi-baker
```

Scan the resulting QR code in Signal under **Settings → Linked devices → Link new device**.

The configured account must use E.164 format, for example `+15551234567`.

## Configure

At minimum, export the linked account number in the shell that starts the daemon:

```bash
export PI_BAKER_SIGNAL_ACCOUNT="+15551234567"
```

Optionally authorize direct-message operators:

```bash
export PI_BAKER_WHITELIST="+15557654321,+15559876543"
```

Note to Self is always authorized. The whitelist is only needed for messages sent from other Signal accounts.

### Configuration reference

| Variable / flag | Default | Description |
|---|---:|---|
| `--baker-daemon` | off | Run this Pi session as the orchestrator daemon. |
| `PI_BAKER_ROLE` | `member` | Alternative role selection: `daemon` or `member`. |
| `PI_BAKER_SIGNAL_ACCOUNT` | required for daemon | Linked Signal account in E.164 format. |
| `PI_BAKER_WHITELIST` | empty | Comma-separated E.164 numbers with full operator access. |
| `PI_BAKER_SIGNAL_URL` | `http://127.0.0.1:51921` | Loopback signal-cli HTTP endpoint. |
| `PI_BAKER_MANAGE_SIGNAL` | `true` | Start, monitor, and restart signal-cli. |
| `PI_BAKER_DIR` | `~/.pi-baker` | Database, socket, and runtime-state directory. |
| `PI_BAKER_STORE_TURNS` | `true` | Store a truncated last assistant turn per session. |
| `PI_BAKER_QUIET` | `true` | Suppress signal-cli child output and message content in logs. |

## Start the daemon

With the package installed:

```bash
pi --baker-daemon
```

Or with temporary loading from a checkout:

```bash
pi -e /path/to/pi-baker --baker-daemon
```

Keep this Pi process running. In the daemon TUI, verify startup with:

```text
/baker-setup
/baker-status
/baker-sessions
```

The daemon starts signal-cli as:

```bash
signal-cli -a "$PI_BAKER_SIGNAL_ACCOUNT" \
  daemon --http 127.0.0.1:51921
```

It health-checks signal-cli, reconnects the SSE stream, and restarts the child with backoff if it exits.

## Start member sessions

After global installation, start Pi normally in any project:

```bash
cd /path/to/project
pi
```

The extension automatically connects to the daemon. If no daemon is available, the member remains usable and retries in the background.

Check a member's connection:

```text
/baker-status
```

Each connected session receives a stable short ID such as `#1` or `#2`.

## Use from Signal

Send messages through Note to Self or from a whitelisted direct-message account.

Ordinary text prompts the daemon's LLM:

```text
Check the active sessions and tell me which ones are blocked.
```

Slash commands are deterministic and do not invoke the LLM.

| Command | Effect |
|---|---|
| `/help` | Show the Signal command list. |
| `/sessions [all]` | List connected sessions or include history. |
| `/status [session]` | Show daemon health or detailed session status. |
| `/tell <session> <text>` | Queue a follow-up prompt and relay the next turn. |
| `/steer <session> <text>` | Steer a running session and relay the next turn. |
| `/ask <session>` | Return the most recent assistant turn. |
| `/abort <session>` | Abort the target session's current operation. |
| `/watch <session> on\|off` | Push every completed turn from the session. |
| `/spawn <directory> [prompt]` | Start a daemon-owned headless Pi session. |
| `/kill <session>` | Stop a daemon-owned spawned session. |
| `/name <session> <name>` | Rename a session. |
| `/pause` / `/resume` | Pause or resume ordinary-text LLM prompts. |
| `/model [name]` | Show or switch the daemon model. |
| `/resend` | Resend the daemon's most recent Signal reply. |
| `/whoami` | Show daemon identity, model, cwd, and version. |
| `/clear` | Explain how to clear from the daemon TUI; see the limitation below. |

Selectors accept a short ID, `me` for the daemon, or an unambiguous session-name prefix.

Relayed member output is prefixed with its source:

```text
[#1 refactor] Tests now pass.
```

## TUI commands

### Available in members and the daemon

```text
/baker-status
/baker-setup
```

### Member controls

```text
/baker-disconnect
/baker-connect
```

### Daemon controls

```text
/baker-sessions [all]
/baker-tell <session> <text>
/baker-steer <session> <text>
/baker-ask <session>
/baker-abort <session>
/baker-watch <session> on|off
/baker-name <session> <name>
/baker-spawn <directory> [prompt]
/baker-kill <session>
/baker-clear
```

`/baker-clear` replaces the daemon's Pi session while preserving the registry, Signal bridge, socket, spawned children, and connected members.

## Externally managed signal-cli

To run signal-cli through a service manager instead of pi-baker:

```bash
export PI_BAKER_MANAGE_SIGNAL=false
export PI_BAKER_SIGNAL_URL="http://127.0.0.1:51921"

signal-cli -a "$PI_BAKER_SIGNAL_ACCOUNT" \
  daemon --http 127.0.0.1:51921
```

Then start the Pi daemon separately:

```bash
pi --baker-daemon
```

Health check:

```bash
curl http://127.0.0.1:51921/api/v1/check
```

## LLM orchestration tools

The daemon model receives these guarded tools:

- `baker_sessions`
- `baker_session_status`
- `baker_session_prompt`
- `baker_session_last`
- `baker_session_abort`
- `baker_spawn`
- `baker_kill`
- `baker_signal_send`

The same service layer implements both tools and deterministic Signal commands.

## Security and privacy

- A whitelisted Signal number has full operator power and can cause code execution as the daemon user. Treat it as root access.
- signal-cli binds to loopback only.
- The Unix socket is mode `0600` inside a mode `0700` directory.
- Signal message bodies and injected prompts are not stored by pi-baker.
- Audit events store metadata only and are capped.
- Session transcripts remain in Pi's normal session files.
- Group messages and unsupported payloads are dropped silently.

## Troubleshooting

### Signal messages receive no response

Run this in the daemon TUI:

```text
/baker-status
```

Confirm that the Signal health check and SSE connection are active. Check signal-cli directly:

```bash
curl http://127.0.0.1:51921/api/v1/check
```

After changing extension source, fully restart the daemon rather than relying on `/reload`; process-owned daemon resources intentionally survive session replacement and reload.

### Member does not appear

Run `/baker-status` in the member. Verify that the daemon socket exists:

```bash
ls -l ~/.pi-baker/baker.sock
```

Members retry automatically with exponential backoff.

### Existing daemon error

Only one daemon may own a baker directory. Stop the existing daemon or use a separate `PI_BAKER_DIR` for testing.

## Known limitation

Current Pi versions expose session replacement only to TUI command handlers. Therefore Signal `/clear` cannot safely replace the daemon session; use `/baker-clear` in the daemon TUI instead.

## Development

```bash
nix develop
npm ci
npm run typecheck
npm test
nix flake check
```

Run the opt-in live spawn integration test with:

```bash
PI_BAKER_RUN_LIVE_SPAWN=1 \
  node --test packages/extension/test/spawn-live.test.ts
```

See [`SPEC.md`](./SPEC.md) for the full protocol, registry schema, lifecycle, and milestone specification.
