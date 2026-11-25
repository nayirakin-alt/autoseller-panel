'use client';
import { useCallback, useEffect, useState } from 'react';
import { api, ago, money, parseMoney } from '@/lib/format';

const date = (iso?: string | null) => (iso ? new Date(iso).toLocaleString('tr-TR') : '—');
const KIND: Record<string, string> = { PURCHASE: 'Satın alma', EXTEND: 'Uzatma', UPGRADE: 'Yükseltme' };
const SOURCE: Record<string, string> = { PURCHASE: 'satın alma', UPGRADE: 'yükseltme', GIFT: 'hediye' };
const STATUS: Record<string, string> = { PENDING: 'ödeme bekleniyor', PAID: 'ödendi', CANCELLED: 'iptal', EXPIRED: 'süresi doldu' };
const UNITS = { saat: 3600, gün: 86400, hafta: 604800 } as const;

/** Aktif rutbe: kullanicinin su an gecerli en yuksek rutbesi (yoksa Bronze) */
export function activeRankOf(userId: string, grants: any[], ranks: any[]) {
  const now = Date.now();
  const sortOf = (c: string) => ranks.find((r) => r.code === c)?.sort ?? 0;
  const act = grants.filter((g) => g.user_id === userId && new Date(g.starts_at).getTime() <= now && new Date(g.ends_at).getTime() > now)
    .sort((a, b) => sortOf(b.rank_code) - sortOf(a.rank_code));
  const code = act[0]?.rank_code ?? 'BRONZE';
  return { rank: ranks.find((r) => r.code === code), grant: act[0] };
}

