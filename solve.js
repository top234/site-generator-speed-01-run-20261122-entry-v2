// Swift Site Forge v2 — a fast, dependency-free drop-in for makefun-site 1.0.0.
//
// Written from the makefun-site specification (its README and reference code as
// the behavioural contract). Nothing here is copied from the reference: the
// pipeline is re-implemented around three ideas that make it fast:
//
//   1. No-split scanning. Bodies and front matter are scanned in place with
//      indexOf('\n'); lines are never materialised into arrays, and block
//      classification reads character codes straight from the source range.
//   2. Range-based inline rendering. Inline markup renders over [start, end)
//      ranges of the original string — no substring copies for nested
//      strong/emphasis/link spans — and the scan intercepts every
//      HTML-special character itself, so plain runs need no separate
//      escaping pass.
//   3. Compiled templates. Each template is parsed once per case and compiled
//      to a specialised render function (via the Function constructor, plain
//      JavaScript), so rendering is direct property access and string
//      concatenation instead of an interpreted AST walk with a scope-chain
//      lookup per node. Loop bindings live in one mutable env object that
//      each loop saves and restores, so includes inside loops see the same
//      scope exactly as the dialect requires.
//
// Everything is computed per run() call: the slug/date memos, the compiled
// templates and all intermediate state are created fresh for each case and
// never shared between cases.

/** Code-unit order (never the locale's). */
const byCodeUnits = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/** The top-level directories the generator writes itself. */
const RESERVED = ['posts', 'tags', 'page'];

/** The report file every build writes. */
const REPORT_FILE = 'build-report.txt';

