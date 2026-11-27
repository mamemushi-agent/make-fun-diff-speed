// A fast line diff that returns, for { old, new }, exactly the patch the
// makefun-diff/1 format specifies: a header line, then hunks of kept, deleted
// and inserted lines with 3 lines of context. Written from scratch for speed:
// the two texts are cut into lines once, every distinct line is interned to a
// small integer, and Myers's greedy search then runs on integer arrays — a
// triangular table of furthest-reaching points, one packed row per edit count,
// with no objects allocated inside the search. The winning path is recovered
// by walking the table back and re-applying the search's own choice rule
// (the candidate that reaches further into the old text wins; a tie goes to
// the deletion), so the script is the search's script, byte for byte.

/** The patch's first word, and the kept lines shown around each change run. */
const FORMAT = 'makefun-diff/1';
const CONTEXT = 3;

const KEEP = 0;
const DELETE = 1;
const INSERT = 2;
const OP_CHAR = ['=', '-', '+'];

/**
 * Cut a text into lines: a line ends at each "\n" (kept on the line; a "\r"
 * before it is part of the line), and a trailing piece with no "\n" is a
 * line too. The empty text has no lines.
 */
function splitLines(text) {
  const lines = [];
  let start = 0;
  let at = text.indexOf('\n');
  while (at !== -1) {
    lines.push(text.slice(start, at + 1));
    start = at + 1;
    at = text.indexOf('\n', start);
  }
  if (start < text.length) lines.push(text.slice(start));
  return lines;
}

/** Intern every line of both texts to an integer id; returns the id arrays. */
function internIds(aLines, bLines) {
  const ids = new Map();
  let next = 0;
  const a = new Uint32Array(aLines.length);
  const b = new Uint32Array(bLines.length);
  for (let i = 0; i < aLines.length; i++) {
    const line = aLines[i];
    let id = ids.get(line);
    if (id === undefined) {
      id = next++;
      ids.set(line, id);
    }
    a[i] = id;
  }
  for (let i = 0; i < bLines.length; i++) {
    const line = bLines[i];
    let id = ids.get(line);
    if (id === undefined) {
      id = next++;
      ids.set(line, id);
    }
    b[i] = id;
  }
  return [a, b];
}

/**
 * The edit runs of the middle slices a (length n) and b (length m), as a flat
 * list [kind, count, kind, count, ...] in order, kinds KEEP/DELETE/INSERT.
 * The search keeps, for every edit count d and diagonal k = x - y, the
 * furthest old position a path of d edits reaches on k after its run of
 * equal lines; row d of the table packs those positions for k = -d..d in
 * steps of 2 (index j = (k + d) / 2), with -1 for a diagonal no path reaches.
 */
function middleRuns(a, b, n, m) {
  if (n === 0) return m === 0 ? [] : [INSERT, m];
  if (m === 0) return [DELETE, n];

  const rows = [];
  let first = 0;
  while (first < n && first < m && a[first] === b[first]) first++;
  rows.push(Int32Array.of(first));
  let winD = -1;
  let winJ = -1;
  if (first === n && first === m) {
    winD = 0;
    winJ = 0;
  }
  for (let d = 1; winD < 0; d++) {
    const prev = rows[d - 1];
    const row = new Int32Array(d + 1);
    for (let j = 0, k = -d; j <= d; j++, k += 2) {
      // The deletion extends the (d-1)-path on diagonal k-1 (packed at j-1):
      // it consumes one old line, so it is a candidate only when that path
      // exists and has not already consumed the whole old text.
      let delX = -1;
      if (j > 0) {
        const px = prev[j - 1];
        if (px >= 0 && px < n) delX = px + 1;
      }
      // The insertion extends the (d-1)-path on diagonal k+1 (packed at j):
      // it consumes one new line, a candidate only when that path exists and
      // the extra new line stays inside the new text.
      let insX = -1;
      if (j < d) {
        const px = prev[j];
        if (px >= 0 && px - k <= m) insX = px;
      }
      // The candidate reaching further into the old text wins; on a tie the
      // deletion (delX >= insX) — the search's stated tie-break.
      let x = delX >= insX ? delX : insX;
      if (x < 0) {
        row[j] = -1;
        continue;
      }
      // The run of equal lines that follows the edit, walked in place.
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x++;
        y++;
      }
      row[j] = x;
      if (x === n && y === m) {
        winD = d;
        winJ = j;
        break;
      }
    }
    rows.push(row);
  }

  // Walk the winning path back: at each step re-derive which edit the search
  // took into the state (the same comparison it made going forward), cross
  // the run of equal lines that followed the edit, and step to the state the
  // edit extended. Segments are collected backwards, then read in reverse.
  const backwards = [];
  let d = winD;
  let j = winJ;
  while (d > 0) {
    const k = 2 * j - d;
    const prev = rows[d - 1];
    const x = rows[d][j];
    let delX = -1;
    if (j > 0) {
      const px = prev[j - 1];
      if (px >= 0 && px < n) delX = px + 1;
    }
    let insX = -1;
    if (j < d) {
      const px = prev[j];
      if (px >= 0 && px - k <= m) insX = px;
    }
    // Walking back, the state's run of equal lines is crossed before its
    // edit, so the segments are collected as (KEEP, edit) pairs.
    if (delX >= insX) {
      backwards.push(KEEP, x - delX, DELETE, 1);
      j = j - 1;
    } else {
      backwards.push(KEEP, x - insX, INSERT, 1);
      // j stays: the insertion came from diagonal k+1, packed at the same j.
    }
    d--;
  }
  backwards.push(KEEP, rows[0][0]);

  // Read the segments forwards, dropping empty runs and merging neighbours
  // of one kind (an edit whose following run of equal lines is empty sits
  // directly beside the next edit of the walk).
  const runs = [];
  for (let i = backwards.length - 2; i >= 0; i -= 2) {
    const kind = backwards[i];
    const count = backwards[i + 1];
    if (count === 0) continue;
    if (runs.length >= 2 && runs[runs.length - 2] === kind) runs[runs.length - 1] += count;
    else runs.push(kind, count);
  }
  return runs;
}

