/**
 * The calendar date where the clinician is standing.
 *
 * `new Date().toISOString().slice(0, 10)` is UTC, and an encounter date is a
 * LOCAL calendar date. The two disagree for part of every day, in both
 * directions: a 7pm clinic in the US stamps encounters with tomorrow, and a
 * 1am entry in Uganda (UTC+3) stamps them with yesterday. That silently
 * misdates charts and shifts them out of the day's report.
 */
export function todayLocal(d: Date = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}
