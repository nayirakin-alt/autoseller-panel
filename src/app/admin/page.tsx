'use client';
import { Fragment, useCallback, useEffect, useState } from 'react';
import { Header } from '@/components/Header';
import { AdminRanks, activeRankOf } from '@/components/AdminRanks';
import { AdminJobs } from '@/components/AdminJobs';
import { AccountPayRow } from '@/components/AccountPayRow';
import { SalesLog } from '@/components/SalesLog';
import { Earnings } from '@/components/Earnings';
import { api, ago, duration, money } from '@/lib/format';

type Tab = 'accounts' | 'payments' | 'requests' | 'ranks' | 'earnings' | 'operators' | 'security' | 'users' | 'settings';
const KNOWN: Record<string, string> = {
  commission_rate: 'Eski sabit komisyon oranı (kullanılmıyor; oran Rütbeler sekmesinden)',
  window_seconds: 'Pencere süresi (sn aktif çalışma)',
  heartbeat_max_gap_sec: 'Heartbeat boşluk sınırı (sn)',
  heartbeat_min_interval: 'Heartbeat en kısa aralık (sn)',
  session_timeout_sec: 'Oturum zaman aşımı (sn)',
  commission_receiver: 'Komisyon alıcısı (kasa MC hesabı)',
  commission_grace_min: 'Ödeme süresi, sonra PAY_ONLY (dk)',
  payment_match_window_min: 'Ödeme eşleştirme penceresi (dk)',
  min_mod_version: 'En düşük mod sürümü',
  require_mojang_auth: 'Mojang hesap doğrulaması',
  allowed_mod_hashes: 'İzinli mod jar SHA-256 listesi',
  tamper_action: 'Kritik kurcalamada eylem',
  balance_mismatch_min: 'Bakiye-kâr uyarı eşiği ($)',
  rank_order_ttl_min: 'Rütbe siparişi geçerlilik süresi (dk)',
  log_operator_accounts: 'Operatör MC hesapları güvenlik logu üretsin mi',
  security_dedupe_min: 'Aynı güvenlik olayını tekrar yazmama süresi (dk)',
};

