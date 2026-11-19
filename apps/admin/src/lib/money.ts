// Prices are minor units (øre) including VAT, in the account's currency (NOK for now,
// docs/ticketing.md). Staff type and read them in kroner.

export const CURRENCY = "NOK";

/** 45000 → "kr 450,00" (nb) / "NOK 450.00" (en). */
export function formatMoney(minor: number, language: string): string {
  return new Intl.NumberFormat(language, { style: "currency", currency: CURRENCY, minimumFractionDigits: minor % 100 === 0 ? 0 : 2 }).format(minor / 100);
}

/** "450", "450,50", "450.5" → minor units; null if not an amount. */
export function parseMoney(text: string): number | null {
  const t = text.trim().replace(/\s/g, "").replace(",", ".");
  if (!/^\d+(\.\d{1,2})?$/.test(t)) return null;
  const minor = Math.round(Number(t) * 100);
  return minor <= 100_000_000 ? minor : null;
}

/** 45050 → "450,50" for an input in the UI language. */
export function moneyInput(minor: number | null | undefined, language: string): string {
  if (minor === null || minor === undefined) return "";
  const s = minor % 100 === 0 ? String(minor / 100) : (minor / 100).toFixed(2);
  return language.startsWith("en") ? s : s.replace(".", ",");
}
