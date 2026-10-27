// The assessment belongs to the main set; drop sets keep their own repetitions.
export function technique(value, repetitions) {
  // Older five-point ratings do not tell us how many repetitions were clean.
  if (!value || !Number.isInteger(value.clean) || value.clean < 0) return null;
  return { clean: Math.min(value.clean, Math.max(0, Math.floor(Number(repetitions) || 0))) };
}

export function techniqueText(value, repetitions, seconds = false) {
  const q = technique(value, repetitions);
  if (!q) return '';
  return `Чисто ${q.clean} из ${repetitions}${seconds ? ' сек' : ''}`;
}

export function techniquePercent(record) {
  let clean = 0, total = 0;
  (record.s || []).forEach((s, i) => {
    const q = s && technique(record.q?.[i], s[1]);
    if (q && s[1] > 0) { clean += q.clean; total += s[1]; }
  });
  return total ? clean / total * 100 : null;
}

export function compareTechnique(current, previous, repetitions, previousRepetitions) {
  const a = technique(current, repetitions), b = technique(previous, previousRepetitions);
  if (!a || !b || repetitions <= 0 || previousRepetitions <= 0) return null;
  return Math.sign(a.clean * previousRepetitions - b.clean * repetitions);
}

export function techniqueProgress(record, previous, { weighted = false, assisted = false } = {}) {
  let improved = 0, worse = false;
  (record?.s || []).forEach((s, i) => {
    const p = previous?.s?.[i];
    if (!s || !p) return;
    const change = compareTechnique(record.q?.[i], previous.q?.[i], s[1], p[1]);
    if (change === -1) worse = true;
    const loadHeld = !weighted || (assisted ? s[0] <= p[0] : s[0] >= p[0]);
    if (change === 1 && loadHeld && s[1] >= p[1]) improved++;
  });
  return worse ? -1 : improved ? 1 : 0;
}

export function techniqueReadiness(record) {
  const done = (record.s || []).flatMap((s, i) => s ? [{ s, q: technique(record.q?.[i], s[1]) }] : []);
  if (done.some(({ s, q }) => q && q.clean < s[1])) return 'hold';
  if (done.some(({ q }) => !q)) return 'unknown';
  return 'ready';
}
