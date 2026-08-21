export {
  HARNESS_IDS,
  HARNESS_SPECS,
  harnessLabel,
  isHarnessId,
  isSessionHarness,
  specOf,
  type HarnessId,
  type HarnessSpec,
  type SessionHarness,
} from './harness/catalog.ts'

export {
  discoverHarnesses,
  formatHarnessList,
  type DiscoverOptions,
  type HarnessDiscovery,
} from './harness/discover.ts'

export {
  buildHarnessOverlay,
  harnessAssistantText,
  prepareOverlayHome,
  spawnHarnessTurn,
  type HarnessTurnResult,
  type ModelSelection,
  type OverlayInput,
  type OverlayPlan,
  type SpawnHarnessOptions,
} from './harness/overlay.ts'
