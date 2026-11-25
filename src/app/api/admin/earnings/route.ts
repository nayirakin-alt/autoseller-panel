import { z } from 'zod';
import { body, handle } from '@/lib/http';
import { requireOperator } from '@/lib/auth';
import { rpc } from '@/lib/supabase';

// Operator: tum hesaplarin islem kayitlari, son 1 saat, saatlik/gunluk kazanc notu
export const GET = handle(async (req) => {
  const me = await requireOperator();
  const account = new URL(req.url).searchParams.get('account');
  const report = await rpc('earnings_report', { p_viewer: me.id, p_scope: 'OPERATOR', p_account: account || null, p_now: null, p_limit: 300 });
  return { ok: true, report };
});

// Sifirla: SADECE bu operatorun gorunumu (uyelerin paneli ve diger operatorler etkilenmez)
const Schema = z.object({ kind: z.enum(['STATS', 'EARNINGS']), accountId: z.string().uuid().nullable().optional() });

export const POST = handle(async (req) => {
  const me = await requireOperator();
  const b = await body(req, Schema);
  const at = await rpc('view_reset', { p_viewer: me.id, p_scope: 'OPERATOR', p_kind: b.kind, p_target: b.accountId ?? null, p_now: null });
  return { ok: true, resetAt: at };
});
