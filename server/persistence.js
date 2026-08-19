/**
 * Snapshot rooms to disk so a restart does not lose anyone's text.
 *
 * A whole-document snapshot (not an append log) keeps this to a few lines and
 * bounds the file at the size of the content; writes are debounced so a burst
 * of keystrokes costs one write, and go through a temp file so a crash
 * mid-write cannot leave a half-written room behind.
 */
import fs from 'node:fs';
import path from 'node:path';
import * as Y from 'yjs';

const DIR = process.env.DATA_DIR || path.join(process.cwd(), '.data');
const DEBOUNCE = Number(process.env.PERSIST_DEBOUNCE || 2000);

const timers = new Map();
const fileFor = (room) => path.join(DIR, `${encodeURIComponent(room)}.bin`);

export const load = (doc) => {
  try {
    const file = fileFor(doc.name);
    if (fs.existsSync(file)) Y.applyUpdate(doc, new Uint8Array(fs.readFileSync(file)), 'persistence');
  } catch (err) {
    console.error(`[persist] load ${doc.name}:`, err.message);
  }
};

export const flush = (doc) => {
  clearTimeout(timers.get(doc.name));
  timers.delete(doc.name);
  try {
    fs.mkdirSync(DIR, { recursive: true });
    const file = fileFor(doc.name);
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, Y.encodeStateAsUpdate(doc));
    fs.renameSync(tmp, file);
  } catch (err) {
    console.error(`[persist] save ${doc.name}:`, err.message);
  }
};

export const schedule = (doc) => {
  if (timers.has(doc.name)) return;
  timers.set(doc.name, setTimeout(() => flush(doc), DEBOUNCE));
};
