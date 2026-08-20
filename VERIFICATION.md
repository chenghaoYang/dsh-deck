# Deck verification

Live `approval/requested` and `question/requested` frames were captured against
`dsh` **0.1.0-rc.7** (globally installed) driven by the bundled fake-llm. No
real API key. The user's `~/.dsh` and the host already listening on **3080**
were not touched.

Integrator: add this to `package.json` scripts (this module does not own that file):

```json
"e2e": "node --experimental-strip-types scripts/e2e.mjs"
```

Also add `LICENSE` (and optionally `VERIFICATION.md` / `scripts`) to `files` if
they should ship in the published tarball.

## Re-run

```sh
node --experimental-strip-types scripts/e2e.mjs
```

Requires Node `>= 22.19`, a `dsh` on `$PATH`, and free ports in `3090+` /
`4320+`. Total runtime is ~12–15s once the web profile has been initialized in
a throwaway `$DSH_HOME` (first-ever `dsh web` on a machine can take longer).
Exit `0` on pass, `1` on fail. Ran **twice back-to-back**; both passed. After
exit, `lsof` on the e2e ports is empty and `ps` shows only the user's existing
`dsh web --port 3080`.

## Isolation

Every host the e2e starts is launched with:

| env | value |
|---|---|
| `DSH_HOME` | `$(mktemp -d)/dsh-e2e` |
| `DSH_AGENTS_HOME` | sibling `agents/` under the same temp root |
| `DEEPSEEK_BASE_URL` | the in-process fake-llm (`127.0.0.1:4320+`) |
| `DEEPSEEK_API_KEY` | `fake` |
| `DSH_CORDIS_CONFIG` / `DSH_PERMISSION_MODE` | unset |

`packages/util/home-paths` resolves `$DSH_HOME` before `~/.dsh`. Sessions and
the auto-initialized `web` profile land only under the temp home. `~/.dsh` and
`~/.dsh/settings.yaml` mtimes were unchanged across both e2e runs. Cleanup
kills only the child we spawned (and any leftover listener on **our** ports);
port **3080** is never bound or signalled.

`dsh web --port` honors the flag. fake-llm and the host bind `127.0.0.1` only.

## What was verified

1. **fake-llm** — `GET /health`, and keyword scenarios `default` / `tools` /
   `long` / `error` plus the new `escalate` / `ask`. Title-only auxiliary
   calls never emit tools. `npm run fake-llm` still prints the attach command.
2. **Host readiness** — both sockets plus `host.describe` (e2e uses
   `DeckClient` + a mux WebSocket, matching the crib in `/tmp/deck-e2e-real.mjs`).
3. **Tools turn** — prompt `tools please` produces
   `turn/start` → `assistant/chunk` (`reasoning-delta` **and** `tool-call-delta`)
   → `tool/call` → `tool/result` → `assistant/message` → `turn/end`
   `{kind:"completed"}`. `ls -la` auto-runs under default `workspace-write`;
   no approval frame.
4. **Live approval (route a: escalation args)** — prompt `escalate please`
   emits bash with `sandbox_permissions: "danger-full-access"` + `justification`.
   That is the only strictly-wider target from the default `workspace-write`
   mode (`packages/sandbox/sandbox/src/escalation.ts`). The host publishes
   `approval/requested`; `POST /api/respond` with
   `{sessionId, approvalId, outcome:"allowed-once"}` yields `approval/resolved`
   and a completed turn. A second session with `outcome:"rejected"` yields
   `approval/resolved` `{outcome:"rejected"}`; the tool result is
   `Error: the user rejected escalating this command to "danger-full-access"`.
   Route **b** (`/permission` preset) was not needed.
