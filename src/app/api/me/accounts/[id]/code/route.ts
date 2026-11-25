import { handle, HttpError } from '@/lib/http';
import { requireUser } from '@/lib/auth';
import { rpc, userClient } from '@/lib/supabase';
import { newDailyCode } from '@/lib/modauth';

type Ctx = { params: Promise<{ id: string }> };

// Bugunun (Istanbul) erisim kodu; yoksa olusturulur. Sadece hesap sahibi.
export const GET = handle<Ctx>(async (_req, { params }) => {
  const me = await requireUser();
  const { id } = await params;
  const { data: acc } = await (await userClient()).from('mc_accounts').select('id, owner_id').eq('id', id).maybeSingle();
  if (!acc || acc.owner_id !== me.id) throw new HttpError(404, 'Hesap bulunamadı');
  const code = await rpc('get_or_create_daily_code', { p_account: id, p_candidate: newDailyCode(), p_now: null });
  return { ok: true, code };
});