/** Operator: rutbe fiyat/oran tablosu, hediye, siparisler, aktif rutbeler */
export function AdminRanks({ users, onData }: { users: any[]; onData?: (d: any) => void }) {
  const [d, setD] = useState<any>(null);
  const [err, setErr] = useState('');
  const [gUser, setGUser] = useState('');
  const [gRank, setGRank] = useState('GOLD');
  const [gAmount, setGAmount] = useState(1);
  const [gUnit, setGUnit] = useState<keyof typeof UNITS>('gün');
  const [gNote, setGNote] = useState('');

  const load = useCallback(async () => {
    try { const r = await api('/api/admin/ranks'); setD(r); onData?.(r); } catch (e: any) { setErr(e.message); }
  }, [onData]);
  useEffect(() => { load(); const t = setInterval(load, 20_000); return () => clearInterval(t); }, [load]);
  const act = (fn: () => Promise<unknown>) => async () => { setErr(''); try { await fn(); await load(); } catch (e: any) { setErr(e.message); } };
  const post = (json: unknown) => api('/api/admin/ranks', { method: 'POST', json });

  if (!d) return <div className="card">{err ? <div className="err">{err}</div> : 'Yükleniyor…'}</div>;
  const nameOf = (id: string) => users.find((u) => u.id === id)?.display_name ?? id.slice(0, 8);
  const pending = d.orders.filter((o: any) => o.status === 'PENDING');

  return (
    <>
      {pending.length > 0 && (
        <div className="card notice">
          <h2>Ödeme bekleyen rütbe siparişleri</h2>
          <p className="muted">Kasa hesabında mod açıksa ödeme gelince sipariş kendiliğinden onaylanır. Kasayı elle kontrol ettiysen "Ödendi" de.</p>
          <table><thead><tr><th>#</th><th>Kullanıcı</th><th>İşlem</th><th className="num">Tutar</th><th>Komut</th><th>Son geçerlilik</th><th></th></tr></thead>
            <tbody>{pending.map((o: any) => (
              <tr key={o.id}><td>{o.id}</td><td>{nameOf(o.user_id)}</td>
                <td>{KIND[o.kind]} {o.from_rank_code && o.kind === 'UPGRADE' ? `${o.from_rank_code} → ` : ''}{o.rank_code}{o.weeks ? ` · ${o.weeks} hf` : ''}</td>
                <td className="num"><b>{money(o.amount)}</b></td><td><code>/pay {o.pay_to} {o.amount}</code></td>
                <td className="muted">{date(o.expires_at)}</td>
                <td className="row">
                  <button className="primary" onClick={act(() => post({ action: 'order_paid', orderId: o.id, note: prompt('Not (isteğe bağlı)') ?? undefined }))}>Ödendi</button>
                  <button className="danger" onClick={act(() => post({ action: 'order_cancel', orderId: o.id }))}>İptal</button>
                </td></tr>))}
            </tbody></table>
        </div>
      )}

      <div className="grid2">
        <div className="card">
          <h2>Rütbeler</h2>
          <table><thead><tr><th>Rütbe</th><th>Komisyon</th><th className="num">Haftalık ücret</th><th></th></tr></thead>
            <tbody>{d.ranks.map((r: any) => (
              <tr key={r.code}><td><b style={{ color: r.color }}>{r.name}</b></td><td>%{Math.round(Number(r.commission_rate) * 100)}</td>
                <td className="num">{Number(r.weekly_price) ? money(r.weekly_price) : 'ücretsiz'}</td>
                <td><button onClick={act(async () => {
                  const rate = prompt(`${r.name} komisyon oranı (%)`, String(Math.round(Number(r.commission_rate) * 100)));
                  if (rate == null) return;
                  const price = r.code === 'BRONZE' ? '0' : prompt(`${r.name} haftalık ücret (örn. 80m)`, money(r.weekly_price));
                  if (price == null) return;
                  await post({ action: 'set_rank', code: r.code, rate: Number(rate) / 100, weeklyPrice: parseMoney(price) });
                })}>Düzenle</button></td></tr>))}
            </tbody></table>
          <p className="muted">Komisyon her 60 dk'lık pencere açılırken kullanıcının o anki rütbesinden alınır; pencere içinde
            rütbe yükselirse oran hemen düşer.</p>
        </div>

        <div className="card">
          <h2>Rütbe hediye et</h2>
          <div className="row">
            <select value={gUser} onChange={(e) => setGUser(e.target.value)}>
              <option value="">— kullanıcı seç —</option>
              {users.map((u) => <option key={u.id} value={u.id}>{u.display_name}</option>)}
            </select>
            <select value={gRank} onChange={(e) => setGRank(e.target.value)}>
              {d.ranks.filter((r: any) => r.code !== 'BRONZE').map((r: any) => <option key={r.code} value={r.code}>{r.name}</option>)}
            </select>
          </div>
          <div className="row" style={{ marginTop: 8 }}>
            <input type="number" min={1} style={{ width: 90 }} value={gAmount} onChange={(e) => setGAmount(Math.max(1, Number(e.target.value)))} />
            <select value={gUnit} onChange={(e) => setGUnit(e.target.value as keyof typeof UNITS)}>
              {Object.keys(UNITS).map((u) => <option key={u} value={u}>{u}</option>)}
            </select>
            <input placeholder="Not (örn. etkinlik ödülü)" value={gNote} onChange={(e) => setGNote(e.target.value)} />
            <button className="primary" disabled={!gUser}
              onClick={act(async () => { await post({ action: 'gift', userId: gUser, rank: gRank, seconds: gAmount * UNITS[gUnit], note: gNote || undefined }); setGNote(''); })}>
              Hediye et</button>
          </div>
          <p className="muted">Ücretsizdir, "hediye" kaynağıyla kaydedilir. Kullanıcıda aynı rütbe aktifse süresinin sonuna eklenir.</p>
        </div>
      </div>

      <div className="card">
        <h2>Aktif rütbe süreleri</h2>
        <table><thead><tr><th>Kullanıcı</th><th>Rütbe</th><th>Kaynak</th><th className="num">Ödenen</th><th>Başlangıç → bitiş</th><th>Not</th><th></th></tr></thead>
          <tbody>{d.grants.map((g: any) => (
            <tr key={g.id}><td>{nameOf(g.user_id)}</td><td><b>{g.rank_code}</b></td>
              <td>{g.source === 'GIFT' ? <span className="pill accent">hediye</span> : SOURCE[g.source]}</td>
              <td className="num">{Number(g.price) ? money(g.price) : '—'}</td>
              <td className="muted">{date(g.starts_at)} → {date(g.ends_at)}{new Date(g.starts_at) > new Date() && ' (sırada)'}</td>
              <td className="muted">{g.note}</td>
              <td><button className="danger" onClick={act(async () => { if (confirm('Bu rütbe süresi iptal edilsin mi?')) await post({ action: 'revoke', grantId: g.id }); })}>İptal</button></td></tr>))}
            {d.grants.length === 0 && <tr><td colSpan={7} className="muted">Aktif rütbe yok (herkes Bronze).</td></tr>}
          </tbody></table>
      </div>

      <div className="card">
        <h2>Sipariş geçmişi</h2>
        <div className="scroll" style={{ maxHeight: 360 }}><table>
          <thead><tr><th>#</th><th>Kullanıcı</th><th>İşlem</th><th className="num">Tutar</th><th>Durum</th><th>Ödeme</th><th>Tarih</th></tr></thead>
          <tbody>{d.orders.map((o: any) => (
            <tr key={o.id}><td>{o.id}</td><td>{nameOf(o.user_id)}</td><td>{KIND[o.kind]} {o.rank_code}{o.weeks ? ` · ${o.weeks} hf` : ''}</td>
              <td className="num">{money(o.amount)}</td><td>{STATUS[o.status]}</td><td className="muted">{o.paid_via ?? ''}</td>
              <td className="muted">{ago(o.created_at)}</td></tr>))}
            {d.orders.length === 0 && <tr><td colSpan={7} className="muted">Yok.</td></tr>}
          </tbody></table></div>
      </div>
      {err && <div className="err">{err}</div>}
    </>
  );
}
