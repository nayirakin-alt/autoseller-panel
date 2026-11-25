import { handle } from '@/lib/http';
import { requireOperator } from '@/lib/auth';
import { rpc } from '@/lib/supabase';

type Ctx = { params: Promise<{ id: string }> };

// Henuz mod tarafindan teslim alinmamis emri iptal et
export const DELETE = handle<Ctx>(async (_req, { params }) => {
  const me = await requireOperator();
  const { id } = await params;
  await rpc('admin_cancel_job', { p_actor: me.id, p_job: Number(id), p_note: null });
  return { ok: true };
});
