import { handle, HttpError } from '@/lib/http';
import { requireUser } from '@/lib/auth';
import { userClient } from '@/lib/supabase';

type Ctx = { params: Promise<{ id: string }> };

// Saatlik pencereler, komisyonlar, odemeler, oturumlar (RLS ile sadece sahip / operator)
export const GET = handle<Ctx>(async (_req, { params }) => {
  await requireUser();
  const { id } = await params;
  const sb = await userClient();
  const { data: acc } = await sb.from('mc_accounts').select('id').eq('id', id).maybeSingle();
  if (!acc) throw new HttpError(404, 'Hesap bulunamadı');
  const [w, c, p, s] = await Promise.all([
    sb.from('commission_windows').select('*').eq('mc_account_id', id).order('window_no', { ascending: false }).limit(48),
    sb.from('commissions').select('*').eq('mc_account_id', id).order('created_at', { ascending: false }).limit(100),
    sb.from('payments').select('id, amount, tax, status, source, to_player, claimed_at, verified_at, verified_by, unallocated, note')
      .eq('mc_account_id', id).order('claimed_at', { ascending: false }).limit(100),
    sb.from('bot_sessions').select('id, started_at, ended_at, end_reason, mode, running, daily_code_id, mod_version, last_heartbeat_at')
      .eq('mc_account_id', id).order('started_at', { ascending: false }).limit(30),
  ]);
  return { ok: true, windows: w.data ?? [], commissions: c.data ?? [], payments: p.data ?? [], sessions: s.data ?? [] };
});
