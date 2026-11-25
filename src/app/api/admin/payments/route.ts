import { handle } from '@/lib/http';
import { requireOperator } from '@/lib/auth';
import { userClient } from '@/lib/supabase';

// Son odemeler + alici tarafinin eslesmeyen "paid you" kayitlari (elle eslestirme icin)
export const GET = handle(async () => {
  await requireOperator();
  const sb = await userClient();
  const [p, r] = await Promise.all([
    sb.from('payments').select('*').order('claimed_at', { ascending: false }).limit(200),
    sb.from('received_payments').select('*').is('matched_payment_id', null).order('seen_at', { ascending: false }).limit(200),
  ]);
  return { ok: true, payments: p.data ?? [], unmatchedReceived: r.data ?? [] };
});
