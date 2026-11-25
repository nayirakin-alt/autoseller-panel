import { z } from 'zod';
import { body, handle } from '@/lib/http';
import { requireOperator } from '@/lib/auth';
import { rpc, userClient } from '@/lib/supabase';

// Operator Minecraft hesaplari: kod istemez, komisyon uretmez. SADECE operator.
export const GET = handle(async () => {
  await requireOperator();
  const { data } = await (await userClient()).from('v_operator_account_overview').select('*').order('mc_name');
  return { ok: true, accounts: data ?? [] };
});

const Schema = z.object({
  mcName: z.string().regex(/^[.*]?[A-Za-z0-9_]{3,16}$/, 'Geçersiz Minecraft adı'),
  mcUuid: z.string().uuid().optional(),
  note: z.string().max(200).optional(),
});

export const POST = handle(async (req) => {
  const me = await requireOperator();
  const b = await body(req, Schema);
  const account = await rpc('admin_add_operator_account', {
    p_actor: me.id, p_mc_name: b.mcName, p_mc_uuid: b.mcUuid ?? null, p_note: b.note ?? null,
  });
  return { ok: true, account };
});
