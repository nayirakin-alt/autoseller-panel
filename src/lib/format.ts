/** 1250000 -> "1.25M" (oyun ici para) */
export function money(v: number | string | null | undefined): string {
  const n = Number(v ?? 0);
  const a = Math.abs(n), sign = n < 0 ? '-' : '';
  const f = (x: number, s: string) => sign + (Math.round(x * 100) / 100).toString() + s;
  if (a >= 1e12) return f(a / 1e12, 'T');
  if (a >= 1e9) return f(a / 1e9, 'B');
  if (a >= 1e6) return f(a / 1e6, 'M');
  if (a >= 1e3) return f(a / 1e3, 'K');
  return sign + a.toString();
}

export function duration(sec: number | string | null | undefined): string {
  const s = Math.max(0, Math.floor(Number(sec ?? 0)));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
  return h > 0 ? `${h} sa ${m} dk` : `${m} dk`;
}

export function ago(iso: string | null | undefined): string {
  if (!iso) return '—';
  const s = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return `${s} sn önce`;
  if (s < 3600) return `${Math.floor(s / 60)} dk önce`;
  if (s < 86400) return `${Math.floor(s / 3600)} sa önce`;
  return new Date(iso).toLocaleString('tr-TR');
}

/** JSON API cagrisi; hata varsa firlatir */
export async function api<T = any>(url: string, init?: RequestInit & { json?: unknown }): Promise<T> {
  const res = await fetch(url, {
    ...init,
    headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
    body: init?.json !== undefined ? JSON.stringify(init.json) : init?.body,
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok || j.ok === false) throw new Error(j.error ?? `HTTP ${res.status}`);
  return j as T;
}

/** "80m", "1.5k", "2,000,000" -> sayi (gecersizse NaN) */
export function parseMoney(v: string | null | undefined): number {
  if (!v) return NaN;
  const s = v.trim().toLowerCase().replace(/\s|\$/g, '');
  const m = s.match(/^(\d+(?:[.,]\d+)?)([kmbt]?)$/);
  if (!m) return Number(s.replace(/[.,]/g, ''));
  const mult = { '': 1, k: 1e3, m: 1e6, b: 1e9, t: 1e12 }[m[2] as '' | 'k' | 'm' | 'b' | 't'];
  return Math.round(Number(m[1].replace(',', '.')) * mult);
}
