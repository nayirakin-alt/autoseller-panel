import { z } from 'zod';
import { body, handle } from '@/lib/http';
import { requireOperator } from '@/lib/auth';
import { rpc, userClient } from '@/lib/supabase';

// Operator: bot is emirleri ("Odeme al" = kasaya /pay, "Bildirim" = oyuncuya mesaj)
export const GET = handle(async (req) => {
  await requireOperator();
  await rpc('match_extra_payments', { p_now: null }).catch(() => undefined);
  const account = new URL(req.url).searchParams.get('account');
  let qb = (await userClient()).from('bot_jobs').select('*').order('created_at', { ascending: false }).limit(200);
  if (account) qb = qb.eq('mc_account_id', account);
  const { data, error } = await qb;
  if (error) throw error;
  return { ok: true, jobs: data ?? [] };
});

const Schema = z.object({
  accountId: z.string().uuid(),
  kind: z.enum(['PAY', 'NOTIFY']),
  amount: z.number().int().positive().optional(),
  message: z.string().max(200).optional(),
  applyToCommission: z.boolean().optional(),
});

export const POST = handle(async (req) => {
  const me = await requireOperator();
  const b = await body(req, Schema);
  const id = await rpc('admin_create_job', {
    p_actor: me.id, p_account: b.accountId, p_kind: b.kind, p_amount: b.amount ?? null,
    p_message: b.message ?? null, p_apply_commission: b.applyToCommission ?? true, p_now: null,
  });
  return { ok: true, id };
});
