/**
 * Glob matching that gives the same answer on every platform (REQ-PROJ-9). Node's `path.matchesGlob` folds the wildcard
 * parts of a glob on macOS and Windows only, so the gate judged `testGlobs` and allow lists differently on a Mac and in
 * Linux CI. This matcher is always exact; a caller that wants folding lowercases both sides (`locksAny`).
 *
 * Syntax, as `path.matchesGlob` reads it: `*` and `?` stay inside one segment, a `**` segment spans segments (one or
 * more at the end of the glob, zero or more elsewhere), `[...]` and `[!...]`/`[^...]` classes, `{a,b}` alternatives,
 * and `\` is a path separator. A wildcard never matches a leading dot: `*.js` is not `.eslintrc.js`, `**` does not enter
 * `.git/`. `!` and `#` at the start are literal.
 */

// Extglobs, POSIX classes, and brace ranges: path.matchesGlob reads them, this matcher does not.
const UNSUPPORTED = /[?*+@!]\(|\[:|\{[^{},]*\.\.[^{},]*\}/;
const SEGMENT = '(?!\\.)[^/]*';
const cache = new Map();

export function globMatches(path, glob) {
  let re = cache.get(glob);
  if (!re) cache.set(glob, (re = compile(glob)));
  return re.test(path);
}

function compile(glob) {
  if (UNSUPPORTED.test(glob)) throw new Error(`unsupported glob syntax in "${glob}": use *, **, ?, [...], {a,b}`);
  return new RegExp(`^(?:${expand(glob.replaceAll('\\', '/')).map(pattern).join('|')})$`);
}

/** `{a,b}` → one glob per alternative, nested braces included; a brace without a top-level comma is literal. */
function expand(glob) {
  for (let i = 0; i < glob.length; i++) {
    if (glob[i] !== '{') continue;
    const cuts = [i];
    for (let j = i, depth = 0; j < glob.length; j++) {
      if (glob[j] === '{') depth++;
      else if (glob[j] === ',' && depth === 1) cuts.push(j);
      else if (glob[j] === '}' && --depth === 0) {
        if (cuts.length === 1) break;
        cuts.push(j);
        const alternatives = cuts.slice(1).map((cut, k) => glob.slice(cuts[k] + 1, cut));
        return alternatives.flatMap((alt) => expand(glob.slice(0, i) + alt + glob.slice(j + 1)));
      }
    }
  }
  return [glob];
}

function pattern(glob) {
  const segments = glob.split('/');
  let out = '';
  let joined = true; // at the start, or just after a `**/`, so the next segment needs no separator
  segments.forEach((seg, i) => {
    const sep = joined ? '' : '/';
    joined = false;
    if (seg !== '**') out += sep + segment(seg);
    else if (i === segments.length - 1) out += `${sep}${SEGMENT}(?:/${SEGMENT})*`;
    else {
      out += `${sep}(?:${SEGMENT}/)*`;
      joined = true;
    }
  });
  return out;
}

function segment(seg) {
  let out = '';
  for (let i = 0; i < seg.length; i++) {
    const c = seg[i];
    const close = c === '[' ? classEnd(seg, i) : -1;
    if (c === '*') {
      out += '[^/]*';
      while (seg[i + 1] === '*') i++;
    } else if (c === '?') out += '[^/]';
    else if (close > 0) {
      const negated = '!^'.includes(seg[i + 1]);
      const body = seg.slice(i + (negated ? 2 : 1), close).replace(/[\\[\]^]/g, '\\$&');
      out += negated ? `[^/${body}]` : `[${body}]`;
      i = close;
    } else out += c.replace(/[.*+?^${}()|[\]\\/]/, '\\$&');
  }
  return /^[*?[]/.test(seg) ? `(?!\\.)${out}` : out;
}

/** Index of the `]` that closes the class opened at `start`, or -1 when the `[` is literal. A `]` first in it is literal. */
function classEnd(seg, start) {
  let j = start + 1;
  if ('!^'.includes(seg[j])) j++;
  return seg.indexOf(']', j + 1);
}
