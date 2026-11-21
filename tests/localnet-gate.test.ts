/**
 * Tests for the release gate (`.github/localnet-gate.mjs`).
 */
// The release gate that keeps a red localnet suite from reaching npm (F24). Run through its CLI, the
// way the publish workflow runs it: JSON on stdin, TAG_SHA in the environment, exit code as verdict.
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/** The gate script, run as a child process exactly as the publish workflow runs it. */
const SCRIPT = fileURLToPath(new URL('../.github/localnet-gate.mjs', import.meta.url))
// The tagged commit and another commit (40-hex placeholders), and a timestamp helper.
const TAG = 'a'.repeat(40)
const OTHER = 'b'.repeat(40)
/** An ISO timestamp `h` hours in the past. */
const hoursAgo = (h: number) => new Date(Date.now() - h * 3_600_000).toISOString()

/** One workflow run, in the shape `gh run list --json` produces. */
interface Run {
  /** The run's result (`success`, `failure`, …). */
  conclusion: string
  /** The commit the run tested. */
  headSha: string
  /** When it started (ISO). */
  createdAt: string
  /** Where to read it. */
  url: string
  /** What triggered it. */
  event: string
}
/** A scheduled run with the given result, commit and age in hours. */
const run = (conclusion: string, headSha: string, h: number): Run => ({
  conclusion,
  headSha,
  createdAt: hoursAgo(h),
  url: `https://example.test/runs/${conclusion}-${h}`,
  event: 'schedule',
})

/** Run the gate with `runs` on stdin (or a raw `stdin`), `TAG_SHA` set, and a minimal environment; returns the exit code and both streams. */
function gate(runs: unknown, env: Record<string, string> = {}, stdin?: string) {
  const r = spawnSync(process.execPath, [SCRIPT], {
    input: stdin ?? JSON.stringify(runs),
    env: { PATH: process.env.PATH ?? '', TAG_SHA: TAG, ...env },
    encoding: 'utf8',
  })
  return { code: r.status, out: r.stdout, err: r.stderr }
}

describe('localnet release gate', () => {
  it('passes on a recent green run on main, and says it is not for the tagged commit', () => {
    const r = gate([run('success', OTHER, 5)])
    expect(r.code).toBe(0)
    expect(r.out).toContain('no run exists for the tagged commit')
  })

  it('blocks when the newest conclusive run on main is red, even if an older one was green', () => {
    const r = gate([run('failure', OTHER, 2), run('success', OTHER, 30)])
    expect(r.code).toBe(1)
    expect(r.err).toContain('RED')
  })

  it('ignores cancelled and skipped runs', () => {
    expect(gate([run('cancelled', OTHER, 1), run('skipped', OTHER, 2), run('success', OTHER, 6)]).code).toBe(0)
    const none = gate([run('cancelled', OTHER, 1)])
    expect(none.code).toBe(1)
    expect(none.err).toContain('no completed localnet run')
  })

  it('blocks when there is no run at all', () => {
    expect(gate([]).code).toBe(1)
  })

  it('blocks a green run older than the limit (a paused schedule must not vouch forever)', () => {
    const r = gate([run('success', OTHER, 100)])
    expect(r.code).toBe(1)
    expect(r.err).toContain('old')
    expect(gate([run('success', OTHER, 100)], { MAX_AGE_HOURS: '200' }).code).toBe(0)
  })

  it('judges the tagged commit by its own run when one exists', () => {
    const red = gate([run('failure', TAG, 1), run('success', OTHER, 2)])
    expect(red.code).toBe(1)
    expect(red.err).toContain('tagged commit')
    // an old green run for the exact commit is still that commit's verdict (age matters only for main)
    const green = gate([run('success', TAG, 200), run('failure', OTHER, 1)])
    expect(green.code).toBe(0)
    expect(green.out).toContain('green for the tagged commit')
  })

  it('refuses malformed input', () => {
    expect(gate(null, {}, 'not json').code).toBe(1)
    expect(gate({ not: 'an array' }).code).toBe(1)
  })
})
