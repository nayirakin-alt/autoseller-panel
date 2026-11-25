import { handle } from '@/lib/http';
import { requireUser } from '@/lib/auth';
import { rpc, userClient } from '@/lib/supabase';

// Profil + kendi hesaplari (RLS: sadece kendi satirlari)
export const GET = handle(async () => {
  const me = await requireUser();
  const sb = await userClient();
  const rank = await rpc('rank_status', { p_user: me.id, p_now: null }).catch(() => null);
  const [{ data: accounts }, { data: settings }] = await Promise.all([
    sb.from('v_account_overview').select('*').eq('owner_id', me.id).order('mc_name'),
    sb.from('settings').select('key, value').in('key', ['commission_rate', 'commission_receiver', 'commission_grace_min', 'window_seconds']),
  ]);
  return { ok: true, me, rank, accounts: accounts ?? [], settings: Object.fromEntries((settings ?? []).map((s) => [s.key, s.value])) };
});
