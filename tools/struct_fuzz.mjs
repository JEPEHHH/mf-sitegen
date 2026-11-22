// Structural fuzz: random (often malformed) templates, front matter and Markdown bodies, compared against
// makefun-site 1.0.0 value by value. node tools/struct_fuzz.mjs [--rounds N]
import { pathToFileURL } from 'node:url';
const KIT = '/root/work/sitegen/site-generator-speed-01-run-20261122-kit';
const base = await import(pathToFileURL(`${KIT}/baselines/makefun-site/solve.js`).href);
const mine = await import(pathToFileURL('/root/work/sitegen/repo/solve.js').href);

let seed = Number(process.argv.includes('--seed') ? process.argv[process.argv.indexOf('--seed') + 1] : 1) >>> 0;
const rnd = () => { seed = (seed * 1103515245 + 12345) >>> 0; return seed / 4294967296; };
const int = (lo, hi) => lo + Math.floor(rnd() * (hi - lo + 1));
const pick = (xs) => xs[int(0, xs.length - 1)];

const TPL_BITS = ['<p>', '</p>', '\n', ' ', 'x', '{{ page.title }}', '{{{ page.content }}}', '{{ title }}', '{{ page.tags }}',
  '{% for t in page.tags %}[{{ t.name }}:{{ loop.index }}:{{ loop.first }}:{{ loop.last }}:{{ loop.length }}]{% endfor %}',
  '{% if page.is_post %}POST{% else %}PAGE{% endif %}', '{% if not page.newer %}NONE{% endif %}', '{% if posts %}P{% else %}Q{% endif %}',
  '{% for p in posts %}{{ p.title }}{{ p.reading_minutes }}{{ p.excerpt }}{% endfor %}',
  '{% for t in tags %}{{ t.slug }}{{ t.count }}{% endfor %}', '{% include "a" %}', '{% include "b" %}', '{% include "nope" %}',
  '{% for x in recent %}{{ x.url }}{% endfor %}', '{{ pager.number }}/{{ pager.total }}', '{{ pager.newer_url }}',
  '{{ site.title }} {{ site.base_url }}', '{% for p in posts %}', '{% endfor %}', '{% endif %}', '{% else %}',
  '{{ tid }}', '{% for t in page.tags %}{% for u in tags %}{{ t.name }}{{ u.slug }}{% endfor %}{% endfor %}',
  '{% include "self" %}', '{{ page.toc }}', '{{ 1 }}', '{', '}', '{% if %}', '{{ .bad }}', '{% include "A" %}'];

const FM_KEYS = ['title', 'date', 'tags', 'draft', 'layout', 'slug', 'summary', 'unknown', 'Title'];
const BODY_BITS = ['plain text', '# Heading', '## Sub *em*', '```js', '```', '---', '***', '> quote', '- item', '* item',
  '1. one', '2) two', '  continued', '**strong**', '*em*', '`code`', '[link](other.md)', '[link](../x.md#frag)',
  '[ext](https://e.x/y)', '[bad](a b)', '& < > " \'', '\\*escaped\\*', 'a_b_c', '<b>html</b>', '####### seven',
  '  indented', '', '', '\t', 'https://x.y', '_em_', '\\\\'];

function template(n) {
  let s = '';
  for (let i = 0; i < n; i++) s += pick(TPL_BITS);
  return s;
}
function body(n) {
  const out = [];
  for (let i = 0; i < n; i++) out.push(pick(BODY_BITS));
  return out.join('\n');
}
function frontMatter() {
  const lines = ['---'];
  const n = int(0, 5);
  for (let i = 0; i < n; i++) {
    const k = pick(FM_KEYS);
    const v = pick(['My Title', '"Quoted \\"x\\""', '"unclosed', '2026-11-09', '2026-13-01', '2026-02-30', '1970-01-01',
      '[a, b]', '[]', '[a,,b]', '["x"]', 'true', 'false', 'yes', 'post', 'page', 'Bad Layout', 'a-slug', 'A Slug',
      'x'.repeat(70), '[Café, cafe culture]', '']);
    lines.push(k === 'unknown' ? `unknown: ${v}` : `${k}: ${v}`);
  }
  lines.push('---');
  return lines.join('\n');
}

let fails = 0;
const STATS = new Map();
const rounds = Number(process.argv.includes('--rounds') ? process.argv[process.argv.indexOf('--rounds') + 1] : 300);
for (let r = 0; r < rounds; r++) {
  const templates = { post: '{{ page.title }}\n{{{ page.content }}}\n', page: '{{ page.title }}\n{{{ page.content }}}\n',
    index: '{% for p in posts %}{{ p.title }}\n{% endfor %}', tag: '{{ tag.name }}', tags: '{% for t in tags %}{{ t.slug }}{% endfor %}' };
  const extra = int(0, 4);
  for (let i = 0; i < extra; i++) templates[pick(['a', 'b', 'self', 'post', 'page', 'z'])] = template(int(1, 8));
  const files = [];
  const nf = int(1, 6);
  for (let i = 0; i < nf; i++) {
    files.push({
      path: pick(['posts/', 'posts/2020/', 'docs/', 'tags/', 'page/', '']) + pick(['a', 'b', 'c', 'x y', 'a']) + pick(['.md', '.md', '.md', '.txt', '.css']),
      content: pick([frontMatter() + '\n' + body(int(0, 6)), body(int(0, 6)), '---\ntitle: X\ndate: 2020-01-01\n---\n',
        '---\ntitle: T\n---\n# H\n\npara\n']),
    });
  }
  const input = { site: { title: pick(['S', 'A & B']), base_url: pick(['https://x.y/', 'https://x.y/blog', 'http://e/']), per_page: pick([1, 2, 3, 10]), recent: pick([0, 1, 2, 5]) }, templates, files };
  const want = base.run(JSON.parse(JSON.stringify(input)));
  const got = mine.run(JSON.parse(JSON.stringify(input)));
  if (process.argv.includes('--stats')) {
    for (const line of String(got['build-report.txt']).split('\n')) {
      if (line === '') continue;
      const key = line.split(':')[0].split(' ').slice(0, 3).join(' ');
      STATS.set(key, (STATS.get(key) ?? 0) + 1);
    }
  }
  const a = JSON.stringify(got), b = JSON.stringify(want);
  if (a !== b) {
    fails++;
    const ka = Object.keys(got), kb = Object.keys(want);
    const onlyA = ka.filter((k) => !(k in want)), onlyB = kb.filter((k) => !(k in got));
    let detail = `keys ${ka.length}/${kb.length} only-got ${onlyA.slice(0, 3)} only-want ${onlyB.slice(0, 3)}`;
    for (const k of ka) if (k in want && got[k] !== want[k]) {
      let i = 0; const A = String(got[k]), B = String(want[k]);
      while (i < A.length && A[i] === B[i]) i++;
      detail = `${k}: ${JSON.stringify(A.slice(Math.max(0, i - 50), i + 50))} vs ${JSON.stringify(B.slice(Math.max(0, i - 50), i + 50))}`;
      break;
    }
    if (fails <= 6) console.log(`round ${r}: ${detail}`);
  }
}
console.log(`${rounds - fails}/${rounds} random structural cases identical`);
if (process.argv.includes('--stats')) {
  for (const [k, v] of [...STATS].sort((x, y) => y[1] - x[1])) console.log(`  ${String(v).padStart(5)}  ${k}`);
}
process.exit(fails === 0 ? 0 : 1);
