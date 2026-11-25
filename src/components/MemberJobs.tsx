'use client';
import { useCallback, useEffect, useState } from 'react';
import { api, ago, money } from '@/lib/format';
import { browserClient } from '@/lib/browser';
import { JOB_STATUS } from './AdminJobs';

/** Uye: uzaktan odeme onayi + hesaplarina gelen bot is emirleri */
export function MemberJobs({ consentAt, receiver, onChange }: { consentAt: string | null; receiver: string; onChange: () => void }) {
  const [jobs, setJobs] = useState<any[]>([]);
  const [err, setErr] = useState('');
  const load = useCallback(async () => {
    const { data, error } = await browserClient().from('bot_jobs').select('*').order('created_at', { ascending: false }).limit(30);
    if (error) setErr(error.message); else setJobs(data ?? []);
  }, []);
  useEffect(() => { load(); const t = setInterval(load, 30_000); return () => clearInterval(t); }, [load]);

  async function toggle(on: boolean) {
    if (on && !confirm(`Operatör "Ödeme al" dediğinde bot, oyunda onay sormadan ${receiver || 'kasa'} hesabına /pay gönderecek.\n` +
      'Her emir oyunda bildirimle gösterilir ve burada listelenir. Onayı istediğin zaman geri alabilirsin. Kabul ediyor musun?')) return;
    try { await api('/api/me/remote-pay-consent', { method: 'POST', json: { on } }); onChange(); } catch (e: any) { setErr(e.message); }
  }

  return (
    <div className="card">
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <h2>Operatör ödeme emirleri</h2>
        {consentAt
          ? <span className="row"><span className="green">Uzaktan ödeme açık ({ago(consentAt)})</span>
              <button onClick={() => toggle(false)}>Onayı geri al</button></span>
          : <button className="primary" onClick={() => toggle(true)}>Uzaktan ödemeye izin ver</button>}
      </div>
      <p className="muted">Operatör bir tutar girdiğinde bot bunu oyunda bildirir ve kasa hesabına <code>/pay</code> ile gönderir
        (bakiye yetmezse gönderilmez). Onay vermezsen operatör ödeme emri oluşturamaz.</p>
      {jobs.length > 0 && (
        <table><thead><tr><th>#</th><th>Tür</th><th className="num">Tutar</th><th>Durum</th><th>Not</th><th>Zaman</th></tr></thead>
          <tbody>{jobs.map((j) => (
            <tr key={j.id}><td>{j.id}</td><td>{j.kind === 'PAY' ? 'Ödeme' : 'Bildirim'}</td>
              <td className="num">{j.amount ? money(j.amount) : '—'}</td><td>{JOB_STATUS[j.status] ?? j.status}</td>
              <td className="muted">{j.message}{j.result_note ? ` · ${j.result_note}` : ''}</td><td className="muted">{ago(j.created_at)}</td></tr>))}
          </tbody></table>)}
      {err && <div className="err">{err}</div>}
    </div>
  );
}
