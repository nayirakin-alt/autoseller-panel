import { z } from 'zod';
import { body, handle } from '@/lib/http';
import { requireOperator } from '@/lib/auth';
import { rpc, userClient } from '@/lib/supabase';

// Operator: rutbe tablosu, aktif rutbe sureleri, siparisler
export const GET = handle(async () => {
  await requireOperator();
  await rpc('match_extra_payments', { p_now: null }).catch(() => undefined);
  const sb = await userClient();
  const now = new Date().toISOString();
  const [ranks, grants, orders] = await Promise.all([
    sb.from('ranks').select('*').order('sort'),
    sb.from('rank_grants').select('*').eq('status', 'ACTIVE').gt('ends_at', now).order('ends_at'),
    sb.from('rank_orders').select('*').order('created_at', { ascending: false }).limit(200),
  ]);
  return { ok: true, ranks: ranks.data ?? [], grants: grants.data ?? [], orders: orders.data ?? [] };
});

const Schema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('gift'), userId: z.string().uuid(), rank: z.string().max(16),
             seconds: z.number().int().min(60).max(366 * 86400), note: z.string().max(300).optional() }),
  z.object({ action: z.literal('order_paid'), orderId: z.number().int().positive(), note: z.string().max(300).optional() }),
  z.object({ action: z.literal('order_cancel'), orderId: z.number().int().positive(), note: z.string().max(300).optional() }),
  z.object({ action: z.literal('revoke'), grantId: z.number().int().positive(), note: z.string().max(300).optional() }),
  z.object({ action: z.literal('set_rank'), code: z.string().max(16), rate: z.number().min(0).max(1),
             weeklyPrice: z.number().int().min(0) }),
]);

export const POST = handle(async (req) => {
  const me = await requireOperator();
  const b = await body(req, Schema);
  switch (b.action) {
    case 'gift':
      return { ok: true, grantId: await rpc('admin_gift_rank', { p_actor: me.id, p_user: b.userId, p_rank: b.rank,
                                                                p_seconds: b.seconds, p_note: b.note ?? null, p_now: null }) };
    case 'order_paid':
      return { ok: true, grantId: await rpc('admin_rank_order_paid', { p_actor: me.id, p_order: b.orderId, p_note: b.note ?? null, p_now: null }) };
    case 'order_cancel':
      await rpc('admin_rank_order_cancel', { p_actor: me.id, p_order: b.orderId, p_note: b.note ?? null });
      return { ok: true };
    case 'revoke':
      await rpc('admin_revoke_rank_grant', { p_actor: me.id, p_grant: b.grantId, p_note: b.note ?? null });
      return { ok: true };
    case 'set_rank':
      await rpc('admin_set_rank', { p_actor: me.id, p_code: b.code, p_rate: b.rate, p_weekly: b.weeklyPrice });
      return { ok: true };
  }
});
