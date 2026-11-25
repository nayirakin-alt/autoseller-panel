import { z } from 'zod';
import { body, handle } from '@/lib/http';
import { requireOperator } from '@/lib/auth';
import { rpc } from '@/lib/supabase';

type Ctx = { params: Promise<{ id: string }> };
const Schema = z.object({ amount: z.number().int().positive().safe(), note: z.string().max(200).optional() });

// Mod disinda yapilan odemeyi elle kaydet (dogrulanmis sayilir, en eski borca dagitilir)
export const POST = handle<Ctx>(async (req, { params }) => {
  const me = await requireOperator();
  const { id } = await params;
  const b = await body(req, Schema);
  const paymentId = await rpc('admin_manual_payment', { p_actor: me.id, p_account: id, p_amount: b.amount, p_note: b.note ?? null });
  return { ok: true, paymentId };
});
