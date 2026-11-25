import { handle } from '@/lib/http';
import { requireUser } from '@/lib/auth';
import { rpc } from '@/lib/supabase';

// Uye: kendi hesaplarinin urun bazli satis gecmisi
export const GET = handle(async (req) => {
  const me = await requireUser();
  const account = new URL(req.url).searchParams.get('account');
  const report = await rpc('sales_report', { p_viewer: me.id, p_scope: 'MEMBER', p_account: account || null, p_limit: 300, p_now: null });
  return { ok: true, report };
});
