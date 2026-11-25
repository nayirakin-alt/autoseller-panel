import { z } from 'zod';
import { handle } from '@/lib/http';
import { rpc } from '@/lib/supabase';
import { authenticateMod } from '@/lib/mod';

// Mod v0.7.1+ satis kaydi (sadece gosterim; komisyon yine profitDelta'dan)
const Sale = z.object({
  id: z.string().uuid(),
  at: z.number().int().nonnegative(),
  itemId: z.string().max(80).nullable().optional(),
  itemName: z.string().max(120).nullable().optional(),
  amount: z.number().int().nullable().optional(),
  revenue: z.number().int().safe(),
  cost: z.number().int().safe().nullable().optional(),
  tax: z.number().int().safe().nullable().optional(),
  net: z.number().int().safe().nullable().optional(),
  how: z.string().max(20).nullable().optional(),
});

// Her ~30 sn. profitDelta: son ONAYLANAN heartbeat'ten beri satislardan gelen net kar degisimi.
const Schema = z.object({
  seq: z.number().int().positive(),
  running: z.boolean(),
  profitDelta: z.number().int().safe(),
  balance: z.number().int().nonnegative().nullable().optional(),
  sales: z.array(Sale).max(100).optional(),
});

export const POST = handle(async (req) => {
  const { session, json } = await authenticateMod(req);
  const b = Schema.parse(json);
  const state = await rpc<Record<string, unknown>>('mod_heartbeat', {
    p_token_hash: session.tokenHash, p_seq: b.seq, p_running: b.running,
    p_profit_delta: b.profitDelta, p_balance: b.balance ?? null, p_now: null,
  });
  if (!state?.ok) return state;
  // Ek alanlar: eski mod (0.7.0) bunlari yok sayar
  const extra: Record<string, unknown> = {};
  if (b.sales?.length) {
    extra.sales_saved = await rpc<number>('mod_report_sales', { p_token_hash: session.tokenHash, p_sales: b.sales });
  }
  if (state.allowed !== false) {
    extra.jobs = await rpc('mod_pull_jobs', { p_token_hash: session.tokenHash, p_now: null });
  }
  return { ...state, ...extra };
});
