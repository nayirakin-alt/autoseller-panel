import { handle } from '@/lib/http';
import { requireUser } from '@/lib/auth';
import { rpc } from '@/lib/supabase';

// "Mod sunucuya veri gonderir ve uzaktan kapatilabilir; komisyon %40" onayi. Onaysiz bot acilmaz.
export const POST = handle(async () => {
  const me = await requireUser();
  await rpc('member_consent', { p_user: me.id });
  return { ok: true };
});
