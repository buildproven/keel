/**
 * A GitHub workflow file compared by structure (REQ-GATE-43): a small YAML subset parser and the rule that a head
 * workflow keeps every base job, step, `needs`, `if`, `run`, and check name unchanged and only adds. Zero dependencies:
 * Node has no YAML parser. Anything outside the subset (anchors, aliases, tags, multi-line plain or quoted scalars,
 * multi-line flow collections, tabs, several documents, duplicate keys) throws, so an unread shape stays locked.
 */

export class Unparsed extends Error {}
const bad = (n, why) => {
  throw new Unparsed(`line ${n + 1}: ${why}`);
};

// A block mapping key: double-quoted, single-quoted, or plain (no indicator first, ends at the first `: ` or `:` at end).
const KEY = /^("(?:[^"\\]|\\.)*"|'(?:[^']|'')*'|[^\s"'#&*!|>%@`{}[\],?:-][^#]*?)\s*:(?:\s+(.*))?$/;
const isItem = (s) => s === '-' || s.startsWith('- ');
const indentOf = (l) => l.length - l.trimStart().length;
const blank = (l) => l.trim() === '' || l.trimStart().startsWith('#');

/** Scalars keep how they were written: `p:` plain, `s:` single-, `d:` double-quoted, `b<style><chomp>:` block. */
const keyText = (k, n) => {
  if (k.startsWith('"') && k.includes('\\')) bad(n, 'an escape in a double-quoted key');
  return k.startsWith('"') ? `d:${k.slice(1, -1)}` : k.startsWith("'") ? `s:${k.slice(1, -1)}` : k;
};

/** A plain scalar ends at ` #` (a comment); a `: ` inside one is not YAML in block context. */
function plain(text, n) {
  const v = text.replace(/\s+#.*$/, '').trimEnd();
  if (/:\s/.test(v) || v.endsWith(':')) bad(n, 'a ": " inside a plain value');
  return `p:${v}`;
}

/** A quoted scalar at the start of `text` and what follows it, which may only be a comment. */
function quoted(text, n) {
  const m = text[0] === '"' ? /^"((?:[^"\\]|\\.)*)"/.exec(text) : /^'((?:[^']|'')*)'/.exec(text);
  if (!m) bad(n, 'a quoted value that does not end on its line');
  // An escape could spell `${{` or anything else the checks look for, so a decoded value would differ from the text.
  if (text[0] === '"' && m[1].includes('\\')) bad(n, 'an escape in a double-quoted value');
  return { value: `${text[0] === '"' ? 'd' : 's'}:${m[1]}`, rest: text.slice(m[0].length) };
}

