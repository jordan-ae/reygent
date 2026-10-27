/** Number, money and date formatting shared by every page. */

export const dateTimeFormat = new Intl.DateTimeFormat(undefined, {
  month: "short", day: "numeric", hour: "2-digit", minute: "2-digit",
});
export const fullDateFormat = new Intl.DateTimeFormat(undefined, { dateStyle: "full", timeStyle: "long" });
export const dayFormat = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" });

export const count = (value: number | null | undefined): string => Number(value || 0).toLocaleString("en-US");

export function usd(value: number, digits = 2): string {
  return `$${Number(value).toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;
}

/** LLM spend is often a fraction of a cent, so small amounts keep more decimals. */
export function spend(value: number | null | undefined): string {
  const amount = Math.abs(Number(value) || 0);
  return usd(value || 0, amount === 0 || amount >= 1 ? 2 : amount >= 0.01 ? 4 : 5);
}

/** A budget day ("2026-10-12") as a short local date, without shifting it across midnight. */
export function dayLabel(day: string): string {
  return dayFormat.format(new Date(`${day}T00:00:00`));
}

export function compensation(job: {
  compMin: number | null;
  compMax: number | null;
  compCurrency: string | null;
  compPeriod: string | null;
}): string {
  const { compMin: low, compMax: high } = job;
  if (low === null && high === null) return "—";
  const currency = job.compCurrency && job.compCurrency !== "USD" ? `${job.compCurrency} ` : "$";
  const figure = (amount: number | null): string => Number(amount).toLocaleString("en-US");
  const range = low !== null && high !== null && low !== high ? `${figure(low)}–${figure(high)}` : figure(high ?? low);
  return `${currency}${range}${job.compPeriod ? ` / ${job.compPeriod}` : ""}`;
}

export const plural = (n: number, one: string, many: string): string => (n === 1 ? one : many);
