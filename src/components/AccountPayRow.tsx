'use client';
import { useEffect, useState } from 'react';
import { api, ago, money, parseMoney } from '@/lib/format';

/**
 * Uye Hesaplari satirinin altinda acilan odeme paneli:
 *  - "Odeme al": bot is emri (kasaya /pay). Uye "uzaktan odeme" onayi vermediyse olusturulamaz.
 *  - "+odeme": sadece kasada GORULMUS ve eslesmemis bir odeme secilerek borca dusulur.
 */
export function AccountPayRow({ account, owner, receiver, colSpan, mode, onDone, onClose }: {
  account: any; owner: any; receiver: string; colSpan: number; mode: 'job' | 'manual';
  onDone: () => void; onClose: () => void;
}) {
  const [amount, setAmount] = useState(Number(account.pending_debt) > 0 ? String(account.pending_debt) : '');
  const [commission, setCommission] = useState(true);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [msg, setMsg] = useState('');
  const [received, setReceived] = useState<any[] | null>(null);
  const consent = !!owner?.remote_pay_consent_at;
  const amt = parseMoney(amount);

  useEffect(() => {
    if (mode !== 'manual') return;
    api(`/api/admin/accounts/${account.id}/manual-payment`).then((r) => setReceived(r.received)).catch((e) => setErr(e.message));
  }, [mode, account.id]);

  async function run(fn: () => Promise<string>) {
    setErr(''); setMsg(''); setBusy(true);
    try { setMsg(await fn()); onDone(); } catch (e: any) { setErr(e.message); } finally { setBusy(false); }
  }

  return (
    <tr><td colSpan={colSpan} style={{ background: '#11161d' }}>
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <b>{mode === 'job' ? 'Ödeme al' : '+ödeme (kasada görülen ödemeyi borca say)'} — {account.mc_name} ({account.owner_name})</b>
        <button onClick={onClose}>Kapat</button>
      </div>

      {mode === 'job' && <>
        {!consent && (
          <div className="err" style={{ marginTop: 8 }}>
            {account.owner_name} panelinde "Uzaktan ödemeye izin ver" onayını vermemiş. Onay vermeden ödeme emri oluşturulamaz;
            kullanıcıdan panelinin "Hesaplarım" sekmesindeki onayı açmasını iste.
          </div>
        )}
        {!receiver && <div className="err" style={{ marginTop: 8 }}>Kasa hesabı seçilmemiş (Operatör Hesapları sekmesi).</div>}
        <div className="row" style={{ marginTop: 8 }}>
          <span>Kasa: <b>{receiver || '—'}</b></span>
          <input placeholder="Tutar (örn. 25m)" value={amount} onChange={(e) => setAmount(e.target.value)} style={{ width: 150 }} disabled={!consent} />
          <label className="row"><input type="checkbox" checked={commission} onChange={(e) => setCommission(e.target.checked)} disabled={!consent} />
            Komisyon borcundan düş (borç {money(account.pending_debt)})</label>
          <input placeholder="Oyuncuya not (isteğe bağlı)" value={note} onChange={(e) => setNote(e.target.value)} style={{ minWidth: 220 }} disabled={!consent} />
          <button className="primary" disabled={busy || !consent || !receiver || !(amt > 0)}
            onClick={() => run(async () => {
              const r = await api('/api/admin/jobs', { method: 'POST', json: { accountId: account.id, kind: 'PAY', amount: amt,
                applyToCommission: commission, message: note || undefined } });
              return `İş emri #${r.id} oluşturuldu: bot oyunda bildirim gösterip ${receiver} hesabına $${amt.toLocaleString('tr-TR')} gönderecek (en geç ~30 sn).`;
            })}>Ödeme al {amt > 0 ? `(${money(amt)})` : ''}</button>
        </div>
        <p className="muted">{account.online ? 'Bot şu an bağlı.' : 'Bot şu an bağlı değil; bağlanırsa 30 dk içinde çalışır, yoksa emir düşer.'}
          {' '}Borç, ancak bot ödemeyi bildirdiğinde düşer; kasa "paid you" ile doğrular. Mod v0.7.1+ gerekir.</p>
      </>}

      {mode === 'manual' && <>
        <p className="muted" style={{ marginTop: 8 }}>Borç kanıtsız düşülmez. Aşağıda {account.mc_name} adından kasaya gelmiş ama hiçbir kayda
          bağlanmamış ödemeler listelenir (kasa hesabında mod açıkken kaydedilir). Birini seçince doğrulanmış ödeme olarak borca sayılır.</p>
        {received === null ? 'Yükleniyor…' : received.length === 0 ? (
          <div className="err">Kasada görülmüş, eşleşmemiş ödeme yok. Borcu düşmek için "Ödeme al" ile bot iş emri oluştur.</div>
        ) : (
          <table><thead><tr><th>#</th><th className="num">Tutar</th><th>Kasa</th><th>Görüldü</th><th>Sohbet satırı</th><th></th></tr></thead>
            <tbody>{received.map((r) => (
              <tr key={r.id}><td>{r.id}</td><td className="num"><b>{money(r.amount)}</b></td><td>{r.receiver_mc}</td>
                <td className="muted">{ago(r.seen_at)}</td><td className="detail">{r.chat_line}</td>
                <td><button className="primary" disabled={busy} onClick={() => run(async () => {
                  await api(`/api/admin/accounts/${account.id}/manual-payment`, { method: 'POST', json: { receivedId: r.id, note: note || undefined } });
                  setReceived((x) => (x ?? []).filter((y) => y.id !== r.id));
                  return `${money(r.amount)} doğrulanmış ödeme olarak borca sayıldı.`;
                })}>Borca say</button></td></tr>))}
            </tbody></table>
        )}
      </>}
      {msg && <div className="green" style={{ marginTop: 6 }}>{msg}</div>}
      {err && <div className="err" style={{ marginTop: 6 }}>{err}</div>}
    </td></tr>
  );
}
