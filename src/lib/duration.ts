/**
 * Lenient duration parsing. Accepts "2h30m", "2h 30m", "2.5", "2.5h", "150", "1:45", "90 min",
 * "90m", "1 hour 15 minutes", "45 minutes", "half an hour", "an hour", "1.5 hrs", "0:30".
 *
 * Rules for bare numbers (no unit): a decimal is hours ("2.5"); an integer ≤ 12 is hours ("8"),
 * anything larger is minutes ("150", "45" → minutes? no: 45 > 12 → minutes). We echo the
 * interpretation so the model can confirm with the user.
 */
export interface ParsedDuration {
  minutes: number;
  normalized: string; // e.g. "2h 30m"
  interpretation: string; // human explanation of how the input was read
}

const WORD_NUMBERS: Record<string, number> = {
  a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  half: 0.5, quarter: 0.25,
};

export function formatMinutes(min: number): string {
  const h = Math.floor(min / 60);
  const m = Math.round(min % 60);
  if (h && m) return `${h}h ${m}m`;
  if (h) return `${h}h`;
  return `${m}m`;
}

export function parseDuration(input: string | number | null | undefined): ParsedDuration | null {
  if (input === null || input === undefined) return null;
  if (typeof input === 'number') {
    return finish(bareNumber(input), `number ${input}`);
  }
  let s = String(input).trim().toLowerCase();
  if (!s) return null;
  s = s.replace(/,/g, '.').replace(/\s+/g, ' ');

  // "1:45" or "0:30" or "1:45:00"
  const colon = s.match(/^(\d{1,3}):(\d{1,2})(?::(\d{1,2}))?$/);
  if (colon) {
    const min = Number(colon[1]) * 60 + Number(colon[2]) + (colon[3] ? Number(colon[3]) / 60 : 0);
    return finish(min, `${colon[1]}:${colon[2]} as hours:minutes`);
  }

  // Bare number: "2.5", "150", "8"
  const bare = s.match(/^(\d+(?:\.\d+)?)$/);
  if (bare) {
    const n = Number(bare[1]);
    const isDecimal = bare[1].includes('.');
    if (isDecimal) return finish(n * 60, `${bare[1]} as hours`);
    return finish(bareNumber(n), n <= 12 ? `${n} as hours` : `${n} as minutes`);
  }

  // Word forms: "half an hour", "an hour", "a quarter hour"
  const words = s.match(/^(half|quarter|a|an|one|two|three|four|five|six|seven|eight|nine|ten)(?: an?)? (hour|hours|hr|hrs|minute|minutes|min|mins)$/);
  if (words) {
    const n = WORD_NUMBERS[words[1]];
    const unitIsHour = /^h/.test(words[2]);
    return finish(unitIsHour ? n * 60 : n, `"${s}"`);
  }

  // Unit tokens: "2h30m", "2h 30m", "1 hour 15 minutes", "90 min", "1.5 hrs", "2 hours and 15 mins"
  const re = /(\d+(?:\.\d+)?)\s*(hours?|hrs?|h|minutes?|mins?|m)(?![a-z])/g;
  let total = 0;
  let matched = false;
  let m: RegExpExecArray | null;
  let consumed = '';
  while ((m = re.exec(s))) {
    matched = true;
    consumed += m[0];
    const n = Number(m[1]);
    const unit = m[2];
    if (/^h/.test(unit)) total += n * 60;
    else total += n;
  }
  if (matched) {
    // Reject if there's leftover garbage beyond connectors
    const leftover = s.replace(re, '').replace(/\b(and|&|,)\b/g, '').trim();
    if (leftover.length > 0 && !/^[\s.]*$/.test(leftover)) return null;
    return finish(total, `"${s}"`);
  }

  return null;
}

function bareNumber(n: number): number {
  if (!Number.isFinite(n) || n <= 0) return NaN;
  if (!Number.isInteger(n)) return n * 60; // decimal → hours
  return n <= 12 ? n * 60 : n; // small integer → hours, larger → minutes
}

function finish(minutes: number, interpretation: string): ParsedDuration | null {
  if (!Number.isFinite(minutes) || minutes <= 0) return null;
  const rounded = Math.round(minutes);
  if (rounded <= 0) return null;
  if (rounded > 24 * 60) return null; // more than a day in one entry is almost certainly a typo
  return { minutes: rounded, normalized: formatMinutes(rounded), interpretation: `${interpretation} → ${formatMinutes(rounded)}` };
}
