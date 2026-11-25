import { z } from 'zod';
import { handle } from '@/lib/http';
import { rpc } from '@/lib/supabase';
import { authenticateMod } from '@/lib/mod';

// Mod ~5 dk'da bir butunluk raporu gonderir; ayrica calisirken gordugu olaylari (events) bildirir.
const Schema = z.object({
  integrity: z.object({
    jarSha256: z.string().max(128).default(''),
    agents: z.array(z.string().max(300)).max(20).default([]),
    debugger: z.boolean().default(false),
    devEnv: z.boolean().default(false),
    modVersion: z.string().max(32).optional(),
  }).optional(),
  events: z.array(z.object({
    kind: z.string().max(40),
    severity: z.enum(['INFO', 'WARN', 'CRITICAL']).default('WARN'),
    detail: z.record(z.unknown()).optional(),
  })).max(20).default([]),
});

export const POST = handle(async (req) => {
  const { session, json } = await authenticateMod(req);
  const b = Schema.parse(json);
  const out: Record<string, unknown> = { ok: true };
  if (b.integrity) {
    out.integrity = await rpc('mod_report_integrity', { p_token_hash: session.tokenHash, p_report: b.integrity });
  }
  if (b.events.length) {
    out.events = await rpc('mod_report_events', { p_token_hash: session.tokenHash, p_events: b.events });
  }
  return out;
});
