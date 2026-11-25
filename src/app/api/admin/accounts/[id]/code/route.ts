import { handle } from '@/lib/http';
import { requireOperator } from '@/lib/auth';
import { rpc } from '@/lib/supabase';
import { newDailyCode } from '@/lib/modauth';

type Ctx = { params: Promise<{ id: string }> };

// Operator herhangi bir uye hesabinin bugunku kodunu gorebilir / olusturabilir
export const GET = handle<Ctx>(async (_req, { params }) => {
  await requireOperator();
  const { id } = await params;
  const code = await rpc('get_or_create_daily_code', { p_account: id, p_candidate: newDailyCode(), p_now: null });
  return { ok: true, code };
});
