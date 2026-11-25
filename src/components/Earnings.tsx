'use client';
import { useCallback, useEffect, useState } from 'react';
import { api, ago, money } from '@/lib/format';

type Report = {
  now: string;
  accounts: { id: string; kind: string; mc_name: string; owner_name: string; stats_reset_at: string | null;
              earnings_reset_at: string | null; profit_since_reset: number; events_since_reset: number;
              last_hour: number; today: number }[];
  events: { at: string; account_id: string; mc_name: string; kind: string; delta: number; balance: number | null }[];
  hourly: { hour: string; account_id: string; mc_name: string; profit: number; events: number }[];
  daily: { day: string; account_id: string; mc_name: string; profit: number; events: number }[];
};

const fmtHour = (h: string) => { const d = h.slice(0, 10).split('-'); return `${d[2]}.${d[1]} ${h.slice(11, 16)}`; };
const fmtDay = (d: string) => { const p = d.slice(0, 10).split('-'); return `${p[2]}.${p[1]}.${p[0]}`; };
const sign = (n: number) => (Number(n) > 0 ? 'green' : Number(n) < 0 ? 'red' : 'muted');

/**
 * Satis / kazanc kayitlari + saatlik / gunluk kazanc notu.
 * scope=member -> /api/me/earnings, scope=admin -> /api/admin/earnings.
 * "Sifirla" butonlari sadece bu goruntuleyenin gorunumunu sifirlar (kayit silinmez, karsi taraf etkilenmez).
 */
