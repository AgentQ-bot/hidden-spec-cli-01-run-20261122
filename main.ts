// main.ts is mend, the CLI SPEC.md specifies. Node 22 and its standard library alone;
// run it as `node main.ts [options] [PATCH]`.
//
// Implements SPEC.md in full: the command line, output and exit codes, safe paths,
// format detection, line matching at three tiers (section 5), unified diffs (section 6),
// SEARCH/REPLACE blocks (section 7), V4A patches (section 8), JSON edits (section 9),
// and the all-or-nothing write with move reporting (section 10, section 2).
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and this file
// hands over to runner.ts (the last lines below): keep that hand-over and runner.ts as they are.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** A file as lines plus its own line break and whether it ends with one (SPEC section 3). */
interface FileModel {
  lines: string[];
  br: string;
  final: boolean;
}

function splitFile(text: string): FileModel {
  if (text === '') return { lines: [], br: '\n', final: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const final = text.endsWith(br);
  if (final) parts.pop();
  return { lines: parts, br, final };
}

function joinFile(f: FileModel): string {
  if (f.lines.length === 0) return '';
  return f.lines.join(f.br) + (f.final ? f.br : '');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  readonly moves: { old: string; nw: string }[] = [];
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
  recordMove(oldP: string, newP: string): void {
    this.moves.push({ old: oldP, nw: newP });
  }
}

type Edit = (tree: Tree) => void;

/* ------------------------------------------------------------------ */
/* Section 5: matching lines at three tiers                            */
/* ------------------------------------------------------------------ */

function normLine(line: string, tier: number): string {
  if (tier === 0) return line;
  if (tier === 1) return line.replace(/[ \t]+$/, '');
  return line.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
}

function occurrencesAt(O: string[], F: string[], tier: number, from: number): number[] {
  const out: number[] = [];
  if (O.length === 0) return out;
  const nO = O.map((l) => normLine(l, tier));
  for (let i = Math.max(0, from); i + O.length <= F.length; i++) {
    let ok = true;
    for (let j = 0; j < O.length; j++) {
      if (normLine(F[i + j]!, tier) !== nO[j]) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

/** First tier (0, 1, 2; strict: 0 only) at which O occurs at least once, at or after `from`. */
function findTier(O: string[], F: string[], strict: boolean, from = 0): { tier: number; occ: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const occ = occurrencesAt(O, F, t, from);
    if (occ.length > 0) return { tier: t, occ };
  }
  return null;
}

/** First line at or after `from` equal to `line` at the first tier where one is (single line). */
function findSingleLine(F: string[], from: number, line: string, strict: boolean): number {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const want = normLine(line, t);
    for (let i = Math.max(0, from); i < F.length; i++) {
      if (normLine(F[i]!, t) === want) return i;
    }
  }
  return -1;
}

function leadingWs(s: string): string {
  const m = /^[ \t]*/.exec(s);
  return m ? m[0] : '';
}

interface NLine {
  text: string;
  ctx: boolean;
  oPos: number;
}

/**
 * Build the replacement lines for N (section 5): a context line is written as the file's
 * own matched line; at tier 2 every other line is re-indented (P, the leading whitespace
 * of O's first line, replaced by F, the leading whitespace of the file's first matched line).
 */
function buildReplacement(N: NLine[], O: string[], fileLines: string[], pos: number, tier: number): string[] {
  if (tier !== 2) return N.map((n) => (n.ctx ? fileLines[pos + n.oPos]! : n.text));
  const F = leadingWs(fileLines[pos] ?? '');
  const P = leadingWs(O[0] ?? '');
  return N.map((n) => {
    if (n.ctx) return fileLines[pos + n.oPos]!;
    const t = n.text;
    if (t === '' || t.trim() === '') return t;
    if (t.startsWith(P)) return F + t.slice(P.length);
    return t;
  });
}

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const model = splitFile(before);
      if (line < 0 || line > model.lines.length) throw new Fail('no-match', p);
      model.lines.splice(line, 0, ...add);
      tree.now.set(p, joinFile(model));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

/* ------------------------------------------------------------------ */
/* Section 6: unified diffs                                            */
/* ------------------------------------------------------------------ */

type BodyKind = 'ctx' | 'old' | 'new' | 'bs';
interface BodyLine {
  kind: BodyKind;
  text: string;
}
interface Hunk {
  a: number;
  body: BodyLine[];
}

/** Does a `\` line follow the hunk's last context or `+` line? */
function bsAfterLastCtxOrPlus(h: Hunk): boolean {
  let last = -1;
  for (let i = 0; i < h.body.length; i++) {
    if (h.body[i]!.kind === 'ctx' || h.body[i]!.kind === 'new') last = i;
  }
  if (last < 0) return false;
  return h.body[last + 1]?.kind === 'bs';
}

/** Split a hunk body into O (context + `-`) and N (context + `+`) line lists. */
function hunkON(h: Hunk): { O: string[]; N: NLine[] } {
  const O: string[] = [];
  const N: NLine[] = [];
  for (const b of h.body) {
    if (b.kind === 'ctx') {
      N.push({ text: b.text, ctx: true, oPos: O.length });
      O.push(b.text);
    } else if (b.kind === 'old') {
      O.push(b.text);
    } else if (b.kind === 'new') {
      N.push({ text: b.text, ctx: false, oPos: -1 });
    }
  }
  return { O, N };
}

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@( .*)?$/;

interface UniSection {
  oldP: string | null;
  newP: string | null;
  renameFrom: string | null;
  renameTo: string | null;
  diffOld: string | null;
  diffNew: string | null;
  hasPair: boolean;
  newFile: boolean;
  deletedFile: boolean;
  hunks: Hunk[];
}

function stripAB(p: string): string {
  return p.startsWith('a/') || p.startsWith('b/') ? p.slice(2) : p;
}

/** Path after `--- ` / `+++ `: text after the four characters, up to the first tab, trimmed. */
function headerPath(line: string): string {
  const rest = line.slice(4);
  const tab = rest.indexOf('\t');
  return (tab >= 0 ? rest.slice(0, tab) : rest).trim();
}

function parseUnified(lines: string[], strict: boolean): Edit[] {
  const sections: UniSection[] = [];
  let cur: UniSection | null = null;
  const newSection = (): UniSection => {
    const s: UniSection = {
      oldP: null,
      newP: null,
      renameFrom: null,
      renameTo: null,
      diffOld: null,
      diffNew: null,
      hasPair: false,
      newFile: false,
      deletedFile: false,
      hunks: [],
    };
    sections.push(s);
    return s;
  };

  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.startsWith('diff --git ')) {
      const m = /^diff --git a\/(\S+) b\/(\S+)$/.exec(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      cur = newSection();
      cur.diffOld = m[1]!;
      cur.diffNew = m[2]!;
      i++;
      continue;
    }
    if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      if (cur === null || cur.hasPair || cur.hunks.length > 0) {
        cur = newSection();
      }
      cur.oldP = stripAB(headerPath(line));
      cur.newP = stripAB(headerPath(lines[i + 1]!));
      cur.hasPair = true;
      i += 2;
      continue;
    }
    if (line.startsWith('--- ')) {
      // A `--- ` line not followed by `+++ `, inside a section's header.
      if (cur !== null && cur.hunks.length === 0) throw new Exit2(`error: parse ${i + 2}`);
      i++;
      continue;
    }
    if (line.startsWith('@@')) {
      if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
      const m = HUNK_RE.exec(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      const a = Number(m[1]);
      i++;
      // Hunk body: lines starting with ' ', '-', '+', '\', or empty; ends at the first
      // other line, at a `diff --git ` line, or at a `--- ` line followed by `+++ `.
      const body: BodyLine[] = [];
      while (i < lines.length) {
        const bl = lines[i]!;
        if (bl.startsWith('diff --git ')) break;
        if (bl.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) break;
        if (bl === '') body.push({ kind: 'ctx', text: '' });
        else if (bl[0] === ' ') body.push({ kind: 'ctx', text: bl.slice(1) });
        else if (bl[0] === '-') body.push({ kind: 'old', text: bl.slice(1) });
        else if (bl[0] === '+') body.push({ kind: 'new', text: bl.slice(1) });
        else if (bl[0] === '\\') body.push({ kind: 'bs', text: bl });
        else break;
        i++;
      }
      // Empty lines at the end of a body are not part of it.
      while (body.length > 0 && body[body.length - 1]!.kind === 'ctx' && body[body.length - 1]!.text === '') body.pop();
      cur.hunks.push({ a, body });
      continue;
    }
    if (cur !== null && cur.hunks.length === 0) {
      // Section header lines.
      if (line.startsWith('+++ ')) {
        if (cur.newP === null) cur.newP = stripAB(headerPath(line));
      } else if (line.startsWith('rename from ')) {
        cur.renameFrom = line.slice('rename from '.length);
      } else if (line.startsWith('rename to ')) {
        cur.renameTo = line.slice('rename to '.length);
      } else if (line.startsWith('new file mode')) {
        cur.newFile = true;
      } else if (line.startsWith('deleted file mode')) {
        cur.deletedFile = true;
      }
      // `index`, `old mode`, `new mode`, `similarity index`, `dissimilarity index`,
      // `Index:` and any other line are ignored.
    }
    // Outside bodies, lines that are not part of a section header are ignored.
    i++;
  }

  const edits: Edit[] = [];
  for (const s of sections) {
    const rawOld = s.hasPair ? s.oldP : (s.renameFrom ?? s.diffOld);
    const rawNew = s.hasPair ? s.newP : (s.renameTo ?? s.diffNew);
    const oldP = rawOld === '/dev/null' ? null : rawOld;
    const newP = rawNew === '/dev/null' ? null : rawNew;
    const isCreate = oldP === null || s.newFile;
    const isDelete = newP === null || s.deletedFile;
    const hunks = s.hunks;
    edits.push((tree) => {
      if (oldP !== null && !safe(oldP)) throw new Fail('unsafe', oldP);
      if (newP !== null && newP !== oldP && !safe(newP)) throw new Fail('unsafe', newP);
      if (isCreate && newP !== null) {
        if (tree.get(newP) !== null) throw new Fail('exists', newP);
        const plus: string[] = [];
        for (const h of hunks) for (const b of h.body) if (b.kind === 'new') plus.push(b.text);
        let noFinal = false;
        for (let hi = hunks.length - 1; hi >= 0; hi--) {
          const h = hunks[hi]!;
          let lastPlus = -1;
          for (let bi = 0; bi < h.body.length; bi++) if (h.body[bi]!.kind === 'new') lastPlus = bi;
          if (lastPlus >= 0) {
            noFinal = h.body[lastPlus + 1]?.kind === 'bs';
            break;
          }
        }
        tree.now.set(newP, plus.length === 0 ? '' : plus.join('\n') + (noFinal ? '' : '\n'));
        return;
      }
      if (isDelete && oldP !== null) {
        if (tree.get(oldP) === null) throw new Fail('missing', oldP);
        tree.now.set(oldP, null);
        return;
      }
      if (oldP === null || newP === null) return; // degenerate section: no file either side.
      const before = tree.get(oldP);
      if (before === null) throw new Fail('missing', oldP);
      const isMove = oldP !== newP;
      if (isMove && tree.get(newP) !== null) throw new Fail('exists', newP);
      const model = splitFile(before);
      let d = 0;
      for (const h of hunks) {
        const { O, N } = hunkON(h);
        if (O.length === 0) {
          const idx = Math.min(Math.max(h.a + d, 0), model.lines.length);
          const wasEnd = idx === model.lines.length;
          const R = N.map((n) => n.text);
          model.lines.splice(idx, 0, ...R);
          if (wasEnd) model.final = !bsAfterLastCtxOrPlus(h);
          d += N.length;
          continue;
        }
        const found = findTier(O, model.lines, strict);
        if (found === null) throw new Fail('no-match', oldP);
        const target = h.a - 1 + d;
        let pos = found.occ[0]!;
        let best = Math.abs(pos - target);
        for (const p of found.occ) {
          const dist = Math.abs(p - target);
          if (dist < best) {
            best = dist;
            pos = p;
          }
        }
        const R = buildReplacement(N, O, model.lines, pos, found.tier);
        const atEnd = pos + O.length === model.lines.length;
        model.lines.splice(pos, O.length, ...R);
        if (atEnd) model.final = !bsAfterLastCtxOrPlus(h);
        d += N.length - O.length;
      }
      const out = joinFile(model);
      if (isMove) {
        tree.now.set(oldP, null);
        tree.now.set(newP, out);
        tree.recordMove(oldP, newP);
      } else {
        tree.now.set(oldP, out);
      }
    });
  }
  return edits;
}

/* ------------------------------------------------------------------ */
/* Section 7: SEARCH/REPLACE blocks                                    */
/* ------------------------------------------------------------------ */

function parseSearchReplace(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevEnd = 0; // first line index a path search may use (after the previous block)
  let prevPath: string | null = null;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i++;
      continue;
    }
    const s = i;
    // Find `=======` after SEARCH, then `>>>>>>> REPLACE` after that.
    let eq = -1;
    for (let j = s + 1; j < lines.length; j++) {
      const t = lines[j]!.trimEnd();
      if (t === '=======') {
        eq = j;
        break;
      }
      if (t === '>>>>>>> REPLACE' || t === '<<<<<<< SEARCH') break;
    }
    if (eq < 0) throw new Exit2(`error: parse ${s + 1}`);
    let rep = -1;
    for (let j = eq + 1; j < lines.length; j++) {
      const t = lines[j]!.trimEnd();
      if (t === '>>>>>>> REPLACE') {
        rep = j;
        break;
      }
      if (t === '<<<<<<< SEARCH') break;
    }
    if (rep < 0) throw new Exit2(`error: parse ${s + 1}`);
    // The path is the nearest line before SEARCH, after the previous block, that is
    // not blank and does not start with three backticks (surrounding whitespace removed).
    let path: string | null = null;
    for (let j = s - 1; j >= prevEnd; j--) {
      const l = lines[j]!;
      if (blank(l)) continue;
      if (l.trim().startsWith('```')) continue;
      path = l.trim();
      break;
    }
    if (path === null) {
      if (prevPath === null) throw new Exit2(`error: parse ${s + 1}`);
      path = prevPath;
    }
    const oldLines = lines.slice(s + 1, eq);
    const newLines = lines.slice(eq + 1, rep);
    prevPath = path;
    prevEnd = rep + 1;
    i = rep + 1;
    edits.push((tree) => {
      if (!safe(path!)) throw new Fail('unsafe', path!);
      if (oldLines.length === 0) {
        if (tree.get(path!) !== null) throw new Fail('exists', path!);
        tree.now.set(path!, newLines.length === 0 ? '' : newLines.join('\n') + '\n');
        return;
      }
      const before = tree.get(path!);
      if (before === null) throw new Fail('missing', path!);
      const model = splitFile(before);
      const found = findTier(oldLines, model.lines, strict);
      if (found === null) throw new Fail('no-match', path!);
      if (found.occ.length > 1) throw new Fail('ambiguous', path!);
      const pos = found.occ[0]!;
      const N: NLine[] = newLines.map((t) => ({ text: t, ctx: false, oPos: -1 }));
      const R = buildReplacement(N, oldLines, model.lines, pos, found.tier);
      model.lines.splice(pos, oldLines.length, ...R);
      tree.now.set(path!, joinFile(model));
    });
  }
  return edits;
}