5. **Live question** — prompt `ask please` emits `ask_user_question` with two
   options and `multi_select: false`. Mux frame uses `multiSelect: false`.
   Answer `{sessionId, answer:{answers:[{id, selected:[label]}]}}` yields
   `question/resolved` `{outcome:"answered", questionRpcId: <echoed rpcId>}`.
   fake-llm then receives a follow-up whose tool message is
   `{"answers":[{"id":"q_proceed","selected":["Continue"]}]}`.
6. **`GET /api/events.mux`** → **426** (WebSocket-only; no SSE fallback).
7. **`--version`** — `src/cli.ts` already reads `package.json` via
   `packageVersion()` and prints `dsh-deck 0.1.0`. It is not hardcoded. This
   module does not own `src/cli.ts`.

## Recorded frames (trimmed)

Shapes below are from the second back-to-back pass. Ids change every run;
fields do not.

### `approval/requested` (allow)

```json
{
  "type": "server-request",
  "rpcId": "cedc0597-40e9-4880-95ef-0af880b944f9",
  "method": "approval/requested",
  "payload": {
    "type": "approval/requested",
    "sessionId": "session-58bfc794-498c-41ff-b019-7951b58d234e",
    "approvalId": "7a509acf-b263-4220-afe9-2c6da648386b",
    "toolName": "bash",
    "callId": "call_fake_escalate",
    "reason": "escalate sandbox to danger-full-access: Need full access to retry a command the workspace-write sandbox would deny outside the workspace."
  }
}
```

Respond (`POST /api/respond`), echoing the host's `rpcId`:

```json
{
  "type": "client-response",
  "rpcId": "cedc0597-40e9-4880-95ef-0af880b944f9",
  "result": {
    "ok": true,
    "value": {
      "sessionId": "session-58bfc794-498c-41ff-b019-7951b58d234e",
      "approvalId": "7a509acf-b263-4220-afe9-2c6da648386b",
      "outcome": "allowed-once"
    }
  }
}
```

Then `approval/resolved`:

```json
{
  "type": "approval/resolved",
  "sessionId": "session-58bfc794-498c-41ff-b019-7951b58d234e",
  "approvalId": "7a509acf-b263-4220-afe9-2c6da648386b",
  "outcome": "allowed-once"
}
```

Reject is the same envelope with `outcome: "rejected"` on both the respond
payload and the resolved frame. `ApprovalResponsePayload` in `contract.ts`
matches the live respond body.

### `question/requested`

```json
{
  "type": "server-request",
  "rpcId": "4f37f577-d341-49b9-8319-2c1b5a8e5bdf",
  "method": "question/requested",
  "payload": {
    "type": "question/requested",
    "sessionId": "session-26c47f0d-8d21-4b4a-8970-377ae1cedd92",
    "questions": [
      {
        "id": "q_proceed",
        "question": "Should the agent continue after this checkpoint?",
        "header": "Confirm",
        "options": [
          { "label": "Continue", "description": "Proceed with the remaining work." },
          { "label": "Stop", "description": "Stop here and wait." }
        ],
        "multiSelect": false
      }
    ]
  }
}
```

Respond:

```json
{
  "type": "client-response",
  "rpcId": "4f37f577-d341-49b9-8319-2c1b5a8e5bdf",
  "result": {
    "ok": true,
    "value": {
      "sessionId": "session-26c47f0d-8d21-4b4a-8970-377ae1cedd92",
      "answer": { "answers": [{ "id": "q_proceed", "selected": ["Continue"] }] }
    }
  }
}
```

Then `question/resolved`:

```json
{
  "type": "question/resolved",
  "sessionId": "session-26c47f0d-8d21-4b4a-8970-377ae1cedd92",
  "questionRpcId": "4f37f577-d341-49b9-8319-2c1b5a8e5bdf",
  "outcome": "answered"
}
```

**`QuestionResponsePayload` matches `contract.ts`.** Do not change the
contract for the respond body. The model-facing tool argument is `multi_select`
(snake); the mux frame is `multiSelect` (camel). `AskUserQuestionItem` already
describes the mux shape.

