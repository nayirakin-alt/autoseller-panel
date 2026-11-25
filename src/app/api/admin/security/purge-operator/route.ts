import { handle } from '@/lib/http';
import { requireOperator } from '@/lib/auth';
import { rpc } from '@/lib/supabase';

// Operator hesaplari icin daha once yazilmis (gereksiz) guvenlik loglarini temizle
export const POST = handle(async () => {
  const me = await requireOperator();
  const deleted = await rpc('admin_purge_operator_security_events', { p_actor: me.id });
  return { ok: true, deleted };
});
