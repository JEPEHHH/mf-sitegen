# site-generator-speed-01 entry

`solve.js` is a faster drop-in for makefun-site 1.0.0: `run(input)` returns exactly the output tree
makefun-site 1.0.0's `build` returns for that input, byte for byte, computed faster. `main.ts` is the
house driver, unchanged (it reads `/input/cases.json`, answers each case with `run`, writes
`/output/answers.json`). `vendor/makefun-site/` is the reference, kept beside it as the kit ships it.

Everything the answer must be is stated in `vendor/makefun-site/README.md`, and that code is the
answer wherever the README and it disagree. This entry restates that build without changing what it
answers; the rules it follows are the same rules, only run in a cheaper order.

## What is faster, and why it does not change the answer

- **Templates are parsed once per build and compiled to closures.** A layout is rendered by direct
  calls (one writer per node) instead of a switch over a node tree on every page. `{% include %}` is
  bound to its compiled template once, after every template is compiled, so a render never looks a
  name up in a map — the include depth (`8`) and the scope chain are unchanged.
- **Markdown inline runs are escaped in stretches.** The scanner jumps to the next character that can
  mean anything (`\ ` * [ & < > " '`) and escapes whole plain runs at once, where the reference calls
  the escape on one character at a time. Code spans, strong, emphasis, links, backslash escapes and
  the escape table are the same.
- **Each lookup is computed once per build**: the parsed layouts, the set of static paths, each
  source's directory (and its path parts, for link resolution), each slug (titles repeat: the first
  spelling wins, the slug is cached), each long date, a source's reading time (a post's card is built
  twice — once for lists, once for its own page), and the include targets.
- **Text is built as arrays joined once** (template output, Markdown blocks), except an inline run,
  which is measured faster as one rope than as an array of pieces.
- **Word counts are counted, not collected**: no `match(/\S+/g)` array, and `\s` is checked by code
  unit (the same set: TAB, LF, VT, FF, CR, space, NBSP, 1680, 2000-200A, 2028, 2029, 202F, 205F, 3000,
  FEFF).
- **Line dispatch costs one character comparison**: a Markdown block test runs only when the line can
  match it (`#`, `` ` ``, `-`, `*`, `>`, digit, space/tab), and trimming spaces and tabs returns the
  same string when there is nothing to trim.
- **Front matter** finds the closing `---` before it reads a key line (the reference's order), so the
  first reason a source is refused is the same, and takes the body as the rest of the text instead of
  re-joining it line by line.

Nothing is cached from one case to the next: `run` starts with fresh per-build maps.

## Verifying it locally

    node tools/check.mjs            # practice set: solve.js vs practice/reference/expected.json
    node tools/fuzz.mjs --seeds 6   # fresh sites from the kit's own generator, vs makefun-site 1.0.0
    node tools/struct_fuzz.mjs      # random (often malformed) templates/front matter/Markdown bodies
    python3 tools/bench_main.py     # CPU time of `node main.ts`, entry vs the house baseline

`tools/*` read the kit from `/root/work/sitegen/site-generator-speed-01-run-20261122-kit` (set `SG_KIT`
to move it). They are test scaffolding, never imported by `main.ts` or `solve.js`.
