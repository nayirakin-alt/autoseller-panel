import { z } from 'zod';
import { body, handle } from '@/lib/http';
import { requireOperator } from '@/lib/auth';
import { rpc } from '@/lib/supabase';

type Ctx = { params: Promise<{ id: string }> };
const Schema = z.object({ role: z.enum(['UYE', 'OPERATOR']) });

export const POST = handle<Ctx>(async (req, { params }) => {
  const me = await requireOperator();
  const { id } = await params;
  const b = await body(req, Schema);
  await rpc('admin_set_role', { p_actor: me.id, p_user: id, p_role: b.role });
  return { ok: true };
});
