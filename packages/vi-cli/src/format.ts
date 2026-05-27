import Table from "cli-table3";

export function printTable(head: string[], rows: string[][]): void {
  const table = new Table({ head, style: { head: ["cyan"] } });
  for (const row of rows) table.push(row);
  process.stdout.write(table.toString() + "\n");
}

export function printJson(data: unknown): void {
  process.stdout.write(JSON.stringify(data, null, 2) + "\n");
}

export function ago(iso: string): string {
  const s = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

export function short(s: string, max = 20): string {
  return s.length > max ? s.slice(0, max - 1) + "…" : s;
}
