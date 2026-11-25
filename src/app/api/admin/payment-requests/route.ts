import { z } from 'zod';
import { body, handle, HttpError } from '@/lib/http';
import { requireOperator } from '@/lib/auth';
import { rpc, userClient } from '@/lib/supabase';

// Operator: ESKI odeme talepleri (yeni talep olusturma kaldirildi; yerine "Odeme al" bot is emri: /api/admin/jobs).
// Eski acik talepler listelenip kapatilabilir.
export const GET = handle(async () => {
  await requireOperator();
  await rpc('match_extra_payments', { p_now: null }).catch(() => undefined);
  const { data, error } = await (await userClient()).from('payment_requests').select('*')
    .order('created_at', { ascending: false }).limit(300);
  if (error) throw error;
  return { ok: true, requests: data ?? [] };
});

const Schema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('create') }).passthrough(),
  z.object({ action: z.literal('resolve'), requestId: z.number().int().positive(),
             status: z.enum(['PAID', 'CANCELLED']), note: z.string().max(300).optional() }),
]);

export const POST = handle(async (req) => {
  const me = await requireOperator();
  const b = await body(req, Schema);
  if (b.action === 'create') {
    throw new HttpError(410, 'Ödeme talebi kaldırıldı; "Ödeme al" (bot iş emri) kullan');
  }
  await rpc('admin_resolve_payment_request', { p_actor: me.id, p_request: b.requestId, p_status: b.status, p_note: b.note ?? null });
  return { ok: true };
});
