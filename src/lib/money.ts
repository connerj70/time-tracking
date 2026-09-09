export function toCents(amount: number | string | null | undefined): number | null {
  if (amount === null || amount === undefined || amount === '') return null;
  const n = typeof amount === 'string' ? Number(amount.replace(/[^0-9.\-]/g, '')) : amount;
  if (!Number.isFinite(n)) return null;
  return Math.round(n * 100);
}

export function formatMoney(cents: number, currency: string, locale = 'en-US'): string {
  try {
    return new Intl.NumberFormat(locale, { style: 'currency', currency }).format(cents / 100);
  } catch {
    return `${(cents / 100).toFixed(2)} ${currency}`;
  }
}

/** Hours (2dp) × rate → cents, rounded half-up. */
export function lineAmountCents(hours: number, rateCents: number): number {
  return Math.round(hours * rateCents);
}

export function minutesToHours(min: number): number {
  return Math.round((min / 60) * 100) / 100;
}
