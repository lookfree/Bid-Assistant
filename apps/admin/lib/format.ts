/** ISO 时间串 → "2026-07-23 22:31:46"（浏览器本地时区）。空/非法输入回 "-"，绝不渲染 Invalid Date。 */
export function formatDateTime(iso?: string | null): string {
  if (!iso) return "-"
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return "-"
  const p = (n: number) => String(n).padStart(2, "0")
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}
