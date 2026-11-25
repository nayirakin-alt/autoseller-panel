import { z } from 'zod';
import { body, handle } from '@/lib/http';
import { requireOperator } from '@/lib/auth';
import { rpc } from '@/lib/supabase';

type Ctx = { params: Promise<{ id: string }> };

// Kasada GORULMUS ama hicbir kayda eslesmemis gelen odemeler (borca sayilabilecek kanitlar)
export const GET = handle<Ctx>(async (_req, { params }) => {
  const me = await requireOperator();
  const { id } = await params;
  const received = await rpc('admin_unmatched_received', { p_actor: me.id, p_account: id });
  return { ok: true, received };
});

// "+odeme": sadece kasada gorulmus bir odeme secilerek borca dusulur (kanitsiz dusme yok)
const Schema = z.object({ receivedId: z.number().int().positive(), note: z.string().max(200).optional() });

export const POST = handle<Ctx>(async (req, { params }) => {
  const me = await requireOperator();
  const { id } = await params;
  const b = await body(req, Schema);
  const paymentId = await rpc('admin_manual_payment_from_received', {
    p_actor: me.id, p_account: id, p_received: b.receivedId, p_note: b.note ?? null,
  });
  return { ok: true, paymentId };
});
