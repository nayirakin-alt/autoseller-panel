import { handle } from '@/lib/http';
import { requireOperator } from '@/lib/auth';
import { rpc } from '@/lib/supabase';

type Ctx = { params: Promise<{ id: string }> };

export const DELETE = handle<Ctx>(async (_req, { params }) => {
  const me = await requireOperator();
  const { id } = await params;
  await rpc('admin_remove_operator_account', { p_actor: me.id, p_id: id });
  return { ok: true };
});
