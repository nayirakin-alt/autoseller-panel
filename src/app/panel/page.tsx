'use client';
import { Fragment, useCallback, useEffect, useState } from 'react';
import { Header } from '@/components/Header';
import { RankShop } from '@/components/RankShop';
import { Earnings } from '@/components/Earnings';
import { SalesLog } from '@/components/SalesLog';
import { MemberJobs } from '@/components/MemberJobs';
import { api, ago, duration, money } from '@/lib/format';

type Account = Record<string, any>;

function accessLabel(a: Account) {
  if (a.access_enabled) return <span className="pill green">onaylı · açık</span>;
  if ((a.blocked_reason ?? '').includes('onay')) return <span className="pill accent">onay bekliyor</span>;
  return <span className="pill red" title={a.blocked_reason}>kapalı</span>;
}

// UYE paneli: kendi MC hesaplari, gunluk kod, 50/60 dk, saatlik kar, %40 komisyon, odeme durumu
export default function MemberPanel() {
  const [data, setData] = useState<any>(null);
  const [err, setErr] = useState('');
  const [codes, setCodes] = useState<Record<string, any>>({});
  const [hist, setHist] = useState<Record<string, any>>({});
  const [newName, setNewName] = useState('');
  const [agree, setAgree] = useState(false);
  const [tab, setTab] = useState<'accounts' | 'rank' | 'earnings'>('accounts');

  const load = useCallback(() => api('/api/me').then(setData).catch((e) => setErr(e.message)), []);
  useEffect(() => { load(); const t = setInterval(load, 30_000); return () => clearInterval(t); }, [load]);

  if (!data) return <div className="wrap">{err ? <div className="err">{err}</div> : 'Yükleniyor…'}</div>;
  const { me, accounts, settings } = data;
  // Komisyon orani rutbeye gore (Bronze %50, Gold %40, Diamond %30, Ametis %25)
  const rate = Number(data.rank?.commission_rate ?? settings.commission_rate ?? 0.5);
  const winSec = Number(settings.window_seconds ?? 3600);
  const grace = Number(settings.commission_grace_min ?? 120);
  const receiver = settings.commission_receiver || 'operatör';

  async function consent() { await api('/api/me/consent', { method: 'POST', json: {} }); load(); }
  async function showCode(id: string) {
    setErr('');
    try { const r = await api(`/api/me/accounts/${id}/code`); setCodes((c) => ({ ...c, [id]: r.code })); }
    catch (x: any) { setErr(x.message); }
  }
  async function toggleHist(id: string) {
    if (hist[id]) { setHist((h) => { const n = { ...h }; delete n[id]; return n; }); return; }
    const r = await api(`/api/me/accounts/${id}/history`); setHist((h) => ({ ...h, [id]: r }));
  }
  async function add(e: React.FormEvent) {
    e.preventDefault(); setErr('');
    try { await api('/api/me/accounts', { method: 'POST', json: { mcName: newName } }); setNewName(''); load(); }
    catch (x: any) { setErr(x.message); }
  }

  const sum = (k: string) => accounts.reduce((t: number, a: Account) => t + Number(a[k] ?? 0), 0);

  return (
    <div className="wrap">
      <Header name={me.displayName} role={me.role} />

      {!me.consentAt && (
        <div className="card notice">
          <h2>İlk kullanım onayı</h2>
          <p>AutoSeller'ı lisanslı kullanmadan önce şunları kabul etmen gerekiyor:</p>
          <ul>
            <li>Mod çalışırken bu panele <b>net kâr, çalışma süresi, bakiye ve /pay ödeme bilgisi</b> gönderir.</li>
            <li>Mod bir <b>bütünlük kontrolü</b> yapar: mod dosyasının parmak izi (SHA-256), Java agent / debugger ve
                geliştirme ortamı tespiti. Kişisel dosya taranmaz. Kurcalama bulgusu kullanıcı adın, MC hesabın ve günlük kod
                numaranla operatöre raporlanır.</li>
            <li>Operatör erişimini <b>uzaktan kapatabilir</b>; mod 30 sn içinde durur.</li>
            <li>Her <b>60 dakikalık aktif çalışmada</b> o saatte elde edilen <b>net kârın rütbene göre bir yüzdesi</b>
                (şu an {data.rank?.name ?? 'Bronze'}: %{Math.round(rate * 100)})
                (satış − ürün maliyeti − ilan vergisi) komisyon olarak <b>{receiver}</b> hesabına bakiye yettiğinde otomatik
                <code> /pay</code> ile gönderilir. {grace} dk içinde ödenmeyen borçta mod <b>sadece ödeme</b> moduna geçer.</li>
            <li>Mod kullanımı sunucu kurallarına aykırı olabilir; <b>ban riski sana aittir</b>.</li>
          </ul>
          <label className="row"><input type="checkbox" checked={agree} onChange={(e) => setAgree(e.target.checked)} />
            Mod veri gönderir ve uzaktan kapatılabilir; okudum, kabul ediyorum.</label>
          <div style={{ marginTop: 10 }}><button className="primary" disabled={!agree} onClick={consent}>Onaylıyorum</button></div>
        </div>
      )}

      <div className="card stats">
        <div className="stat"><b>{money(sum('profit_total'))}</b><span>toplam net kâr</span></div>
        <div className="stat"><b>{money(sum('commission_total'))}</b><span>hesaplanan komisyon (%{Math.round(rate * 100)})</span></div>
        <div className="stat"><b className="green">{money(sum('payments_verified'))}</b><span>doğrulanmış ödeme</span></div>
        <div className="stat"><b className={sum('pending_debt') > 0 ? 'accent' : ''}>{money(sum('pending_debt'))}</b><span>bekleyen borç</span></div>
        <div className="stat"><b style={{ color: data.rank?.color }}>{data.rank?.name ?? 'Bronze'}</b>
          <span>rütbe · %{Math.round(rate * 100)} komisyon</span></div>
        <div className="stat"><b>{me.status === 'ACTIVE' ? <span className="green">aktif</span> : <span className="red">askıda</span>}</b>
          <span>üyelik durumu{me.suspendedReason ? ` · ${me.suspendedReason}` : ''}</span></div>
      </div>

      <div className="tabs">
        <button className={tab === 'accounts' ? 'on' : ''} onClick={() => setTab('accounts')}>Hesaplarım</button>
        <button className={tab === 'rank' ? 'on' : ''} onClick={() => setTab('rank')}>Rütbe ve ödeme talepleri</button>
        <button className={tab === 'earnings' ? 'on' : ''} onClick={() => setTab('earnings')}>Satışlar / kazanç</button>
      </div>

      {tab === 'rank' && <RankShop onChange={load} />}
      {tab === 'earnings' && <><SalesLog scope="member" /><Earnings scope="member" /></>}
      {tab === 'accounts' && me.consentAt && <MemberJobs consentAt={me.remotePayConsentAt ?? null} receiver={receiver} onChange={load} />}

      {tab === 'accounts' && <div className="card">
        <h2>Minecraft hesaplarım</h2>
        <div className="scroll">
          <table>
            <thead><tr>
              <th>Hesap</th><th>Erişim</th><th>Bot</th><th>Bu saat (aktif süre)</th>
              <th className="num">Toplam net kâr</th><th className="num">Son 1 saat kâr</th><th className="num">%{Math.round(rate * 100)} komisyon</th>
              <th className="num">Ödenen</th><th className="num">Bekleyen borç</th><th>Bugünün kodu</th><th>Son görülme</th><th></th>
            </tr></thead>
            <tbody>
              {accounts.map((a: Account) => {
                const act = Number(a.open_window_active_seconds ?? 0);
                const pct = Math.min(100, Math.round((act / winSec) * 100));
                return (
                  <Fragment key={a.id}>
                    <tr>
                      <td><b>{a.mc_name}</b>{a.mod_version && <div className="muted">v{a.mod_version}</div>}</td>
                      <td>{accessLabel(a)}{!a.access_enabled && a.blocked_reason && !(a.blocked_reason ?? '').includes('onay') &&
                        <div className="muted" style={{ whiteSpace: 'normal', maxWidth: 200 }}>{a.blocked_reason}</div>}</td>
                      <td>{a.online ? (a.running ? <span className="green">çalışıyor</span> : 'bağlı') : <span className="muted">kapalı</span>}
                        {a.session_mode === 'PAY_ONLY' && <div><span className="pill red">sadece ödeme</span></div>}</td>
                      <td><span className="bar"><i style={{ width: pct + '%' }} /></span> {Math.floor(act / 60)}/{Math.round(winSec / 60)} dk
                        <div className="muted">bu saatin kârı {money(a.open_window_profit)}</div></td>
                      <td className="num">{money(a.profit_total)}<div className="muted">{duration(a.active_seconds_total)}</div></td>
                      <td className="num">{a.last_hour_profit != null ? money(a.last_hour_profit) : '—'}
                        {a.last_hour_closed_at && <div className="muted">{ago(a.last_hour_closed_at)}</div>}</td>
                      <td className="num">{a.last_hour_commission != null ? money(a.last_hour_commission) : '—'}
                        <div className="muted">toplam {money(a.commission_total)}</div></td>
                      <td className="num">{money(a.commission_paid_claimed)}<div className="muted">✔ {money(a.payments_verified)} doğrulandı</div></td>
                      <td className={'num ' + (Number(a.pending_debt) > 0 ? (a.overdue ? 'red' : 'accent') : '')}>{money(a.pending_debt)}
                        {a.overdue && <div className="red">vadesi geçti</div>}</td>
                      <td>{codes[a.id]
                        ? <span><span className="code">{codes[a.id].code}</span> <span className="muted">#{codes[a.id].id}</span></span>
                        : <button onClick={() => showCode(a.id)} disabled={!a.access_enabled || !me.consentAt}>Göster</button>}</td>
                      <td className="muted">{ago(a.last_seen_at)}{a.last_code_id ? ` · kod #${a.last_code_id}` : ''}</td>
                      <td><button onClick={() => toggleHist(a.id)}>{hist[a.id] ? 'Gizle' : 'Geçmiş'}</button></td>
                    </tr>
                    {hist[a.id] && (
                      <tr><td colSpan={12} style={{ background: '#11161d' }}>
                        <div className="grid2">
                          <div><b>Saatlik pencereler</b>
                            <table><thead><tr><th>#</th><th>Durum</th><th>Süre</th><th className="num">Kâr</th><th className="num">Komisyon</th><th>Kapanış</th></tr></thead>
                              <tbody>{hist[a.id].windows.map((w: any) => (
                                <tr key={w.id}><td>{w.window_no}</td><td>{w.status === 'OPEN' ? 'açık' : 'kapandı'}</td>
                                  <td>{duration(w.active_seconds)}</td><td className="num">{money(w.profit_delta)}</td>
                                  <td className="num">{money(w.commission)}</td><td className="muted">{ago(w.closed_at)}</td></tr>))}
                              </tbody></table></div>
                          <div><b>Ödemeler</b>
                            <table><thead><tr><th>#</th><th className="num">Tutar</th><th>Alıcı</th><th>Durum</th><th>Zaman</th></tr></thead>
                              <tbody>{hist[a.id].payments.map((p: any) => (
                                <tr key={p.id}><td>{p.id}</td><td className="num">{money(p.amount)}</td><td>{p.to_player}</td>
                                  <td>{p.status === 'VERIFIED' ? <span className="green">doğrulandı</span> : p.status === 'REJECTED' ? <span className="red">reddedildi</span> : 'bekliyor'}</td>
                                  <td className="muted">{ago(p.claimed_at)}</td></tr>))}
                                {hist[a.id].payments.length === 0 && <tr><td colSpan={5} className="muted">Yok.</td></tr>}
                              </tbody></table></div>
                        </div>
                      </td></tr>
                    )}
                  </Fragment>
                );
              })}
              {accounts.length === 0 && <tr><td colSpan={12} className="muted">Henüz hesap yok.</td></tr>}
            </tbody>
          </table>
        </div>
        <form onSubmit={add} className="row" style={{ marginTop: 12 }}>
          <input placeholder="Minecraft adı" value={newName} onChange={(e) => setNewName(e.target.value)} />
          <button>Hesap ekle</button>
          <span className="muted">Yeni hesap operatör onayından sonra çalışır. Kod her gün (İstanbul saatiyle 00:00) yenilenir;
            moddaki <b>Lisans</b> sekmesine ya da açılışta sorulduğunda gir.</span>
        </form>
        {err && <div className="err">{err}</div>}
      </div>}
    </div>
  );
}
