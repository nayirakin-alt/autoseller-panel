import { handle } from '@/lib/http';
import { requireOperator } from '@/lib/auth';
import { rpc } from '@/lib/supabase';

type Ctx = { params: Promise<{ id: string }> };

// Inceleme sonrasi kurcalama bayragini kaldir (PAY_ONLY'den cikar). Erisim ayrica acilmalidir.
export const POST = handle<Ctx>(async (_req, { params }) => {
  const me = await requireOperator();
  const { id } = await params;
  await rpc('admin_clear_tamper', { p_actor: me.id, p_account: id });
  return { ok: true };
});
