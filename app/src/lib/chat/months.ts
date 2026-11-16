// Month references in answer text -> YYYY-MM, for the burning-calendar highlight.

export const MONTH_NAMES = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
] as const;

const MONTH_INDEX: Record<string, number> = {};
MONTH_NAMES.forEach((name, i) => {
  MONTH_INDEX[name.toLowerCase()] = i + 1;
  MONTH_INDEX[name.slice(0, 3).toLowerCase()] = i + 1;
});
MONTH_INDEX["sept"] = 9;

const NAME_PATTERN = Object.keys(MONTH_INDEX)
  .sort((a, b) => b.length - a.length)
  .join("|");

// "2024-08" (not part of a longer date like 2024-08-15), or "August 2024" / "Aug. 2024" / "Aug 2024".
const ISO = /(?<![\d-])((?:19|20)\d{2})-(0[1-9]|1[0-2])(?![\d-])/g;
const NAMED = new RegExp(`\\b(${NAME_PATTERN})\\.?,?\\s+((?:19|20)\\d{2})\\b`, "gi");

const pad = (m: number) => String(m).padStart(2, "0");

/** Months referenced in `text`, as unique YYYY-MM strings in order of first appearance. */
export function extractMonths(text: string): string[] {
  const found: { at: number; month: string }[] = [];
  for (const m of text.matchAll(ISO)) found.push({ at: m.index, month: `${m[1]}-${m[2]}` });
  for (const m of text.matchAll(NAMED)) {
    const idx = MONTH_INDEX[m[1].toLowerCase()];
    if (idx) found.push({ at: m.index, month: `${m[2]}-${pad(idx)}` });
  }
  found.sort((a, b) => a.at - b.at);
  return [...new Set(found.map((f) => f.month))];
}

/** "2024-08" -> "August 2024". */
export function monthLabel(ym: string): string {
  const [y, m] = ym.split("-");
  const name = MONTH_NAMES[Number(m) - 1];
  return name ? `${name} ${y}` : ym;
}
