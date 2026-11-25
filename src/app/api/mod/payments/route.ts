import { z } from 'zod';
import { handle } from '@/lib/http';
import { rpc } from '@/lib/supabase';
import { authenticateMod } from '@/lib/mod';

// Uye modu: "/pay <alici> <tutar>" sonrasi "You paid <alici> $X (+ $Y tax)" goruldu.
// clientTxId mod tarafinda /pay'den ONCE uretilir ve diske yazilir; tekrar gonderimde cift kayit olmaz.
const Schema = z.object({
  clientTxId: z.string().uuid(),
  toPlayer: z.string().min(3).max(17),
  amount: z.number().int().positive().safe(),
  tax: z.number().int().nonnegative().nullable().optional(),
  chatLine: z.string().max(300).optional(),
});

export const POST = handle(async (req) => {
  const { session, json } = await authenticateMod(req);
  const b = Schema.parse(json);
  return rpc('mod_report_payment', {
    p_token_hash: session.tokenHash, p_client_tx: b.clientTxId, p_to_player: b.toPlayer,
    p_amount: b.amount, p_tax: b.tax ?? null, p_line: b.chatLine ?? null, p_now: null,
  });
});
