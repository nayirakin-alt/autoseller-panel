'use client';
import { browserClient } from '@/lib/browser';

export function Header({ name, role }: { name?: string; role?: string }) {
  return (
    <div className="row" style={{ justifyContent: 'space-between', marginBottom: 16 }}>
      <div className="row">
        <b className="accent">◆ AutoSeller</b>
        <a href="/panel">Hesaplarım</a>
        {role === 'OPERATOR' && <a href="/admin">Operatör</a>}
      </div>
      <div className="row muted">
        {name} {role && <span className="pill">{role}</span>}
        <button onClick={async () => { await browserClient().auth.signOut(); window.location.href = '/login'; }}>Çıkış</button>
      </div>
    </div>
  );
}
