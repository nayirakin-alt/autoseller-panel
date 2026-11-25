import { z } from 'zod';
import { handle } from '@/lib/http';
import { rpc } from '@/lib/supabase';
import { authenticateMod } from '@/lib/mod';

// Her ~30 sn. profitDelta: son ONAYLANAN heartbeat'ten beri satislardan gelen net kar degisimi.
const Schema = z.object({
  seq: z.number().int().positive(),
  running: z.boolean(),
  profitDelta: z.number().int().safe(),
  balance: z.number().int().nonnegative().nullable().optional(),
});

export const POST = handle(async (req) => {
  const { session, json } = await authenticateMod(req);
  const b = Schema.parse(json);
  return rpc('mod_heartbeat', {
    p_token_hash: session.tokenHash, p_seq: b.seq, p_running: b.running,
    p_profit_delta: b.profitDelta, p_balance: b.balance ?? null, p_now: null,
  });
});
