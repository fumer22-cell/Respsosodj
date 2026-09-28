// =============================================================================
//  Pace notes: detect corners from spline curvature, grade them 1 (slowest)
//  to 6 (fastest) like a real co-driver, add modifiers, and call them out
//  ahead of time based on the car's speed.
// =============================================================================
import { CONFIG } from './config.js';

/** Find corners as runs of curvature above a threshold (with hysteresis). */
export function detectCorners(st) {
  const pc = CONFIG.paceNotes;
  const n = st.count, ds = st.ds, k = st.k;
  let raw = [];
  for (let i = 0; i < n;) {
    if (Math.abs(k[i]) >= pc.enterCurvature) {
      const dir = Math.sign(k[i]);
      let a = i; while (a > 0 && k[a - 1] * dir >= pc.exitCurvature) a--;
      let j = i; while (j < n && k[j] * dir >= pc.exitCurvature) j++;
      raw.push({ start: a, end: j - 1, dir });
      i = j;
    } else i++;
  }
  // Merge same-direction corners separated by a tiny gap.
  const merged = [];
  for (const c of raw) {
    const p = merged[merged.length - 1];
    if (p && p.dir === c.dir && (c.start - p.end) * ds < 14) p.end = c.end;
    else merged.push({ ...c });
  }
  const out = [];
  for (const c of merged) {
    let angle = 0, maxK = 0, apex = c.start;
    for (let i = c.start; i <= c.end; i++) {
      angle += k[i] * ds;
      if (Math.abs(k[i]) > maxK) { maxK = Math.abs(k[i]); apex = i; }
    }
    angle = Math.abs(angle);
    if (angle < pc.minAngle) continue;
    const minR = 1 / Math.max(maxK, 1e-6);
    let grade = 6;
    for (const [r, g] of pc.grades) if (minR < r) { grade = g; break; }
    const len = (c.end - c.start) * ds;
    const hairpin = minR < pc.hairpinRadius && angle > pc.hairpinAngle;
    // Does the corner tighten or open? Compare peak curvature in each half.
    const mid = (c.start + c.end) >> 1;
    let k1 = 0, k2 = 0;
    for (let i = c.start; i <= mid; i++) k1 = Math.max(k1, Math.abs(k[i]));
    for (let i = mid; i <= c.end; i++) k2 = Math.max(k2, Math.abs(k[i]));
    out.push({
      start: c.start, end: c.end, apex, dir: c.dir, angle, minR, grade, len, hairpin,
      square: !hairpin && grade <= 2 && angle > 1.25 && angle < 1.95,
      long: !hairpin && (len > pc.longLength || angle > 2.0),
      tightens: len > 30 && k2 > k1 * 1.45,
      opens: len > 30 && k1 > k2 * 1.45,
      dontCut: false,
    });
  }
  return out;
}

const DIGIT_WORDS = ['', 'one', 'two', 'three', 'four', 'five', 'six'];

/** Turn corners into callouts ("Left 3 long, don't cut, into Right 4"). */
export function buildPaceNotes(st) {
  const pc = CONFIG.paceNotes, ds = st.ds;
  const cs = st.corners.filter((c) => c.end > st.startIndex);
  const describe = (c, prevStraight) => {
    const dirWord = c.dir > 0 ? 'Right' : 'Left';
    const mods = [];
    let label, spoken, written;
    if (c.hairpin) { label = 'HP'; spoken = written = `Hairpin ${dirWord.toLowerCase()}`; }
    else if (c.square) { label = 'SQ'; spoken = written = `${dirWord} square`; }
    else { label = String(c.grade); spoken = `${dirWord} ${DIGIT_WORDS[c.grade]}`; written = `${dirWord} ${c.grade}`; }
    if (c.long) mods.push('long');
    if (c.tightens) mods.push('tightens');
    else if (c.opens) mods.push('opens');
    if (c.dontCut) mods.push("don't cut");
    const caution = (c.grade <= 2 || c.hairpin) && prevStraight > 140;
    const text = [caution ? 'Caution!' : null, written, ...mods].filter(Boolean).join(', ');
    const say = [caution ? 'Caution' : null, spoken, ...mods].filter(Boolean).join(', ');
    return { dir: c.dir, label, mods, caution, text, say };
  };

  const notes = [];
  let prevEnd = st.startIndex;
  for (let m = 0; m < cs.length; m++) {
    const group = [cs[m]];
    // Chain corners that follow each other closely: "... into ..."
    while (m + 1 < cs.length && (cs[m + 1].start - cs[m].end) * ds < pc.intoGap && group.length < 3) {
      m++; group.push(cs[m]);
    }
    const parts = group.map((c, gi) => describe(c, gi === 0 ? (c.start - prevEnd) * ds : 0));
    const next = cs[m + 1];
    let distance = null;
    if (next) {
      const gap = (next.start - cs[m].end) * ds;
      if (gap >= 60) distance = gap > 260 ? 'long straight' : String(Math.round(gap / 50) * 50);
    }
    const first = group[0];
    notes.push({
      kind: 'corner',
      s: Math.max(first.start, st.startIndex + 1) * ds,
      parts,
      distance,
      text: parts.map((p) => p.text).join(' into ') + (distance ? ` — ${distance}` : ''),
      say: parts.map((p) => p.say).join(', into ') + (distance ? `, ${distance}` : ''),
    });
    prevEnd = cs[m].end;
  }

  // Surface changes
  for (let i = st.startIndex + 10; i < st.finishIndex; i++) {
    if (st.surf[i] !== st.surf[i - 1]) {
      const lbl = CONFIG.surfaces[st.surf[i]].label;
      notes.push({ kind: 'surface', s: i * ds, parts: [], text: `Onto ${lbl}`, say: `Onto ${lbl}` });
    }
  }
  notes.push({ kind: 'finish', s: st.finishIndex * ds - 60, parts: [], text: 'Flat to the finish!', say: 'Flat to the finish' });
  notes.sort((a, b) => a.s - b.s);
  return notes;
}

/** Runtime: decides when to call each note based on distance and speed. */
export class PaceNoteCaller {
  constructor(notes) { this.notes = notes; this.next = 0; }
  /** Skip notes behind `s` (used after a reset). */
  reset(s) {
    this.next = 0;
    while (this.next < this.notes.length && this.notes[this.next].s < s + 5) this.next++;
  }
  /** Returns a note to announce now, or null. */
  update(s, speed) {
    const pc = CONFIG.paceNotes;
    const lead = Math.min(pc.callMaxDistance, Math.max(pc.callMinDistance, speed * pc.callLeadTime));
    while (this.next < this.notes.length) {
      const note = this.notes[this.next];
      if (note.s - s > lead) return null;
      this.next++;
      if (note.s > s - 5) return note;             // don't call corners already passed
    }
    return null;
  }
}
