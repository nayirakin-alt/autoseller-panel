'use client';
import { useCallback, useEffect, useState } from 'react';
import { api, ago, money, parseMoney } from '@/lib/format';

export const JOB_STATUS: Record<string, string> = {
  QUEUED: 'sırada (bot bağlanınca gider)', DELIVERED: 'bota gönderildi', RECEIVED: 'bot aldı, işleniyor',
  DONE: 'tamamlandı', UNVERIFIED: 'gönderildi (oyun onayı görülmedi)', FAILED: 'başarısız',
  CANCELLED: 'iptal', EXPIRED: 'süresi doldu (bot almadı)',
};
const statusClass = (s: string) => (s === 'DONE' ? 'green' : s === 'FAILED' || s === 'EXPIRED' ? 'red' : s === 'CANCELLED' ? 'muted' : 'accent');

/** Operator: "Odeme al" ve "Bildirim" bot is emirleri */
export function AdminJobs({ accounts, receiver, version }: { accounts: any[]; receiver: string; version?: number }) {
  const [jobs, setJobs] = useState<any[] | null>(null);
  const [err, setErr] = useState('');
  const [acc, setAcc] = useState('');
  const [amount, setAmount] = useState('');
  const [commission, setCommission] = useState(true);
  const [msg, setMsg] = useState('');
  const [nAcc, setNAcc] = useState('');
  const [nMsg, setNMsg] = useState('');

  const load = useCallback(async () => {
    try { setJobs((await api('/api/admin/jobs')).jobs); } catch (e: any) { setErr(e.message); }
  }, []);
  useEffect(() => { load(); const t = setInterval(load, 10_000); return () => clearInterval(t); }, [load, version]);
  const act = (fn: () => Promise<unknown>) => async () => { setErr(''); try { await fn(); await load(); } catch (e: any) { setErr(e.message); } };
  if (!jobs) return <div className="card">{err ? <div className="err">{err}</div> : 'Yükleniyor…'}</div>;
  const nameOf = (id: string) => accounts.find((a) => a.id === id)?.mc_name ?? '?';
  const ownerOf = (id: string) => accounts.find((a) => a.id === id)?.owner_name ?? '';
  const amt = parseMoney(amount);
  const sel = accounts.find((a) => a.id === acc);

  return (
    <>
      <div className="grid2">
        <div className="card">
          <h2>Ödeme al (kasaya aktar)</h2>
          <p className="muted">Onay beklemez: emir bota iletilir, bot oyunda oyuncuya bildirim gösterir ve
            <code> /pay {receiver || 'KASA'} tutar</code> komutunu gönderir. Bot bağlı değilse bağlandığında (30 dk içinde) çalışır.
            Mod sürümünün 0.7.1+ olması gerekir.</p>
          <div className="row">
            <select value={acc} onChange={(e) => setAcc(e.target.value)}>
              <option value="">— MC hesabı —</option>
              {accounts.map((a) => <option key={a.id} value={a.id}>{a.mc_name} ({a.owner_name}){a.online ? ' · çevrimiçi' : ''}</option>)}
            </select>
            <input placeholder="Tutar (örn. 25m)" value={amount} onChange={(e) => setAmount(e.target.value)} style={{ width: 140 }} />
          </div>
          <div className="row" style={{ marginTop: 8 }}>
            <label className="row"><input type="checkbox" checked={commission} onChange={(e) => setCommission(e.target.checked)} />
              Komisyon borcundan düş {sel && Number(sel.pending_debt) > 0 ? `(borç ${money(sel.pending_debt)})` : ''}</label>
          </div>
          <div className="row" style={{ marginTop: 8 }}>
            <input placeholder="Oyuncuya not (isteğe bağlı)" value={msg} onChange={(e) => setMsg(e.target.value)} style={{ minWidth: 260 }} />
            <button className="primary" disabled={!acc || !(amt > 0) || !receiver}
              onClick={act(async () => {
                await api('/api/admin/jobs', { method: 'POST', json: { accountId: acc, kind: 'PAY', amount: amt, applyToCommission: commission, message: msg || undefined } });
                setAmount(''); setMsg('');
              })}>Ödeme al {amt > 0 ? `(${money(amt)})` : ''}</button>
          </div>
          {!receiver && <div className="err">Önce Operatör Hesapları sekmesinden kasa hesabını seç.</div>}
        </div>
        <div className="card">
          <h2>Bildirim gönder</h2>
          <p className="muted">Sadece oyuncunun ekranında (sohbet alanında) AutoSeller mesajı olarak görünür; sunucuya bir şey yazılmaz.</p>
          <div className="row">
            <select value={nAcc} onChange={(e) => setNAcc(e.target.value)}>
              <option value="">— MC hesabı —</option>
              {accounts.map((a) => <option key={a.id} value={a.id}>{a.mc_name} ({a.owner_name})</option>)}
            </select>
          </div>
          <div className="row" style={{ marginTop: 8 }}>
            <input placeholder="Mesaj" maxLength={200} value={nMsg} onChange={(e) => setNMsg(e.target.value)} style={{ minWidth: 300 }} />
            <button disabled={!nAcc || !nMsg.trim()} onClick={act(async () => {
              await api('/api/admin/jobs', { method: 'POST', json: { accountId: nAcc, kind: 'NOTIFY', message: nMsg } }); setNMsg('');
            })}>Gönder</button>
          </div>
        </div>
      </div>

      <div className="card">
        <h2>İş emirleri</h2>
        <div className="scroll"><table>
          <thead><tr><th>#</th><th>Hesap</th><th>Tür</th><th className="num">Tutar</th><th>Komisyona</th><th>Durum</th>
            <th>Not / sonuç</th><th>Oluşturuldu</th><th></th></tr></thead>
          <tbody>{jobs.map((j) => (
            <tr key={j.id}><td>{j.id}</td><td><b>{nameOf(j.mc_account_id)}</b><div className="muted">{ownerOf(j.mc_account_id)}</div></td>
              <td>{j.kind === 'PAY' ? 'Ödeme al' : 'Bildirim'}</td>
              <td className="num">{j.amount ? money(j.amount) : '—'}{j.tax != null && <div className="muted">vergi {money(j.tax)}</div>}</td>
              <td>{j.kind === 'PAY' ? (j.apply_to_commission ? 'evet' : 'hayır') : ''}</td>
              <td className={statusClass(j.status)}>{JOB_STATUS[j.status] ?? j.status}
                {j.verified_at && <div className="green">✔ kasada doğrulandı</div>}</td>
              <td className="detail">{j.message}{j.result_note ? ` · ${j.result_note}` : ''}{j.chat_line ? <div>{j.chat_line}</div> : null}</td>
              <td className="muted">{ago(j.created_at)}</td>
              <td>{(j.status === 'QUEUED' || j.status === 'DELIVERED') &&
                <button className="danger" onClick={act(() => api(`/api/admin/jobs/${j.id}`, { method: 'DELETE' }))}>İptal</button>}</td></tr>))}
            {jobs.length === 0 && <tr><td colSpan={9} className="muted">Henüz iş emri yok.</td></tr>}
          </tbody></table></div>
        {err && <div className="err">{err}</div>}
      </div>
    </>
  );
}
