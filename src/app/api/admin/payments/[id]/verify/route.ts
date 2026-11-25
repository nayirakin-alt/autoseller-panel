import { z } from 'zod';
import { body, handle } from '@/lib/http';
import { requireOperator } from '@/lib/auth';
import { rpc } from '@/lib/supabase';

type Ctx = { params: Promise<{ id: string }> };
const Schema = z.object({ accept: z.boolean(), note: z.string().max(200).optional() });

// Onayla ya da reddet. Red: dagitim geri alinir, borc yeniden acilir.
export const POST = handle<Ctx>(async (req, { params }) => {
  const me = await requireOperator();
  const { id } = await params;
  const b = await body(req, Schema);
  await rpc('admin_verify_payment', { p_actor: me.id, p_payment: Number(id), p_accept: b.accept, p_note: b.note ?? null });
  return { ok: true };
});
