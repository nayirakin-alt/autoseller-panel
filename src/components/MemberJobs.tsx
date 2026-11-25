'use client';
import { useCallback, useEffect, useState } from 'react';
import { ago, money } from '@/lib/format';
import { browserClient } from '@/lib/browser';
import { JOB_STATUS } from './AdminJobs';

/** Uye: uzaktan odeme onayi + hesaplarina gelen bot is emirleri */
export function MemberJobs() {
  const [jobs, setJobs] = useState<any[]>([]);
  const [err, setErr] = useState('');
  const load = useCallback(async () => {
    const { data, error } = await browserClient().from('bot_jobs').select('*').order('created_at', { ascending: false }).limit(30);
    if (error) setErr(error.message); else setJobs(data ?? []);
  }, []);
  useEffect(() => { load(); const t = setInterval(load, 30_000); return () => clearInterval(t); }, [load]);

  return (
    <div className="card">
      <h2>Operatör ödeme emirleri</h2>
      <p className="muted">Operatör bir tutar girdiğinde bot bunu oyunda bildirir ve kasa hesabına <code>/pay</code> ile gönderir
        (bakiye yetmezse gönderilmez). Buraya son emirler düşer.</p>
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
