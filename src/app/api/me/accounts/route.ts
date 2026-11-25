import { z } from 'zod';
import { body, handle } from '@/lib/http';
import { requireUser } from '@/lib/auth';
import { rpc } from '@/lib/supabase';

const Schema = z.object({ mcName: z.string().regex(/^[.*]?[A-Za-z0-9_]{3,16}$/, 'Geçersiz Minecraft adı') });

// Uye MC hesabi ekler -> operator onayi bekler (access_enabled=false)
export const POST = handle(async (req) => {
  const me = await requireUser();
  const { mcName } = await body(req, Schema);
  const account = await rpc('member_add_account', { p_user: me.id, p_mc_name: mcName });
  return { ok: true, account };
});
