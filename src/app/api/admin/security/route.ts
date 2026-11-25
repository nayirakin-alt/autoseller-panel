import { handle } from '@/lib/http';
import { requireOperator } from '@/lib/auth';
import { userClient } from '@/lib/supabase';

// Guvenlik / kurcalama loglari: kullanici, MC hesabi, gunluk kod, zaman, tur, detay
export const GET = handle(async (req) => {
  await requireOperator();
  const u = new URL(req.url);
  const severity = u.searchParams.get('severity');
  const account = u.searchParams.get('account');
  let qb = (await userClient()).from('v_security_events').select('*').order('at', { ascending: false }).limit(300);
  if (severity && ['INFO', 'WARN', 'CRITICAL'].includes(severity)) qb = qb.eq('severity', severity);
  if (account) qb = qb.eq('mc_account_id', account);
  const { data, error } = await qb;
  if (error) throw error;
  return { ok: true, events: data ?? [] };
});
