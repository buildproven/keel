import { spawnSync } from 'node:child_process';
import { globMatches } from './glob.js';

/** Prose files: no code markers in them, and a change to only these is a doc change (REQ-GATE-25). */
export const PROSE = new Set(['.md', '.txt', '.rst']);

export const matchesAny = (path, globs) => globs.some((g) => globMatches(path, g));

/**
 * Case-insensitive match for the files a tool opens by name (REQ-GATE-4): on a case-insensitive filesystem (APFS, NTFS)
 * a tool that opens `pytest.ini` reads `PYTEST.INI`. Only for `verificationPaths`: test globs are naming conventions
 * (`*Test.java` must not match `Latest.java`), and folding an allow list (`allowEdits`, `paths`) would widen it.
 */
export const fold = (path) => path.toLowerCase();
export const locksAny = (path, globs) => globs.some((g) => globMatches(fold(path), fold(g)));

// Line heuristics: they catch the common forms, not every computed or multi-line variant.
// Covers JS/TS, Python, Go, Rust, Ruby, Java/Kotlin, C#, PHP (REQ-PROJ-3).
const SKIP_MARKERS = [
  /\b(?:it|test|describe|context|suite)\.(?:skip|only|todo)\b/, // JS/TS
  /\bx(?:it|describe|test)\s*\(/, // JS/TS (xit/xdescribe)
  /\bf(?:it|describe)\s*\(/, // JS/TS (fit/fdescribe)
  /@pytest\.mark\.(?:skip|skipif|xfail)\b/, // Python (pytest)
  /@unittest\.(?:skip|expectedFailure)\b/, // Python (unittest)
  /\{\s*skip\s*:\s*true/, // generic config object
  /\bt\.Skip(?:f|Now)?\s*\(/, // Go
  /#\[(?:ignore|should_panic)\]/, // Rust
  /^\s*skip\s+["'].*["']\s+do\b/, // Ruby (minitest/rspec `skip "..." do`)
  /@(?:Disabled|Ignore)\b/, // Java/JUnit, Kotlin
  /\[Ignore(?:\(|\b)/, // C# (NUnit/MSTest)
  /->\s*markTestSkipped\s*\(/, // PHP (PHPUnit)
];

const BYPASS_MARKERS = [
  /eslint-disable/, // JS/TS
  /\/\*\s*eslint\s+[@\w/-]+\s*:/, // JS/TS inline rule config (`/* eslint rule: "off" */`)
  /\b(?:oxlint-disable|deno-lint-ignore|biome-ignore|prettier-ignore)\b/, // JS/TS linters and formatter
  /@ts-(?:ignore|nocheck|expect-error)\b/, // TS
  /:\s*any\b|\bas\s+any\b|<any>/, // TS
  /#\s*type:\s*ignore/, // Python (mypy)
  /#\s*noqa\b/, // Python (flake8/ruff)
  /#\s*ruff:\s*noqa\b/, // Python (ruff, file-level)
  /#\s*pyright:\s*(?:ignore|basic)\b/, // Python (pyright)
  /#\s*mypy:\s*(?:ignore-errors|disable-error-code)\b/, // Python (mypy, file-level)
  /#\s*pylint:\s*disable\b/, // Python (pylint)
  /--no-verify\b/, // git hook bypass
  /(?:istanbul|c8)\s+ignore/, // JS coverage
  /#\s*pragma:\s*no\s*cover/, // Python coverage
  /\/\/\s*nolint\b/, // Go (golangci-lint)
  /#\[allow\(/, // Rust
  /#\s*rubocop:disable\b/, // Ruby
  /@SuppressWarnings\s*\(/, // Java/Kotlin
  /#pragma\s+warning\s+disable\b/, // C#
  /@phpstan-ignore/, // PHP (PHPStan)
  /@psalm-suppress\b/, // PHP (Psalm)
  /#\s*shellcheck\s+disable=/, // shell
];

const hits = (lines, patterns, rule) =>
  lines
    .filter(({ text }) => patterns.some((p) => p.test(text)))
    .map(({ path, line, text }) => ({ rule, path, line, text: text.trim().slice(0, 160) }));

export const findSkipMarkers = (lines) => hits(lines, SKIP_MARKERS, 'skip-marker');
export const findBypassMarkers = (lines) => hits(lines, BYPASS_MARKERS, 'bypass-marker');

/** Changed paths that match none of the allowed globs. */
export const outOfScope = (paths, allowed) => (allowed.length ? paths.filter((p) => !matchesAny(p, allowed)) : []);

// A file an interpreter runs (`node x.mjs`, `sh ./x.sh`, `python -u x.py`) or a script executed directly (`./x.sh`).
const FILE_TOKEN =
  /(?:\b(?:node|sh|bash|zsh|python3?|tsx|ts-node|bun|deno\s+run)\s+(?:-[\w-]+\s+)*|(?:^|[;&|(]\s*))\.?\/?((?:[\w@.-]+\/)*[\w@.-]+\.(?:c?m?js|ts|sh|py))\b/g;
// A package.json script a command runs: `npm test`, `npm run x`, `pnpm run-script x`, `yarn x`, `bun run x`.
const SCRIPT_REF = /(?:^|[;&|(]\s*|\s)(?:npm|pnpm|yarn|bun)\s+(?:run(?:-script)?\s+)?([\w:.-]+)/g;

/**
 * Repo files the configured commands run (REQ-GATE-4): files named in the commands themselves and in the
 * package.json scripts they invoke, followed through scripts that run other scripts (with pre/post hooks at
 * each level; a cycle ends at the first repeat). Locked like runner configs.
 */
export function scriptPaths(pkgText, commands) {
  const { texts } = scriptWalk(pkgText === null ? {} : (JSON.parse(pkgText).scripts ?? {}), commands);
  return [...new Set(texts.flatMap((t) => [...t.matchAll(FILE_TOKEN)]).map((m) => m[1]))];
}

/**
 * The commands and the package.json scripts they run, with their pre/post hooks, followed through scripts that run
 * scripts (a cycle ends at the first repeat): `names` of the scripts and `texts` of the commands and scripts.
 */
function scriptWalk(scripts, commands) {
  const texts = [...commands];
  const names = new Set();
  for (let i = 0; i < texts.length; i++)
    for (const [, name] of texts[i].matchAll(SCRIPT_REF))
      for (const n of [`pre${name}`, name, `post${name}`])
        if (!names.has(n) && typeof scripts[n] === 'string') {
          names.add(n);
          texts.push(scripts[n]);
        }
  return { names, texts };
}

// node options that run only some tests of a file, so a file a glob names may still not run in full (REQ-GATE-33).
const TEST_FILTER = /--test-(?:name-pattern|skip-pattern|only|shard)\b/;
// A file argument: a path, a glob, or a script.
const FILE_ARG = /[/*]|\.[cm]?[jt]sx?$/;
let nodeOptions;
/**
 * The options that `node --help` of the running node lists, each true when it takes a value written `--opt value`
 * (`--import=...`), false when it takes none (`--cpu-prof`) or only with `=` (`--inspect[=port]`). Read from node itself,
 * since a hand list misses options (REQ-GATE-33).
 */
function nodeOptionValues() {
  if (!nodeOptions) {
    const help = spawnSync(process.execPath, ['--help'], { encoding: 'utf8' });
    if (help.status !== 0) throw new Error(`node --help failed: ${help.error?.message ?? help.stderr}`);
    nodeOptions = new Map();
    for (const [, short, long, value] of help.stdout.matchAll(/^ {2}(?:(-\w), )?(--?[\w-]+)(=)?/gm))
      for (const name of [short, long]) if (name) nodeOptions.set(name, Boolean(value));
  }
  return nodeOptions;
}

/**
 * The file globs that `node --test` runs in shell command `text` (REQ-GATE-33): the file arguments after `node` in each
 * part of the command that has `--test`. An unquoted `**` is the shell's, which stays in one directory like `*`; a
 * quoted one is node's own, which spans directories; `--` ends the options. None when the command filters tests by name
 * or shard or changes directory, since then a file that matches may not run in full, or the globs are not relative to
 * the repo root, or when an option `node --help` does not list comes right before a file word, which may be its value.
 */
export function nodeTestGlobs(text) {
  if (untargetable(text)) return [];
  const globs = [];
  for (const part of text.split(/[;&|\n]+/)) {
    const words = [...part.matchAll(/'([^']*)'|"([^"]*)"|(\S+)/g)].map((m) => ({ word: m[1] ?? m[2] ?? m[3], quoted: !m[3] }));
    const node = words.findIndex((w) => !w.quoted && w.word === 'node');
    if (node < 0 || !words.slice(node + 1).some((w) => w.word === '--test')) continue;
    const args = words.slice(node + 1);
    for (let i = 0, options = true; i < args.length; i++) {
      const { word, quoted } = args[i];
      if (options && word === '--') options = false;
      else if (options && word.startsWith('-')) {
        const takesValue = word.includes('=') ? false : nodeOptionValues().get(word);
        if (takesValue)
          i++; // skip the option's value
        else if (takesValue === undefined && args[i + 1] && FILE_ARG.test(args[i + 1].word)) return []; // not node's: a flag, or an option and its value?
      } else if (FILE_ARG.test(word)) globs.push(quoted ? word : word.replaceAll('**', '*'));
    }
  }
  return globs;
}

const untargetable = (text) => TEST_FILTER.test(text) || /(^|[;&|(]\s*)cd\s/.test(text);

/**
 * The `node --test` file globs that `commands` run, directly or through the package.json scripts they invoke
 * (REQ-GATE-33). None when any of them filters tests or changes directory: `npm test -- --test-name-pattern=x`
 * passes the filter on to the script.
 */
export function commandTestGlobs(pkgText, commands) {
  const { texts } = scriptWalk(pkgText === null ? {} : (JSON.parse(pkgText).scripts ?? {}), commands);
  return texts.some(untargetable) ? [] : texts.flatMap(nodeTestGlobs);
}

// package.json keys that configure a test, lint, or format tool; a change redefines "passing" (REQ-GATE-4).
const PACKAGE_TOOL_KEYS = ['jest', 'mocha', 'ava', 'c8', 'nyc', 'eslintConfig', 'eslintIgnore', 'prettier'];

/** True when the tool-config keys of package.json differ between two versions (null = file absent). */
export function packageToolConfigChanged(before, after) {
  const keys = (text) => {
    const pkg = text === null ? {} : JSON.parse(text);
    return JSON.stringify(PACKAGE_TOOL_KEYS.map((k) => pkg[k] ?? null));
  };
  return keys(before) !== keys(after);
}

/** True when package.json "scripts" differ between two versions (null = file absent). */
export function scriptsChanged(before, after) {
  const scripts = (text) => JSON.stringify(text === null ? null : (JSON.parse(text).scripts ?? {}));
  return scripts(before) !== scripts(after);
}

// Tools whose pyproject.toml tables configure tests, lint, or types; a change here redefines "passing" (REQ-PROJ-4).
// Other tables (dependencies, build-system, project metadata, other tools) stay free to change.
const LOCKED_TOOLS = new Set(['pytest', 'ruff', 'mypy', 'pyright', 'coverage']);

/** A key path that reaches a locked tool, or the bare `tool` table that can hold any of them. */
const locksTool = (parts) => parts[0] === 'tool' && (parts.length === 1 || LOCKED_TOOLS.has(parts[1]));

const ESCAPES = { b: '\b', t: '\t', n: '\n', f: '\f', r: '\r', e: '\x1b', '"': '"', '\\': '\\' };

/** A TOML basic string at s[i] (the opening quote): its decoded text and the index after it, or null if malformed. */
function basicString(s, i) {
  let out = '';
  for (let j = i + 1; j < s.length && s[j] !== '\n'; j++) {
    if (s[j] === '"') return { text: out, end: j + 1 };
    if (s[j] !== '\\') {
      out += s[j];
      continue;
    }
    const e = s[++j];
    const hex = { u: 4, U: 8, x: 2 }[e];
    if (hex) {
      const h = s.slice(j + 1, j + 1 + hex);
      if (!/^[0-9a-fA-F]+$/.test(h) || h.length !== hex) return null;
      out += String.fromCodePoint(parseInt(h, 16));
      j += hex;
    } else if (e in ESCAPES) out += ESCAPES[e];
    else return null;
  }
  return null;
}

/** A dotted TOML key at the start of s: its decoded parts and the rest of s, or null if it does not read as a key. */
function parseKey(s) {
  const parts = [];
  let i = 0;
  const ws = () => {
    while (s[i] === ' ' || s[i] === '\t') i++;
  };
  for (;;) {
    ws();
    if (s[i] === '"') {
      const str = basicString(s, i);
      if (!str) return null;
      parts.push(str.text);
      i = str.end;
    } else if (s[i] === "'") {
      const j = s.indexOf("'", i + 1);
      if (j < 0 || s.slice(i, j).includes('\n')) return null;
      parts.push(s.slice(i + 1, j));
      i = j + 1;
    } else {
      const bare = /^[A-Za-z0-9_-]+/.exec(s.slice(i));
      if (!bare) return null;
      parts.push(bare[0]);
      i += bare[0].length;
    }
    ws();
    if (s[i] !== '.') return { parts, rest: s.slice(i) };
    i++;
  }
}

/**
 * The statements of a TOML text: each table header or key/value, with every line of a multi-line value. Strings,
 * multi-line strings, comments, and open brackets are tracked, so a `[`, `#`, or newline inside them does not split
 * or start a statement.
 */
function statements(text) {
  const out = [];
  let start = 0;
  let depth = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    const triple = text.startsWith('"""', i) ? '"""' : text.startsWith("'''", i) ? "'''" : null;
    if (triple) {
      // Up to two quotes may end the content right before the closing delimiter (`""""` is `"` then `"""`).
      let j = i + 3;
      while (j < text.length && !text.startsWith(triple, j)) j += triple === '"""' && text[j] === '\\' ? 2 : 1;
      let end = j + 3;
      while (end < j + 5 && text[end] === triple[0]) end++;
      i = end - 1;
    } else if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < text.length && text[j] !== c && text[j] !== '\n') j += c === '"' && text[j] === '\\' ? 2 : 1;
      i = text[j] === c ? j : j - 1;
    } else if (c === '#') {
      while (i + 1 < text.length && text[i + 1] !== '\n') i++;
    } else if (c === '[' || c === '{') depth++;
    else if (c === ']' || c === '}') depth--;
    else if (c === '\n' && depth <= 0) {
      out.push(text.slice(start, i));
      start = i + 1;
      depth = 0;
    }
  }
  out.push(text.slice(start));
  return out;
}

/**
 * Text of the locked tool settings in a pyproject.toml (REQ-PROJ-4): every statement whose full key (its table plus
 * its own dotted key, quoted keys decoded as TOML decodes them) reaches a locked tool, or the bare `tool` table. A
 * header or key that does not read as TOML is locked, and so is everything under a header it cannot read: an unknown
 * shape fails closed.
 */
function toolSectionsText(tomlText) {
  const kept = [];
  let table = [];
  for (const statement of statements(tomlText)) {
    const t = statement.trim();
    if (!t || t.startsWith('#')) continue;
    if (t.startsWith('[')) {
      const array = t.startsWith('[[');
      const key = parseKey(t.slice(array ? 2 : 1));
      const close = array ? /^\]\]\s*(?:#.*)?$/ : /^\]\s*(?:#.*)?$/;
      table = key && close.test(key.rest) ? key.parts : null;
      if (!table || locksTool(table)) kept.push(statement);
      continue;
    }
    const key = parseKey(t);
    if (!table || !key || !/^=/.test(key.rest.trimStart()) || locksTool([...table, ...key.parts])) kept.push(statement);
  }
  return kept.join('\n');
}

/** True when the tool sections of pyproject.toml differ between two versions (null = file absent). */
export function pyprojectToolSectionsChanged(before, after) {
  const text = (t) => (t === null ? null : toolSectionsText(t));
  return text(before) !== text(after);
}

// One argument a test script may gain (REQ-GATE-42): a path or glob, optionally quoted, with no shell syntax and no
// leading `-`, so it can be neither an option nor a command.
const ARG = /^(['"]?)([\w@.*?/][\w@.*?/-]*)\1$/;

/**
 * Why a package.json `scripts` change may weaken the test run (REQ-GATE-42), or null when it is append-only: the same
 * script names, and each changed script is one the test command runs whose new text is its old text plus arguments
 * that each name test files (they match `testGlobs`) after an old text that already ends with one. A runner that
 * already lists test files only gains files; one that discovered every test would be narrowed by a first file.
 */
export function scriptsAppendOnly(before, after, commands, testGlobs) {
  if (before === null || after === null) return 'package.json is new or deleted';
  const b = JSON.parse(before).scripts ?? {};
  const a = JSON.parse(after).scripts ?? {};
  const keys = (s) => JSON.stringify(Object.keys(s).sort());
  if (keys(b) !== keys(a)) return 'a script was added or removed';
  const run = scriptWalk(b, commands).names;
  const isTestArg = (t) => {
    const m = ARG.exec(t);
    return Boolean(m) && matchesAny(m[2], testGlobs);
  };
  for (const name of Object.keys(b)) {
    if (a[name] === b[name]) continue;
    if (!run.has(name)) return `script ${name} changed, and the test command does not run it`;
    if (typeof a[name] !== 'string' || !a[name].startsWith(b[name])) return `script ${name} is not its old text with arguments appended`;
    if (!isTestArg(b[name].trim().split(/\s+/).at(-1))) return `script ${name} does not end with a test file, so a new one would narrow it`;
    const suffix = a[name].slice(b[name].length);
    // Text glued to the old last argument is not a new argument: it turns that test file into another path.
    if (!/^\s/.test(suffix)) return `script ${name} changes its last argument, so it no longer names the same test file`;
    const wrong = suffix
      .trim()
      .split(/\s+/)
      .find((t) => !isTestArg(t));
    if (wrong !== undefined) return `script ${name} gains ${JSON.stringify(wrong)}, which is not a test file`;
  }
  return null;
}

// Test declarations and assertions by line heuristics, as for skip markers (REQ-GATE-44). Named tests: JS/TS `it`/
// `test`, Ruby `it '…' do`, Python `def test_*`, Go `func Test*`. Unnamed: Rust `#[test]`, JUnit `@Test`, xUnit. Each
// pattern runs on masked code (see `masked`); a named test's name group is read from the original text at its indices.
const NAMED_TESTS = [
  /\b(?:it|test)\s*\(\s*(['"`])((?:\\.|(?!\1).)*)\1/dg,
  /\b(?:it|specify)\s+(['"])((?:\\.|(?!\1).)*)\1\s+do\b/dg,
  /^\s*(?:async\s+)?def\s+()(test\w*)/dgm,
  /^func\s+()(Test\w+)\s*\(/dgm,
];
const UNNAMED_TESTS = [/#\[test\]/g, /@Test\b/g, /\[(?:Test|Fact|Theory|TestMethod)\]/g];
const ASSERTIONS = [
  /\b(?:assert|expect|should|refute|verify)\w*(?:\.\w+)*\s*[(!]/g, // assert(, assert.equal(, assertEqual(, expect(, assert_eq!(
  /^\s*assert\s/gm, // Python `assert x`
  /\bt\.(?:Error|Errorf|Fatal|Fatalf|Fail|FailNow)\s*\(/g, // Go
];

/**
 * The code of a test file with comments and the contents of string literals blanked to spaces (newlines kept, so
 * offsets and lines match the text), so a commented-out check, or a test call or assertion written as text in a string,
 * does not count (REQ-GATE-44). Comments: `//`, `/* *\/`, and `#` at a line start or after whitespace (not `#[` or
 * `#!`). Strings: `'…'` and `"…"` end at their line, a triple-quoted one and a template literal may span lines.
 */
function masked(text) {
  const out = [...text];
  const blank = (from, to) => {
    for (let k = from; k < to; k++) if (out[k] !== '\n') out[k] = ' ';
  };
  const lineEnd = (k) => (text.indexOf('\n', k) < 0 ? text.length : text.indexOf('\n', k));
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    const two = text.slice(i, i + 2);
    if (two === '/*') {
      const end = text.indexOf('*/', i + 2);
      const stop = end < 0 ? text.length : end + 2;
      blank(i, stop);
      i = stop;
    } else if (two === '//' || (c === '#' && (i === 0 || /\s/.test(text[i - 1])) && !'[!'.includes(text[i + 1] ?? ''))) {
      const stop = lineEnd(i);
      blank(i, stop);
      i = stop;
    } else if (c === "'" || c === '"' || c === '`') {
      const triple = c !== '`' && text.startsWith(c.repeat(3), i);
      const open = triple ? 3 : 1;
      let k = i + open;
      while (k < text.length) {
        if (text[k] === '\\') k += 2;
        else if (triple ? text.startsWith(c.repeat(3), k) : text[k] === c) break;
        else if (text[k] === '\n' && c !== '`' && !triple) break;
        else k++;
      }
      blank(i + open, Math.min(k, text.length));
      i = text[k] === c ? k + open : k;
    } else i++;
  }
  return out.join('');
}
const count = (text, patterns) => patterns.reduce((n, p) => n + [...text.matchAll(p)].length, 0);

/** What an existing test file checks (REQ-GATE-44): its test names (unnamed ones as `#unnamed`), assertion count, and skip markers. */
export function testShape(text) {
  const code = masked(text);
  const tests = NAMED_TESTS.flatMap((p) => [...code.matchAll(p)].map((m) => text.slice(...m.indices[2])));
  for (let n = count(code, UNNAMED_TESTS); n > 0; n--) tests.push('#unnamed');
  const lines = text.split('\n').map((t, k) => ({ path: '', line: k + 1, text: t }));
  return { tests, assertions: count(code, ASSERTIONS), skips: findSkipMarkers(lines).length };
}