// OPERATOR paneli
export default function OperatorPanel() {
  const [me, setMe] = useState<any>(null);
  const [d, setD] = useState<any>(null);
  const [tab, setTab] = useState<Tab>('accounts');
  const [err, setErr] = useState('');
  const [codes, setCodes] = useState<Record<string, any>>({});
  const [opName, setOpName] = useState('');
  const [opNote, setOpNote] = useState('');
  const [settings, setSettings] = useState<any[]>([]);
  const [events, setEvents] = useState<any[]>([]);
  const [sev, setSev] = useState('');
  const [hashIn, setHashIn] = useState('');
  const [filter, setFilter] = useState('');
  const [rankInfo, setRankInfo] = useState<any>({ ranks: [], grants: [], orders: [] });
  const [live, setLive] = useState<Record<string, any>>({});
  const [jobsVersion, setJobsVersion] = useState(0);
  const [payOpen, setPayOpen] = useState<{ id: string; mode: 'job' | 'manual' } | null>(null);

  const load = useCallback(async () => {
    try {
      const m = await api('/api/me'); setMe(m.me);
      setD(await api('/api/admin/overview'));
      setSettings((await api('/api/admin/settings')).settings);
      setEvents((await api(`/api/admin/security${sev ? `?severity=${sev}` : ''}`)).events);
      setRankInfo(await api('/api/admin/ranks'));
      const er = (await api('/api/admin/earnings')).report;
      setLive(Object.fromEntries(er.accounts.map((x: any) => [x.id, x])));
    } catch (e: any) { setErr(e.message); }
  }, [sev]);
  useEffect(() => { load(); const t = setInterval(load, 15_000); return () => clearInterval(t); }, [load]);

  const act = (fn: () => Promise<unknown>) => async () => { setErr(''); try { await fn(); await load(); } catch (e: any) { setErr(e.message); } };
  if (!d) return <div className="wrap">{err ? <div className="err">{err}</div> : 'Yükleniyor…'}</div>;
  const nameOf = (id: string) => d.accounts.find((a: any) => a.id === id)?.mc_name ?? id;
  const setting = (k: string) => settings.find((s) => s.key === k)?.value;
  const putSetting = (key: string, value: unknown) => api('/api/admin/settings', { method: 'PUT', json: { key, value } });
  const receiver: string = setting('commission_receiver') ?? '';
  const hashes: string[] = Array.isArray(setting('allowed_mod_hashes')) ? setting('allowed_mod_hashes') : [];
  const winSec = Number(setting('window_seconds') ?? 3600);
  const awaiting = d.accounts.filter((a: any) => !a.access_enabled && String(a.blocked_reason ?? '').includes('onay'));
  const rows = d.accounts.filter((a: any) => !filter || `${a.mc_name} ${a.owner_name}`.toLowerCase().includes(filter.toLowerCase()));

  const T = (id: Tab, label: string, badge?: number) => (
    <button className={tab === id ? 'on' : ''} onClick={() => setTab(id)}>{label}{badge ? <span className="badge">{badge}</span> : null}</button>
  );

  return (
    <div className="wrap">
      <Header name={me?.displayName} role={me?.role} />
      {err && <div className="err">{err}</div>}

      <div className="card stats">
        <div className="stat"><b>{d.totals.online} / {d.totals.accounts}</b><span>çevrimiçi / hesap</span></div>
        <div className="stat"><b>{money(d.totals.profit_total)}</b><span>toplam net kâr</span></div>
        <div className="stat"><b>{money(d.totals.commission_total)}</b><span>gereken komisyon</span></div>
        <div className="stat"><b className="green">{money(d.totals.payments_verified)}</b><span>doğrulanmış ödeme</span></div>
        <div className="stat"><b className="accent">{money(d.totals.pending_debt)}</b><span>bekleyen borç</span></div>
        <div className="stat"><b className={d.totals.security_events_24h ? 'red' : ''}>{d.totals.security_events_24h}</b><span>güvenlik uyarısı (24 sa)</span></div>
      </div>

      <div className="tabs">
        {T('accounts', 'Hesaplar', awaiting.length)}
        {T('payments', 'Ödemeler', d.unverifiedPayments.length)}
        {T('requests', 'Ödeme Al / İş Emirleri')}
        {T('ranks', 'Rütbeler', rankInfo.orders.filter((o: any) => o.status === 'PENDING').length)}
        {T('earnings', 'Satışlar / Kazanç')}
        {T('operators', 'Operatör Hesapları')}
        {T('security', 'Güvenlik / Kurcalama Logları', d.totals.tampered)}
        {T('users', 'Kullanıcılar')}
        {T('settings', 'Ayarlar')}
      </div>

      {tab === 'accounts' && <>
        {awaiting.length > 0 && (
          <div className="card notice">
            <h2>Onay bekleyen hesaplar</h2>
            <table><thead><tr><th>Hesap</th><th>Kullanıcı</th><th>Eklendi</th><th></th></tr></thead>
              <tbody>{awaiting.map((a: any) => (
                <tr key={a.id}><td><b>{a.mc_name}</b></td><td>{a.owner_name}</td><td className="muted">{ago(a.created_at)}</td>
                  <td className="row">
                    <button className="primary" onClick={act(() => api(`/api/admin/accounts/${a.id}/access`, { method: 'POST', json: { enabled: true } }))}>Onayla</button>
                    <button className="danger" onClick={act(() => api(`/api/admin/accounts/${a.id}/access`, { method: 'POST', json: { enabled: false, reason: prompt('Red sebebi?') || 'Operatör reddetti' } }))}>Reddet</button>
                  </td></tr>))}
              </tbody></table>
          </div>
        )}
        <div className="card">
          <div className="row" style={{ justifyContent: 'space-between' }}>
            <h2>Üye hesapları</h2>
            <input placeholder="Ara (hesap / kullanıcı)" value={filter} onChange={(e) => setFilter(e.target.value)} />
          </div>
          <div className="scroll"><table>
            <thead><tr>
              <th>Hesap</th><th>Kullanıcı</th><th>Aktiflik</th><th>Bu saat</th><th className="num">Toplam kâr</th>
              <th className="num">1 saatte (canlı)</th>
              <th className="num">Son 1 saat kâr</th><th className="num">Gereken komisyon</th>
              <th className="num">Gönderilen</th><th className="num">Bekleyen</th><th>Kod</th><th>Erişim</th>
            </tr></thead>
            <tbody>{rows.map((a: any) => {
              const act2 = Number(a.open_window_active_seconds ?? 0);
              return (
                <Fragment key={a.id}>
                <tr>
                  <td><b>{a.mc_name}</b><div className="muted">{a.mod_version ? `v${a.mod_version}` : ''}</div>
                    {a.tamper_flag && <span className="pill red" title={a.tamper_reason}>⚠ {a.tamper_reason}</span>}</td>
                  <td>{a.owner_name}{(() => { const rk = activeRankOf(a.owner_id, rankInfo.grants, rankInfo.ranks).rank; return rk &&
                    <div><span className="pill" style={{ borderColor: rk.color, color: rk.color }}>{rk.name} %{Math.round(Number(rk.commission_rate) * 100)}</span></div>; })()}</td>
                  <td>{a.online ? (a.running ? <span className="green">çalışıyor</span> : 'bağlı') : <span className="muted">kapalı</span>}
                    {a.session_mode === 'PAY_ONLY' && <div><span className="pill red">PAY_ONLY</span></div>}
                    <div className="muted">{ago(a.last_seen_at)}</div></td>
                  <td><span className="bar"><i style={{ width: Math.min(100, act2 / winSec * 100) + '%' }} /></span> {Math.floor(act2 / 60)}/{Math.round(winSec / 60)} dk
                    <div className="muted">{money(a.open_window_profit)}</div></td>
                  <td className="num">{money(a.profit_total)}<div className="muted">{duration(a.active_seconds_total)}</div></td>
                  <td className="num">{money(live[a.id]?.last_hour ?? 0)}<div className="muted">bugün {money(live[a.id]?.today ?? 0)}</div></td>
                  <td className="num">{a.last_hour_profit != null ? money(a.last_hour_profit) : '—'}<div className="muted">→ {money(a.last_hour_commission)}</div></td>
                  <td className="num">{money(a.commission_total)}</td>
                  <td className="num">{money(a.commission_paid_claimed)}<div className="muted">✔ {money(a.payments_verified)}</div></td>
                  <td className={'num ' + (a.overdue ? 'red' : Number(a.pending_debt) > 0 ? 'accent' : '')}>{money(a.pending_debt)}
                    {a.overdue && <div className="red">vadesi geçti</div>}</td>
                  <td>{a.session_code_id ? `#${a.session_code_id}` : a.last_code_id ? <span className="muted">#{a.last_code_id}</span> : '—'}
                    {a.last_code && <div className="muted">{a.last_code}</div>}
                    {codes[a.id] ? <div className="code" style={{ fontSize: 13 }}>{codes[a.id].code}</div>
                      : <div><button onClick={act(async () => { const r = await api(`/api/admin/accounts/${a.id}/code`); setCodes((c) => ({ ...c, [a.id]: r.code })); })}>bugün</button></div>}</td>
                  <td>{a.access_enabled
                    ? <button className="danger" onClick={act(() => api(`/api/admin/accounts/${a.id}/access`, { method: 'POST', json: { enabled: false, reason: prompt('Kapatma sebebi?') || 'Operatör kapattı' } }))}>Kapat</button>
                    : <button className="primary" title={a.blocked_reason} onClick={act(() => api(`/api/admin/accounts/${a.id}/access`, { method: 'POST', json: { enabled: true } }))}>Aç</button>}
                    {!a.access_enabled && <div className="muted" style={{ whiteSpace: 'normal', maxWidth: 160 }}>{a.blocked_reason}</div>}
                    <div className="row" style={{ marginTop: 4 }}>
                      <button className="primary" onClick={() => setPayOpen(payOpen?.id === a.id && payOpen?.mode === 'job' ? null : { id: a.id, mode: 'job' })}>Ödeme al</button>
                      <button title="Sadece kasada görülmüş ödemeyi borca sayar" onClick={() => setPayOpen(payOpen?.id === a.id && payOpen?.mode === 'manual' ? null : { id: a.id, mode: 'manual' })}>+ödeme</button>
                      {a.tamper_flag && <button onClick={act(() => api(`/api/admin/accounts/${a.id}/clear-tamper`, { method: 'POST', json: {} }))}>bayrağı kaldır</button>}
                    </div>
                  </td>
                </tr>
                {payOpen?.id === a.id && (
                  <AccountPayRow account={a} receiver={receiver} colSpan={12}
                    mode={payOpen!.mode} onDone={() => { setJobsVersion((v) => v + 1); load(); }} onClose={() => setPayOpen(null)} />
                )}
                </Fragment>);
            })}
            {rows.length === 0 && <tr><td colSpan={12} className="muted">Hesap yok.</td></tr>}
            </tbody>
          </table></div>
        </div>
      </>}

      {tab === 'payments' && (
        <div className="card">
          <h2>Doğrulanmamış ödemeler</h2>
          <p className="muted">Mod "/pay gönderdim" dedi; kasa hesabının "paid you" kaydıyla ±{String(setting('payment_match_window_min') ?? 15)} dk içinde eşleşmedi.
            Kasayı kontrol edip onayla ya da reddet (red, borcu geri açar). Kasa hesabında mod açıksa eşleştirme otomatik olur.</p>
          <table><thead><tr><th>#</th><th>Hesap</th><th className="num">Tutar</th><th className="num">Vergi</th><th>Alıcı</th><th>Sohbet satırı</th><th>Zaman</th><th></th></tr></thead>
            <tbody>{d.unverifiedPayments.map((p: any) => (
              <tr key={p.id}><td>{p.id}</td><td>{nameOf(p.mc_account_id)}</td><td className="num">{money(p.amount)}</td>
                <td className="num muted">{money(p.tax)}</td><td>{p.to_player}</td>
                <td className="muted detail">{p.chat_line}</td><td className="muted">{ago(p.claimed_at)}</td>
                <td className="row">
                  <button className="primary" onClick={act(() => api(`/api/admin/payments/${p.id}/verify`, { method: 'POST', json: { accept: true } }))}>Onayla</button>
                  <button className="danger" onClick={act(() => api(`/api/admin/payments/${p.id}/verify`, { method: 'POST', json: { accept: false, note: prompt('Red sebebi?') ?? '' } }))}>Reddet</button>
                </td></tr>))}
              {d.unverifiedPayments.length === 0 && <tr><td colSpan={8} className="muted">Yok.</td></tr>}
            </tbody></table>
        </div>
      )}

      {tab === 'operators' && (
        <div className="card">
          <h2>Operatör hesapları</h2>
          <p className="muted">Bu listedeki Minecraft hesapları <b>günlük kod istemez</b> ve <b>komisyon üretmez</b> (muaf).
            Komisyonların gönderileceği <b>kasa</b> hesabı da burada olmalı; kasa hesabında mod açıkken gelen "paid you" mesajları ödemeleri otomatik doğrular.</p>
          <div className="row" style={{ margin: '10px 0' }}>
            <b>Kasa (alıcı) hesabı:</b>
            <select value={receiver} onChange={(e) => act(() => putSetting('commission_receiver', e.target.value))()}>
              <option value="">— seçilmedi —</option>
              {d.operatorAccounts.map((o: any) => <option key={o.id} value={o.mc_name}>{o.mc_name}</option>)}
            </select>
            {!receiver && <span className="red">Kasa seçilmeden komisyon ödenemez.</span>}
          </div>
          <table><thead><tr><th>Hesap</th><th>Not</th><th>Rol</th><th>Durum</th><th className="num">Kâr</th><th>Süre</th><th>Son görülme</th><th></th></tr></thead>
            <tbody>{d.operatorAccounts.map((o: any) => (
              <tr key={o.id}><td><b>{o.mc_name}</b></td><td className="muted">{o.note}</td>
                <td>{o.mc_name.toLowerCase() === receiver.toLowerCase() ? <span className="pill accent">KASA</span> : <span className="pill">muaf</span>}</td>
                <td>{o.online ? (o.running ? <span className="green">çalışıyor</span> : 'bağlı') : <span className="muted">kapalı</span>}</td>
                <td className="num">{money(o.profit_total)}</td><td>{duration(o.active_seconds_total)}</td><td className="muted">{ago(o.last_seen_at)}</td>
                <td><button className="danger" onClick={act(async () => { if (confirm(`${o.mc_name} muafiyet listesinden çıkarılsın mı?`)) await api(`/api/admin/operator-accounts/${o.id}`, { method: 'DELETE' }); })}>Kaldır</button></td></tr>))}
              {d.operatorAccounts.length === 0 && <tr><td colSpan={8} className="muted">Yok.</td></tr>}
            </tbody></table>
          <div className="row" style={{ marginTop: 10 }}>
            <input placeholder="Minecraft adı" value={opName} onChange={(e) => setOpName(e.target.value)} />
            <input placeholder="Not (örn. kasa)" value={opNote} onChange={(e) => setOpNote(e.target.value)} />
            <button className="primary" onClick={act(async () => { await api('/api/admin/operator-accounts', { method: 'POST', json: { mcName: opName, note: opNote || undefined } }); setOpName(''); setOpNote(''); })}>Ekle</button>
          </div>
        </div>
      )}

      {tab === 'security' && (
        <div className="card">
          <div className="row" style={{ justifyContent: 'space-between' }}>
            <h2>Güvenlik / Kurcalama Logları</h2>
            <div className="row">
              <button onClick={act(async () => {
                if (!confirm('Operatör hesaplarına ait eski güvenlik logları silinsin mi? (Yeni log zaten üretilmiyor)')) return;
                const r = await api('/api/admin/security/purge-operator', { method: 'POST', json: {} });
                alert(`${r.deleted} kayıt silindi`);
              })}>Operatör hesabı loglarını temizle</button>
              <span className="muted">Kritik olayda: <b>{String(setting('tamper_action') ?? 'LOG')}</b></span>
              <select value={sev} onChange={(e) => setSev(e.target.value)}>
                <option value="">tümü</option><option value="CRITICAL">CRITICAL</option><option value="WARN">WARN</option><option value="INFO">INFO</option>
              </select>
            </div>
          </div>
          <p className="muted">JAR_HASH_MISMATCH: mod dosyası değiştirilmiş · JAVA_AGENT / DEBUGGER: çalışma anında kod enjeksiyonu ya da hata ayıklayıcı ·
            DEV_ENVIRONMENT: geliştirme ortamında çalıştırma · BAD_SIGNATURE: imzası bozuk istek · SEQ_REGRESSION: tekrar oynatılan istek ·
            BALANCE_PROFIT_MISMATCH: bakiye artışı bildirilen kârla açıklanamıyor (kâr eksik bildiriliyor olabilir).</p>
          <div className="scroll"><table>
            <thead><tr><th>Zaman</th><th>Seviye</th><th>Tür</th><th>Kullanıcı</th><th>MC hesabı</th><th>Günlük kod</th><th>Eylem</th><th>Detay</th></tr></thead>
            <tbody>{events.map((e: any) => (
              <tr key={e.id}>
                <td className="muted" title={e.at}>{new Date(e.at).toLocaleString('tr-TR')}</td>
                <td className={'sev-' + e.severity}>{e.severity}</td>
                <td><b>{e.kind}</b></td>
                <td>{e.is_operator_account ? <span className="pill">operatör</span> : (e.owner_name ?? '—')}</td>
                <td>{e.mc_name ?? '—'}</td>
                <td>{e.daily_code_id ? <>#{e.daily_code_id} <span className="muted">{e.daily_code}</span></> : '—'}</td>
                <td>{e.action_taken === 'LOGGED' ? <span className="muted">kayıt</span> : <span className="red">{e.action_taken}</span>}</td>
                <td className="detail">{e.detail ? JSON.stringify(e.detail) : ''}</td>
              </tr>))}
              {events.length === 0 && <tr><td colSpan={8} className="muted">Kayıt yok.</td></tr>}
            </tbody>
          </table></div>
        </div>
      )}

      {tab === 'requests' && <>
        <AdminJobs accounts={d.accounts} receiver={receiver} version={jobsVersion} />
      </>}
      {tab === 'ranks' && <AdminRanks users={d.users} />}
      {tab === 'earnings' && <><SalesLog scope="admin" /><Earnings scope="admin" /></>}

      {tab === 'users' && (
        <div className="card">
          <h2>Kullanıcılar</h2>
          <table><thead><tr><th>Ad</th><th>Rol</th><th>Rütbe</th><th>Durum</th><th>Hesap sayısı</th><th>Onay (rıza)</th><th>Kayıt</th><th></th></tr></thead>
            <tbody>{d.users.map((u: any) => (
              <tr key={u.id}><td>{u.display_name}</td><td><span className="pill">{u.role}</span></td>
                <td>{(() => { const x = activeRankOf(u.id, rankInfo.grants, rankInfo.ranks); return x.rank ? <>
                  <b style={{ color: x.rank.color }}>{x.rank.name}</b>
                  {x.grant && <div className="muted">{x.grant.source === 'GIFT' ? 'hediye · ' : ''}{new Date(x.grant.ends_at).toLocaleString('tr-TR')}</div>}</> : '—'; })()}</td>
                <td>{u.status === 'ACTIVE' ? <span className="green">aktif</span> : <span className="red" title={u.suspended_reason}>askıda</span>}</td>
                <td>{d.accounts.filter((a: any) => a.owner_id === u.id).length}</td>
                <td className="muted">{u.consent_at ? ago(u.consent_at) : 'yok'}</td>
                <td className="muted">{ago(u.created_at)}</td>
                <td className="row">
                  {u.status === 'ACTIVE'
                    ? <button className="danger" onClick={act(() => api(`/api/admin/users/${u.id}/status`, { method: 'POST', json: { status: 'SUSPENDED', reason: prompt('Sebep?') ?? '' } }))}>Askıya al</button>
                    : <button onClick={act(() => api(`/api/admin/users/${u.id}/status`, { method: 'POST', json: { status: 'ACTIVE' } }))}>Aktif et</button>}
                  <button onClick={act(() => api(`/api/admin/users/${u.id}/role`, { method: 'POST', json: { role: u.role === 'OPERATOR' ? 'UYE' : 'OPERATOR' } }))}>
                    {u.role === 'OPERATOR' ? 'Üye yap' : 'Operatör yap'}</button>
                  <button onClick={() => setTab('requests')}>Ödeme al</button>
                  <button onClick={() => setTab('ranks')}>Rütbe hediye</button>
                </td></tr>))}
            </tbody></table>
        </div>
      )}

      {tab === 'settings' && <>
        <div className="card">
          <h2>Kurcalama koruması</h2>
          <div className="row">
            <b>Kritik olayda eylem:</b>
            <select value={String(setting('tamper_action') ?? 'LOG')} onChange={(e) => act(() => putSetting('tamper_action', e.target.value))()}>
              <option value="LOG">LOG — sadece kaydet</option>
              <option value="PAY_ONLY">PAY_ONLY — bot sadece borç öder, satış durur</option>
              <option value="BLOCK">BLOCK — erişimi kapat, bot durur</option>
            </select>
          </div>
          <p className="muted" style={{ marginTop: 12 }}>İzinli mod jar parmak izleri (SHA-256). Liste boşsa jar kontrolü yapılmaz.
            Derleme sonunda <code>HAZIR\autoseller-*.jar.sha256.txt</code> dosyasındaki değeri buraya ekle; listede olmayan jar
            <b> JAR_HASH_MISMATCH</b> (kritik) üretir.</p>
          <table><tbody>{hashes.map((h) => (
            <tr key={h}><td><code>{h}</code></td>
              <td><button className="danger" onClick={act(() => putSetting('allowed_mod_hashes', hashes.filter((x) => x !== h)))}>Sil</button></td></tr>))}
            {hashes.length === 0 && <tr><td className="muted">Liste boş (kontrol kapalı).</td></tr>}
          </tbody></table>
          <div className="row" style={{ marginTop: 8 }}>
            <input style={{ minWidth: 480 }} placeholder="64 karakter SHA-256" value={hashIn} onChange={(e) => setHashIn(e.target.value.trim().toLowerCase())} />
            <button className="primary" disabled={!/^[0-9a-f]{64}$/.test(hashIn)}
              onClick={act(async () => { await putSetting('allowed_mod_hashes', Array.from(new Set([...hashes, hashIn]))); setHashIn(''); })}>Ekle</button>
          </div>
        </div>
        <div className="card">
          <h2>Tüm ayarlar</h2>
          <table><tbody>{settings.map((s: any) => (
            <tr key={s.key}><td>{KNOWN[s.key] ?? s.key}<div className="muted">{s.key}</div></td><td className="detail"><code>{JSON.stringify(s.value)}</code></td>
              <td><button onClick={act(async () => {
                const v = prompt(`${s.key} (JSON, örn. 0.40 ya da "OpBank")`, JSON.stringify(s.value));
                if (v != null) await putSetting(s.key, JSON.parse(v));
              })}>Değiştir</button></td></tr>))}
          </tbody></table>
        </div>
      </>}
    </div>
  );
}
