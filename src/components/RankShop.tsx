'use client';
import { useCallback, useEffect, useState } from 'react';
import { api, ago, duration, money } from '@/lib/format';

const pct = (r: number | string) => `%${Math.round(Number(r) * 100)}`;
const date = (iso?: string | null) => (iso ? new Date(iso).toLocaleString('tr-TR') : '—');
const ORDER_STATUS: Record<string, string> = { PENDING: 'ödeme bekleniyor', PAID: 'ödendi', CANCELLED: 'iptal', EXPIRED: 'süresi doldu' };
const KIND: Record<string, string> = { PURCHASE: 'Satın alma', EXTEND: 'Uzatma', UPGRADE: 'Yükseltme' };
const SOURCE: Record<string, string> = { PURCHASE: 'satın alma', UPGRADE: 'yükseltme', GIFT: 'hediye' };

/** Uye: rutbe durumu, satin alma / uzatma / yukseltme, siparisler ve operator odeme talepleri */
export function RankShop({ onChange }: { onChange?: () => void }) {
  const [d, setD] = useState<any>(null);
  const [rank, setRank] = useState('GOLD');
  const [weeks, setWeeks] = useState(1);
  const [quote, setQuote] = useState<any>(null);
  const [err, setErr] = useState('');

  const load = useCallback(() => api('/api/me/rank').then(setD).catch((e) => setErr(e.message)), []);
  useEffect(() => { load(); const t = setInterval(load, 30_000); return () => clearInterval(t); }, [load]);

  const ask = useCallback(async (r: string, w: number) => {
    setErr('');
    try { setQuote((await api('/api/me/rank', { method: 'POST', json: { action: 'quote', rank: r, weeks: w } })).quote); }
    catch (e: any) { setErr(e.message); }
  }, []);
  useEffect(() => { if (d) ask(rank, weeks); }, [d?.status?.code, rank, weeks, ask]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!d) return <div className="card">{err ? <div className="err">{err}</div> : 'Rütbe bilgisi yükleniyor…'}</div>;
  const st = d.status;
  const cur = d.ranks.find((r: any) => r.code === st.code);
  const buyable = d.ranks.filter((r: any) => Number(r.weekly_price) > 0);
  const pending = d.orders.find((o: any) => o.status === 'PENDING');
  const openReq = d.requests.filter((r: any) => r.status === 'OPEN');
  const upgradeOnly = quote?.ok && quote.kind === 'UPGRADE';

  async function order() {
    setErr('');
    try { await api('/api/me/rank', { method: 'POST', json: { action: 'order', rank, weeks } }); await load(); onChange?.(); }
    catch (e: any) { setErr(e.message); }
  }
  async function cancel(id: number) {
    try { await api('/api/me/rank', { method: 'POST', json: { action: 'cancel', orderId: id } }); await load(); }
    catch (e: any) { setErr(e.message); }
  }
  const reason = (r: string) => ({ INVALID_WEEKS: 'Hafta sayısı geçersiz (yükseltme dışında en az 1 hafta).',
                                   INVALID_RANK: 'Bu rütbe satın alınamaz.' } as Record<string, string>)[r] ?? r;

  return (
    <>
      {openReq.length > 0 && (
        <div className="card notice">
          <h2>Ödeme talepleri</h2>
          <p className="muted">Operatör senden aşağıdaki tutarları kasa hesabına göndermeni istedi. Oyunda komutu yaz; kasa ödemeyi görünce talep
            kendiliğinden kapanır (birkaç dakika sürebilir). Bu talepler satış komisyonu borcundan ayrıdır.</p>
          <table><thead><tr><th>#</th><th className="num">Tutar</th><th>Komut</th><th>Not</th><th>Son tarih</th><th>Oluşturuldu</th></tr></thead>
            <tbody>{openReq.map((r: any) => (
              <tr key={r.id}><td>{r.id}</td><td className="num accent"><b>{money(r.amount)}</b></td>
                <td><code>/pay {r.pay_to} {r.amount}</code></td><td>{r.note}</td>
                <td className="muted">{date(r.due_at)}</td><td className="muted">{ago(r.created_at)}</td></tr>))}
            </tbody></table>
        </div>
      )}

      <div className="card">
        <h2>Rütbem</h2>
        <div className="stats">
          <div className="stat"><b style={{ color: st.color }}>{st.name}</b><span>aktif rütbe{st.source ? ` · ${SOURCE[st.source] ?? st.source}` : ''}</span></div>
          <div className="stat"><b>{pct(st.commission_rate)}</b><span>satış komisyonu</span></div>
          <div className="stat"><b>{st.ends_at ? date(st.ends_at) : '—'}</b>
            <span>{st.ends_at ? `bitiş · ${duration((new Date(st.ends_at).getTime() - Date.now()) / 1000)} kaldı` : 'süresiz (varsayılan)'}</span></div>
        </div>
        <table style={{ marginTop: 12 }}>
          <thead><tr><th>Rütbe</th><th>Komisyon</th><th className="num">Haftalık ücret</th></tr></thead>
          <tbody>{d.ranks.map((r: any) => (
            <tr key={r.code} style={r.code === st.code ? { background: '#11161d' } : undefined}>
              <td><b style={{ color: r.color }}>{r.name}</b>{r.code === st.code && <span className="pill accent" style={{ marginLeft: 6 }}>senin</span>}</td>
              <td>{pct(r.commission_rate)}</td><td className="num">{Number(r.weekly_price) ? money(r.weekly_price) : 'ücretsiz'}</td></tr>))}
          </tbody></table>
      </div>

      <div className="card">
        <h2>Rütbe al / uzat / yükselt</h2>
        <div className="row">
          <select value={rank} onChange={(e) => setRank(e.target.value)}>
            {buyable.map((r: any) => <option key={r.code} value={r.code}>{r.name} — {pct(r.commission_rate)} · {money(r.weekly_price)}/hafta</option>)}
          </select>
          <select value={weeks} onChange={(e) => setWeeks(Number(e.target.value))}>
            <option value={0}>0 hafta (sadece kalan süreyi yükselt)</option>
            {[1, 2, 3, 4, 5, 6, 8, 12].map((w) => <option key={w} value={w}>{w} hafta</option>)}
          </select>
        </div>
        {quote && !quote.ok && <div className="err" style={{ marginTop: 8 }}>{reason(quote.reason)}</div>}
        {quote?.ok && (
          <div style={{ marginTop: 12 }}>
            <table><tbody>
              <tr><td>İşlem</td><td><b>{KIND[quote.kind]}</b>{quote.queued && <span className="muted"> · mevcut üst rütben bitince başlar</span>}</td></tr>
              {upgradeOnly && <>
                <tr><td>Kalan süre ({cur?.name})</td><td>{duration(quote.remaining_seconds)}</td></tr>
                <tr><td>Mevcut rütbenin kalan değeri</td><td className="num">{money(quote.current_remaining_value)}</td></tr>
                <tr><td>Aynı süre için yeni rütbe</td><td className="num">{money(quote.target_value_for_remaining)}</td></tr>
                <tr><td>Fark</td><td className="num">{money(quote.difference)}</td></tr>
                {Number(quote.weeks) > 0 && <tr><td>Ek {quote.weeks} hafta</td><td className="num">{money(quote.extra_weeks_price)}</td></tr>}
              </>}
              {!upgradeOnly && <tr><td>{quote.weeks} hafta × {money(d.ranks.find((r: any) => r.code === quote.rank)?.weekly_price)}</td><td className="num">{money(quote.amount)}</td></tr>}
              <tr><td>Süre</td><td>{date(quote.starts_at)} → {date(quote.ends_at)}</td></tr>
              <tr><td><b>Ödenecek</b></td><td className="num accent"><b>{money(quote.amount)}</b> <span className="muted">(${Number(quote.amount).toLocaleString('tr-TR')})</span></td></tr>
            </tbody></table>
            <div className="row" style={{ marginTop: 10 }}>
              <button className="primary" onClick={order} disabled={Number(quote.amount) <= 0}>Siparişi oluştur</button>
              <span className="muted">Sipariş oluşunca oyunda kasa hesabına <code>/pay</code> ile öde; kasa ödemeyi görünce rütbe kendiliğinden açılır.</span>
            </div>
          </div>
        )}
        {pending && (
          <div className="card notice" style={{ marginTop: 14 }}>
            <b>Bekleyen sipariş #{pending.id}: {KIND[pending.kind]} {d.ranks.find((r: any) => r.code === pending.rank_code)?.name}</b>
            <p>Oyunda şu komutu yaz (kayıtlı MC hesaplarından biriyle): <code>/pay {pending.pay_to} {pending.amount}</code></p>
            <p className="muted">Son geçerlilik: {date(pending.expires_at)}. Ödeme kasada görülünce birkaç dakika içinde onaylanır.
              Kasa modu kapalıysa operatör elle onaylar.</p>
            <button onClick={() => cancel(pending.id)}>Siparişi iptal et</button>
          </div>
        )}
        {err && <div className="err">{err}</div>}
      </div>

      <div className="card">
        <h2>Rütbe geçmişi</h2>
        <div className="grid2">
          <div><b>Siparişler</b>
            <table><thead><tr><th>#</th><th>İşlem</th><th className="num">Tutar</th><th>Durum</th><th>Tarih</th></tr></thead>
              <tbody>{d.orders.map((o: any) => (
                <tr key={o.id}><td>{o.id}</td><td>{KIND[o.kind]} {o.rank_code}{o.weeks ? ` · ${o.weeks} hf` : ''}</td>
                  <td className="num">{money(o.amount)}</td><td>{ORDER_STATUS[o.status]}</td><td className="muted">{ago(o.created_at)}</td></tr>))}
                {d.orders.length === 0 && <tr><td colSpan={5} className="muted">Yok.</td></tr>}
              </tbody></table></div>
          <div><b>Rütbe süreleri</b>
            <table><thead><tr><th>Rütbe</th><th>Kaynak</th><th>Başlangıç → bitiş</th><th>Durum</th></tr></thead>
              <tbody>{d.grants.map((g: any) => (
                <tr key={g.id}><td>{g.rank_code}</td><td>{SOURCE[g.source]}</td><td className="muted">{date(g.starts_at)} → {date(g.ends_at)}</td>
                  <td>{g.status === 'ACTIVE' ? (new Date(g.ends_at) > new Date() ? 'aktif' : 'bitti') : g.status === 'SUPERSEDED' ? 'yükseltildi' : 'iptal'}</td></tr>))}
                {d.grants.length === 0 && <tr><td colSpan={4} className="muted">Yok.</td></tr>}
              </tbody></table></div>
        </div>
        {d.requests.some((r: any) => r.status !== 'OPEN') && <>
          <b style={{ display: 'block', marginTop: 12 }}>Kapanan ödeme talepleri</b>
          <table><tbody>{d.requests.filter((r: any) => r.status !== 'OPEN').map((r: any) => (
            <tr key={r.id}><td>#{r.id}</td><td className="num">{money(r.amount)}</td><td>{r.note}</td>
              <td>{r.status === 'PAID' ? <span className="green">ödendi</span> : <span className="muted">iptal</span>}</td>
              <td className="muted">{ago(r.paid_at ?? r.created_at)}</td></tr>))}</tbody></table>
        </>}
      </div>
    </>
  );
}