/** A one-line flow collection (`[a, b]`, `{a: b}`); nested ones too. Returns the value and the index after it. */
function flow(s, i, n) {
  const ws = () => {
    while (s[i] === ' ') i++;
  };
  const node = () => {
    ws();
    if (s[i] === '[' || s[i] === '{') {
      const close = s[i] === '[' ? ']' : '}';
      const list = close === ']' ? [] : new Map();
      i++;
      ws();
      while (s[i] !== close) {
        if (i >= s.length) bad(n, 'a flow collection that does not end on its line');
        if (close === ']') list.push(node());
        else {
          const k = node();
          ws();
          if (s[i] !== ':') bad(n, 'a flow mapping entry without ":"');
          i++;
          if (list.has(k)) bad(n, `duplicate key ${k}`);
          list.set(k, node());
        }
        ws();
        if (s[i] === ',') i++;
        else if (s[i] !== close) bad(n, 'a flow collection that does not end on its line');
        ws();
      }
      i++;
      return list;
    }
    if (s[i] === '"' || s[i] === "'") {
      const q = quoted(s.slice(i), n);
      i = s.length - q.rest.length;
      return q.value;
    }
    const m = /^[^,[\]{}#"'&*!|>%@`:]+/.exec(s.slice(i));
    if (!m) bad(n, 'a flow value outside the subset');
    i += m[0].length;
    return `p:${m[0].trim()}`;
  };
  const value = node();
  return { value, end: i };
}

/** Parse a workflow file into Maps, arrays, scalar strings, and null; throws Unparsed outside the subset. */
export function parseWorkflow(text) {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  let i = 0;
  lines.forEach((l, n) => {
    if (/^\s*\t/.test(l) && l.trim() !== '') bad(n, 'a tab in the indentation');
    if (/^(?:---|\.\.\.)(?:\s|$)/.test(l) && !(n === 0 && l.trim() === '---')) bad(n, 'more than one YAML document');
    if (/^%/.test(l)) bad(n, 'a YAML directive');
  });
  if (lines[0]?.trim() === '---') i = 1;
  const skip = () => {
    while (i < lines.length && blank(lines[i])) i++;
  };

  /** The node under a key or item at `parent` indent: deeper lines, else null. */
  function block(parent) {
    skip();
    if (i >= lines.length || indentOf(lines[i]) <= parent) return null;
    const ind = indentOf(lines[i]);
    return isItem(lines[i].trimStart()) ? seq(ind) : map(ind);
  }

  /** The value after `key:` or `- ` on line n (already consumed), at indent `ind`. */
  function value(rest, ind, n, inMap) {
    const r = (rest ?? '').trim();
    if (r === '' || r.startsWith('#')) {
      skip();
      if (inMap && i < lines.length && indentOf(lines[i]) === ind && isItem(lines[i].trimStart())) return seq(ind);
      return block(ind);
    }
    let out;
    if (r[0] === '|' || r[0] === '>') return blockScalar(r, ind, n);
    if (/^[&*!%@`?]/.test(r)) bad(n, 'an anchor, alias, tag, or reserved indicator');
    if (r[0] === '"' || r[0] === "'") {
      const q = quoted(r, n);
      if (q.rest.trim() && !/^\s+#/.test(q.rest)) bad(n, 'text after a quoted value');
      out = q.value;
    } else if (r[0] === '[' || r[0] === '{') {
      const f = flow(r, 0, n);
      const after = r.slice(f.end);
      if (after.trim() && !/^\s+#/.test(after)) bad(n, 'text after a flow collection');
      out = f.value;
    } else out = plain(r, n);
    skip();
    if (i < lines.length && indentOf(lines[i]) > ind) bad(i, 'a value that goes on to the next line');
    return out;
  }

  function blockScalar(header, ind, n) {
    const h = /^([|>])([-]?)\s*(?:#.*)?$/.exec(header);
    if (!h) bad(n, 'a block scalar header outside the subset');
    let end = i;
    while (end < lines.length && (lines[end].trim() === '' || indentOf(lines[end]) > ind)) end++;
    const body = lines.slice(i, end);
    while (body.length && body.at(-1).trim() === '') body.pop();
    i = end;
    const first = body.find((l) => l.trim() !== '');
    if (!first) return `b${h[1]}${h[2]}:`;
    const ci = indentOf(first);
    if (body.some((l) => l.trim() !== '' && indentOf(l) < ci)) bad(n, 'a block scalar line less indented than its first');
    return `b${h[1]}${h[2]}:${body.map((l) => (l.length > ci ? l.slice(ci) : '')).join('\n')}`;
  }

  function map(ind) {
    const out = new Map();
    for (;;) {
      skip();
      if (i >= lines.length) break;
      const l = lines[i];
      const li = indentOf(l);
      if (li < ind) break;
      if (li > ind) bad(i, 'unexpected indentation');
      if (isItem(l.trimStart())) break;
      const m = KEY.exec(l.slice(ind).trimEnd());
      if (!m) bad(i, 'not a "key: value" line');
      const key = keyText(m[1], i);
      if (out.has(key)) bad(i, `duplicate key ${key}`);
      const n = i++;
      out.set(key, value(m[2], ind, n, true));
    }
    return out;
  }

  function seq(ind) {
    const out = [];
    for (;;) {
      skip();
      if (i >= lines.length) break;
      const l = lines[i];
      const li = indentOf(l);
      if (li < ind) break;
      if (li > ind) bad(i, 'unexpected indentation');
      if (!isItem(l.trimStart())) break;
      const after = l.slice(ind + 1);
      const content = after.trimStart();
      if (content === '' || content.startsWith('#')) {
        i++;
        out.push(block(ind));
        continue;
      }
      const col = ind + 1 + (after.length - content.length);
      if (isItem(content) || KEY.test(content.trimEnd())) {
        lines[i] = ' '.repeat(col) + content; // the item's first line, read as the first line of a nested block
        out.push(isItem(content) ? seq(col) : map(col));
      } else {
        const n = i++;
        out.push(value(content, ind, n, false));
      }
    }
    return out;
  }

  skip();
  const root = i < lines.length ? (isItem(lines[i].trimStart()) ? seq(indentOf(lines[i])) : map(indentOf(lines[i]))) : null;
  skip();
  if (i < lines.length) bad(i, 'a line outside the document structure');
  return root;
}

const isMap = (x) => x instanceof Map;

/** Structural equality of parsed values; mapping key order does not count, list order does. */
export function same(a, b) {
  if (Array.isArray(a)) return Array.isArray(b) && a.length === b.length && a.every((x, k) => same(x, b[k]));
  if (isMap(a)) return isMap(b) && a.size === b.size && [...a].every(([k, v]) => b.has(k) && same(v, b.get(k)));
  return a === b;
}

/** Every key of a and b except `except`: the first that is missing, added, or different, as a phrase, or null. */
function diffKeys(a, b, except) {
  for (const k of new Set([...a.keys(), ...b.keys()])) {
    if (k === except) continue;
    if (!b.has(k)) return `removes ${k}`;
    if (!a.has(k)) return `adds ${k}`;
    if (!same(a.get(k), b.get(k))) return `changes ${k}`;
  }
  return null;
}

// What an added step may hold (REQ-GATE-43): a plain shell command, nothing that changes its privileges or inputs.
const STEP_KEYS = new Set(['name', 'run', 'shell', 'working-directory', 'timeout-minutes']);

/**
 * Why an added step could do more than the candidate's own test code already does in a base step, or null: it must be a
 * `run` step with only STEP_KEYS and no `${{ }}` anywhere, so it cannot read secrets or tokens, call an action, set an
 * environment, or change permissions. Code it runs is candidate code, as a new test is.
 */
function addedStepRisk(step, where) {
  if (!isMap(step)) return `${where} is not a mapping`;
  if (!step.has('run')) return `${where} is not a run step`;
  const extra = [...step.keys()].find((k) => !STEP_KEYS.has(k));
  if (extra) return `${where} sets ${extra}`;
  if ([...step.values()].some((v) => typeof v === 'string' && v.includes('${{'))) return `${where} has a \${{ }} expression`;
  return null;
}

/** Every scalar in a parsed value, as written. */
const scalars = (v) => (Array.isArray(v) ? v.flatMap(scalars) : isMap(v) ? [...v].flatMap(([k, x]) => [k, ...scalars(x)]) : v ? [v] : []);

/**
 * Why a step added to base job `job` could reach more than the candidate's code already reaches in that job, or null.
 * The job must already run a configured command (`commands`: the test command and checks) in a base run step, so
 * candidate code already runs there with the job's environment and token; and neither the job nor the workflow may
 * hold a `${{ }}` expression outside `if` (a secret or the token, in any spelling), set an environment, or grant a write or id-token permission, which a later step could
 * read even when the step that used them did not.
 */
function jobRisk(top, job, id, commands) {
  const steps = Array.isArray(job.get('steps')) ? job.get('steps') : [];
  const runs = steps
    .filter(isMap)
    .map((s) => s.get('run'))
    .filter((r) => typeof r === 'string');
  if (!runs.some((r) => commands.some((c) => c && r.includes(c))))
    return `job ${id} runs no configured check or test command, so an added step would run candidate code where none ran`;
  // Any expression outside `if` could put a secret or the token (in any spelling) where a later step reads it: env,
  // GITHUB_ENV, a checkout's git config. Fail closed rather than list spellings.
  const exprs = [...[...job].filter(([k]) => k !== 'if'), ['env', top.get('env')], ['defaults', top.get('defaults')]];
  if (exprs.some(([, v]) => scalars(v).some((x) => x.includes('${{'))))
    return `job ${id} or the workflow env has a \${{ }} expression, which could hold a secret or the token`;
  if (job.has('environment')) return `job ${id} has a deployment environment`;
  const perms = [job.get('permissions'), top.get('permissions')].flatMap(scalars);
  if (perms.some((x) => /write/.test(x))) return `job ${id} or the workflow grants a write or id-token permission`;
  return null;
}

/**
 * Why the head workflow may drop or weaken a base check (REQ-GATE-43), or null when it only adds steps. Top level:
 * only `jobs` may change, and only by its base jobs. A base job keeps its id and every key unchanged; its `steps` keep
 * every base step unchanged, in order, and may only gain plain run steps after them (an earlier step could change what
 * a base step checks). A new job stays locked: it could report a check name a required check uses, here, in another
 * workflow, or from another app.
 */
export function workflowWeakened(baseText, headText, commands = []) {
  let b, h;
  try {
    b = parseWorkflow(baseText);
    h = parseWorkflow(headText);
  } catch (e) {
    if (e instanceof Unparsed) return `cannot parse the workflow (${e.message})`;
    throw e;
  }
  if (!isMap(b) || !isMap(h)) return 'cannot parse the workflow (not a mapping)';
  const top = diffKeys(b, h, 'jobs');
  if (top) return top.replace(/^(\w+) /, '$1 top-level ');
  const bj = b.get('jobs');
  const hj = h.get('jobs');
  if (!isMap(bj) || !isMap(hj)) return same(bj, hj) ? null : 'changes top-level jobs';
  for (const [id, job] of bj) {
    const head = hj.get(id);
    if (!hj.has(id)) return `removes job ${id}`;
    if (!isMap(job) || !isMap(head)) {
      if (!same(job, head)) return `changes job ${id}`;
      continue;
    }
    const keys = diffKeys(job, head, 'steps');
    if (keys) return `job ${id}: ${keys}`;
    const bs = job.get('steps') ?? [];
    const hs = head.get('steps') ?? [];
    if (!Array.isArray(bs) || !Array.isArray(hs)) {
      if (!same(bs, hs)) return `job ${id}: changes steps`;
      continue;
    }
    for (let k = 0; k < bs.length; k++)
      if (!same(bs[k], hs[k])) return `${k < hs.length ? 'changes' : 'removes'} step ${k + 1} of job ${id}`;
    if (hs.length > bs.length) {
      const risk = jobRisk(b, job, id, commands);
      if (risk) return risk;
    }
    for (let k = bs.length; k < hs.length; k++) {
      const risk = addedStepRisk(hs[k], `added step ${k + 1} of job ${id}`);
      if (risk) return risk;
    }
  }
  for (const id of hj.keys()) if (!bj.has(id)) return `adds job ${id}; a new job could report a required check name`;
  return null;
}
