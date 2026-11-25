import { handle } from '@/lib/http';
import { requireOperator } from '@/lib/auth';
import { rpc } from '@/lib/supabase';

// Operator: modun bildirdigi urun bazli satis gecmisi
export const GET = handle(async (req) => {
  const me = await requireOperator();
  const account = new URL(req.url).searchParams.get('account');
  const report = await rpc('sales_report', { p_viewer: me.id, p_scope: 'OPERATOR', p_account: account || null, p_limit: 500, p_now: null });
  return { ok: true, report };
});
