import { z } from 'zod';
import { body, handle } from '@/lib/http';
import { requireOperator } from '@/lib/auth';
import { rpc, userClient } from '@/lib/supabase';

// Operator: odeme talepleri (kasa hesabina gonderilmesi istenen tutarlar; komisyondan ayri)
export const GET = handle(async () => {
  await requireOperator();
  await rpc('match_extra_payments', { p_now: null }).catch(() => undefined);
  const { data, error } = await (await userClient()).from('payment_requests').select('*')
    .order('created_at', { ascending: false }).limit(300);
  if (error) throw error;
  return { ok: true, requests: data ?? [] };
});

const Schema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('create'), userId: z.string().uuid(), accountId: z.string().uuid().nullable().optional(),
             amount: z.number().int().positive(), note: z.string().max(500).optional(),
             dueAt: z.string().datetime({ offset: true }).nullable().optional() }),
  z.object({ action: z.literal('resolve'), requestId: z.number().int().positive(),
             status: z.enum(['PAID', 'CANCELLED']), note: z.string().max(300).optional() }),
]);

export const POST = handle(async (req) => {
  const me = await requireOperator();
  const b = await body(req, Schema);
  if (b.action === 'create') {
    const id = await rpc('admin_create_payment_request', { p_actor: me.id, p_user: b.userId, p_account: b.accountId ?? null,
                                                           p_amount: b.amount, p_note: b.note ?? null, p_due: b.dueAt ?? null });
    return { ok: true, id };
  }
  await rpc('admin_resolve_payment_request', { p_actor: me.id, p_request: b.requestId, p_status: b.status, p_note: b.note ?? null });
  return { ok: true };
});
