// solve.js — a faster drop-in for makefun-site 1.0.0, make.fun's own reference program of site-generator-speed-01.
//
// run(input) returns makefun-site 1.0.0's answer for one case: its build's output tree, byte for byte, computed
// faster. Every rule is makefun-site's own, stated in vendor/makefun-site/README.md (its code is the reference
// wherever the two differ). This module restates that build for speed, without changing what it answers:
//
//   * every template is parsed once per build and compiled to a closure, so a page's layout is rendered by direct
//     calls instead of a switch over a node tree;
//   * an inline Markdown run is escaped in whole stretches (one replace per plain run) instead of one call per
//     character, and the inline scanner jumps to the next character that can mean anything;
//   * each per-build lookup is computed once: the parsed layouts, the static paths, each source's directory and its
//     path parts, each slug (titles repeat) and each long date;
//   * text is accumulated in arrays and joined once, and a file is read from the case's files exactly once.
//
// Nothing is cached from one case to the next: build() starts with fresh maps, as the rules require.

/* ---------------------------------------------------------------- the text rules (lib/text.js) */

/** The HTML escape table, in this order: & < > " ' (README.md). */
const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const escapeChar = (c) => ESCAPES[c];
const HTML_SPECIALS = /[&<>"']/g;

/** `text` with & < > " and ' escaped. */
function escapeHtml(text) {
  return text.replace(HTML_SPECIALS, escapeChar);
}

const SLUG_MAX = 64;
const COMBINING = /\p{M}/gu;

/**
 * The slug of `text`: NFKD, combining marks dropped, A-Z lowered, every run of characters other than a-z and 0-9 one
 * "-", none at either end, at most SLUG_MAX characters (a "-" left at the cut dropped), and "untitled" when nothing
 * is left. ASCII text takes a fast path: NFKD and the combining-mark strip cannot touch it.
 */
function slugify(text) {
  let out = '';
  let gap = false;
  const n = text.length;
  for (let i = 0; i < n; i++) {
    const c = text.charCodeAt(i);
    if (c > 127) return slugifyUnicode(text);
    let keep = null;
    if (c >= 65 && c <= 90) keep = String.fromCharCode(c + 32);
    else if ((c >= 97 && c <= 122) || (c >= 48 && c <= 57)) keep = text[i];
    if (keep === null) {
      gap = out.length > 0;
      continue;
    }
    if (gap) {
      out += '-';
      gap = false;
    }
    out += keep;
  }
  out = out.slice(0, SLUG_MAX).replace(/-+$/, '');
  return out === '' ? 'untitled' : out;
}

/** The same slug for text outside ASCII, exactly as the reference writes it. */
function slugifyUnicode(text) {
  const plain = text.normalize('NFKD').replace(COMBINING, '');
  let out = '';
  let gap = false;
  for (const ch of plain) {
    let keep = null;
    if (ch >= 'A' && ch <= 'Z') keep = ch.toLowerCase();
    else if ((ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9')) keep = ch;
    if (keep === null) {
      gap = out.length > 0;
      continue;
    }
    if (gap) out += '-';
    gap = false;
    out += keep;
  }
  out = out.slice(0, SLUG_MAX).replace(/-+$/, '');
  return out === '' ? 'untitled' : out;
}

/** `slug` made unique against `taken` (and added to it): the first of slug, slug-2, slug-3 ... not taken. */
function uniqueSlug(slug, taken) {
  let out = slug;
  for (let n = 2; taken.has(out); n++) out = `${slug}-${n}`;
  taken.add(out);
  return out;
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** A YYYY-MM-DD date in words, from the string alone: "2026-11-09" is "9 November 2026". */
function longDate(date) {
  const hit = LONG_DATES.get(date);
  if (hit !== undefined) return hit;
  const [y, m, d] = date.split('-');
  const out = `${Number(d)} ${MONTHS[Number(m) - 1]} ${y}`;
  LONG_DATES.set(date, out);
  return out;
}

/* ------------------------------------------------------- the front matter (lib/frontmatter.js) */

/** The keys a source's front matter may give. */
const KEYS = new Set(['title', 'date', 'tags', 'draft', 'layout', 'slug', 'summary']);

const FM_LINE = /^([a-z_]+):(?: (.*))?$/;
const FM_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const FM_NAME = /^[a-z0-9-]+$/;
const FM_SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const FM_TAG = /^[^"[\]]+$/;
const FM_BLANK = /^[ \t]*$/;

/** The days of month `m` (1-12) of year `y`, by the Gregorian rule. */
function daysIn(y, m) {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return [4, 6, 9, 11].includes(m) ? 30 : 31;
}

/** A string value: "..." with \" and \\ its only escapes, or bare, the rest of the line (never opening on " or [). */
function stringOf(raw) {
  if (raw.startsWith('"')) {
    if (raw.length < 2 || !raw.endsWith('"')) return { error: 'a quoted string is not closed' };
    let out = '';
    for (let i = 1; i < raw.length - 1; i++) {
      const c = raw[i];
      if (c === '\\') {
        const n = raw[i + 1];
        if ((n !== '"' && n !== '\\') || i + 1 === raw.length - 1) return { error: 'a quoted string holds an escape other than \\" or \\\\' };
        out += n;
        i++;
      } else if (c === '"') return { error: 'a quoted string holds a stray quote' };
      else out += c;
    }
    return { value: out };
  }
  if (raw.startsWith('[')) return { error: 'a bare string opens on [' };
  return { value: raw };
}

/** One key's value, or why it is refused. */
function valueOf(key, raw) {
  switch (key) {
    case 'title':
    case 'summary': {
      const s = stringOf(raw);
      return 'error' in s ? { error: `key "${key}": ${s.error}` } : s;
    }
    case 'date': {
      const m = FM_DATE.exec(raw);
      const y = m ? Number(m[1]) : 0;
      const mo = m ? Number(m[2]) : 0;
      const d = m ? Number(m[3]) : 0;
      if (!m || y < 1970 || y > 2099 || mo < 1 || mo > 12 || d < 1 || d > daysIn(y, mo)) return { error: 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };
      return { value: raw };
    }
    case 'tags': {
      if (!raw.startsWith('[') || !raw.endsWith(']')) return { error: 'key "tags": not a list [a, b]' };
      const inner = raw.slice(1, -1);
      if (inner.trim() === '') return { value: [] };
      const tags = inner.split(',').map((t) => t.trim());
      if (tags.some((t) => t === '' || !FM_TAG.test(t))) return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
      return { value: tags };
    }
    case 'draft':
      return raw === 'true' ? { value: true } : raw === 'false' ? { value: false } : { error: 'key "draft": true or false' };
    case 'layout':
      return FM_NAME.test(raw) ? { value: raw } : { error: 'key "layout": not a template name' };
    case 'slug':
      return FM_SLUG.test(raw) && raw.length <= 64 ? { value: raw } : { error: 'key "slug": not a slug' };
    default:
      return { error: `unknown key "${key}"` };
  }
}

/**
 * A source's front matter and body: { data, body }, or { error } with the first reason it is refused. `text` has "\n"
 * line ends. The closing "---" is found before any key line is read (the reference's order), and the body is taken as
 * the rest of the text, never re-joined line by line.
 */
function parseFrontMatter(text) {
  if (!text.startsWith('---\n') && text !== '---') return { error: 'no front matter' };
  const len = text.length;
  let closeStart = -1;
  let bodyStart = len;
  let p = 4;
  while (p <= len) {
    const nl = text.indexOf('\n', p);
    const end = nl === -1 ? len : nl;
    if (end - p === 3 && text.charCodeAt(p) === 45 && text.charCodeAt(p + 1) === 45 && text.charCodeAt(p + 2) === 45) {
      closeStart = p;
      bodyStart = nl === -1 ? len : nl + 1;
      break;
    }
    if (nl === -1) break;
    p = nl + 1;
  }
  if (closeStart === -1) return { error: 'the front matter is not closed' };
  const data = {};
  let lineStart = 4;
  let i = 1;
  while (lineStart < closeStart) {
    const nl = text.indexOf('\n', lineStart);
    const end = nl === -1 || nl > closeStart ? closeStart : nl;
    const line = text.slice(lineStart, end);
    if (!FM_BLANK.test(line) && !line.startsWith('#')) {
      const m = FM_LINE.exec(line);
      if (!m) return { error: `line ${i + 1} is not "key: value"` };
      const key = m[1];
      const raw = (m[2] ?? '').replace(/[ \t]+$/, '');
      if (!KEYS.has(key)) return { error: `unknown key "${key}"` };
      if (Object.hasOwn(data, key)) return { error: `key "${key}" is given twice` };
      if (raw === '') return { error: `key "${key}" has no value` };
      const v = valueOf(key, raw);
      if ('error' in v) return v;
      data[key] = v.value;
    }
    lineStart = end + 1;
    i++;
  }
  if (!Object.hasOwn(data, 'title')) return { error: 'no title' };
  return { data, body: bodyStart >= len ? '' : text.slice(bodyStart) };
}

/* ------------------------------------------------------------- the templates (lib/template.js) */

/** The deepest an include nests: one past it renders nothing. */
const INCLUDE_DEPTH = 8;

const T_PATH = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const T_FOR = /^for ([A-Za-z_][A-Za-z0-9_]*) in (\S+)$/;
const T_IF = /^if (not )?(\S+)$/;
const T_INCLUDE = /^include "([a-z0-9-]+)"$/;
const T_ONLY_SPACES = /^[ \t]*$/;

/** A template that does not parse: its name and why. */
class TemplateError extends Error {}

/** The path `text` names, split at its dots, or a TemplateError. */
function pathOf(name, text) {
  if (!T_PATH.test(text)) throw new TemplateError(`template "${name}": ${JSON.stringify(text)} is not a path`);
  return text.split('.');
}

/** `src`'s tokens: text, {{ }}, {{{ }}} and {% %}, a standalone tag's line taken with it. */
function tokenize(name, src) {
  const tokens = [];
  let text = '';
  let i = 0;
  const len = src.length;
  while (i < len) {
    const open = src.indexOf('{', i);
    if (open === -1 || open === len - 1) {
      text += src.slice(i);
      break;
    }
    const next = src[open + 1];
    if (next !== '{' && next !== '%') {
      text += src.slice(i, open + 1);
      i = open + 1;
      continue;
    }
    if (open > i) text += src.slice(i, open);
    if (next === '{') {
      const raw = src[open + 2] === '{';
      const from = open + (raw ? 3 : 2);
      const close = src.indexOf(raw ? '}}}' : '}}', from);
      if (close === -1) throw new TemplateError(`template "${name}": a ${raw ? '{{{' : '{{'} is not closed`);
      if (text !== '') tokens.push({ t: 'text', text });
      text = '';
      tokens.push({ t: raw ? 'raw' : 'var', path: pathOf(name, src.slice(from, close).trim()) });
      i = close + (raw ? 3 : 2);
      continue;
    }
    const close = src.indexOf('%}', open + 2);
    if (close === -1) throw new TemplateError(`template "${name}": a {% is not closed`);
    const end = close + 2;
    const lineStart = src.lastIndexOf('\n', open - 1) + 1;
    const nl = src.indexOf('\n', end);
    const lineEnd = nl === -1 ? len : nl;
    const standalone = T_ONLY_SPACES.test(src.slice(lineStart, open)) && T_ONLY_SPACES.test(src.slice(end, lineEnd));
    if (standalone) text = text.slice(0, text.length - (open - lineStart));
    if (text !== '') tokens.push({ t: 'text', text });
    text = '';
    tokens.push({ t: 'tag', tag: src.slice(open + 2, close).trim() });
    i = standalone ? (nl === -1 ? len : nl + 1) : end;
  }
  if (text !== '') tokens.push({ t: 'text', text });
  return tokens;
}

/** `src` parsed into its tree of nodes (a TemplateError when it does not parse). */
function parseTemplate(name, src) {
  const root = { kind: 'root', body: [] };
  const stack = [root];
  let body = root.body;
  for (const tok of tokenize(name, src)) {
    if (tok.t === 'text') body.push({ kind: 'text', text: tok.text });
    else if (tok.t === 'var' || tok.t === 'raw') body.push({ kind: tok.t, path: tok.path });
    else {
      const tag = tok.tag;
      const top = stack[stack.length - 1];
      let m;
      if ((m = T_FOR.exec(tag)) !== null) {
        const node = { kind: 'for', name: m[1], path: pathOf(name, m[2]), body: [] };
        body.push(node);
        stack.push(node);
        body = node.body;
      } else if ((m = T_IF.exec(tag)) !== null) {
        const node = { kind: 'if', not: m[1] !== undefined, path: pathOf(name, m[2]), then: [], else: null };
        body.push(node);
        stack.push(node);
        body = node.then;
      } else if (tag === 'else') {
        if (top.kind !== 'if' || top.else !== null) throw new TemplateError(`template "${name}": an else outside an if`);
        top.else = [];
        body = top.else;
      } else if (tag === 'endfor' || tag === 'endif') {
        if (top.kind !== (tag === 'endfor' ? 'for' : 'if')) throw new TemplateError(`template "${name}": an ${tag} with no open ${tag.slice(3)}`);
        stack.pop();
        const parent = stack[stack.length - 1];
        body = parent.kind === 'root' ? parent.body : parent.kind === 'for' ? parent.body : parent.else ?? parent.then;
      } else if ((m = T_INCLUDE.exec(tag)) !== null) body.push({ kind: 'include', name: m[1] });
      else throw new TemplateError(`template "${name}": {% ${tag} %} is not a tag`);
    }
  }
  if (stack.length > 1) throw new TemplateError(`template "${name}": a ${stack[stack.length - 1].kind} is not closed`);
  return root.body;
}

/** The value at `path` in the scope chain: its first name from the nearest scope holding it, then own properties. */
function lookup(scope, path) {
  const head = path[0];
  let s = scope;
  while (s !== null) {
    const vars = s.vars;
    if (Object.hasOwn(vars, head)) {
      let v = vars[head];
      for (let k = 1; k < path.length; k++) {
        if (v === null || typeof v !== 'object' || !Object.hasOwn(v, path[k])) return undefined;
        v = v[path[k]];
      }
      return v;
    }
    s = s.parent;
  }
  return undefined;
}

/** A value as text: a string itself, a number in JavaScript's digits, true or false, an array's items joined by ", ", else "". */
function textOf(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) return v.map(textOf).join(', ');
  return '';
}

/** Whether a value counts as true in an if: not undefined, null, false, "", 0 or an empty array. */
function truthy(v) {
  if (Array.isArray(v)) return v.length > 0;
  return v !== undefined && v !== null && v !== false && v !== '' && v !== 0;
}

const pushText = (text) => (out) => out.push(text);

/** One node as a writer: (out, scope, depth) appends its text to `out`. */
function compileNode(node, templates) {
  switch (node.kind) {
    case 'text':
      return pushText(node.text);
    case 'var': {
      const path = node.path;
      return (out, scope) => out.push(escapeHtml(textOf(lookup(scope, path))));
    }
    case 'raw': {
      const path = node.path;
      return (out, scope) => out.push(textOf(lookup(scope, path)));
    }
    case 'if': {
      const path = node.path;
      const not = node.not;
      const then = compileNodes(node.then, templates);
      const otherwise = node.else === null ? null : compileNodes(node.else, templates);
      if (otherwise === null) {
        return (out, scope, depth) => {
          if (truthy(lookup(scope, path)) !== not) then(out, scope, depth);
        };
      }
      return (out, scope, depth) => {
        if (truthy(lookup(scope, path)) !== not) then(out, scope, depth);
        else otherwise(out, scope, depth);
      };
    }
    case 'for': {
      const path = node.path;
      const name = node.name;
      const body = compileNodes(node.body, templates);
      return (out, scope, depth) => {
        const xs = lookup(scope, path);
        if (!Array.isArray(xs)) return;
        const len = xs.length;
        for (let k = 0; k < len; k++) {
          body(out, { vars: { [name]: xs[k], loop: { index: k + 1, first: k === 0, last: k === len - 1, length: len } }, parent: scope }, depth);
        }
      };
    }
    case 'include': {
      // bound once every template is compiled (a template may include one compiled after it)
      const cell = { w: undefined };
      templates.binds.push({ cell, name: node.name });
      return (out, scope, depth) => {
        const t = cell.w;
        if (t !== undefined && depth < INCLUDE_DEPTH) t(out, scope, depth + 1);
      };
    }
    default:
      return () => {};
  }
}

/** `nodes` as one writer: (out, scope, depth) appends them all, in order. */
function compileNodes(nodes, templates) {
  const len = nodes.length;
  if (len === 0) return () => {};
  if (len === 1) return compileNode(nodes[0], templates);
  const writers = new Array(len);
  for (let i = 0; i < len; i++) writers[i] = compileNode(nodes[i], templates);
  return (out, scope, depth) => {
    for (let i = 0; i < len; i++) writers[i](out, scope, depth);
  };
}

/* -------------------------------------------------------------- the Markdown (lib/markdown.js) */

const MD_BLANK = /^[ \t]*$/;
const MD_FENCE_OPEN = /^```([A-Za-z0-9_+-]*)[ \t]*$/;
const MD_FENCE_CLOSE = /^```[ \t]*$/;
const MD_HEADING = /^(#{1,6})[ \t]+(.*?)[ \t]*$/;
const MD_HR = /^(?:---|\*\*\*)[ \t]*$/;
const MD_BULLET = /^[-*] (.*)$/;
const MD_ORDERED = /^(\d{1,9})\. (.*)$/;
const MD_CONTINUED = /^ {2,}\S/;


/** A heading line's level and text, or null (a heading's text is never empty). */
function headingOf(line) {
  const m = MD_HEADING.exec(line);
  return m === null || m[2] === '' ? null : { depth: m[1].length, text: m[2] };
}

/** Whether `line` ends a paragraph: a blank line, a fence, a heading or a thematic break. */
function endsParagraph(line) {
  const c = line.charCodeAt(0);
  if (c === 32 || c === 9) return MD_BLANK.test(line);
  if (c === 96) return MD_FENCE_OPEN.test(line); // ```
  if (c === 35) return headingOf(line) !== null; // #
  if (c === 45 || c === 42) return MD_HR.test(line); // --- or ***
  return line.length === 0;
}

/** A paragraph line as it is rendered: spaces and tabs at either end dropped (the same line when there are none). */
function trimLine(line) {
  const len = line.length;
  let start = 0;
  let end = len;
  while (start < end) {
    const c = line.charCodeAt(start);
    if (c !== 32 && c !== 9) break;
    start++;
  }
  if (start === end) return '';
  while (end > start) {
    const c = line.charCodeAt(end - 1);
    if (c !== 32 && c !== 9) break;
    end--;
  }
  return start === 0 && end === len ? line : line.slice(start, end);
}

/** `src`'s block tokens, in order. Each block's first character settles which test can match, so a line costs one
 *  character comparison before its one regular expression. */
function lex(src) {
  const lines = src.split('\n');
  const tokens = [];
  const count = lines.length;
  let i = 0;
  while (i < count) {
    const line = lines[i];
    if (line.length === 0) {
      i++;
      continue;
    }
    const c0 = line.charCodeAt(0);
    if (c0 === 32 || c0 === 9) {
      if (MD_BLANK.test(line)) {
        i++;
        continue;
      }
    } else if (c0 === 96) {
      const fence = MD_FENCE_OPEN.exec(line);
      if (fence !== null) {
        const body = [];
        i++;
        while (i < count && !MD_FENCE_CLOSE.test(lines[i])) body.push(lines[i++]);
        i++;
        tokens.push({ type: 'code', lang: fence[1], lines: body });
        continue;
      }
    } else if (c0 === 35) {
      const heading = headingOf(line);
      if (heading !== null) {
        tokens.push({ type: 'heading', depth: heading.depth, text: heading.text });
        i++;
        continue;
      }
    } else if (c0 === 45 || c0 === 42) {
      if (MD_HR.test(line)) {
        tokens.push({ type: 'hr' });
        i++;
        continue;
      }
    } else if (c0 === 62) {
      const body = [];
      while (i < count && lines[i].charCodeAt(0) === 62) {
        const raw = lines[i++];
        const rest = raw.charCodeAt(1) === 32 ? raw.slice(2) : raw.slice(1);
        const text = trimLine(rest);
        if (text !== '') body.push(text);
      }
      tokens.push({ type: 'blockquote', lines: body });
      continue;
    }
    const bullet = c0 === 45 || c0 === 42 ? MD_BULLET.exec(line) : null;
    const ordered = bullet === null && c0 >= 48 && c0 <= 57 ? MD_ORDERED.exec(line) : null;
    if (bullet !== null || ordered !== null) {
      const isOrdered = ordered !== null;
      const marker = isOrdered ? MD_ORDERED : MD_BULLET;
      const items = [];
      while (i < count) {
        const next = lines[i];
        const m = marker.exec(next);
        if (m !== null) {
          items.push([trimLine(isOrdered ? m[2] : m[1])]);
          i++;
        } else if (next.charCodeAt(0) === 32 && next.charCodeAt(1) === 32 && MD_CONTINUED.test(next)) {
          items[items.length - 1].push(trimLine(next));
          i++;
        } else break;
      }
      const joined = new Array(items.length);
      for (let k = 0; k < items.length; k++) joined[k] = items[k].join('\n');
      tokens.push({ type: 'list', ordered: isOrdered, start: isOrdered ? Number(ordered[1]) : 1, items: joined });
      continue;
    }
    const body = [trimLine(line)];
    i++;
    while (i < count && !endsParagraph(lines[i])) body.push(trimLine(lines[i++]));
    tokens.push({ type: 'paragraph', text: body.join('\n') });
  }
  return tokens;
}

/** The characters a backslash escapes. */
const ESCAPABLE = new Set(['\\', '`', '*', '_', '[', ']', '(', ')', '#', '+', '-', '.', '!', '>']);

/** The characters the inline scanner stops at: an escape, a code span, strong, emphasis, a link, or an escape table entry. */
const INLINE_STOP = /[\\`*\[&<>"']/g;

/** The first index from `from` where `s` holds `what` outside a backslash escape, or -1. */
function findUnescaped(s, what, from) {
  const stop = s.length - what.length;
  for (let j = from; j <= stop; j++) {
    if (s[j] === '\\' && j + 1 < s.length && ESCAPABLE.has(s[j + 1])) {
      j++;
      continue;
    }
    if (s.startsWith(what, j)) return j;
  }
  return -1;
}

/** The first single * from `from` (one whose run is not **), outside an escape, or -1. */
function findSingleStar(s, from) {
  for (let j = from; j < s.length; j++) {
    const c = s[j];
    if (c === '\\' && j + 1 < s.length && ESCAPABLE.has(s[j + 1])) {
      j++;
      continue;
    }
    if (c !== '*') continue;
    if (s[j + 1] === '*') {
      j++;
      continue;
    }
    return j;
  }
  return -1;
}

const HAS_WHITESPACE = /\s/;

/** `s` rendered inline; `link(target)` is a link's href. The scanner jumps to the next character that can mean
 *  anything, and the text is built as one rope (measured faster than an array of pieces joined at the end). */
function inline(s, link) {
  let out = '';
  const n = s.length;
  let i = 0;
  while (i < n) {
    INLINE_STOP.lastIndex = i;
    const m = INLINE_STOP.exec(s);
    if (m === null) {
      out += s.slice(i);
      break;
    }
    const k = m.index;
    if (k > i) out += s.slice(i, k);
    const c = s[k];
    if (c === '\\') {
      const nx = s[k + 1];
      if (k + 1 < n && ESCAPABLE.has(nx)) {
        out += ESCAPES[nx] ?? nx;
        i = k + 2;
      } else {
        out += '\\';
        i = k + 1;
      }
      continue;
    }
    if (c === '`') {
      const j = s.indexOf('`', k + 1);
      if (j > k + 1) {
        out += `<code>${escapeHtml(s.slice(k + 1, j))}</code>`;
        i = j + 1;
      } else {
        out += '`';
        i = k + 1;
      }
      continue;
    }
    if (c === '*') {
      if (s[k + 1] === '*') {
        const j = findUnescaped(s, '**', k + 2);
        if (j > k + 2) {
          out += `<strong>${inline(s.slice(k + 2, j), link)}</strong>`;
          i = j + 2;
        } else {
          out += '**';
          i = k + 2;
        }
        continue;
      }
      const j = findSingleStar(s, k + 1);
      if (j > k + 1) {
        out += `<em>${inline(s.slice(k + 1, j), link)}</em>`;
        i = j + 1;
      } else {
        out += '*';
        i = k + 1;
      }
      continue;
    }
    if (c === '[') {
      const close = findUnescaped(s, ']', k + 1);
      const m2 = close !== -1 && s[close + 1] === '(' ? s.indexOf(')', close + 2) : -1;
      const target = m2 === -1 ? '' : s.slice(close + 2, m2);
      if (target !== '' && !HAS_WHITESPACE.test(target)) {
        out += `<a href="${escapeHtml(link(target))}">${inline(s.slice(k + 1, close), link)}</a>`;
        i = m2 + 1;
      } else {
        out += '[';
        i = k + 1;
      }
      continue;
    }
    out += escapeChar(c);
    i = k + 1;
  }
  return out;
}

/**
 * `src` rendered: its HTML (each block on its own lines, a "\n" after the last), its table of contents (every level 2
 * and 3 heading: level, id and its inline HTML) and its excerpt (the first paragraph's inline HTML, or "").
 */
function renderMarkdown(src, link) {
  const ids = new Set();
  const blocks = [];
  const toc = [];
  let excerpt = null;
  for (const t of lex(src)) {
    switch (t.type) {
      case 'heading': {
        const id = uniqueSlug(slugify(t.text), ids);
        const html = inline(t.text, link);
        blocks.push(`<h${t.depth} id="${id}">${html}</h${t.depth}>`);
        if (t.depth === 2 || t.depth === 3) toc.push({ level: t.depth, id, html });
        break;
      }
      case 'code': {
        const cls = t.lang === '' ? '' : ` class="language-${escapeHtml(t.lang)}"`;
        const lines = t.lines;
        const body = new Array(lines.length);
        for (let i = 0; i < lines.length; i++) body[i] = escapeHtml(lines[i]);
        blocks.push(`<pre><code${cls}>${body.length === 0 ? '' : `${body.join('\n')}\n`}</code></pre>`);
        break;
      }
      case 'hr':
        blocks.push('<hr>');
        break;
      case 'blockquote':
        blocks.push(t.lines.length === 0 ? '<blockquote>\n</blockquote>' : `<blockquote>\n<p>${inline(t.lines.join('\n'), link)}</p>\n</blockquote>`);
        break;
      case 'list': {
        const tag = t.ordered ? 'ol' : 'ul';
        const open = t.ordered && t.start !== 1 ? `<ol start="${t.start}">` : `<${tag}>`;
        const items = t.items;
        const body = new Array(items.length);
        for (let i = 0; i < items.length; i++) body[i] = `<li>${inline(items[i], link)}</li>`;
        blocks.push(`${open}\n${body.length === 0 ? '' : `${body.join('\n')}\n`}</${tag}>`);
        break;
      }
      case 'paragraph': {
        const html = inline(t.text, link);
        if (excerpt === null) excerpt = html;
        blocks.push(`<p>${html}</p>`);
        break;
      }
    }
  }
  return { html: blocks.length === 0 ? '' : `${blocks.join('\n')}\n`, toc, excerpt: excerpt ?? '' };
}

/* ------------------------------------------------------------- the build (index.js) */

/** The report file every build writes. */
const REPORT_FILE = 'build-report.txt';

/** The top-level directories the generator writes itself, which no page's slug at the root may take. */
const RESERVED = Object.freeze(['posts', 'tags', 'page']);

/** Code-unit order (never the locale's). */
const byCodeUnits = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/** Whether `c` (a UTF-16 code unit) is one of the characters \s matches: WhiteSpace and LineTerminator. */
function isSpace(c) {
  if (c < 128) return c === 32 || (c >= 9 && c <= 13);
  return c === 0xa0 || c === 0x1680 || (c >= 0x2000 && c <= 0x200a) || c === 0x2028 || c === 0x2029 || c === 0x202f || c === 0x205f || c === 0x3000 || c === 0xfeff;
}

/** The words of a body: its runs of characters other than whitespace (counted, never collected). */
function wordsOf(text) {
  let n = 0;
  let inWord = false;
  const len = text.length;
  for (let i = 0; i < len; i++) {
    if (isSpace(text.charCodeAt(i))) inWord = false;
    else if (!inWord) {
      inWord = true;
      n++;
    }
  }
  return n;
}

/** `rel` (a link's path, "/"-separated) from the directory `dirParts` of a source, or null when it climbs out of the root. */
function resolvePath(dirParts, rel) {
  const parts = dirParts.length === 0 ? [] : dirParts.slice();
  for (const seg of rel.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (parts.length === 0) return null;
      parts.pop();
    } else parts.push(seg);
  }
  return parts.join('/');
}

/** The directory of `path` ("" at the root). */
const dirOf = (path) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');

/** A page's link record as templates read it. */
const linkOf = (s) => (s === null ? null : { title: s.data.title, url: s.url, date: s.data.date ?? '', date_long: s.data.date === undefined ? '' : longDate(s.data.date) });

/** A source's reading time: its body's words over 200, rounded up, at least 1 (counted once per source). */
function readingMinutesOf(s) {
  let minutes = s.readingMinutes;
  if (minutes === undefined) {
    minutes = Math.max(1, Math.ceil(wordsOf(s.body) / 200));
    s.readingMinutes = minutes;
  }
  return minutes;
}

/** A post's card, as lists show it. */
function cardOf(s) {
  return {
    title: s.data.title,
    url: s.url,
    date: s.data.date ?? '',
    date_long: s.data.date === undefined ? '' : longDate(s.data.date),
    summary: s.data.summary ?? '',
    excerpt: s.excerpt,
    reading_minutes: readingMinutesOf(s),
    tags: s.tagRefs.map((t) => ({ name: t.name, slug: t.slug, url: t.url })),
  };
}

/** A page as its layout reads it (a card's fields, then the page's own). */
function pageOf(s) {
  return {
    title: s.data.title,
    url: s.url,
    date: s.data.date ?? '',
    date_long: s.data.date === undefined ? '' : longDate(s.data.date),
    summary: s.data.summary ?? '',
    excerpt: s.excerpt,
    reading_minutes: readingMinutesOf(s),
    tags: s.tagRefs.map((t) => ({ name: t.name, slug: t.slug, url: t.url })),
    slug: s.slug,
    content: s.html,
    toc: s.toc,
    newer: linkOf(s.newer ?? null),
    older: linkOf(s.older ?? null),
    is_post: s.post,
  };
}

/** A source's own tags, each slug once, in its own order. */
function ownTags(s) {
  const names = s.data.tags ?? [];
  const seen = new Set();
  const out = [];
  for (const name of names) {
    const slug = slugify(name);
    if (!seen.has(slug)) {
      seen.add(slug);
      out.push(name);
    }
  }
  return out;
}

/** Fresh per-build caches (nothing survives from one case to the next). */
let LONG_DATES = new Map();

/** One site's output tree: path -> text, exactly as makefun-site 1.0.0's build returns it. */
export function run(input) {
  LONG_DATES = new Map();
  const base = input.site.base_url.replace(/\/+$/, '');
  const report = [];

  // Templates: parsed once per build, in code-unit order of their names; one that does not parse is reported.
  const parsed = new Map();
  for (const name of Object.keys(input.templates).sort(byCodeUnits)) {
    try {
      parsed.set(name, parseTemplate(name, input.templates[name]));
    } catch (err) {
      if (!(err instanceof TemplateError)) throw err;
      report.push(err.message);
    }
  }
  const templates = new Map();
  templates.binds = [];
  for (const [name, nodes] of parsed) templates.set(name, compileNodes(nodes, templates));
  for (const { cell, name } of templates.binds) cell.w = templates.get(name);

  // 1. Sources: in code-unit order of their paths, line ends made "\n"; a source that is not .md is static.
  const sources = [];
  const statics = [];
  for (const f of [...input.files].sort((x, y) => byCodeUnits(x.path, y.path))) {
    if (f.path.endsWith('.md')) {
      const content = f.content;
      sources.push({ path: f.path, text: content.indexOf('\r') === -1 ? content : content.replace(/\r\n?/g, '\n') });
    } else statics.push({ path: f.path, content: f.content });
  }

  // 2. Each source's front matter: a refused source is reported and dropped, and so is a draft.
  const kept = [];
  for (const s of sources) {
    const fm = parseFrontMatter(s.text);
    if ('error' in fm) {
      report.push(`refused ${s.path}: ${fm.error}`);
      continue;
    }
    s.data = fm.data;
    s.body = fm.body;
    s.post = s.path.startsWith('posts/');
    const own = RESERVED.find((d) => d !== 'posts' && s.path.startsWith(`${d}/`));
    if (own !== undefined) {
      report.push(`refused ${s.path}: ${own}/ is the generator's own`);
      continue;
    }
    if (s.post && !Object.hasOwn(s.data, 'date')) {
      report.push(`refused ${s.path}: a post needs a date`);
      continue;
    }
    const layout = s.data.layout ?? (s.post ? 'post' : 'page');
    if (!templates.has(layout)) {
      report.push(`refused ${s.path}: layout "${layout}" is no template that parses`);
      continue;
    }
    s.layout = layout;
    if (s.data.draft === true) {
      report.push(`draft ${s.path}`);
      continue;
    }
    kept.push(s);
  }

  // 3. Permalinks: each page's output directory and url, its slug unique in its directory in source order.
  const bySource = new Map();
  const sources2 = kept;
  const taken = new Map();
  for (const s of sources2) {
    const dir = s.post ? 'posts' : dirOf(s.path);
    s.dir = dir;
    let takenHere = taken.get(dir);
    if (takenHere === undefined) {
      takenHere = new Set(dir === '' ? RESERVED : []);
      taken.set(dir, takenHere);
    }
    const slug = uniqueSlug(s.data.slug ?? slugify(s.data.title), takenHere);
    s.slug = slug;
    s.outDir = dir === '' ? slug : `${dir}/${slug}`;
    s.url = `${base}/${s.outDir}/`;
    bySource.set(s.path, s);
  }

  // 4. Each body's Markdown, its links resolved to the pages and static files they name.
  const staticPaths = new Set();
  for (const f of statics) staticPaths.add(f.path);
  const broken = new Set();
  for (const s of sources2) {
    const path = s.path;
    const srcDir = dirOf(path);
    const dirParts = srcDir === '' ? [] : srcDir.split('/');
    const link = (target) => {
      if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(target) || target.startsWith('/') || target.startsWith('#')) return target;
      const hash = target.indexOf('#');
      const rel = hash === -1 ? target : target.slice(0, hash);
      const frag = hash === -1 ? '' : target.slice(hash);
      const resolved = rel === '' ? null : resolvePath(dirParts, rel);
      if (resolved !== null && bySource.has(resolved)) return `${bySource.get(resolved).url}${frag}`;
      if (resolved !== null && staticPaths.has(resolved)) return `${base}/${resolved}${frag}`;
      broken.add(`broken-link ${path} -> ${target}`);
      return target;
    };
    const md = renderMarkdown(s.body, link);
    s.html = md.html;
    s.toc = md.toc;
    s.excerpt = md.excerpt;
  }

  // 5. The posts, newest first and then by slug; each post's newer and older neighbours.
  const posts = [];
  for (const s of sources2) if (s.post) posts.push(s);
  posts.sort((x, y) => byCodeUnits(y.data.date, x.data.date) || byCodeUnits(x.slug, y.slug));
  for (let k = 0; k < posts.length; k++) {
    const p = posts[k];
    p.newer = k === 0 ? null : posts[k - 1];
    p.older = k === posts.length - 1 ? null : posts[k + 1];
  }

  // 6. The tags: grouped by their slug, each named as first met in the posts' order, ordered by count and then slug.
  const bySlug = new Map();
  for (const p of posts) {
    p.tagRefs = [];
    for (const name of ownTags(p)) {
      const slug = slugify(name);
      let tag = bySlug.get(slug);
      if (tag === undefined) {
        tag = { name, slug, url: `${base}/tags/${slug}/`, posts: [] };
        bySlug.set(slug, tag);
      }
      tag.posts.push(p);
      p.tagRefs.push(tag);
    }
  }
  // A page's tags link to the posts' tag of the same slug, and to nothing (url "") where no post has it.
  for (const s of sources2) {
    if (s.post) continue;
    s.tagRefs = ownTags(s).map((name) => {
      const slug = slugify(name);
      return bySlug.get(slug) ?? { name, slug, url: '', posts: [] };
    });
  }
  const tags = [...bySlug.values()].sort((x, y) => y.posts.length - x.posts.length || byCodeUnits(x.slug, y.slug));

  // 7. Every page through its layout, the index pages and the tag pages through theirs.
  const output = {};
  const cards = new Map();
  for (const p of posts) cards.set(p, cardOf(p));
  const site = { title: input.site.title, base_url: base };
  const allTags = tags.map((t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length }));
  const recent = [];
  const recentCount = Math.min(input.site.recent, posts.length);
  for (let i = 0; i < recentCount; i++) recent.push(cards.get(posts[i]));

  /** A template rendered with the vars every template sees, or null when no template of that name parses. */
  const render = (name, vars) => {
    const nodes = templates.get(name);
    if (nodes === undefined) return null;
    const out = [];
    const scopeVars = { site, tags: allTags, recent };
    if (vars !== null) Object.assign(scopeVars, vars);
    nodes(out, { vars: scopeVars, parent: null }, 0);
    return out.join('');
  };

  for (const s of sources2) output[`${s.outDir}/index.html`] = render(s.layout, { page: pageOf(s) });

  const per = input.site.per_page;
  const pages = Math.max(1, Math.ceil(posts.length / per));
  const indexUrl = (k) => (k === 1 ? `${base}/` : `${base}/page/${k}/`);
  for (let k = 1; k <= pages; k++) {
    const slice = [];
    const from = (k - 1) * per;
    const to = Math.min(k * per, posts.length);
    for (let i = from; i < to; i++) slice.push(cards.get(posts[i]));
    const html = render('index', {
      posts: slice,
      pager: { number: k, total: pages, url: indexUrl(k), newer_url: k === 1 ? '' : indexUrl(k - 1), older_url: k === pages ? '' : indexUrl(k + 1) },
    });
    if (html !== null) output[k === 1 ? 'index.html' : `page/${k}/index.html`] = html;
  }
  for (const t of tags) {
    const html = render('tag', { tag: { name: t.name, slug: t.slug, url: t.url, count: t.posts.length, posts: t.posts.map((p) => cards.get(p)) } });
    if (html !== null) output[`tags/${t.slug}/index.html`] = html;
  }
  const tagsHtml = render('tags', {});
  if (tagsHtml !== null) output['tags/index.html'] = tagsHtml;

  for (const f of statics) {
    if (Object.hasOwn(output, f.path)) report.push(`shadowed ${f.path}: a built page has its path`);
    else output[f.path] = f.content;
  }

  // 8. The report: every refusal, draft, broken link and template that did not parse, sorted, then the counts.
  let pageCount = 0;
  for (const s of sources2) if (!s.post) pageCount++;
  const lines = [...report, ...broken].sort(byCodeUnits);
  lines.push(`built ${pageCount} pages, ${posts.length} posts, ${tags.length} tags and ${statics.length} static files`);
  output[REPORT_FILE] = `${lines.join('\n')}\n`;
  return output;
}