// ---------------------------------------------------------------- text

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const ESC_RE = /[&<>"']/g;
const ESC_TEST = /[&<>"']/;

/** `text` with & < > " and ' escaped. */
function esc(text) {
  return ESC_TEST.test(text) ? text.replace(ESC_RE, (c) => ESCAPES[c]) : text;
}

const MARK_RE = /\p{M}/gu;
const NONASCII_RE = /[^\x00-\x7f]/;

/**
 * The slug of `text`: NFKD, combining marks dropped, A-Z lowered, every run
 * of characters other than a-z and 0-9 one "-", none at either end, at most
 * 64 characters (a "-" left at the cut dropped), "untitled" when nothing is
 * left. Memoised within one run. (NFKD is the identity on pure-ASCII text,
 * and every combining mark is non-ASCII, so ASCII text skips both steps.)
 */
function slugify(C, text) {
  const hit = C.slugMemo.get(text);
  if (hit !== undefined) return hit;
  const plain = NONASCII_RE.test(text) ? text.normalize('NFKD').replace(MARK_RE, '') : text;
  let out = '';
  let gap = false;
  for (let i = 0; i < plain.length; i++) {
    const c = plain.charCodeAt(i);
    let keep = -1;
    if (c >= 65 && c <= 90) keep = c + 32;
    else if ((c >= 97 && c <= 122) || (c >= 48 && c <= 57)) keep = c;
    if (keep < 0) {
      gap = out.length > 0;
      continue;
    }
    if (gap) out += '-';
    gap = false;
    out += String.fromCharCode(keep);
  }
  if (out.length > 64) out = out.slice(0, 64);
  let e = out.length;
  while (e > 0 && out.charCodeAt(e - 1) === 45) e--;
  if (e < out.length) out = out.slice(0, e);
  if (out === '') out = 'untitled';
  C.slugMemo.set(text, out);
  return out;
}

/** `slug` made unique against `taken` (and added to it). */
function uniqueSlug(slug, taken) {
  let out = slug;
  for (let n = 2; taken.has(out); n++) out = `${slug}-${n}`;
  taken.add(out);
  return out;
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** A YYYY-MM-DD date in words, from the string alone. Memoised within one run. */
function longDate(C, date) {
  let v = C.dateMemo.get(date);
  if (v === undefined) {
    v = `${Number(date.slice(8, 10))} ${MONTHS[Number(date.slice(5, 7)) - 1]} ${date.slice(0, 4)}`;
    C.dateMemo.set(date, v);
  }
  return v;
}

/** Whether char code `c` is JavaScript whitespace (\s). */
function isSpaceCode(c) {
  return c === 32 || (c >= 9 && c <= 13) || c === 0xa0 || c === 0x1680 || (c >= 0x2000 && c <= 0x200a) || c === 0x2028 || c === 0x2029 || c === 0x202f || c === 0x205f || c === 0x3000 || c === 0xfeff;
}

/** The words of the line `src[s..e)`: its runs of characters other than whitespace. */
function countWordsRange(src, s, e) {
  let n = 0;
  let w = false;
  for (let i = s; i < e; i++) {
    const c = src.charCodeAt(i);
    let sp;
    if (c <= 32) sp = c === 32 || (c >= 9 && c <= 13);
    else if (c < 128) sp = false;
    else sp = c === 0xa0 || c === 0x1680 || (c >= 0x2000 && c <= 0x200a) || c === 0x2028 || c === 0x2029 || c === 0x202f || c === 0x205f || c === 0x3000 || c === 0xfeff;
    if (!sp && !w) n++;
    w = !sp;
  }
  return n;
}

const dirOf = (path) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');

// ---------------------------------------------------------------- front matter

const KEYS = new Set(['title', 'date', 'tags', 'draft', 'layout', 'slug', 'summary']);

/** The days of month `m` (1-12) of year `y`, by the Gregorian rule. */
function daysIn(y, m) {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31;
}

/** Whether `raw` is a real day from 1970-01-01 to 2099-12-31 (YYYY-MM-DD). */
function validDate(raw) {
  if (raw.length !== 10 || raw.charCodeAt(4) !== 45 || raw.charCodeAt(7) !== 45) return false;
  for (let i = 0; i < 10; i++) {
    if (i === 4 || i === 7) continue;
    const c = raw.charCodeAt(i);
    if (c < 48 || c > 57) return false;
  }
  const y = Number(raw.slice(0, 4));
  const mo = Number(raw.slice(5, 7));
  const d = Number(raw.slice(8, 10));
  if (y < 1970 || y > 2099 || mo < 1 || mo > 12 || d < 1) return false;
  return d <= daysIn(y, mo);
}

/** Whether `raw` is a template name (a-z, 0-9 and `-`). */
function validName(raw) {
  for (let i = 0; i < raw.length; i++) {
    const c = raw.charCodeAt(i);
    if (!((c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 45)) return false;
  }
  return raw.length > 0;
}

/** Whether `raw` is a slug ([a-z0-9]+(-[a-z0-9]+)*), at most 64 characters. */
function validSlug(raw) {
  const n = raw.length;
  if (n === 0 || n > 64) return false;
  let prevDash = true;
  for (let i = 0; i < n; i++) {
    const c = raw.charCodeAt(i);
    if ((c >= 97 && c <= 122) || (c >= 48 && c <= 57)) {
      prevDash = false;
      continue;
    }
    if (c === 45 && !prevDash) {
      prevDash = true;
      continue;
    }
    return false;
  }
  return !prevDash;
}

/** A string value: "..." with \" and \\ its only escapes, or bare. */
function stringOf(raw) {
  if (raw.charCodeAt(0) === 34) {
    if (raw.length < 2 || raw.charCodeAt(raw.length - 1) !== 34) return { error: 'a quoted string is not closed' };
    // Fast path: no backslash and the only inner quote is the closing one.
    if (raw.indexOf('"', 1) === raw.length - 1 && raw.indexOf('\\', 1) === -1) return { value: raw.slice(1, -1) };
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
  if (raw.charCodeAt(0) === 91) return { error: 'a bare string opens on [' };
  return { value: raw };
}

/** One key's value, or why it is refused. */
function valueOf(key, raw) {
  switch (key) {
    case 'title':
    case 'summary': {
      const s = stringOf(raw);
      return s.error !== undefined ? { error: `key "${key}": ${s.error}` } : s;
    }
    case 'date':
      return validDate(raw) ? { value: raw } : { error: 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };
    case 'tags': {
      if (raw.charCodeAt(0) !== 91 || raw.charCodeAt(raw.length - 1) !== 93) return { error: 'key "tags": not a list [a, b]' };
      const inner = raw.slice(1, -1);
      if (inner.trim() === '') return { value: [] };
      const tags = inner.split(',');
      for (let i = 0; i < tags.length; i++) {
        const t = tags[i].trim();
        tags[i] = t;
        if (t === '' || t.indexOf('"') !== -1 || t.indexOf('[') !== -1 || t.indexOf(']') !== -1) return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
      }
      return { value: tags };
    }
    case 'draft':
      if (raw === 'true') return { value: true };
      if (raw === 'false') return { value: false };
      return { error: 'key "draft": true or false' };
    case 'layout':
      return validName(raw) ? { value: raw } : { error: 'key "layout": not a template name' };
    case 'slug':
      return validSlug(raw) ? { value: raw } : { error: 'key "slug": not a slug' };
    default:
      return { error: `unknown key "${key}"` };
  }
}

/**
 * A source's front matter and body: { data, body }, or { error } with the
 * first reason it is refused. `text` has "\n" line ends. Scanned in place,
 * line by line, without splitting.
 */
function parseFrontMatter(text) {
  const nl = text.indexOf('\n');
  const firstEnd = nl === -1 ? text.length : nl;
  if (text.slice(0, firstEnd) !== '---') return { error: 'no front matter' };
  if (nl === -1) return { error: 'the front matter is not closed' };
  const data = {};
  let pos = nl + 1;
  let lineNo = 2;
  let closeEnd = -1;
  while (pos < text.length) {
    let e = text.indexOf('\n', pos);
    if (e === -1) e = text.length;
    if (e - pos === 3 && text.charCodeAt(pos) === 45 && text.charCodeAt(pos + 1) === 45 && text.charCodeAt(pos + 2) === 45) {
      closeEnd = e;
      break;
    }
    let blank = true;
    for (let i = pos; i < e; i++) {
      const c = text.charCodeAt(i);
      if (c !== 32 && c !== 9) {
        blank = false;
        break;
      }
    }
    if (!blank && text.charCodeAt(pos) !== 35) {
      let k = pos;
      while (k < e) {
        const c = text.charCodeAt(k);
        if ((c >= 97 && c <= 122) || c === 95) k++;
        else break;
      }
      if (k === pos || k >= e || text.charCodeAt(k) !== 58) return { error: `line ${lineNo} is not "key: value"` };
      const key = text.slice(pos, k);
      let raw;
      if (k + 1 === e) raw = '';
      else if (text.charCodeAt(k + 1) === 32) {
        let rEnd = e;
        while (rEnd > k + 2) {
          const c = text.charCodeAt(rEnd - 1);
          if (c === 32 || c === 9) rEnd--;
          else break;
        }
        raw = text.slice(k + 2, rEnd);
      } else return { error: `line ${lineNo} is not "key: value"` };
      if (!KEYS.has(key)) return { error: `unknown key "${key}"` };
      if (Object.hasOwn(data, key)) return { error: `key "${key}" is given twice` };
      if (raw === '') return { error: `key "${key}" has no value` };
      const v = valueOf(key, raw);
      if (v.error !== undefined) return v;
      data[key] = v.value;
    }
    pos = e + 1;
    lineNo++;
  }
  if (closeEnd === -1) return { error: 'the front matter is not closed' };
  if (!Object.hasOwn(data, 'title')) return { error: 'no title' };
  return { data, body: closeEnd < text.length ? text.slice(closeEnd + 1) : '' };
}

// ---------------------------------------------------------------- markdown

/** The characters a backslash escapes, as a code table. */
const ET = new Uint8Array(128);
for (const ch of [92, 96, 42, 95, 91, 93, 40, 41, 35, 43, 45, 46, 33, 62]) ET[ch] = 1;

/** The HTML entity for an escapable char code, else undefined. */
const ENTSTR = new Array(128);
ENTSTR[38] = '&amp;';
ENTSTR[60] = '&lt;';
ENTSTR[62] = '&gt;';
ENTSTR[34] = '&quot;';
ENTSTR[39] = '&#39;';

const WS_RE = /\s/;

/** Whether the line `src[s..e)` is blank (spaces and tabs only). */
function isBlank(src, s, e) {
  for (let i = s; i < e; i++) {
    const c = src.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** A fence-open line's language, or null. */
function fenceLang(src, s, e) {
  if (e - s < 3) return null;
  if (src.charCodeAt(s) !== 96 || src.charCodeAt(s + 1) !== 96 || src.charCodeAt(s + 2) !== 96) return null;
  let i = s + 3;
  while (i < e) {
    const c = src.charCodeAt(i);
    if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 95 || c === 43 || c === 45) i++;
    else break;
  }
  const langEnd = i;
  while (i < e) {
    const c = src.charCodeAt(i);
    if (c !== 32 && c !== 9) return null;
    i++;
  }
  return src.slice(s + 3, langEnd);
}

/** Whether the line `src[s..e)` closes a fence. */
function isFenceClose(src, s, e) {
  if (e - s < 3) return false;
  if (src.charCodeAt(s) !== 96 || src.charCodeAt(s + 1) !== 96 || src.charCodeAt(s + 2) !== 96) return false;
  for (let i = s + 3; i < e; i++) {
    const c = src.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** A heading line's { depth, a, b } (text range), or null. */
function headingOf(src, s, e) {
  let i = s;
  while (i < e && src.charCodeAt(i) === 35) i++;
  const depth = i - s;
  if (depth === 0 || depth > 6) return null;
  if (i >= e) return null;
  const c = src.charCodeAt(i);
  if (c !== 32 && c !== 9) return null;
  while (i < e) {
    const cc = src.charCodeAt(i);
    if (cc === 32 || cc === 9) i++;
    else break;
  }
  if (i >= e) return null;
  let b = e;
  while (b > i) {
    const cc = src.charCodeAt(b - 1);
    if (cc === 32 || cc === 9) b--;
    else break;
  }
  if (b <= i) return null;
  return { depth, a: i, b };
}

/** Whether the line `src[s..e)` is a thematic break. */
function isHr(src, s, e) {
  if (e - s < 3) return false;
  const c = src.charCodeAt(s);
  if (c !== 45 && c !== 42) return false;
  if (src.charCodeAt(s + 1) !== c || src.charCodeAt(s + 2) !== c) return false;
  for (let i = s + 3; i < e; i++) {
    const cc = src.charCodeAt(i);
    if (cc !== 32 && cc !== 9) return false;
  }
  return true;
}

/** A bullet item's text start, or -1. */
function bulletStart(src, s, e) {
  if (e - s < 2) return -1;
  const c = src.charCodeAt(s);
  if ((c === 45 || c === 42) && src.charCodeAt(s + 1) === 32) return s + 2;
  return -1;
}

/** Scratch for an ordered item's number. */
const ORD = { num: '' };

/** An ordered item's text start (its number in ORD.num), or -1. */
function orderedStart(src, s, e) {
  let i = s;
  while (i < e) {
    const c = src.charCodeAt(i);
    if (c >= 48 && c <= 57) i++;
    else break;
  }
  const nd = i - s;
  if (nd === 0 || nd > 9) return -1;
  if (i + 1 >= e) return -1;
  if (src.charCodeAt(i) !== 46 || src.charCodeAt(i + 1) !== 32) return -1;
  ORD.num = src.slice(s, i);
  return i + 2;
}

/** Whether the line `src[s..e)` continues a list item (2+ spaces, then non-space). */
function isContinued(src, s, e) {
  if (e - s < 3) return false;
  if (src.charCodeAt(s) !== 32 || src.charCodeAt(s + 1) !== 32) return false;
  let i = s + 2;
  while (i < e && src.charCodeAt(i) === 32) i++;
  return i < e && !isSpaceCode(src.charCodeAt(i));
}

/** Whether the line `src[s..e)` ends a paragraph (blank, fence, heading or break). */
function endsParagraph(src, s, e) {
  if (e === s) return true;
  const c0 = src.charCodeAt(s);
  if (c0 === 32 || c0 === 9) return isBlank(src, s, e);
  if (c0 === 96) return fenceLang(src, s, e) !== null;
  if (c0 === 35) return headingOf(src, s, e) !== null;
  if (c0 === 45 || c0 === 42) return isHr(src, s, e);
  return false;
}

/** The line `src[s..e)` trimmed of spaces and tabs at both ends. */
function trimSlice(src, s, e) {
  let a = s;
  let b = e;
  while (a < b) {
    const c = src.charCodeAt(a);
    if (c === 32 || c === 9) a++;
    else break;
  }
  while (b > a) {
    const c = src.charCodeAt(b - 1);
    if (c === 32 || c === 9) b--;
    else break;
  }
  return src.slice(a, b);
}

/** The first `**` from `from` outside a backslash escape, or -1. */
function findPair(s, from, b) {
  for (let j = from; j + 1 < b; j++) {
    const c = s.charCodeAt(j);
    if (c === 92) {
      const n = s.charCodeAt(j + 1);
      if (n < 128 && ET[n] === 1) {
        j++;
        continue;
      }
    } else if (c === 42 && s.charCodeAt(j + 1) === 42) return j;
  }
  return -1;
}

/** The first `code` from `from` outside a backslash escape, or -1. */
function findOne(s, code, from, b) {
  for (let j = from; j < b; j++) {
    const c = s.charCodeAt(j);
    if (c === 92) {
      const n = j + 1 < b ? s.charCodeAt(j + 1) : -1;
      if (n !== -1 && n < 128 && ET[n] === 1) {
        j++;
        continue;
      }
    } else if (c === code) return j;
  }
  return -1;
}

/** The first single `*` from `from` (one whose run is not `**`), outside an escape, or -1. */
function findSingleStar(s, from, b) {
  for (let j = from; j < b; j++) {
    const c = s.charCodeAt(j);
    if (c === 92) {
      const n = j + 1 < b ? s.charCodeAt(j + 1) : -1;
      if (n !== -1 && n < 128 && ET[n] === 1) {
        j++;
        continue;
      }
    }
    if (c !== 42) continue;
    if (j + 1 < b && s.charCodeAt(j + 1) === 42) {
      j++;
      continue;
    }
    return j;
  }
  return -1;
}

/**
 * `s[a..b)` rendered inline. Plain runs are flushed raw (the scan below
 * intercepts every HTML-special character and writes its entity itself, so
 * no separate escaping pass is needed); nested spans recurse on ranges,
 * never on copies.
 */
function inline(C, s, a, b) {
  let out = '';
  let p = a;
  let i = a;
  while (i < b) {
    const c = s.charCodeAt(i);
    if (c === 92) {
      const n = i + 1 < b ? s.charCodeAt(i + 1) : -1;
      if (n !== -1 && n < 128 && ET[n] === 1) {
        if (i > p) out += s.slice(p, i);
        out += s[i + 1];
        i += 2;
        p = i;
      } else i++;
      continue;
    }
    if (c === 96) {
      const j = s.indexOf('`', i + 1);
      if (j !== -1 && j < b && j > i + 1) {
        if (i > p) out += s.slice(p, i);
        out += `<code>${esc(s.slice(i + 1, j))}</code>`;
        i = j + 1;
        p = i;
      } else i++;
      continue;
    }
    if (c === 42) {
      if (i + 1 < b && s.charCodeAt(i + 1) === 42) {
        const j = findPair(s, i + 2, b);
        if (j !== -1 && j > i + 2) {
          if (i > p) out += s.slice(p, i);
          out += `<strong>${inline(C, s, i + 2, j)}</strong>`;
          i = j + 2;
          p = i;
        } else i += 2;
      } else {
        const j = findSingleStar(s, i + 1, b);
        if (j !== -1 && j > i + 1) {
          if (i > p) out += s.slice(p, i);
          out += `<em>${inline(C, s, i + 1, j)}</em>`;
          i = j + 1;
          p = i;
        } else i++;
      }
      continue;
    }
    if (c === 91) {
      const k = findOne(s, 93, i + 1, b);
      let m = -1;
      if (k !== -1 && k + 1 < b && s.charCodeAt(k + 1) === 40) {
        const mm = s.indexOf(')', k + 2);
        if (mm !== -1 && mm < b) m = mm;
      }
      if (m !== -1) {
        const target = s.slice(k + 2, m);
        if (target !== '' && !WS_RE.test(target)) {
          if (i > p) out += s.slice(p, i);
          out += `<a href="${esc(resolveLink(C, target))}">${inline(C, s, i + 1, k)}</a>`;
          i = m + 1;
          p = i;
          continue;
        }
      }
      i++;
      continue;
    }
    const en = c < 128 ? ENTSTR[c] : undefined;
    if (en !== undefined) {
      if (i > p) out += s.slice(p, i);
      out += en;
      i++;
      p = i;
      continue;
    }
    i++;
  }
  if (b > p) out += s.slice(p, b);
  return out;
}

/**
 * `src` rendered: its HTML (each block followed by "\n"), its table of
 * contents (every level 2 and 3 heading), its excerpt (the first
 * paragraph's inline HTML, or "") and its word count (the body's runs of
 * characters other than whitespace, counted line by line as the scan
 * consumes each line exactly once — a run can never span a "\n"). Blocks
 * are scanned and rendered in one pass over the source, without splitting
 * it into lines.
 */
function renderMarkdown(C, src) {
  const n = src.length;
  let pos = 0;
  let html = '';
  const toc = [];
  let excerpt = null;
  let words = 0;
  const ids = new Set();
  while (pos < n) {
    let e = src.indexOf('\n', pos);
    if (e === -1) e = n;
    if (e === pos) {
      pos = e + 1;
      continue;
    }
    // Dispatch on the first character: each block kind has its own opener,
    // so only the matching test runs (a blank line aside, which only a
    // space or tab can open). Anything unmatched falls through to a paragraph.
    const c0 = src.charCodeAt(pos);
    let listKind = -1;
    let listStart = 1;
    if (c0 === 32 || c0 === 9) {
      if (isBlank(src, pos, e)) {
        pos = e + 1;
        continue;
      }
    } else if (c0 === 96) {
      const lang = fenceLang(src, pos, e);
      if (lang !== null) {
        words += countWordsRange(src, pos, e);
        pos = e + 1;
        let code = '';
        while (pos < n) {
          let e2 = src.indexOf('\n', pos);
          if (e2 === -1) e2 = n;
          words += countWordsRange(src, pos, e2);
          if (isFenceClose(src, pos, e2)) {
            pos = e2 + 1;
            break;
          }
          code += esc(src.slice(pos, e2));
          code += '\n';
          pos = e2 + 1;
        }
        html += '<pre><code';
        if (lang !== '') {
          html += ' class="language-';
          html += lang;
          html += '"';
        }
        html += '>';
        html += code;
        html += '</code></pre>\n';
        continue;
      }
    } else if (c0 === 35) {
      const h = headingOf(src, pos, e);
      if (h !== null) {
        words += countWordsRange(src, pos, e);
        const id = uniqueSlug(slugify(C, src.slice(h.a, h.b)), ids);
        const inner = inline(C, src, h.a, h.b);
        html += `<h${h.depth} id="${id}">${inner}</h${h.depth}>\n`;
        if (h.depth === 2 || h.depth === 3) toc.push({ level: h.depth, id, html: inner });
        pos = e + 1;
        continue;
      }
    } else if (c0 === 45 || c0 === 42) {
      if (isHr(src, pos, e)) {
        words += 1;
        html += '<hr>\n';
        pos = e + 1;
        continue;
      }
      if (bulletStart(src, pos, e) !== -1) listKind = 0;
    } else if (c0 === 62) {
      const lines = [];
      while (pos < n) {
        let e2 = src.indexOf('\n', pos);
        if (e2 === -1) e2 = n;
        if (src.charCodeAt(pos) !== 62) break;
        words += countWordsRange(src, pos, e2);
        let q = pos + 1;
        if (q < e2 && src.charCodeAt(q) === 32) q++;
        const t = trimSlice(src, q, e2);
        if (t !== '') lines.push(t);
        pos = e2 + 1;
      }
      if (lines.length === 0) html += '<blockquote>\n</blockquote>\n';
      else {
        const joined = lines.join('\n');
        html += `<blockquote>\n<p>${inline(C, joined, 0, joined.length)}</p>\n</blockquote>\n`;
      }
      continue;
    } else if (c0 >= 48 && c0 <= 57) {
      if (orderedStart(src, pos, e) !== -1) {
        listKind = 1;
        listStart = Number(ORD.num);
      }
    }
    if (listKind !== -1) {
      const ordered = listKind === 1;
      const startNum = listStart;
      const items = [];
      while (pos < n) {
        let e2 = src.indexOf('\n', pos);
        if (e2 === -1) e2 = n;
        const m = ordered ? orderedStart(src, pos, e2) : bulletStart(src, pos, e2);
        if (m !== -1) {
          words += countWordsRange(src, pos, e2);
          items.push(trimSlice(src, m, e2));
          pos = e2 + 1;
        } else if (isContinued(src, pos, e2)) {
          words += countWordsRange(src, pos, e2);
          items[items.length - 1] += `\n${trimSlice(src, pos, e2)}`;
          pos = e2 + 1;
        } else break;
      }
      if (ordered) html += startNum !== 1 ? `<ol start="${startNum}">\n` : '<ol>\n';
      else html += '<ul>\n';
      for (let k = 0; k < items.length; k++) {
        const it = items[k];
        html += `<li>${inline(C, it, 0, it.length)}</li>\n`;
      }
      html += ordered ? '</ol>\n' : '</ul>\n';
      continue;
    }
    let text = trimSlice(src, pos, e);
    words += countWordsRange(src, pos, e);
    pos = e + 1;
    while (pos < n) {
      let e2 = src.indexOf('\n', pos);
      if (e2 === -1) e2 = n;
      if (endsParagraph(src, pos, e2)) break;
      words += countWordsRange(src, pos, e2);
      text += `\n${trimSlice(src, pos, e2)}`;
      pos = e2 + 1;
    }
    const inner = inline(C, text, 0, text.length);
    if (excerpt === null) excerpt = inner;
    html += `<p>${inner}</p>\n`;
  }
  return { html, toc, excerpt: excerpt ?? '', words };
}

// ---------------------------------------------------------------- links

/** Whether `target` opens with a scheme (`https:`, `mailto:` ...). */
function hasScheme(target) {
  const c0 = target.charCodeAt(0);
  if (!((c0 >= 65 && c0 <= 90) || (c0 >= 97 && c0 <= 122))) return false;
  for (let i = 1; i < target.length; i++) {
    const c = target.charCodeAt(i);
    if (c === 58) return true;
    if (!((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 43 || c === 45 || c === 46)) return false;
  }
  return false;
}

/** `rel` (a link's path) from the directory `dir`, or null when it climbs out of the root. */
function resolvePath(dir, rel) {
  if (
    rel !== '.' && rel !== '..' &&
    !rel.startsWith('./') && !rel.startsWith('../') &&
    !rel.endsWith('/.') && !rel.endsWith('/..') &&
    rel.indexOf('/./') === -1 && rel.indexOf('/../') === -1 &&
    rel.indexOf('//') === -1 &&
    rel.charCodeAt(0) !== 47 && rel.charCodeAt(rel.length - 1) !== 47
  ) {
    // No "." or ".." segment and no empty segment: a plain join.
    return dir === '' ? rel : `${dir}/${rel}`;
  }
  const parts = dir === '' ? [] : dir.split('/');
  const segs = rel.split('/');
  for (let i = 0; i < segs.length; i++) {
    const seg = segs[i];
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (parts.length === 0) return null;
      parts.pop();
    } else parts.push(seg);
  }
  return parts.join('/');
}

/** A link target's href, resolved against the current source's directory. */
function resolveLink(C, target) {
  if (hasScheme(target) || target.charCodeAt(0) === 47 || target.charCodeAt(0) === 35) return target;
  const hash = target.indexOf('#');
  const rel = hash === -1 ? target : target.slice(0, hash);
  const frag = hash === -1 ? '' : target.slice(hash);
  const path = rel === '' ? null : resolvePath(C.linkDir, rel);
  if (path !== null) {
    const page = C.bySource.get(path);
    if (page !== undefined) return `${page.url}${frag}`;
    if (C.staticPaths.has(path)) return `${C.base}/${path}${frag}`;
  }
  C.broken.add(`broken-link ${C.linkPath} -> ${target}`);
  return target;
}

// ---------------------------------------------------------------- templates

/** The deepest an include nests: one past it renders nothing. */
const INCLUDE_DEPTH = 8;

const PATH_RE = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const FOR_RE = /^for ([A-Za-z_][A-Za-z0-9_]*) in (\S+)$/;
const IF_RE = /^if (not )?(\S+)$/;
const INCLUDE_RE = /^include "([a-z0-9-]+)"$/;

/** A template that does not parse: its name and why. */
class TemplateError extends Error {}

/** The path `text` names, split at its dots, or a TemplateError. */
function pathOf(name, text) {
  if (!PATH_RE.test(text)) throw new TemplateError(`template "${name}": ${JSON.stringify(text)} is not a path`);
  return text.split('.');
}

/** `src`'s tokens: text, {{ }}, {{{ }}} and {% %}, a standalone tag's line taken with it. */
function tokenize(name, src) {
  const tokens = [];
  let text = '';
  let i = 0;
  const n = src.length;
  while (i < n) {
    const open = src.indexOf('{', i);
    if (open === -1 || open === n - 1) {
      text += src.slice(i);
      break;
    }
    const next = src[open + 1];
    if (next !== '{' && next !== '%') {
      text += src.slice(i, open + 1);
      i = open + 1;
      continue;
    }
    text += src.slice(i, open);
    if (next === '{') {
      const raw = src[open + 2] === '{';
      const close = src.indexOf(raw ? '}}}' : '}}', open + (raw ? 3 : 2));
      if (close === -1) throw new TemplateError(`template "${name}": a ${raw ? '{{{' : '{{'} is not closed`);
      if (text !== '') tokens.push({ t: 'text', text });
      text = '';
      tokens.push({ t: raw ? 'raw' : 'var', path: pathOf(name, src.slice(open + (raw ? 3 : 2), close).trim()) });
      i = close + (raw ? 3 : 2);
      continue;
    }
    const close = src.indexOf('%}', open + 2);
    if (close === -1) throw new TemplateError(`template "${name}": a {% is not closed`);
    const end = close + 2;
    const lineStart = src.lastIndexOf('\n', open - 1) + 1;
    const nl = src.indexOf('\n', end);
    const lineEnd = nl === -1 ? n : nl;
    const standalone = /^[ \t]*$/.test(src.slice(lineStart, open)) && /^[ \t]*$/.test(src.slice(end, lineEnd));
    if (standalone) text = text.slice(0, text.length - (open - lineStart));
    if (text !== '') tokens.push({ t: 'text', text });
    text = '';
    tokens.push({ t: 'tag', tag: src.slice(open + 2, close).trim() });
    i = standalone ? (nl === -1 ? n : nl + 1) : end;
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
      if ((m = FOR_RE.exec(tag)) !== null) {
        const node = { kind: 'for', name: m[1], path: pathOf(name, m[2]), body: [] };
        body.push(node);
        stack.push(node);
        body = node.body;
      } else if ((m = IF_RE.exec(tag)) !== null) {
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
      } else if ((m = INCLUDE_RE.exec(tag)) !== null) body.push({ kind: 'include', name: m[1] });
      else throw new TemplateError(`template "${name}": {% ${tag} %} is not a tag`);
    }
  }
  if (stack.length > 1) throw new TemplateError(`template "${name}": a ${stack[stack.length - 1].kind} is not closed`);
  return root.body;
}

/** A value as text: a string itself, a number in JavaScript's digits, true or false, an array's items joined by ", ", else "". */
function textOf(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) return v.map(textOf).join(', ');
  return '';
}

/** A value as escaped text: exactly esc(textOf(v)), in one call. */
function etx(v) {
  if (typeof v === 'string') return esc(v);
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) return esc(v.map(textOf).join(', '));
  return '';
}
function truthy(v) {
  if (Array.isArray(v)) return v.length > 0;
  return v !== undefined && v !== null && v !== false && v !== '' && v !== 0;
}

/** The own property `k` of `v`, or undefined when `v` is no object or lacks it. */
function getProp(v, k) {
  return v !== null && typeof v === 'object' && Object.hasOwn(v, k) ? v[k] : undefined;
}

/**
 * JavaScript for the value at `path`: its first name from the loop env,
 * else the page's values. A name bound by a lexically enclosing for (or
 * `loop` inside any for) reads straight from the env — the binding is
 * guaranteed present and innermost there; any other name keeps the dynamic
 * env-then-values lookup, since an include may run under a caller's loops.
 */
function pathExpr(path, st) {
  const first = JSON.stringify(path[0]);
  let e;
  if (st.stack.includes(path[0]) || (path[0] === 'loop' && st.stack.length > 0)) e = `E[${first}]`;
  else e = `(Object.hasOwn(E,${first})?E[${first}]:(Object.hasOwn(V,${first})?V[${first}]:void 0))`;
  for (let k = 1; k < path.length; k++) e = `gp(${e},${JSON.stringify(path[k])})`;
  return e;
}

/** JavaScript rendering `nodes` into `o`. `st.uid` numbers the temporaries; `st.stack` is the lexical for-stack. */
function genNodes(nodes, st) {
  let code = '';
  for (const nd of nodes) {
    if (nd.kind === 'text') code += `o+=${JSON.stringify(nd.text)};`;
    else if (nd.kind === 'var') code += `o+=etx(${pathExpr(nd.path, st)});`;
    else if (nd.kind === 'raw') code += `o+=tx(${pathExpr(nd.path, st)});`;
    else if (nd.kind === 'if') {
      const cond = nd.not ? `!ty(${pathExpr(nd.path, st)})` : `ty(${pathExpr(nd.path, st)})`;
      code += `if(${cond}){${genNodes(nd.then, st)}}`;
      if (nd.else !== null) code += `else{${genNodes(nd.else, st)}}`;
    } else if (nd.kind === 'for') {
      const u = ++st.uid;
      const nm = JSON.stringify(nd.name);
      st.stack.push(nd.name);
      const body = genNodes(nd.body, st);
      st.stack.pop();
      code += `{const xs${u}=${pathExpr(nd.path, st)};if(Array.isArray(xs${u})){const L${u}=xs${u}.length;for(let k${u}=0;k${u}<L${u};k${u}++){const hv${u}=Object.hasOwn(E,${nm}),pv${u}=E[${nm}],hl${u}=Object.hasOwn(E,"loop"),pl${u}=E.loop;E[${nm}]=xs${u}[k${u}];E.loop={index:k${u}+1,first:k${u}===0,last:k${u}===L${u}-1,length:L${u}};${body}if(hv${u})E[${nm}]=pv${u};else delete E[${nm}];if(hl${u})E.loop=pl${u};else delete E.loop;}}}`;
    } else if (nd.kind === 'include') {
      const u = ++st.uid;
      code += `if(D<${INCLUDE_DEPTH}){const f${u}=T.get(${JSON.stringify(nd.name)});if(f${u}!==void 0)o+=f${u}(V,E,D+1,T,esc,tx,ty,gp,etx);}`;
    }
  }
  return code;
}

/** `src` parsed and compiled to a render function (V, E, D, T, esc, tx, ty, gp, etx). */
function compileTemplate(name, src) {
  const nodes = parseTemplate(name, src);
  const code = `let o="";${genNodes(nodes, { uid: 0, stack: [] })}return o;`;
  return new Function('V', 'E', 'D', 'T', 'esc', 'tx', 'ty', 'gp', 'etx', code);
}

// ---------------------------------------------------------------- build

/** A page's link record as templates read it. */
function linkOf(C, s) {
  if (s === null) return null;
  return { title: s.data.title, url: s.url, date: s.data.date ?? '', date_long: s.data.date === undefined ? '' : longDate(C, s.data.date) };
}

/** A post's card, as lists show it. */
function cardOf(C, s) {
  return {
    title: s.data.title,
    url: s.url,
    date: s.data.date ?? '',
    date_long: s.data.date === undefined ? '' : longDate(C, s.data.date),
    summary: s.data.summary ?? '',
    excerpt: s.excerpt,
    reading_minutes: Math.max(1, Math.ceil(s.words / 200)),
    tags: s.tagRefs.map((t) => ({ name: t.name, slug: t.slug, url: t.url })),
  };
}

/** A page as its layout reads it. */
function pageOf(C, s) {
  const c = cardOf(C, s);
  c.slug = s.slug;
  c.content = s.html;
  c.toc = s.toc.map((h) => ({ level: h.level, id: h.id, html: h.html }));
  c.newer = linkOf(C, s.newer ?? null);
  c.older = linkOf(C, s.older ?? null);
  c.is_post = s.post;
  return c;
}

/** One site's output tree: path -> text. */
export function run(input) {
  const C = {
    slugMemo: new Map(),
    dateMemo: new Map(),
    base: input.site.base_url.replace(/\/+$/, ''),
    templates: new Map(),
    report: [],
    broken: new Set(),
    bySource: new Map(),
    staticPaths: new Set(),
    linkDir: '',
    linkPath: '',
    output: {},
  };

  // Templates, parsed and compiled in code-unit order of their names. One
  // that does not parse is reported and left out.
  const names = Object.keys(input.templates).sort(byCodeUnits);
  for (let i = 0; i < names.length; i++) {
    const name = names[i];
    try {
      C.templates.set(name, compileTemplate(name, input.templates[name]));
    } catch (err) {
      if (!(err instanceof TemplateError)) throw err;
      C.report.push(err.message);
    }
  }

  // Sources, in code-unit order of their paths, line ends made "\n".
  const files = [...input.files].sort((x, y) => byCodeUnits(x.path, y.path));
  const sources = [];
  const statics = [];
  for (let i = 0; i < files.length; i++) {
    const f = files[i];
    if (f.path.endsWith('.md')) {
      const raw = f.content;
      sources.push({ path: f.path, text: raw.indexOf('\r') === -1 ? raw : raw.replace(/\r\n?/g, '\n') });
    } else statics.push(f);
  }

  // Front matter and the drop checks, in order, first failure reported.
  const kept = [];
  for (let i = 0; i < sources.length; i++) {
    const s = sources[i];
    const fm = parseFrontMatter(s.text);
    if (fm.error !== undefined) {
      C.report.push(`refused ${s.path}: ${fm.error}`);
      continue;
    }
    s.data = fm.data;
    s.body = fm.body;
    s.post = s.path.startsWith('posts/');
    const own = s.path.startsWith('tags/') ? 'tags' : s.path.startsWith('page/') ? 'page' : undefined;
    if (own !== undefined) {
      C.report.push(`refused ${s.path}: ${own}/ is the generator's own`);
      continue;
    }
    if (s.post && !Object.hasOwn(s.data, 'date')) {
      C.report.push(`refused ${s.path}: a post needs a date`);
      continue;
    }
    const layout = s.data.layout ?? (s.post ? 'post' : 'page');
    if (!C.templates.has(layout)) {
      C.report.push(`refused ${s.path}: layout "${layout}" is no template that parses`);
      continue;
    }
    s.layout = layout;
    if (s.data.draft === true) {
      C.report.push(`draft ${s.path}`);
      continue;
    }
    kept.push(s);
  }

  // Permalinks: each slug made unique in its directory, in source order.
  const taken = new Map();
  for (let i = 0; i < kept.length; i++) {
    const s = kept[i];
    const dir = s.post ? 'posts' : dirOf(s.path);
    let set = taken.get(dir);
    if (set === undefined) {
      set = new Set(dir === '' ? RESERVED : []);
      taken.set(dir, set);
    }
    const slug = uniqueSlug(s.data.slug ?? slugify(C, s.data.title), set);
    s.slug = slug;
    s.outDir = dir === '' ? slug : `${dir}/${slug}`;
    s.url = `${C.base}/${s.outDir}/`;
    C.bySource.set(s.path, s);
  }

  // Markdown, each body's links resolved to the pages and static files they name.
  for (let i = 0; i < statics.length; i++) C.staticPaths.add(statics[i].path);
  for (let i = 0; i < kept.length; i++) {
    const s = kept[i];
    C.linkDir = dirOf(s.path);
    C.linkPath = s.path;
    const md = renderMarkdown(C, s.body);
    s.html = md.html;
    s.toc = md.toc;
    s.excerpt = md.excerpt;
    s.words = md.words;
  }

  // Collections: the posts, newest first and then by slug, with neighbours.
  const posts = kept.filter((s) => s.post);
  posts.sort((x, y) => byCodeUnits(y.data.date, x.data.date) || byCodeUnits(x.slug, y.slug));
  for (let k = 0; k < posts.length; k++) {
    posts[k].newer = k === 0 ? null : posts[k - 1];
    posts[k].older = k === posts.length - 1 ? null : posts[k + 1];
  }

  // Tags: grouped by slug, each named as first met in the posts' order.
  const bySlug = new Map();
  const ownTags = (s) => {
    const seen = new Set();
    const arr = s.data.tags ?? [];
    const out = [];
    for (let i = 0; i < arr.length; i++) {
      const sl = slugify(C, arr[i]);
      if (!seen.has(sl)) {
        seen.add(sl);
        out.push(arr[i]);
      }
    }
    return out;
  };
  for (let i = 0; i < posts.length; i++) {
    const p = posts[i];
    p.tagRefs = [];
    const names2 = ownTags(p);
    for (let j = 0; j < names2.length; j++) {
      const name = names2[j];
      const slug = slugify(C, name);
      let tag = bySlug.get(slug);
      if (tag === undefined) {
        tag = { name, slug, url: `${C.base}/tags/${slug}/`, posts: [] };
        bySlug.set(slug, tag);
      }
      tag.posts.push(p);
      p.tagRefs.push(tag);
    }
  }
  for (let i = 0; i < kept.length; i++) {
    const s = kept[i];
    if (s.post) continue;
    s.tagRefs = ownTags(s).map((name) => {
      const sl = slugify(C, name);
      return bySlug.get(sl) ?? { name, slug: sl, url: '', posts: [] };
    });
  }
  const tags = [...bySlug.values()].sort((x, y) => y.posts.length - x.posts.length || byCodeUnits(x.slug, y.slug));

  // Layouts: every page through its layout, the index and tag pages through theirs.
  const cards = new Map();
  for (let i = 0; i < posts.length; i++) cards.set(posts[i], cardOf(C, posts[i]));
  const site = { title: input.site.title, base_url: C.base };
  const allTags = tags.map((t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length }));
  const recent = posts.slice(0, input.site.recent).map((p) => cards.get(p));
  const E = {};
  const render = (name, vars) => {
    const fn = C.templates.get(name);
    if (fn === undefined) return null;
    return fn({ site, tags: allTags, recent, ...vars }, E, 0, C.templates, esc, textOf, truthy, getProp, etx);
  };
  for (let i = 0; i < kept.length; i++) {
    const s = kept[i];
    C.output[`${s.outDir}/index.html`] = render(s.layout, { page: pageOf(C, s) });
  }
  const per = input.site.per_page;
  const pages = Math.max(1, Math.ceil(posts.length / per));
  const indexUrl = (k) => (k === 1 ? `${C.base}/` : `${C.base}/page/${k}/`);
  for (let k = 1; k <= pages; k++) {
    const html = render('index', {
      posts: posts.slice((k - 1) * per, k * per).map((p) => cards.get(p)),
      pager: { number: k, total: pages, url: indexUrl(k), newer_url: k === 1 ? '' : indexUrl(k - 1), older_url: k === pages ? '' : indexUrl(k + 1) },
    });
    if (html !== null) C.output[k === 1 ? 'index.html' : `page/${k}/index.html`] = html;
  }
  for (let i = 0; i < tags.length; i++) {
    const t = tags[i];
    const html = render('tag', { tag: { name: t.name, slug: t.slug, url: t.url, count: t.posts.length, posts: t.posts.map((p) => cards.get(p)) } });
    if (html !== null) C.output[`tags/${t.slug}/index.html`] = html;
  }
  const tagsHtml = render('tags', {});
  if (tagsHtml !== null) C.output['tags/index.html'] = tagsHtml;
  for (let i = 0; i < statics.length; i++) {
    const f = statics[i];
    if (Object.hasOwn(C.output, f.path)) C.report.push(`shadowed ${f.path}: a built page has its path`);
    else C.output[f.path] = f.content;
  }

  // The report: every refusal, draft, broken link and template that did not
  // parse, sorted, then the counts.
  const lines = [...C.report, ...C.broken].sort(byCodeUnits);
  let npages = 0;
  for (let i = 0; i < kept.length; i++) if (!kept[i].post) npages++;
  lines.push(`built ${npages} pages, ${posts.length} posts, ${tags.length} tags and ${statics.length} static files`);
  C.output[REPORT_FILE] = `${lines.join('\n')}\n`;
  return C.output;
}
