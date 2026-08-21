/**
 * Library surface.
 *
 * Deck is primarily a binary, but the transport and the terminal layer are
 * useful on their own: the protocol client is a dependency-free way to drive a
 * DeepSeek Harness host from Node, and the terminal layer is a standalone cell
 * renderer with Ghostty/Kitty integrations and no knowledge of the harness.
 */

export { DeckClient, type DeckClientOptions } from './protocol/client.ts'
export { Connection, type ConnectionEvents, type ConnectionState } from './protocol/connection.ts'
export * from './protocol/contract.ts'

export { applyEvent, applyHistory, emptyTranscript } from './model/fold.ts'
export type { TranscriptItem, TranscriptState, ToolCallEntry, TurnPhase } from './model/fold.ts'
export { DeckStore } from './model/store.ts'
export type { PendingApproval, SessionState, StoreChange } from './model/store.ts'

export { detectCapabilities, type TerminalCapabilities } from './term/capabilities.ts'
export { Screen, type Cell } from './term/screen.ts'
export { TerminalIntegration } from './term/ghostty.ts'
export { InputReader, type Key } from './term/input.ts'
export { graphemeWidth, stringWidth, stripAnsi, truncate, wrap } from './term/width.ts'

export { DeckApp, type DeckAppOptions } from './ui/app.ts'

export {
  HARNESS_IDS,
  buildHarnessOverlay,
  discoverHarnesses,
  formatHarnessList,
  harnessAssistantText,
  type HarnessDiscovery,
  type HarnessId,
  type OverlayPlan,
  type SessionHarness,
} from './harness.ts'
