import { z } from 'zod';
import { body, handle } from '@/lib/http';
import { requireOperator } from '@/lib/auth';
import { rpc, userClient } from '@/lib/supabase';

export const GET = handle(async () => {
  await requireOperator();
  const { data } = await (await userClient()).from('settings').select('key, value, updated_at').order('key');
  return { ok: true, settings: data ?? [] };
});

const Schema = z.object({ key: z.string().max(64), value: z.unknown() });

export const PUT = handle(async (req) => {
  const me = await requireOperator();
  const b = await body(req, Schema);
  await rpc('admin_set_setting', { p_actor: me.id, p_key: b.key, p_value: b.value });
  return { ok: true };
});
