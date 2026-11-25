'use client';
import { useCallback, useEffect, useState } from 'react';
import { api, money } from '@/lib/format';

const HOW: Record<string, string> = { single: 'tekil', batch: 'toplu', unmatched: 'eşleşmedi', early: 'anlık' };
const sign = (n: number | null) => (n == null ? 'muted' : Number(n) > 0 ? 'green' : Number(n) < 0 ? 'red' : 'muted');

/** Urun bazli satis gecmisi (modun bildirdigi gercek satis mesajlari; uydurma veri yok) */
export function SalesLog({ scope }: { scope: 'member' | 'admin' }) {
  const base = scope === 'member' ? '/api/me/sales' : '/api/admin/sales';
  const [rep, setRep] = useState<any>(null);
  const [account, setAccount] = useState('');
  const [accounts, setAccounts] = useState<{ id: string; mc_name: string }[]>([]);
  const [err, setErr] = useState('');

  const load = useCallback(async () => {
    try {
      const r = (await api(`${base}${account ? `?account=${account}` : ''}`)).report;
      setRep(r);
      if (!account) {
        const seen = new Map<string, string>();
        r.sales.forEach((s: any) => seen.set(s.account_id, s.mc_name));
        setAccounts(Array.from(seen, ([id, mc_name]) => ({ id, mc_name })));
      }
    } catch (e: any) { setErr(e.message); }
  }, [base, account]);
  useEffect(() => { load(); const t = setInterval(load, 30_000); return () => clearInterval(t); }, [load]);

  if (!rep) return <div className="card">{err ? <div className="err">{err}</div> : 'Satış geçmişi yükleniyor…'}</div>;
  return (
    <div className="card">
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <h2>Satış geçmişi (ürün bazında)</h2>
        <select value={account} onChange={(e) => setAccount(e.target.value)}>
          <option value="">Tüm hesaplar</option>
          {accounts.map((a) => <option key={a.id} value={a.id}>{a.mc_name}</option>)}
        </select>
      </div>
      {rep.sales.length === 0 ? (
        <p className="muted" style={{ marginTop: 10 }}>Henüz ürün bazlı satış kaydı yok. Kayıtlar AutoSeller mod <b>v0.7.1</b> ve
          üstü çalışırken, oyundaki satış mesajlarından ("… bought your …", "You earned …") otomatik oluşur ve her heartbeat'te
          (≈30 sn) panele gelir. Eski mod sürümleri ürün bilgisi göndermez.</p>
      ) : <>
        {rep.by_item.length > 0 && <>
          <b style={{ display: 'block', marginTop: 10 }}>Son 7 gün · ürün özeti</b>
          <table><thead><tr><th>Ürün</th><th>Hesap</th><th className="num">Satış</th><th className="num">Adet</th><th className="num">Gelir</th><th className="num">Net kâr</th></tr></thead>
            <tbody>{rep.by_item.slice(0, 15).map((x: any, i: number) => (
              <tr key={i}><td><b>{x.item}</b></td><td>{x.mc_name}</td><td className="num">{x.count}</td><td className="num">{x.amount}</td>
                <td className="num">{money(x.revenue)}</td><td className={'num ' + sign(x.net)}>{money(x.net)}</td></tr>))}
            </tbody></table>
        </>}
        <b style={{ display: 'block', marginTop: 12 }}>Tüm satışlar ({rep.total_count})</b>
        <div className="scroll" style={{ maxHeight: 420 }}><table>
          <thead><tr><th>Zaman</th><th>Hesap</th>{scope === 'admin' && <th>Kullanıcı</th>}<th>Ürün</th><th className="num">Adet</th>
            <th className="num">Satış fiyatı</th><th className="num">Birim</th><th className="num">Maliyet</th><th className="num">İlan vergisi</th>
            <th className="num">Net kâr</th><th>Eşleşme</th></tr></thead>
          <tbody>{rep.sales.map((s: any, i: number) => (
            <tr key={i}><td className="muted">{new Date(s.at).toLocaleString('tr-TR')}</td><td>{s.mc_name}</td>
              {scope === 'admin' && <td>{s.owner_name}</td>}
              <td><b>{s.item_name ?? s.item_id ?? '?'}</b>{s.item_id && s.item_name && <div className="muted">{s.item_id}</div>}</td>
              <td className="num">{s.amount ?? '—'}</td><td className="num">{money(s.revenue)}</td>
              <td className="num muted">{s.unit_price != null ? money(s.unit_price) : '—'}</td>
              <td className="num muted">{s.cost != null ? money(s.cost) : '—'}</td>
              <td className="num muted">{s.tax != null ? money(s.tax) : '—'}</td>
              <td className={'num ' + sign(s.net)}>{s.net != null ? money(s.net) : '—'}</td>
              <td className="muted">{HOW[s.how] ?? s.how ?? ''}</td></tr>))}
          </tbody></table></div>
        <p className="muted">"Kayıtları sıfırla" (aşağıdaki kazanç bölümü) bu listeyi de yalnızca senin görünümünde sıfırlar.</p>
      </>}
      {err && <div className="err">{err}</div>}
    </div>
  );
}
