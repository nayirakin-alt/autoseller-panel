import { z } from 'zod';
import { body, handle } from '@/lib/http';
import { requireOperator } from '@/lib/auth';
import { rpc } from '@/lib/supabase';

type Ctx = { params: Promise<{ id: string }> };
const Schema = z.object({ note: z.string().max(200).optional() });

export const POST = handle<Ctx>(async (req, { params }) => {
  const me = await requireOperator();
  const { id } = await params;
  const b = await body(req, Schema);
  await rpc('admin_waive_commission', { p_actor: me.id, p_commission: Number(id), p_note: b.note ?? null });
  return { ok: true };
});
