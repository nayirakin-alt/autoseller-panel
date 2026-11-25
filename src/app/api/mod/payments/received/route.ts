import { z } from 'zod';
import { handle } from '@/lib/http';
import { rpc } from '@/lib/supabase';
import { authenticateMod } from '@/lib/mod';

// Alici (operator kasa) hesabindaki mod: "<gonderen> paid you $X" goruldu.
// tolerance: "$20M" gibi kisaltmali yazimin yuvarlama payi (orn. 50k).
const Schema = z.object({
  fromPlayer: z.string().min(3).max(17),
  amount: z.number().int().positive().safe(),
  tolerance: z.number().int().nonnegative().default(0),
  chatLine: z.string().max(300).optional(),
});

export const POST = handle(async (req) => {
  const { session, json } = await authenticateMod(req);
  const b = Schema.parse(json);
  return rpc('mod_report_received', {
    p_token_hash: session.tokenHash, p_from_player: b.fromPlayer, p_amount: b.amount,
    p_tolerance: b.tolerance, p_line: b.chatLine ?? null, p_now: null,
  });
});
