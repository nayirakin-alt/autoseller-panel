import { z } from 'zod';
import { body, handle } from '@/lib/http';
import { requireUser } from '@/lib/auth';
import { rpc } from '@/lib/supabase';

// Uye: operatorun "Odeme al" emriyle botun kasaya /pay gondermesine izin ver / geri al
export const POST = handle(async (req) => {
  const me = await requireUser();
  const b = await body(req, z.object({ on: z.boolean() }));
  await rpc('member_remote_pay_consent', { p_user: me.id, p_on: b.on });
  return { ok: true };
});
