import { handle, HttpError } from '@/lib/http';
import { rpc } from '@/lib/supabase';

// Vercel Cron (her dakika): heartbeat'i kesilen oturumlari kapatir
export const GET = handle(async (req) => {
  if (req.headers.get('authorization') !== `Bearer ${process.env.CRON_SECRET}`) throw new HttpError(401, 'unauthorized');
  const closed = await rpc<number>('expire_stale_sessions', {});
  return { ok: true, closed };
});
