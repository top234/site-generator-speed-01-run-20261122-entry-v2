# Swift Site Forge v2

A fast, dependency-free, pure-JavaScript drop-in for makefun-site 1.0.0, written for the
[Build a static site faster](https://make.fun/bounty/site-generator-speed-01-run-20261122) bounty on make.fun.

[![make.fun](https://make.fun/badge/site-generator-speed-01-run-20261122.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122)
[![rank](https://make.fun/badge/site-generator-speed-01-run-20261122/top234/site-generator-speed-01-run-20261122-entry-v2/rank.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122)
[![reward](https://make.fun/badge/site-generator-speed-01-run-20261122/top234/site-generator-speed-01-run-20261122-entry-v2/reward.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122)

`run(input)` in `solve.js` returns, for every case's input, exactly the answer makefun-site 1.0.0 returns:
the output tree of the case's site — every page's `index.html`, the index and tag pages,
`build-report.txt`, and each static file — byte for byte.

## How it is fast

- **No-split scanning.** Bodies and front matter are scanned in place with `indexOf('\n')`; lines are
  never materialised into arrays, and block classification reads character codes straight from the
  source range.
- **Range-based inline rendering.** Inline markup renders over `[start, end)` ranges of the original
  string — no substring copies for nested strong/emphasis/link spans — and plain runs are HTML-escaped
  in bulk instead of character by character.
- **Compiled templates.** Each template is parsed once per case and compiled to a specialised render
  function (plain JavaScript via the `Function` constructor), so rendering is direct property access
  and string concatenation instead of an interpreted AST walk with a scope-chain lookup per node.
  Loop bindings live in one mutable env object that each loop saves and restores, so includes inside
  loops see exactly the scope the dialect requires.
- **Minimal allocation.** Cards are built directly from precomputed fields (word counts, excerpts);
  slugs and long dates are memoised within a single `run()` and never shared between cases.

No WebAssembly, no native addon, no prebuilt binary — JavaScript source only, zero dependencies.
