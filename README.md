# deck

**A terminal-native multi-agent cockpit for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness).**

Many agents, one screen. Zero dependencies. Built for [Ghostty](https://ghostty.org).

Actual output of `npm run preview` (Deck renders its own frames to text, so this
is not a mockup):

```
deck  ● ready  refactor the auth module                                 nvidia · openai/gpt-oss-120b
▎⠸ 1 refactor the auth mo…│
 ⚠ 2 迁移数据库到 Postg… 1│
 ○ 3 write the release no…│
 ✖ 4 benchmark the parser │
                          │
                          │ ▸ Refactor the auth module to use JWT instead of session lookups, and
                          │   update the tests.
                          │ · thought for 4 lines
                          │ I'll start by reading the current auth code, then replace the session
                          │ lookup with token verification.
                          │ ⚙ bash ls -la src/auth
                          │   ok
                          │   session.ts
                          │   token.ts
                          │   middleware.ts
                          │   index.ts
                          │ ⚙ str_replace_editor src/auth/session.ts
                          │   awaiting approval
                          │   [a] allow  [r] reject
                          │ Waiting on that edit before I continue with the middleware ⠸
────────────────────────────────────────────────────────────────────────────────────────────────────
also update the integration tests                                                            queue ⏎
a allow  r reject
```

Session 2 is blocked on an approval you can see without switching to it, and the
footer has already handed the keyboard over to answer it.

## Why

DeepSeek Harness ships a web UI and a headless mode. The web UI is good, but a
browser tab is a strange place to keep six agents you are supervising, and it
cannot reach the things a terminal can do.

Deck borrows its shape from [waku](https://github.com/egoist/waku) — a native
app that treats every coding agent as a driver behind one cockpit — and moves
that idea into the terminal, where the agents already live.

The cockpit is the point. A single-session TUI is a chat window; what actually
costs you time is supervising several agents at once and noticing the one that
stopped and is waiting on you.

## What it does

- **Many sessions, one screen.** Background sessions keep streaming while you
  read another. The sidebar shows what is running, what errored, and — most
  importantly — what is **blocked on your approval**. An agent waiting for a
  permission you cannot see is indistinguishable from a hang.
- **Approvals inline.** `a` allows, `r` rejects, from anywhere, including for a
  background session.
- **Real streaming.** Reasoning, text, and tool calls arrive as deltas. A long
  chain of thought collapses so it never pushes the answer off screen.
- **Self-healing transcripts.** The harness's committed `assistant/message`
  replaces whatever was accumulated from deltas, so a reconnect mid-turn shows
  the true message rather than a truncated one.
- **Terminal-native touches**, each capability-gated and a no-op where
  unsupported: progress in the tab/taskbar while an agent works, a desktop
  notification when an agent needs you, clipboard copy of an answer straight out
  of the terminal, clickable file links, and inline images via the Kitty
  graphics protocol.
- **Your conversation stays in your scrollback.** A full-screen TUI draws on the
  alternate screen and vanishes on exit; Deck writes a compact transcript back to
  the primary screen on quit, with semantic prompt marks so your terminal's
  jump-to-prompt walks between turns.

## Install

Requires Node >= 22.19 and the harness CLI.

```sh
npm i -g @deepseek-ai/dsh   # the agent runtime
npm i -g dsh-deck           # this cockpit
```

## Use

```sh
deck
```

Deck attaches to a `dsh` host on `127.0.0.1:3080` if one is listening, and
otherwise starts one for you and stops it again when you quit.

```sh
deck --attach http://127.0.0.1:3080   # use a host you already run
deck --port 3099 --cwd ~/code/myapp   # different port, different project
deck --no-spawn                       # never start a host
deck --help
```

### Try it with no API key

Deck ships a fake, dependency-free model server, so the whole product is
demoable and testable without credentials:

```sh
npm run fake-llm -- --port 4310
DEEPSEEK_BASE_URL=http://127.0.0.1:4310 DEEPSEEK_API_KEY=fake \
  dsh web --no-open --port 3080
deck
```

Type `tools` to exercise the tool-call path, `slow` to watch the progress
indicator, `long` to test scrolling, `error` to see failure handling.

### Any OpenAI-compatible endpoint

The harness ships a generic adapter, so any OpenAI-compatible provider is
configuration rather than code. Declare a route in `~/.dsh/settings.yaml` —
declaring the models explicitly matters, because the built-in DeepSeek route
defaults to `max_tokens: 256000` and most gateways reject that outright:

```yaml
llm-pi-ai:
  providers:
    nvidia:
      displayName: NVIDIA NIM
      apiKeyEnv: NVIDIA_API_KEY
      api: openai-completions
      baseURL: https://integrate.api.nvidia.com/v1
      compat:
        thinkingFormat: deepseek
        supportsDeveloperRole: false
        maxTokensField: max_tokens
      models:
        - id: openai/gpt-oss-120b
          contextWindow: 131072
          maxTokens: 8192

agent-default-model:
  provider: nvidia
  model: openai/gpt-oss-120b
```

Then `export NVIDIA_API_KEY=…` before starting the host. Verified working this
way against NVIDIA NIM, including multi-step turns with real tool calls.

### See the layout without running it

A TUI is awkward to iterate on and impossible to diff, so Deck can paint one
frame into a character grid and print it:

```sh
npm run preview                                    # synthetic cockpit
npm run preview -- --plain --width 100 --height 28 # no color, for pasting
npm run preview -- --attach http://127.0.0.1:3080  # your real sessions
```

### Keys

Printable characters **always** go to the composer — no letter is ever a
command, so you can type "add tests" without triggering anything.

| Key | |
|---|---|
| `enter` | send (queues behind the running turn) |
| `alt+enter` | send as steering, interrupting the turn |
| `tab` | next session |
| `alt+1`…`alt+9` | jump to a session |
| `ctrl+n` | new session |
| `ctrl+f` | fork the session |
| `ctrl+c` | cancel the running turn, or quit when idle |
| `ctrl+d` | quit |
| `ctrl+y` | copy the last answer |
| `ctrl+e` | expand or collapse tool detail |
| `ctrl+u` / `ctrl+w` | clear draft / delete word |
| `up`/`down`, `pgup`/`pgdn`, `ctrl+l` | scroll |
| `ctrl+g` | help |

When an approval is waiting, the overlay takes the keyboard so answering is one
keystroke: `a`/`y`/`enter` allows, `r`/`n`/`esc` rejects. The footer changes to
show it.

### Environment

| | |
|---|---|
| `DECK_CAPS` | force capabilities, e.g. `+kittyGraphics,-progress` |
| `DECK_THEME=plain` | 16-color theme |
| `DECK_ASCII=1` | ASCII glyphs instead of Nerd Font glyphs |
| `NO_COLOR` | no color |

## How it works

Deck is an **out-of-process client**. It speaks the same `/api` protocol the
harness's own web UI speaks, rather than mounting inside the harness as a Cordis
plugin:

- `POST /api/<method>` for unary calls, in the harness's four-quadrant envelope.
- `ws://…/api/events.mux` and `ws://…/api/events.host` as downlink-only event
  streams. Readiness requires both sockets **and** `host.describe`; if either
  socket dies the whole connection generation is discarded and history is
  refetched, because the harness does not implement stream resume.
- `POST /api/respond`, echoing the host's `rpcId`, to answer an approval.

This is deliberate. The harness's ACP server is explicitly automation-only —
it delivers committed messages and keeps live progress, reasoning, and tool
activity off the wire — so a cockpit built on ACP would be blind between turns.
The Host API is the full-fidelity surface, and upstream calls it out as
reusable by "a future TUI".

```
  ┌──────────────┐   POST /api/<method>    ┌────────────────┐
  │              │ ──────────────────────► │                │
  │     deck     │   ws /api/events.mux    │   dsh  host    │
  │  (this repo) │ ◄────────────────────── │  (unmodified)  │
  │              │   ws /api/events.host   │                │
  └──────────────┘   POST /api/respond     └────────────────┘
```

Internally: `src/protocol` is the transport, `src/model` folds the event log
into a transcript (pure, heavily tested), `src/term` is a standalone
double-buffered cell renderer with the terminal integrations, `src/ui` is
presentation, and `src/ui/app.ts` is the only place that combines them. See
[SPEC.md](SPEC.md) for the module contracts.

**Zero runtime dependencies** — Node's global `fetch` and `WebSocket`,
`Intl.Segmenter` for grapheme clustering, and nothing else. No React, no Ink, no
`string-width`.

## Relationship to other work

DeepSeek deleted its own in-tree TUI before open-sourcing, and
[says so explicitly](https://github.com/deepseek-ai/deepseek-harness/blob/master/.agents/notes/implemented/simplification/2026-08-04-remove-tui-package.md):
"DeepSeek Harness has no terminal UI package." Every terminal client is
community-built, and several already exist:

- [`@deepseek-harness-tui/dsh-tui`](https://github.com/ccch1mneyyy/dsh-TUI) is
  the incumbent — a Claude-Code-style **single-session** TUI on a port of Ink,
  moving very fast. If you want one agent in one window, use it.
- [`@huiliyi37/dsh-tianshu-tui`](https://github.com/huiliyi37/dsh-tianshu-tui)
  has a custom ANSI engine and already does inline Kitty/iTerm2 images.
- [waku](https://github.com/egoist/waku) is the native-app inspiration, with
  drivers for Codex, Claude Code, ACP, OpenCode, Pi, and Amp — but none for
  DeepSeek Harness.

Deck is deliberately a different shape: **out-of-process** and
**multi-session**. That is not just an implementation detail. Every in-process
TUI is a bundle stacked into a profile, so a bad combination can refuse to boot
— installing one into the `web` profile has bricked people with duplicate
service ids. Deck cannot do that: it never mounts into your profile, it talks to
the host over HTTP and WebSockets. Your `dsh` install stays exactly as it was,
and you can run Deck and any of the above side by side against the same host.

## Status

Early. `dsh` itself is a developer preview that warns about breaking changes, and
Deck mirrors a hand-written copy of its wire contract (`src/protocol/contract.ts`)
verified against a live host. Expect to pin versions.

## License

MIT
