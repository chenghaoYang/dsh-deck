/**
 * Palette and glyphs.
 *
 * Defaults to Catppuccin Mocha because that is what a Ghostty user is most
 * likely already running; `DECK_THEME=plain` drops to 16-color ANSI for
 * terminals without truecolor, and `NO_COLOR` removes styling entirely.
 */

import { rgb, sgr } from '../term/ansi.ts'
import type { TerminalCapabilities } from '../term/capabilities.ts'

export interface Theme {
  base: string
  dim: string
  subtle: string
  text: string
  accent: string
  user: string
  assistant: string
  reasoning: string
  tool: string
  ok: string
  warn: string
  error: string
  running: string
  selected: string
  border: string
  reset: string
}

const MOCHA = {
  base: '#1e1e2e',
  surface1: '#45475a',
  overlay1: '#7f849c',
  subtext0: '#a6adc8',
  text: '#cdd6f4',
  mauve: '#cba6f7',
  blue: '#89b4fa',
  sapphire: '#74c7ec',
  green: '#a6e3a1',
  yellow: '#f9e2af',
  peach: '#fab387',
  red: '#f38ba8',
  lavender: '#b4befe',
}

function hex(value: string): string {
  const n = Number.parseInt(value.slice(1), 16)
  return rgb((n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff)
}

const RESET = sgr(0)

function plainTheme(): Theme {
  return {
    base: '',
    dim: sgr(2),
    subtle: sgr(2),
    text: '',
    accent: sgr(35),
    user: sgr(36),
    assistant: '',
    reasoning: sgr(2),
    tool: sgr(33),
    ok: sgr(32),
    warn: sgr(33),
    error: sgr(31),
    running: sgr(36),
    selected: sgr(7),
    border: sgr(2),
    reset: RESET,
  }
}

function noTheme(): Theme {
  const empty = ''
  return {
    base: empty,
    dim: empty,
    subtle: empty,
    text: empty,
    accent: empty,
    user: empty,
    assistant: empty,
    reasoning: empty,
    tool: empty,
    ok: empty,
    warn: empty,
    error: empty,
    running: empty,
    selected: sgr(7),
    border: empty,
    reset: RESET,
  }
}

export function createTheme(caps: TerminalCapabilities, env: NodeJS.ProcessEnv = process.env): Theme {
  if (env.NO_COLOR !== undefined && env.NO_COLOR !== '') return noTheme()
  if (env.DECK_THEME === 'plain' || !caps.trueColor) return plainTheme()
  return {
    base: hex(MOCHA.base),
    dim: hex(MOCHA.overlay1),
    subtle: hex(MOCHA.subtext0),
    text: hex(MOCHA.text),
    accent: hex(MOCHA.mauve),
    user: hex(MOCHA.blue),
    assistant: hex(MOCHA.text),
    reasoning: hex(MOCHA.overlay1),
    tool: hex(MOCHA.peach),
    ok: hex(MOCHA.green),
    warn: hex(MOCHA.yellow),
    error: hex(MOCHA.red),
    running: hex(MOCHA.sapphire),
    selected: hex(MOCHA.lavender),
    border: hex(MOCHA.surface1),
    reset: RESET,
  }
}

/**
 * Glyphs. Deck's default set assumes a Nerd Font (this project targets Ghostty,
 * and the reference config runs Maple Mono NF CN); `DECK_ASCII=1` falls back to
 * pure ASCII for plain fonts and for piping output somewhere unforgiving.
 */
export interface Glyphs {
  running: string[]
  idle: string
  error: string
  user: string
  assistant: string
  reasoning: string
  tool: string
  approve: string
  hline: string
  vline: string
  corner: { tl: string; tr: string; bl: string; br: string }
  tee: { left: string; right: string; down: string; up: string }
  bar: string
  arrow: string
}

const UNICODE_GLYPHS: Glyphs = {
  running: ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'],
  idle: '○',
  error: '✖',
  user: '▸',
  assistant: '◆',
  reasoning: '·',
  tool: '⚙',
  approve: '⚠',
  hline: '─',
  vline: '│',
  corner: { tl: '╭', tr: '╮', bl: '╰', br: '╯' },
  tee: { left: '├', right: '┤', down: '┬', up: '┴' },
  bar: '▎',
  arrow: '›',
}

const ASCII_GLYPHS: Glyphs = {
  running: ['|', '/', '-', '\\'],
  idle: 'o',
  error: 'x',
  user: '>',
  assistant: '*',
  reasoning: '.',
  tool: '%',
  approve: '!',
  hline: '-',
  vline: '|',
  corner: { tl: '+', tr: '+', bl: '+', br: '+' },
  tee: { left: '+', right: '+', down: '+', up: '+' },
  bar: '|',
  arrow: '>',
}

export function createGlyphs(env: NodeJS.ProcessEnv = process.env): Glyphs {
  return env.DECK_ASCII === '1' ? ASCII_GLYPHS : UNICODE_GLYPHS
}