/** One line as the patch writes it: op + line, plus a "%" line when the line carries no newline of its own. */
function pushWritten(out, op, line) {
  if (line.charCodeAt(line.length - 1) === 10) out.push(op, line);
  else out.push(op, line, '\n%\n');
}

/**
 * The patch of input.old into input.new, as one string: the header line
 * "makefun-diff/1 old=N new=M hunks=H deleted=D inserted=I", then each hunk
 * as "@ os ol ns nl" and one line per line it covers.
 */
export function run(input) {
  if (input === null || typeof input !== 'object' || typeof input.old !== 'string' || typeof input.new !== 'string') {
    throw new TypeError('the input is { old, new }, two strings');
  }
  const aLines = splitLines(input.old);
  const bLines = splitLines(input.new);
  const n = aLines.length;
  const m = bLines.length;
  const [a, b] = internIds(aLines, bLines);

  // The longest common prefix of lines, then the longest common suffix of
  // the lines left; the search runs between them.
  let prefix = 0;
  while (prefix < n && prefix < m && a[prefix] === b[prefix]) prefix++;
  let suffix = 0;
  while (suffix < n - prefix && suffix < m - prefix && a[n - 1 - suffix] === b[m - 1 - suffix]) suffix++;

  const runs = [];
  if (prefix > 0) runs.push(KEEP, prefix);
  const mid = middleRuns(a.subarray(prefix, n - suffix), b.subarray(prefix, m - suffix), n - prefix - suffix, m - prefix - suffix);
  for (let i = 0; i < mid.length; i++) runs.push(mid[i]);
  if (suffix > 0) runs.push(KEEP, suffix);

  // The change runs: stretches of deletions and insertions between kept
  // lines, each at old line o and new line p, deletions listed first.
  const changes = [];
  let o = 0;
  let p = 0;
  let deleted = 0;
  let inserted = 0;
  for (let i = 0; i < runs.length; i += 2) {
    const kind = runs[i];
    const count = runs[i + 1];
    if (kind === KEEP) {
      o += count;
      p += count;
      continue;
    }
    let c = changes[changes.length - 1];
    if (c === undefined || c[0] + c[2] !== o || c[1] + c[3] !== p) {
      c = [o, p, 0, 0];
      changes.push(c);
    }
    if (kind === DELETE) {
      c[2] += count;
      o += count;
      deleted += count;
    } else {
      c[3] += count;
      p += count;
      inserted += count;
    }
  }

  // The hunks: change runs at most 2 * CONTEXT kept lines apart share one,
  // each shown with up to CONTEXT kept lines before and after it.
  const out = [];
  let hunks = 0;
  let hStart = 0;
  const body = [];
  const flushHunk = (hEnd) => {
    const firstC = changes[hStart];
    const lastC = changes[hEnd - 1];
    const oldStart = Math.max(0, firstC[0] - CONTEXT);
    const newStart = firstC[1] - (firstC[0] - oldStart);
    const after = Math.min(CONTEXT, n - (lastC[0] + lastC[2]));
    const oldEnd = lastC[0] + lastC[2] + after;
    const newEnd = lastC[1] + lastC[3] + after;
    body.push(`@ ${oldStart + 1} ${oldEnd - oldStart} ${newStart + 1} ${newEnd - newStart}\n`);
    let at = oldStart;
    for (let ci = hStart; ci < hEnd; ci++) {
      const c = changes[ci];
      for (; at < c[0]; at++) pushWritten(body, '=', aLines[at]);
      for (let t = 0; t < c[2]; t++) pushWritten(body, '-', aLines[c[0] + t]);
      for (let t = 0; t < c[3]; t++) pushWritten(body, '+', bLines[c[1] + t]);
      at = c[0] + c[2];
    }
    for (; at < oldEnd; at++) pushWritten(body, '=', aLines[at]);
    hunks++;
  };
  for (let ci = 1; ci < changes.length; ci++) {
    const prevC = changes[ci - 1];
    const c = changes[ci];
    if (c[0] - (prevC[0] + prevC[2]) > 2 * CONTEXT) {
      flushHunk(ci);
      hStart = ci;
    }
  }
  if (changes.length > 0) flushHunk(changes.length);

  out.push(`${FORMAT} old=${n} new=${m} hunks=${hunks} deleted=${deleted} inserted=${inserted}\n`);
  return out.join('') + body.join('');
}
