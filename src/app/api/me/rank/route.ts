import { z } from 'zod';
import { body, handle, HttpError } from '@/lib/http';
import { requireUser } from '@/lib/auth';
import { rpc, userClient } from '@/lib/supabase';

// Uye: rutbe durumu, fiyat listesi, siparisler, rutbe sureleri ve operatorden gelen odeme talepleri
export const GET = handle(async () => {
  const me = await requireUser();
  await rpc('match_extra_payments', { p_now: null }).catch(() => undefined);
  const sb = await userClient();
  const [status, ranks, orders, grants, requests, receiver] = await Promise.all([
    rpc('rank_status', { p_user: me.id, p_now: null }),
    sb.from('ranks').select('*').order('sort'),
    sb.from('rank_orders').select('*').eq('user_id', me.id).order('created_at', { ascending: false }).limit(30),
    sb.from('rank_grants').select('*').eq('user_id', me.id).order('created_at', { ascending: false }).limit(30),
    sb.from('payment_requests').select('*').eq('user_id', me.id).order('created_at', { ascending: false }).limit(50),
    sb.from('settings').select('value').eq('key', 'commission_receiver').maybeSingle(),
  ]);
  return {
    ok: true, status, ranks: ranks.data ?? [], orders: orders.data ?? [], grants: grants.data ?? [],
    requests: requests.data ?? [], receiver: receiver.data?.value ?? '',
  };
});

const Schema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('quote'), rank: z.string().max(16), weeks: z.number().int().min(0).max(52) }),
  z.object({ action: z.literal('order'), rank: z.string().max(16), weeks: z.number().int().min(0).max(52) }),
  z.object({ action: z.literal('cancel'), orderId: z.number().int().positive() }),
]);

export const POST = handle(async (req) => {
  const me = await requireUser();
  if (!me.consentAt) throw new HttpError(403, 'Önce ilk kullanım onayını ver');
  const b = await body(req, Schema);
  if (b.action === 'quote') {
    const q = await rpc<Record<string, unknown>>('rank_quote', { p_user: me.id, p_rank: b.rank, p_weeks: b.weeks, p_now: null });
    return { ok: true, quote: q };
  }
  if (b.action === 'order') {
    const o = await rpc('member_create_rank_order', { p_user: me.id, p_rank: b.rank, p_weeks: b.weeks, p_now: null });
    return { ok: true, order: o };
  }
  await rpc('member_cancel_rank_order', { p_user: me.id, p_order: b.orderId });
  return { ok: true };
});
