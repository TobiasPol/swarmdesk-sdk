export function parseRange(size, header) {
  const eq = header.indexOf('=');
  if (eq <= 0) return -2;
  const unit = header.slice(0, eq).trim().toLowerCase();
  if (unit === '' || !/^[a-z]+$/.test(unit)) return -2;
  const specs = header.slice(eq + 1).split(',');
  const ranges = [];
  let sawSpec = false;
  for (const spec of specs) {
    const s = spec.trim();
    if (s === '') continue;
    sawSpec = true;
    const dash = s.indexOf('-');
    if (dash === -1) return -2;
    const first = s.slice(0, dash).trim();
    const last = s.slice(dash + 1).trim();
    if (first === '' && last === '') return -2;
    if ((first !== '' && !/^\d+$/.test(first)) || (last !== '' && !/^\d+$/.test(last))) return -2;
    let start;
    let end;
    if (first === '') {
      start = Math.max(0, size - Number(last));
      end = size - 1;
    } else {
      start = Number(first);
      if (last !== '' && Number(last) < start) return -2;
      end = last === '' ? size - 1 : Math.min(Number(last), size - 1);
    }
    if (start >= size || start > end) continue;
    ranges.push({ start, end });
  }
  if (!sawSpec) return -2;
  if (ranges.length === 0) return -1;
  ranges.sort((a, b) => a.start - b.start);
  const merged = [ranges[0]];
  for (let i = 1; i < ranges.length; i += 1) {
    const top = merged[merged.length - 1];
    const next = ranges[i];
    if (next.start <= top.end + 1) top.end = Math.max(top.end, next.end);
    else merged.push(next);
  }
  return { unit, ranges: merged };
}
