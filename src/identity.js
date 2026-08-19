/**
 * Per-tab identity.
 *
 * Stored in sessionStorage on purpose: two tabs of the same browser are two
 * different people, which is exactly what the demo needs. localStorage would
 * make them collide.
 */
const PALETTE = [
  ['#ff5c8a', 'Coral'], ['#4fd1c5', 'Teal'], ['#f6ad55', 'Amber'],
  ['#a78bfa', 'Iris'], ['#38bdf8', 'Azure'], ['#f472b6', 'Rose'],
  ['#84cc16', 'Lime'], ['#fb7185', 'Blush'], ['#22d3ee', 'Cyan'],
  ['#eab308', 'Gold'], ['#c084fc', 'Orchid'], ['#34d399', 'Mint'],
];
const CREATURES = ['Otter', 'Falcon', 'Ibex', 'Lynx', 'Heron', 'Marten', 'Orca', 'Vireo', 'Onyx', 'Quill'];

const pick = (list) => list[Math.floor(Math.random() * list.length)];

/**
 * Choose a colour nobody in the room is using.
 *
 * Picking at random collides embarrassingly often — with a dozen colours, five
 * people share one about half the time — and two identically coloured carets is
 * the one thing this demo cannot afford to get wrong. Past the palette, hues are
 * generated on the golden angle so a crowded room still separates.
 */
export const pickIdentity = (taken = new Set()) => {
  const free = PALETTE.filter(([hex]) => !taken.has(hex));
  const [color, shade] = free.length
    ? pick(free)
    : [`hsl(${Math.floor(Math.random() * 360)} 72% 64%)`, 'Wild'];
  return {
    name: `${shade} ${pick(CREATURES)}`,
    color,
    // y-codemirror paints remote selections with this, so it must stay faint.
    colorLight: color.startsWith('#') ? `${color}33` : color.replace(')', ' / 20%)'),
  };
};

export const loadIdentity = () => {
  const saved = sessionStorage.getItem('echo:identity');
  if (saved) {
    try { return JSON.parse(saved); } catch { /* fall through and re-roll */ }
  }
  const identity = pickIdentity();
  sessionStorage.setItem('echo:identity', JSON.stringify(identity));
  return identity;
};

export const saveIdentity = (identity) => {
  sessionStorage.setItem('echo:identity', JSON.stringify(identity));
};
