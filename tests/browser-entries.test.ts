// The browser-facing entries (".", "./flow", "./http") must not reach a Node built-in: a browser bundler resolves every import it can
// see, even a dynamic one that never runs there (0.0.34 moved `uploadLocalFile` into "./node" for this reason). The graph is walked
// over the source files, following relative imports (static, `export … from` and `import('./x.js')`).
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const src = (name: string) => fileURLToPath(new URL(`../src/${name}`, import.meta.url))
const SPECIFIER = /(?:from\s+|import\s*\(\s*|import\s+)['"]([^'"]+)['"]/g

function graph(entry: string): { files: Set<string>; nodeImports: string[] } {
  const files = new Set<string>()
  const nodeImports: string[] = []
  const queue = [entry]
  while (queue.length) {
    const file = queue.pop()!
    if (files.has(file)) continue
    files.add(file)
    const text = readFileSync(src(file), 'utf8')
    for (const [, spec] of text.matchAll(SPECIFIER)) {
      if (spec!.startsWith('node:')) nodeImports.push(`${file} → ${spec}`)
      else if (spec!.startsWith('./')) queue.push(spec!.replace(/^\.\//, '').replace(/\.js$/, '.ts'))
    }
  }
  return { files, nodeImports }
}

describe('browser entries', () => {
  for (const entry of ['index.ts', 'flow.ts', 'http.ts']) {
    it(`${entry} reaches no node: import`, () => {
      const { files, nodeImports } = graph(entry)
      expect(files.size).toBeGreaterThan(0)
      expect(nodeImports).toEqual([])
    })
  }

  it('the Node entry is the only module that imports from node:', () => {
    const { nodeImports } = graph('node.ts')
    expect(nodeImports).toEqual(['node.ts → node:fs/promises'])
  })

  it('the walker can see a node: import (the check is not vacuous)', () => {
    const { files } = graph('node.ts')
    expect(files.has('upload.ts')).toBe(true)
  })
})
