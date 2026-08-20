<h1>deck</h1>

**English** · [简体中文](README.zh-CN.md)

**Supervise a whole crew of coding agents from one terminal screen.**

A terminal-native, out-of-process cockpit for
[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness), built for
[Ghostty](https://ghostty.org). Deck attaches to an existing `dsh web` host or
starts one for you, then puts every coding session, approval, question, model,
and mode on one screen. It does not replace the Harness or own your provider
credentials; it is the fast terminal control surface in front of them.

![Deck running in Ghostty](docs/screenshots/dsh-deck-ghostty.png)

[![CI](https://github.com/chenghaoYang/dsh-deck/actions/workflows/ci.yml/badge.svg)](https://github.com/chenghaoYang/dsh-deck/actions/workflows/ci.yml)
![node](https://img.shields.io/badge/node-%3E%3D22.19-brightgreen)
![dependencies](https://img.shields.io/badge/dependencies-0-brightgreen)
![tests](https://img.shields.io/badge/tests-260+-brightgreen)
[![license](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

## Quick start

Prerequisites: macOS or Linux, Node.js 22.19 or newer, and a model credential
supported by DeepSeek Harness.

Harness publishes the newest preview on the `next` tag; Deck is currently
verified with `0.1.0-rc.8`.

```sh
npm i -g @deepseek-ai/dsh@next
npm i -g github:chenghaoYang/dsh-deck
deck --cwd ~/code/my-project
```

`deck` connects to `http://127.0.0.1:3080` when a host is already running. If
not, it starts `dsh web` in the requested working directory and stops that host
when Deck exits. Press `/` for commands, `ctrl+k` for session management, and
`ctrl+g` for help.

If Harness exits before Deck opens, inspect the log path printed by Deck.
Harness rc.8 rejects bootstrap variables such as `NO_PROXY` and
`SSL_CERT_FILE` in a project `.env`; export genuine launch variables from the
shell instead, and keep client certificates in the project-specific variable
its tooling expects.

```
deck  ● ready  refactor the auth module           nvidia · thinkingmachines/inkling · high  standard
▎⠸ 1 refactor the auth mo…│
 ⚠ 2 迁移数据库到 Postg… 1│
 ○ 3 write the release no…│
 ✖ 4 benchmark the parser │
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
also update the integration tests                                                 ⏎ queue · ⌥⏎ steer
a allow  r reject
```

Four agents. Session 1 is streaming, 4 has failed, and **2 is blocked on an
approval you can see without switching to it** — the footer has already handed
the keyboard over so `a` answers it. That frame is the real renderer's output,
printed to text by `npm run preview`, not a mockup.

Deck talks to the harness over the same `/api` protocol its own web UI uses, so
it gets the full-fidelity stream — reasoning deltas, tool calls, approvals,
questions, and the telemetry projections nobody documented.

<table>
<tr><td><b>One screen, many agents</b></td><td>The sidebar stays scoped to the current project; <code>ctrl+k</code> remains the global switcher; <code>ctrl+\</code> is the dashboard — peek and reply without switching.</td></tr>
<tr><td><b>Every dsh mode, one panel</b></td><td><code>ctrl+s</code>: model, reasoning effort, agent preset, permissions, and plan mode.</td></tr>
<tr><td><b>Actually interactive</b></td><td>Click to focus, drag to copy, wheel to scroll, <code>ctrl+k</code> to fuzzy-switch sessions.</td></tr>
<tr><td><b>Terminal-native</b></td><td>Taskbar progress, desktop notifications, prompt marks — each capability-gated. Images open with <code>ctrl+o</code> as a Kitty overlay, not inline in the transcript.</td></tr>
<tr><td><b>Verified on a real terminal</b></td><td>Unit tests, a protocol e2e, and a live PTY run that drives the real binary against a real model.</td></tr>
</table>

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
  permission you cannot see is indistinguishable from a hang. `ctrl+\` opens
  the dashboard: peek the selected agent's latest output, reply without
  switching, dispatch a new session, search (`ctrl+/`), pin (`ctrl+t`), or
  rename (`ctrl+r`). Idle extras fold; `ctrl+x` cancels a running turn or
  archives an idle one.
- **Project identity stays visible.** The header shows
  `project / session title`, so similarly named sessions from different
  workspaces do not lose their context.
- **Approvals inline.** `a` allows, `r` rejects, from anywhere, including for a
  background session.
- **Real streaming.** Reasoning, text, and tool calls arrive as deltas. A long
  chain of thought collapses so it never pushes the answer off screen.
- **Self-healing transcripts.** The harness's committed `assistant/message`
  replaces whatever was accumulated from deltas, so a reconnect mid-turn shows
  the true message rather than a truncated one.
- **Every dsh mode on one panel.** `ctrl+s` switches the model and reasoning
  effort, the agent preset, the permission preset, and plan mode. One-shot
  actions such as `/compact` stay in the slash-command palette. The header
  keeps the safety-relevant modes visible: `read-only`
  and `full-access` get saturated color, because "which permissions is this
  agent running with" is not a question you should have to go looking for.
- **Terminal-native touches**, each capability-gated and a no-op where
  unsupported: progress in the tab/taskbar while an agent works, a desktop
  notification when an agent needs you, clipboard copy of an answer straight out
  of the terminal. Images in a session open with `ctrl+o` as a Kitty graphics
  overlay; they are not drawn inline in the transcript. File paths in tool
  headlines and in user/assistant text (including backtick paths) are OSC 8
  hyperlinks (`DECK_EDITOR_URI` to open them in an editor). `/doctor` reports
  which of these the current terminal actually supports; `/doctor fix` (or `f`
  on that panel) applies in-process repairs such as re-enabling mouse capture
  and filling known-terminal capability flags. It does not rewrite your shell
  rc or upgrade Node.
- **Your conversation stays in your scrollback.** A full-screen TUI draws on the
  alternate screen and vanishes on exit; Deck writes a compact transcript back to
  the primary screen on quit, with semantic prompt marks so your terminal's
  jump-to-prompt walks between turns.

## Install

Requires Node >= 22.19 and the harness CLI.

The newest Harness preview is published on the `next` tag; Deck is currently
verified with `0.1.0-rc.8`.

```sh
npm i -g @deepseek-ai/dsh@next                         # latest preview runtime
npm i -g github:chenghaoYang/dsh-deck                  # this cockpit
```

Not on npm yet. To work on it instead:

```sh
git clone https://github.com/chenghaoYang/dsh-deck && cd dsh-deck
npm install && npm run build && npm link
```

### Make `dsh` open the cockpit

If you would rather never think about `deck` as a separate command, shadow the
bare `dsh` invocation and leave every subcommand alone:

```sh
# ~/.zshrc — `dsh` opens the cockpit; `dsh web`, `dsh plugin`, … still reach the
# real CLI, and `command dsh` always bypasses this.
dsh() {
  if (( $# == 0 )); then command deck; else command dsh "$@"; fi
}
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
demoable and testable without credentials. Run this from a source checkout
(the development-only fake server is not included in the global package):

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
configuration rather than code. Declare a route in `$DSH_HOME/settings.yaml`
(`~/.dsh/settings.yaml` when `DSH_HOME` is unset) —
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
        - id: thinkingmachines/inkling
          name: Inkling (NVIDIA)
          contextWindow: 262144
          maxTokens: 32768
          # Offering the levels is what puts an effort picker in the modes
          # panel; the values are the wire spellings the endpoint expects.
          reasoningEfforts:
            low: low
            medium: medium
            high: high
          compat:
            supportsReasoningEffort: true
        - id: openai/gpt-oss-120b
          contextWindow: 131072
          maxTokens: 8192

agent-default-model:
  provider: nvidia
  model: thinkingmachines/inkling
```

`thinkingFormat: deepseek` is what decodes Inkling's `reasoning_content`, so its
chain of thought streams into the transcript as reasoning rather than answer
text.

Models that advertise reasoning efforts use an explicit two-step picker: choose
the model on step 1/2, then choose the effort and press Return to apply it on
step 2/2.

For the key, either `export NVIDIA_API_KEY=…` before starting the host — a
per-run override, and it wins — or add/update the `NVIDIA_API_KEY` mapping in
`$DSH_HOME/.credentials.yaml` (`~/.dsh/.credentials.yaml` by default), which
is what the harness's own Models page writes. Preserve any existing provider
keys in that file:

```yaml
NVIDIA_API_KEY: nvapi-…
```

Then run `chmod 600 "${DSH_HOME:-$HOME/.dsh}/.credentials.yaml"`; the harness
refuses to boot when the credentials file is readable by other users.

Verified end to end this way against NVIDIA NIM with `thinkingmachines/inkling`:
streamed reasoning, multi-step turns with real tool calls, prompt-cache hits,
and every mode in the panel above.

### See the layout without running it

A TUI is awkward to iterate on and impossible to diff, so Deck can paint one
frame into a character grid and print it:

```sh
npm run preview                                    # synthetic cockpit
npm run preview -- --plain --width 100 --height 28 # no color, for pasting
npm run preview -- --attach http://127.0.0.1:3080  # your real sessions
```

### Verifying it against a real host

Unit tests check the parts and `npm run e2e` checks the protocol, but neither
can tell you the product works: Deck paints by cell diff, so its output is a
stream of cursor moves rather than lines of text. `npm run verify` drives the
real binary on a real pty against a real host, replays that stream back into a
character grid, and asserts on what actually reached the screen — then
cross-checks each mode switch against the host's own projections, so a green
step cannot mean "Deck drew something plausible".

```sh
npm run verify -- --attach http://127.0.0.1:3080          # drive src/
npm run verify -- --attach http://127.0.0.1:3080 --built  # drive the shipped bin
```

It writes every step as a screenshot, which is how the bugs it found were
diagnosed: a header whose title collided with the permission chip, a CJK preset
name that overran the modes panel by four columns and left stale cells behind on
the next frame, harness-injected context rendered as though the user had typed
it, and — only ever reproducible on a real terminal — `ctrl+d` restoring the
terminal and then never exiting, because a resumed tty keeps Node's event loop
alive where a pipe would have hit EOF.

### Keys

Printable characters **always** go to the composer — no letter is ever a
command, so you can type "add tests" without triggering anything. `/vim-mode`
is the exception: Esc enters composer NORMAL (`h`/`l`/`w`/`b`/`x`), Esc again
parks in the transcript (`j`/`k` `g`/`G`), and `i` returns to INSERT.

| Key | |
|---|---|
| `enter` | send (queues behind the running turn) |
| `shift+enter` | newline in the draft |
| `option+return` / `alt+enter` | steer at the next step boundary; does not cancel the turn |
| `tab` | next session |
| `alt+1`…`alt+9` | jump to a session |
| `ctrl+n` | new session |
| `ctrl+s` | modes: model, agent preset, permission, plan |
| `ctrl+p` | model and reasoning effort |
| `ctrl+k` | session manager: search, archive, rename, or create |
| `ctrl+\` | dashboard: peek, reply, dispatch; `ctrl+/` search, `ctrl+t` pin, `ctrl+g` group, `ctrl+r` rename, `ctrl+x` stop |
| `/queue` | visual list of pending messages — edit, remove, or promote to steering |
| `/doctor` | capability report; `/doctor fix` (or `f`) applies in-process repairs |
| `/vim-mode` | composer vim (`i`/`a`/`h`/`l`); Esc Esc parks the transcript (`j`/`k` `g`/`G`) |
| `backspace` / `delete` / `ctrl+d` in session manager | confirm archive when the search box is empty (conversation log is kept) |
| `ctrl+f` | fork the session |
| `esc esc` | rewind: fork at a previous user turn |
| `ctrl+r` | expand or collapse reasoning |
| `ctrl+c` | cancel the running turn, or quit when idle |
| `ctrl+d` | quit |
| `ctrl+y` | copy the last answer |
| `ctrl+o` | open the latest image as a Kitty overlay |
| `ctrl+t` | toggle mouse capture (off = native terminal selection) |
| `ctrl+e` / `cmd+right` when Ghostty maps it to `Ctrl+E` | move to the end of the draft |
| `ctrl+x` | expand or collapse tool detail |
| `option+b` / `option+f` | move one word left / right |
| `ctrl+u` / `ctrl+w` | clear draft / delete word |
| `up`/`down`, `pgup`/`pgdn`, `ctrl+l` | scroll |
| `ctrl+g` | help |
| `/` | live slash-command palette; type to filter, Tab completes |

On macOS, set `macos-option-as-alt = true` in Ghostty to use Option-based
bindings such as Option+Return and Option+B/F. Ghostty reserves Command+Return
for fullscreen by default, so that chord does not reach Deck. If your Ghostty
config maps Command+Right to `Ctrl+E` and Command+Backspace to `Ctrl+U`, Deck
treats them as end-of-draft and clear-draft respectively. Forward Delete is
`Fn+Delete` on a Mac keyboard. `Ctrl+C` closes the active modal first; press it
again to cancel a running turn or exit while idle.

When an approval is waiting, the overlay takes the keyboard so answering is one
keystroke: `a`/`y`/`enter` allows, `r`/`n`/`esc` rejects. The footer changes to
show it.

### Modes

`ctrl+s` opens one panel over the transcript:

```
╭─ modes ──────────────────────────────────────────────────────╮
│› model      nvidia · inkling · high                          │
│  agent      标准模式 locked once the session has run a turn  │
│  permission workspace-write                                  │
│  plan       off                                              │
│↑↓ move · ⏎ change · esc close                                │
╰──────────────────────────────────────────────────────────────╯
```

`enter` on a row lists its options and `enter` again applies it; the panel stays
open and the row shows its new value, so adjusting two things is two keystrokes
rather than two trips. Clicking works too. Names come from the host, so a
Chinese-locale harness shows `标准模式` rather than `standard`.

Rows say what they cannot do instead of failing later: the agent preset is
`locked once the session has run a turn`, because that is when the harness stops
accepting the change. Permission and plan are read back from the host's own
projections, so the panel reflects what the agent is actually running under —
including a change someone made from the web UI.

| Row | Reaches the host as |
|---|---|
| model | `session.selectModel`, with the model's own reasoning efforts |
| agent | `agentPreset.select`, blank sessions only |
| permission | `/permission <preset>` |
| plan | `/plan` and `/plan off` |

### Slash commands

Type `/` to open a command palette above the composer. The list combines Deck's
terminal-native actions with the commands the connected dsh host advertises for
the focused session, so optional plugins appear without a Deck update. Use
`up`/`down` to move, `tab` to complete, `enter` to run, and `esc` to return the
filter to the composer.

Deck provides `/model`, `/effort`, `/modes`, `/preset`, `/permissions`,
`/sessions`, `/resume`, `/archive`, `/new`, `/clear`, `/rename`, `/fork`,
`/rewind`,
`/cancel`, `/interrupt`, `/dashboard`, `/queue`, `/dequeue`, `/steer-queued`,
`/doctor` (`/doctor fix`), `/vim-mode`, `/status`,
`/context`, `/cost`, `/tokens`, `/search`, `/skills`, `/agents`,
`/interrupt-agent`, `/workspaces`, `/help`, and `/exit` (`/q`). A standard dsh host
currently adds commands such as `/compact`,
`/export`, `/feedback`, `/goal`, `/permission`, and `/plan`; the palette always
uses the host's live catalog rather than assuming they are installed.

Common control paths map to real Host APIs: cancel interrupts the focused turn;
queue commands open a visual list (edit in place, `d` remove, `s` steer) or still take an id; search uses
`session.search` and falls back to local title/cwd filtering when the server-side
index is unavailable; skills and subagents are scoped to the focused session.
Continuable subagent sessions use the dedicated subagent history, prompt, and
interrupt RPCs, while one-shot subagents remain read-only.

Commands with arguments complete back into the composer. For example, choose
`/plan`, type `off`, and press Enter. Deck sends `/plan off` through
`commands/execute`; it is never mistaken for a model prompt.

### Mouse

Pasting a filesystem path to a `.png` / `.jpg` / `.gif` / `.webp` file attaches
it to the next prompt (sent as an image content part). Copy uses the OS
clipboard when one is available (`pbcopy`, `wl-copy`/`xclip`, or `clip`) and
always also writes OSC 52.

Mouse capture is on by default: click a sidebar session to focus it, scroll the
transcript with the wheel, and drag to select text — the selection is copied on
release, through the OS clipboard *and* OSC 52, so it survives both a strict
terminal and an SSH hop. Shift+drag is ignored by Deck so the terminal can keep
native selection where the emulator withholds shift-clicks; `ctrl+t` turns
mouse capture off entirely. `ctrl+k` opens the session manager: type to
filter; with an empty filter, Backspace/Delete/`^d` opens an archive
confirmation, `^r` renames, and `^n` creates a session. Archiving hides the
session from Deck but deliberately keeps its conversation log on disk.

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
- [waku](https://github.com/egoist/waku) is the native-app inspiration: every
  coding agent is a driver behind one cockpit. As of 0.0.13 it has a DeepSeek
  Harness driver (`driver/deepseek.rs`) alongside Codex, Claude Code, ACP,
  OpenCode, Pi, and Amp. Deck does not replace Waku for multi-harness desktop
  users. Deck's remaining distinction is that it is **terminal-native**, an
  **out-of-process** client of an unmodified `dsh web` host, and uses Ghostty
  OSC rather than embedding the harness.

Deck is deliberately a different shape from the in-process TUIs: **out-of-process**
and **multi-session**. That is not just an implementation detail. Every in-process
TUI is a bundle stacked into a profile, so a bad combination can refuse to boot
— installing one into the `web` profile has bricked people with duplicate
service ids. Deck cannot do that: it never mounts into your profile, it talks to
the host over HTTP and WebSockets. Your `dsh` install stays exactly as it was,
and you can run Deck and any of the above side by side against the same host.

## Status

Early, but not untested. Unit tests, a protocol e2e against a real throwaway
host, and a live PTY run that drives the shipped binary. Last
verified against `dsh` 0.1.0-rc.8 and `thinkingmachines/inkling` on NVIDIA NIM.

`dsh` itself is a developer preview that warns about breaking changes, and Deck
mirrors a hand-written copy of its wire contract
([`src/protocol/contract.ts`](src/protocol/contract.ts)) verified against a live
host, so expect to pin versions. Every shape in there was confirmed on the wire
rather than read off a type — including a few the harness does not document, like
the telemetry projections behind the context and throughput readouts.

Issues and PRs welcome, particularly reports from terminals other than Ghostty:
every integration is capability-gated and degrades to a no-op, but "degrades
cleanly" is a claim that wants more terminals than one person owns.

## License

MIT
