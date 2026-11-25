import { z } from 'zod';
import { body, handle } from '@/lib/http';
import { requireOperator } from '@/lib/auth';
import { rpc } from '@/lib/supabase';

type Ctx = { params: Promise<{ id: string }> };
const Schema = z.object({ enabled: z.boolean(), reason: z.string().max(200).optional() });

// Erisimi ac/kapat. Kapatinca acik bot oturumu aninda biter.
export const POST = handle<Ctx>(async (req, { params }) => {
  const me = await requireOperator();
  const { id } = await params;
  const b = await body(req, Schema);
  await rpc('admin_set_account_access', { p_actor: me.id, p_account: id, p_enabled: b.enabled, p_reason: b.reason ?? null });
  return { ok: true };
});
