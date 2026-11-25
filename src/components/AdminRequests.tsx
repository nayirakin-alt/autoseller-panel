'use client';
import { useCallback, useEffect, useState } from 'react';
import { api, ago, money, parseMoney } from '@/lib/format';

/** Odeme talebi olustur (kullanici satirindaki / hesap satirindaki buton bunu cagirir) */
export async function createPaymentRequest(userId: string, label: string, accountId?: string | null) {
  const v = prompt(`${label}: ödeme talebi tutarı (örn. 25m)`);
  if (!v) return false;
  const amount = parseMoney(v);
  if (!Number.isFinite(amount) || amount <= 0) { alert('Geçersiz tutar'); return false; }
  const note = prompt('Açıklama (kullanıcı görür)') ?? undefined;
  await api('/api/admin/payment-requests', { method: 'POST', json: { action: 'create', userId, accountId: accountId ?? null, amount, note } });
  return true;
}

/** Operator: "Odeme Talebi" bolumu */
export function AdminRequests({ users, accounts, receiver, version }: { users: any[]; accounts: any[]; receiver: string; version?: number }) {
  const [rows, setRows] = useState<any[] | null>(null);
  const [err, setErr] = useState('');
  const [user, setUser] = useState('');
  const [account, setAccount] = useState('');
  const [amount, setAmount] = useState('');
  const [note, setNote] = useState('');
  const [due, setDue] = useState('');

  const load = useCallback(async () => {
    try { setRows((await api('/api/admin/payment-requests')).requests); } catch (e: any) { setErr(e.message); }
  }, []);
  useEffect(() => { load(); const t = setInterval(load, 20_000); return () => clearInterval(t); }, [load, version]);
  const act = (fn: () => Promise<unknown>) => async () => { setErr(''); try { await fn(); await load(); } catch (e: any) { setErr(e.message); } };
  const nameOf = (id: string) => users.find((u) => u.id === id)?.display_name ?? id.slice(0, 8);
  const accOf = (id: string | null) => (id ? accounts.find((a) => a.id === id)?.mc_name ?? '?' : 'herhangi');
  if (!rows) return <div className="card">{err ? <div className="err">{err}</div> : 'Yükleniyor…'}</div>;
  const open = rows.filter((r) => r.status === 'OPEN');
  const amt = parseMoney(amount);

  return (
    <>
      <div className="card">
        <h2>Yeni ödeme talebi</h2>
        <p className="muted">Talep, kullanıcının panelinde "kasa hesabına gönder" olarak görünür (komut: <code>/pay {receiver || 'KASA'} tutar</code>).
          Kasa hesabında mod açıksa gelen ödeme talebi kendiliğinden kapatır; değilse "Ödendi" ile kapat. Satış komisyonu borcundan ayrıdır,
          mod bunu otomatik ödemez.</p>
        <div className="row">
          <select value={user} onChange={(e) => { setUser(e.target.value); setAccount(''); }}>
            <option value="">— kullanıcı —</option>
            {users.map((u) => <option key={u.id} value={u.id}>{u.display_name}</option>)}
          </select>
          <select value={account} onChange={(e) => setAccount(e.target.value)} disabled={!user}>
            <option value="">herhangi bir MC hesabından</option>
            {accounts.filter((a) => a.owner_id === user).map((a) => <option key={a.id} value={a.id}>{a.mc_name}</option>)}
          </select>
          <input placeholder="Tutar (örn. 25m)" value={amount} onChange={(e) => setAmount(e.target.value)} style={{ width: 140 }} />
          <input placeholder="Açıklama" value={note} onChange={(e) => setNote(e.target.value)} />
          <input type="datetime-local" value={due} onChange={(e) => setDue(e.target.value)} title="Son tarih (isteğe bağlı)" />
          <button className="primary" disabled={!user || !(amt > 0) || !receiver}
            onClick={act(async () => {
              await api('/api/admin/payment-requests', { method: 'POST', json: { action: 'create', userId: user, accountId: account || null,
                amount: amt, note: note || undefined, dueAt: due ? new Date(due).toISOString() : null } });
              setAmount(''); setNote(''); setDue('');
            })}>Talep gönder {amt > 0 ? `(${money(amt)})` : ''}</button>
        </div>
        {!receiver && <div className="err">Önce Operatör Hesapları sekmesinden kasa hesabını seç.</div>}
      </div>

      <div className="card">
        <h2>Açık talepler ({open.length})</h2>
        <table><thead><tr><th>#</th><th>Kullanıcı</th><th>MC hesabı</th><th className="num">Tutar</th><th>Kasa</th><th>Açıklama</th><th>Son tarih</th><th>Oluşturuldu</th><th></th></tr></thead>
          <tbody>{open.map((r) => (
            <tr key={r.id}><td>{r.id}</td><td>{nameOf(r.user_id)}</td><td>{accOf(r.mc_account_id)}</td>
              <td className="num"><b>{money(r.amount)}</b></td><td>{r.pay_to}</td><td>{r.note}</td>
              <td className={r.due_at && new Date(r.due_at) < new Date() ? 'red' : 'muted'}>{r.due_at ? new Date(r.due_at).toLocaleString('tr-TR') : '—'}</td>
              <td className="muted">{ago(r.created_at)}</td>
              <td className="row">
                <button className="primary" onClick={act(() => api('/api/admin/payment-requests', { method: 'POST', json: { action: 'resolve', requestId: r.id, status: 'PAID', note: prompt('Not') ?? undefined } }))}>Ödendi</button>
                <button className="danger" onClick={act(() => api('/api/admin/payment-requests', { method: 'POST', json: { action: 'resolve', requestId: r.id, status: 'CANCELLED', note: prompt('İptal sebebi') ?? undefined } }))}>İptal</button>
              </td></tr>))}
            {open.length === 0 && <tr><td colSpan={9} className="muted">Açık talep yok.</td></tr>}
          </tbody></table>
      </div>

      <div className="card">
        <h2>Kapanan talepler</h2>
        <div className="scroll" style={{ maxHeight: 320 }}><table>
          <thead><tr><th>#</th><th>Kullanıcı</th><th className="num">Tutar</th><th>Durum</th><th>Nasıl</th><th>Not</th><th>Tarih</th></tr></thead>
          <tbody>{rows.filter((r) => r.status !== 'OPEN').map((r) => (
            <tr key={r.id}><td>{r.id}</td><td>{nameOf(r.user_id)}</td><td className="num">{money(r.amount)}</td>
              <td>{r.status === 'PAID' ? <span className="green">ödendi</span> : <span className="muted">iptal</span>}</td>
              <td className="muted">{r.paid_via ?? ''}</td><td className="muted">{r.resolution_note ?? r.note}</td>
              <td className="muted">{ago(r.paid_at ?? r.created_at)}</td></tr>))}
          </tbody></table></div>
      </div>
      {err && <div className="err">{err}</div>}
    </>
  );
}