export function Earnings({ scope, onLoaded }: { scope: 'member' | 'admin'; onLoaded?: (r: Report) => void }) {
  const base = scope === 'member' ? '/api/me/earnings' : '/api/admin/earnings';
  const [rep, setRep] = useState<Report | null>(null);
  const [account, setAccount] = useState('');
  const [err, setErr] = useState('');

  const load = useCallback(async () => {
    try {
      const r = await api(`${base}${account ? `?account=${account}` : ''}`);
      setRep(r.report);
      if (!account) onLoaded?.(r.report);
    } catch (e: any) { setErr(e.message); }
  }, [base, account, onLoaded]);
  useEffect(() => { load(); const t = setInterval(load, 30_000); return () => clearInterval(t); }, [load]);

  async function reset(kind: 'STATS' | 'EARNINGS') {
    const what = kind === 'STATS' ? 'satış/işlem kayıtları ve toplamlar' : 'saatlik/günlük kazanç notu';
    const target = account ? rep?.accounts.find((a) => a.id === account)?.mc_name : 'tüm hesaplar';
    if (!confirm(`${target}: ${what} SENİN görünümünde sıfırlansın mı?\n` +
      (scope === 'member' ? 'Operatör paneli etkilenmez.' : 'Üyelerin paneli ve diğer operatörler etkilenmez.') +
      '\nKomisyon / borç / ödeme kayıtları değişmez.')) return;
    setErr('');
    try { await api(base, { method: 'POST', json: { kind, accountId: account || null } }); await load(); }
    catch (e: any) { setErr(e.message); }
  }

  if (!rep) return <div className="card">{err ? <div className="err">{err}</div> : 'Kazanç kayıtları yükleniyor…'}</div>;
  const totals = rep.accounts.reduce((t, a) => ({ hour: t.hour + Number(a.last_hour), today: t.today + Number(a.today),
                                                   since: t.since + Number(a.profit_since_reset) }), { hour: 0, today: 0, since: 0 });
  const days = Array.from(new Set(rep.daily.map((d) => d.day))).slice(0, 14);
  const dayTotal = (d: string) => rep.daily.filter((x) => x.day === d).reduce((t, x) => t + Number(x.profit), 0);
  const hours = Array.from(new Set(rep.hourly.map((h) => h.hour))).slice(0, 24);
  const hourTotal = (h: string) => rep.hourly.filter((x) => x.hour === h).reduce((t, x) => t + Number(x.profit), 0);

  return (
    <>
      <div className="card">
        <div className="row" style={{ justifyContent: 'space-between' }}>
          <h2>Satış / işlem kayıtları</h2>
          <div className="row">
            <select value={account} onChange={(e) => setAccount(e.target.value)}>
              <option value="">Tüm hesaplar</option>
              {rep.accounts.map((a) => <option key={a.id} value={a.id}>{a.mc_name}{a.kind === 'OPERATOR' ? ' (operatör)' : ''}</option>)}
            </select>
            <button className="danger" onClick={() => reset('STATS')}>Kayıtları sıfırla</button>
          </div>
        </div>
        <div className="stats" style={{ margin: '10px 0' }}>
          <div className="stat"><b className={sign(totals.hour)}>{money(totals.hour)}</b><span>son 1 saatte kazanç</span></div>
          <div className="stat"><b className={sign(totals.today)}>{money(totals.today)}</b><span>bugün (İstanbul)</span></div>
          <div className="stat"><b className={sign(totals.since)}>{money(totals.since)}</b><span>sıfırlamadan beri</span></div>
        </div>
        <div className="scroll"><table>
          <thead><tr><th>Hesap</th>{scope === 'admin' && <th>Kullanıcı</th>}<th className="num">1 saatte</th><th className="num">Bugün</th>
            <th className="num">Sıfırlamadan beri</th><th className="num">İşlem</th><th>Son sıfırlama</th></tr></thead>
          <tbody>{rep.accounts.map((a) => (
            <tr key={a.id}><td><b>{a.mc_name}</b>{a.kind === 'OPERATOR' && <span className="pill" style={{ marginLeft: 6 }}>operatör</span>}</td>
              {scope === 'admin' && <td>{a.owner_name}</td>}
              <td className={'num ' + sign(a.last_hour)}>{money(a.last_hour)}</td>
              <td className={'num ' + sign(a.today)}>{money(a.today)}</td>
              <td className={'num ' + sign(a.profit_since_reset)}>{money(a.profit_since_reset)}</td>
              <td className="num">{a.events_since_reset}</td>
              <td className="muted">{a.stats_reset_at ? ago(a.stats_reset_at) : '—'}</td></tr>))}
            {rep.accounts.length === 0 && <tr><td colSpan={7} className="muted">Hesap yok.</td></tr>}
          </tbody>
        </table></div>
        <p className="muted" style={{ marginTop: 10 }}>Her satır, botun panele bildirdiği bir net kâr değişimidir
          (satış geliri − ürün maliyeti − ilan vergisi). Mod ürün adı ve birim fiyatı göndermediği için ürün bazında
          döküm yoktur; ürün ve fiyat ayrıntısı oyundaki AutoSeller panelinde (O tuşu) görünür.</p>
        <div className="scroll" style={{ maxHeight: 360 }}><table>
          <thead><tr><th>Zaman</th><th>Hesap</th><th className="num">Net kâr değişimi</th><th className="num">Bakiye</th></tr></thead>
          <tbody>{rep.events.map((e, i) => (
            <tr key={i}><td className="muted" title={e.at}>{new Date(e.at).toLocaleString('tr-TR')}</td><td>{e.mc_name}</td>
              <td className={'num ' + sign(e.delta)}>{Number(e.delta) > 0 ? '+' : ''}{money(e.delta)}</td>
              <td className="num muted">{e.balance != null ? money(e.balance) : '—'}</td></tr>))}
            {rep.events.length === 0 && <tr><td colSpan={4} className="muted">Kayıt yok.</td></tr>}
          </tbody>
        </table></div>
      </div>

      <div className="card">
        <div className="row" style={{ justifyContent: 'space-between' }}>
          <h2>Saatlik / günlük kazanç notu</h2>
          <button className="danger" onClick={() => reset('EARNINGS')}>Kazanç notunu sıfırla</button>
        </div>
        <div className="grid2">
          <div><b>Saat saat (son 48 saat)</b>
            <table><thead><tr><th>Saat</th><th>Hesap</th><th className="num">Kazanç</th></tr></thead>
              <tbody>{hours.map((h) => {
                const rows = rep.hourly.filter((x) => x.hour === h);
                return rows.map((x, i) => (
                  <tr key={h + x.account_id}>
                    <td>{i === 0 ? <b>{fmtHour(h)}</b> : ''}</td><td>{x.mc_name}</td>
                    <td className={'num ' + sign(x.profit)}>{money(x.profit)}{i === rows.length - 1 && rows.length > 1 &&
                      <div className="muted">toplam {money(hourTotal(h))}</div>}</td></tr>));
              })}
                {hours.length === 0 && <tr><td colSpan={3} className="muted">Kayıt yok.</td></tr>}
              </tbody></table></div>
          <div><b>Gün gün (son 14 gün)</b>
            <table><thead><tr><th>Gün</th><th>Hesap</th><th className="num">Kazanç</th></tr></thead>
              <tbody>{days.map((d) => {
                const rows = rep.daily.filter((x) => x.day === d);
                return rows.map((x, i) => (
                  <tr key={d + x.account_id}>
                    <td>{i === 0 ? <b>{fmtDay(d)}</b> : ''}</td><td>{x.mc_name}</td>
                    <td className={'num ' + sign(x.profit)}>{money(x.profit)}{i === rows.length - 1 && rows.length > 1 &&
                      <div className="muted">toplam {money(dayTotal(d))}</div>}</td></tr>));
              })}
                {days.length === 0 && <tr><td colSpan={3} className="muted">Kayıt yok.</td></tr>}
              </tbody></table></div>
        </div>
      </div>
      {err && <div className="err">{err}</div>}
    </>
  );
}
