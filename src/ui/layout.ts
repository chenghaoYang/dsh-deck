/**
 * Region arithmetic. Pure: takes a viewport size and returns rectangles, so
 * layout is unit-testable without a terminal.
 *
 * Rows and columns are 1-based to match cursor addressing.
 */

export interface Rect {
  row: number
  col: number
  width: number
  height: number
}

export interface Layout {
  columns: number
  rows: number
  header: Rect
  sidebar: Rect | undefined
  transcript: Rect
  composer: Rect
  footer: Rect
  /** True when the viewport is too narrow to show the sidebar beside the transcript. */
  narrow: boolean
}

const MIN_SIDEBAR = 20
const MAX_SIDEBAR = 34
const SIDEBAR_FRACTION = 0.26
/** Below this width the sidebar becomes a toggled overlay instead of a column. */
const NARROW_THRESHOLD = 76

export interface LayoutOptions {
  /** Composer height in rows, grows with a multi-line draft. */
  composerHeight?: number
  /** Hide the sidebar even on a wide viewport. */
  sidebarHidden?: boolean
  /** Reading-column cap used when the single-session sidebar is hidden. */
  contentMaxWidth?: number
}

export function computeLayout(columns: number, rows: number, options: LayoutOptions = {}): Layout {
  const composerHeight = Math.max(1, Math.min(options.composerHeight ?? 1, Math.max(1, rows - 5)))
  const narrow = columns < NARROW_THRESHOLD
  const showSidebar = !narrow && options.sidebarHidden !== true

  const headerHeight = 1
  const footerHeight = 1
  // +1 for the rule between transcript and composer.
  const bodyHeight = Math.max(1, rows - headerHeight - footerHeight - composerHeight - 1)

  const sidebarWidth = showSidebar
    ? Math.max(MIN_SIDEBAR, Math.min(MAX_SIDEBAR, Math.round(columns * SIDEBAR_FRACTION)))
    : 0

  const contentMaxWidth = Math.max(40, options.contentMaxWidth ?? 120)
  const compactContent = options.sidebarHidden === true
  const contentWidth = compactContent ? Math.min(columns, contentMaxWidth) : columns
  const contentCol = compactContent ? 1 + Math.floor((columns - contentWidth) / 2) : 1

  const header: Rect = { row: 1, col: contentCol, width: contentWidth, height: headerHeight }
  const bodyRow = headerHeight + 1

  const sidebar: Rect | undefined = showSidebar
    ? { row: bodyRow, col: 1, width: sidebarWidth, height: bodyHeight }
    : undefined

  // The divider rule sits at sidebarWidth + 1; leaving a blank column after it
  // keeps transcript text from touching the rule.
  const transcriptCol = showSidebar ? sidebarWidth + 3 : contentCol
  const transcript: Rect = {
    row: bodyRow,
    col: transcriptCol,
    width: showSidebar ? Math.max(1, columns - transcriptCol + 1) : contentWidth,
    height: bodyHeight,
  }

  const composerRow = bodyRow + bodyHeight + 1
  const composer: Rect = { row: composerRow, col: contentCol, width: contentWidth, height: composerHeight }
  const footer: Rect = { row: rows, col: contentCol, width: contentWidth, height: footerHeight }

  return { columns, rows, header, sidebar, transcript, composer, footer, narrow }
}

/** The smallest viewport Deck will try to draw. Below this it shows a notice instead. */
export const MIN_COLUMNS = 40
export const MIN_ROWS = 10

export function viewportTooSmall(columns: number, rows: number): boolean {
  return columns < MIN_COLUMNS || rows < MIN_ROWS
}
