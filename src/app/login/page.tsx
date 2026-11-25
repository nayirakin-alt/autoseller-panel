'use client';
import { useState } from 'react';
import { browserClient } from '@/lib/browser';

// Kayit yok: kullanicilar operator daveti ile gelir (Supabase > Authentication > Invite user)
export default function Login() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setErr('');
    const { error } = await browserClient().auth.signInWithPassword({ email, password });
    setBusy(false);
    if (error) return setErr('Giriş başarısız: ' + error.message);
    window.location.href = '/panel';
  }

  return (
    <div className="wrap" style={{ maxWidth: 380, marginTop: 80 }}>
      <div className="card">
        <h1>◆ AutoSeller Panel</h1>
        <form onSubmit={submit} className="row" style={{ flexDirection: 'column', alignItems: 'stretch' }}>
          <input placeholder="E-posta" type="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
          <input placeholder="Şifre" type="password" value={password} onChange={(e) => setPassword(e.target.value)} required />
          <button className="primary" disabled={busy}>{busy ? '…' : 'Giriş yap'}</button>
          {err && <div className="err">{err}</div>}
        </form>
        <p className="muted">Hesabın yoksa operatörden davet iste.</p>
      </div>
    </div>
  );
}