Follow-up the model actually received (fake-llm log):

```json
[{"role":"tool","tool_call_id":"call_fake_ask","content":"{\"answers\":[{\"id\":\"q_proceed\",\"selected\":[\"Continue\"]}]}"}]
```

## Contract / store mismatches the integrator must fix

These are live facts. `contract.ts` / `store.ts` / `package.json` were not edited.

1. **`DeckStore` drops questions.** `applyMux` handles `approval/requested` and
   `approval/resolved` but **returns without state** on `question/requested` and
   `question/resolved`. There is no `pendingQuestion` (contrast `pendingApproval`).
   The UI cannot show or answer a live question until the store keeps
   `{rpcId, sessionId, questions}` and the shell posts `/api/respond` with
   `QuestionResponsePayload`.
2. **`host.describe.home` is the OS homedir**, not `$DSH_HOME`. Upstream
   `api-proxy.ts` sets `home: homedir()` for the Web breadcrumb. Isolation
   still works; do not treat `describe.home === ~/.dsh` (or `$DSH_HOME`) as a
   readiness check. `describe.cwd` is the host process cwd.
3. **`host.describe.version` is `0.0.1`**, not the CLI's `0.1.0-rc.7`. The
   field is the host-app package version.
4. **`package.json` has no `e2e` script** and `files` does not yet list
   `LICENSE`. Commands are above.

No respond-payload mismatch was found for approvals or questions.

## Surprising dsh behaviour

- `approval/policy` is `{policy:"ask"}` on a default session, yet ordinary
  `bash` (`ls -la`) **auto-runs** under `workspace-write`. Out-of-workspace
  writes are **denied**, not prompted. The only deterministic mux
  `approval/requested` path observed is bash **escalation**:
  `sandbox_permissions` + `justification`, requesting a **strictly wider**
  mode (`danger-full-access` when standing mode is `workspace-write`).
  `reason` on the frame is
  `escalate sandbox to <mode>: <justification>`.
- The last user-role message on every turn is a **runtime-context snapshot**
  (`Current runtime context. This snapshot supersedes…`) that itself contains
  the sentence `Approval policy: ask`. Keyword scenario detection must ignore
  that snapshot or every prompt becomes `ask`.
- `user/message` fires twice per prompt (human text + runtime context), as
  SPEC already noted.
- A parallel `session/title-llm-request` hits the same model endpoint. If that
  call emits `tool_calls`, title generation fails. fake-llm answers title
  requests with plain text.
- After `allowed-once`, the escalated command **runs** (we used `echo`, not a
  write). After `rejected`, nothing runs and the model sees the rejection
  error as a tool result; the turn still ends `completed`.
- Presets (`read-only` / `workspace-write` / `danger-full-access`) change the
  sandbox mode and the ask/never **policy**, but they do not make ordinary
  bash prompt. `/permission` was not required.

## e2e pass output (second of two consecutive runs)

```
PASS  start fake-llm — http://127.0.0.1:4320
PASS  start dsh web --no-open — http://127.0.0.1:3090
PASS  host.describe — version=0.0.1 home=/Users/yangchenghao model=deepseek-v4-flash
PASS  tools sequence — turn/start → reasoning-delta + tool-call-delta → tool/call → tool/result → assistant/message → turn/end completed
PASS  approval allow — rpcId=cedc0597-40e9-4880-95ef-0af880b944f9 route=escalate-args
PASS  approval reject — rpcId=f8a1251d-fa40-4931-ac52-e14d394dbf28
PASS  question answer — rpcId=4f37f577-d341-49b9-8319-2c1b5a8e5bdf selected=Continue
PASS  GET /api/events.mux → 426
PASS  cleanup host port — 3090
PASS  cleanup llm port — 4320
PASS  all steps
elapsed 12268ms
```

First run in the same pair: `elapsed 13212ms`, also `PASS  all steps`.
