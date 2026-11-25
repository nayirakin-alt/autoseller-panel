import { z } from 'zod';
import { handle } from '@/lib/http';
import { rpc } from '@/lib/supabase';
import { authenticateMod } from '@/lib/mod';

// Mod is emri sonucu: RECEIVED (teslim aldi) | DONE | UNVERIFIED | FAILED
const Schema = z.object({
  jobId: z.number().int().positive(),
  status: z.enum(['RECEIVED', 'DONE', 'UNVERIFIED', 'FAILED']),
  tax: z.number().int().nonnegative().nullable().optional(),
  chatLine: z.string().max(300).nullable().optional(),
  note: z.string().max(300).nullable().optional(),
});

export const POST = handle(async (req) => {
  const { session, json } = await authenticateMod(req);
  const b = Schema.parse(json);
  return rpc('mod_job_ack', {
    p_token_hash: session.tokenHash, p_job: b.jobId, p_status: b.status, p_tax: b.tax ?? null,
    p_line: b.chatLine ?? null, p_note: b.note ?? null, p_now: null,
  });
});
