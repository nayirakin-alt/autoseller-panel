import { handle } from '@/lib/http';
import { requireOperator } from '@/lib/auth';
import { userClient } from '@/lib/supabase';

// Operator: tum uye hesaplari (aktiflik, toplam kar, son saat kari, %40, odenen, bekleyen borc,
// kullanilan kod, son gorulme) + operator hesaplari + bekleyen odemeler + kullanicilar
export const GET = handle(async () => {
  await requireOperator();
  const sb = await userClient();   // RLS: operator her seyi gorur
  const since = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
  const [acc, ops, pays, users, sec] = await Promise.all([
    sb.from('v_account_overview').select('*').order('pending_debt', { ascending: false }),
    sb.from('v_operator_account_overview').select('*').order('mc_name'),
    sb.from('payments').select('id, mc_account_id, amount, tax, to_player, status, source, claimed_at, chat_line, unallocated')
      .eq('status', 'CLAIMED').order('claimed_at'),
    sb.from('profiles').select('id, display_name, role, status, suspended_reason, consent_at, remote_pay_consent_at, created_at').order('created_at'),
    sb.from('security_events').select('id', { count: 'exact', head: true }).neq('severity', 'INFO').gte('at', since),
  ]);
  const rows = acc.data ?? [];
  const sum = (k: string) => rows.reduce((t, r) => t + Number((r as Record<string, unknown>)[k] ?? 0), 0);
  return {
    ok: true,
    totals: {
      accounts: rows.length,
      online: rows.filter((r) => r.online).length,
      profit_total: sum('profit_total'),
      commission_total: sum('commission_total'),
      payments_verified: sum('payments_verified'),
      pending_debt: sum('pending_debt'),
      awaiting_approval: rows.filter((r) => !r.access_enabled && String(r.blocked_reason ?? '').includes('onay')).length,
      tampered: rows.filter((r) => r.tamper_flag).length,
      security_events_24h: sec.count ?? 0,
    },
    accounts: rows, operatorAccounts: ops.data ?? [], unverifiedPayments: pays.data ?? [], users: users.data ?? [],
  };
});
