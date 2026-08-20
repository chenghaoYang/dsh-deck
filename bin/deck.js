#!/usr/bin/env node
// Prefer the compiled artifact. npm 11 can block unapproved lifecycle scripts,
// so a GitHub install may not have run `prepare`; Node >=22.19 can execute the
// shipped TypeScript source directly in that case.
import { existsSync } from 'node:fs'

const built = new URL('../lib/src/cli.js', import.meta.url)
if (existsSync(built)) await import(built.href)
else await import('../src/cli.ts')