/* ------------------------------------------------------------------ */
/* Section 8: V4A patches                                               */
/* ------------------------------------------------------------------ */

interface V4aChunk {
  anchor: string | null;
  eof: boolean;
  body: BodyLine[];
}
interface V4aSection {
  kind: 'add' | 'delete' | 'update';
  path: string;
  moveTo: string | null;
  addLines: string[];
  chunks: V4aChunk[];
  updateLine: number; // 1-based line of the `*** Update File:` line, for parse errors
}

function v4aSectionStart(line: string): { kind: 'add' | 'delete' | 'update'; path: string } | null {
  if (line.startsWith('*** Add File: ')) return { kind: 'add', path: line.slice('*** Add File: '.length).trim() };
  if (line.startsWith('*** Delete File: ')) return { kind: 'delete', path: line.slice('*** Delete File: '.length).trim() };
  if (line.startsWith('*** Update File: ')) return { kind: 'update', path: line.slice('*** Update File: '.length).trim() };
  return null;
}

function parseV4a(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!blank(lines[i]!)) {
      last = i;
      break;
    }
  }
  if (last < 0 || lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);

  const sections: V4aSection[] = [];
  let i = first + 1;
  while (i < last) {
    const line = lines[i]!;
    if (blank(line)) {
      i++;
      continue;
    }
    const start = v4aSectionStart(line);
    if (start === null) throw new Exit2(`error: parse ${i + 1}`);
    if (start.kind === 'add') {
      const rawAdd: { text: string; num: number }[] = [];
      i++;
      while (i < last) {
        const l = lines[i]!;
        if (v4aSectionStart(l) !== null || l.trim() === '*** End Patch') break;
        rawAdd.push({ text: l, num: i + 1 });
        i++;
      }
      // Blank lines at the end of a section are not part of it.
      while (rawAdd.length > 0 && blank(rawAdd[rawAdd.length - 1]!.text)) rawAdd.pop();
      const content: string[] = [];
      for (const { text, num } of rawAdd) {
        if (text === '') content.push('');
        else if (text[0] === '+') content.push(text.slice(1));
        else throw new Exit2(`error: parse ${num}`);
      }
      sections.push({ kind: 'add', path: start.path, moveTo: null, addLines: content, chunks: [], updateLine: 0 });
      continue;
    }
    if (start.kind === 'delete') {
      sections.push({ kind: 'delete', path: start.path, moveTo: null, addLines: [], chunks: [], updateLine: 0 });
      i++;
      continue;
    }
    // Update File section.
    const updateLine = i + 1;
    let moveTo: string | null = null;
    i++;
    if (i < last && lines[i]!.startsWith('*** Move to: ')) {
      moveTo = lines[i]!.slice('*** Move to: '.length).trim();
      i++;
    }
    // Collect the section's raw lines (until the next section or End Patch),
    // then strip blank lines at the end of the section.
    const raw: { text: string; num: number }[] = [];
    while (i < last) {
      const l = lines[i]!;
      if (v4aSectionStart(l) !== null || l.trim() === '*** End Patch') break;
      raw.push({ text: l, num: i + 1 });
      i++;
    }
    while (raw.length > 0 && blank(raw[raw.length - 1]!.text)) raw.pop();
    // Parse chunks from the raw lines.
    const chunks: V4aChunk[] = [];
    let chunk: V4aChunk | null = null;
    let afterEof = false;
    const closeChunk = (): void => {
      if (chunk !== null) {
        chunks.push(chunk);
        chunk = null;
      }
    };
    for (const { text, num } of raw) {
      if (text.startsWith('@@')) {
        closeChunk();
        afterEof = false;
        const anchor = text.slice(2).trim();
        chunk = { anchor: anchor === '' ? null : anchor, eof: false, body: [] };
        continue;
      }
      if (text === '*** End of File') {
        if (chunk === null) throw new Exit2(`error: parse ${num}`);
        chunk.eof = true;
        closeChunk();
        afterEof = true;
        continue;
      }
      const isBody = text === '' || text[0] === ' ' || text[0] === '-' || text[0] === '+';
      if (!isBody) throw new Exit2(`error: parse ${num}`);
      if (afterEof) throw new Exit2(`error: parse ${num}`);
      if (chunk === null) {
        // First chunk may start at a body line.
        chunk = { anchor: null, eof: false, body: [] };
      }
      if (text === '') chunk.body.push({ kind: 'ctx', text: '' });
      else if (text[0] === ' ') chunk.body.push({ kind: 'ctx', text: text.slice(1) });
      else if (text[0] === '-') chunk.body.push({ kind: 'old', text: text.slice(1) });
      else chunk.body.push({ kind: 'new', text: text.slice(1) });
    }
    closeChunk();
    if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${updateLine}`);
    sections.push({ kind: 'update', path: start.path, moveTo, addLines: [], chunks, updateLine });
  }

  const edits: Edit[] = [];
  for (const s of sections) {
    if (s.kind === 'add') {
      const p = s.path;
      const content = s.addLines.length === 0 ? '' : s.addLines.join('\n') + '\n';
      edits.push((tree) => {
        if (!safe(p)) throw new Fail('unsafe', p);
        if (tree.get(p) !== null) throw new Fail('exists', p);
        tree.now.set(p, content);
      });
      continue;
    }
    if (s.kind === 'delete') {
      const p = s.path;
      edits.push((tree) => {
        if (!safe(p)) throw new Fail('unsafe', p);
        if (tree.get(p) === null) throw new Fail('missing', p);
        tree.now.set(p, null);
      });
      continue;
    }
    const p = s.path;
    const moveTo = s.moveTo;
    const chunks = s.chunks;
    edits.push((tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (moveTo !== null && !safe(moveTo)) throw new Fail('unsafe', moveTo);
      const before = tree.get(p);
      if (before === null) throw new Fail('missing', p);
      if (moveTo !== null && tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
      const model = splitFile(before);
      let cursor = 0;
      for (const ch of chunks) {
        if (ch.anchor !== null) {
          const idx = findSingleLine(model.lines, cursor, ch.anchor, strict);
          if (idx < 0) throw new Fail('no-match', p);
          cursor = idx + 1;
        }
        const O: string[] = [];
        const N: NLine[] = [];
        for (const b of ch.body) {
          if (b.kind === 'ctx') {
            N.push({ text: b.text, ctx: true, oPos: O.length });
            O.push(b.text);
          } else if (b.kind === 'old') {
            O.push(b.text);
          } else if (b.kind === 'new') {
            N.push({ text: b.text, ctx: false, oPos: -1 });
          }
        }
        if (O.length === 0) {
          const at = ch.eof ? model.lines.length : cursor;
          const R = N.map((n) => n.text);
          model.lines.splice(at, 0, ...R);
          cursor = at + R.length;
          continue;
        }
        // Occurrences at or after the cursor, at the first tier with one; an
        // end-of-file chunk takes only an occurrence ending at the last line.
        let found: { tier: number; occ: number[] } | null = null;
        const tiers = strict ? [0] : [0, 1, 2];
        for (const t of tiers) {
          let occ = occurrencesAt(O, model.lines, t, cursor);
          if (ch.eof) occ = occ.filter((pos) => pos + O.length === model.lines.length);
          if (occ.length > 0) {
            found = { tier: t, occ };
            break;
          }
        }
        if (found === null) throw new Fail('no-match', p);
        const pos = found.occ[0]!;
        const R = buildReplacement(N, O, model.lines, pos, found.tier);
        model.lines.splice(pos, O.length, ...R);
        cursor = pos + R.length;
      }
      const out = joinFile(model);
      if (moveTo !== null) {
        tree.now.set(p, null);
        tree.now.set(moveTo, out);
        tree.recordMove(p, moveTo);
      } else {
        tree.now.set(p, out);
      }
    });
  }
  return edits;
}

/* ------------------------------------------------------------------ */
/* Section 1, 2, 10: invocation, output, atomicity                     */
/* ------------------------------------------------------------------ */

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    if (kind === 'json') edits = jsonEdits(text, lines);
    else if (kind === 'unified') edits = parseUnified(lines, strict);
    else if (kind === 'search-replace') edits = parseSearchReplace(lines, strict);
    else edits = parseV4a(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const beforeMoves = [...tree.moves];
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      tree.moves.length = 0;
      tree.moves.push(...beforeMoves);
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  // Output rows: a successful move edit whose old path existed before the patch and
  // does not after it, and whose new path did not exist before it and does after it,
  // is one `R <old> -> <new>` line (sorting by <new>) replacing that pair's D and A lines.
  const rows: { key: string; text: string }[] = [];
  const suppressed = new Set<string>();
  for (const mv of tree.moves) {
    const wasOld = tree.original(mv.old);
    const nowOld = tree.now.has(mv.old) ? tree.now.get(mv.old)! : tree.original(mv.old);
    const wasNew = tree.original(mv.nw);
    const nowNew = tree.now.has(mv.nw) ? tree.now.get(mv.nw)! : tree.original(mv.nw);
    if (wasOld !== null && nowOld === null && wasNew === null && nowNew !== null) {
      rows.push({ key: mv.nw, text: `R ${mv.old} -> ${mv.nw}` });
      suppressed.add(mv.old);
      suppressed.add(mv.nw);
    }
  }
  for (const p of [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
    if (suppressed.has(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    rows.push({ key: p, text: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  if (!check) {
    // Write in byte order of the paths, as the starter did: a deletion of `a`
    // then lands before a creation under `a/`.
    for (const p of [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
      const was = tree.original(p);
      const now = tree.now.get(p)!;
      if (was === now) continue;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  return { code: 0, out: [...rows.map((r) => r.text), `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
}

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
