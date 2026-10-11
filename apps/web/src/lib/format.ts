/** Number/date formatting per spec RTL rules: Western digits, "." decimal, "," thousands, dd.mm.yyyy. */
const intFmt = new Intl.NumberFormat("he-IL", { maximumFractionDigits: 0 });

export function formatQuantity(value: number, unit: string): string {
  const fractionDigits = unit === "יחידה" || unit === "יח'" || unit === "קומפלט" ? 0 : 2;
  return new Intl.NumberFormat("he-IL", {
    minimumFractionDigits: fractionDigits,
    maximumFractionDigits: fractionDigits,
  }).format(value);
}

export function formatInt(value: number): string {
  return intFmt.format(value);
}

export function formatDate(iso: string | Date): string {
  const d = typeof iso === "string" ? new Date(iso) : iso;
  const dd = String(d.getDate()).padStart(2, "0");
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  return `${dd}.${mm}.${d.getFullYear()}`;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
