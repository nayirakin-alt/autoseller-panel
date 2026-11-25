import { z } from 'zod';
import { body, handle } from '@/lib/http';
import { rpc } from '@/lib/supabase';
import { newServerId } from '@/lib/modauth';

// 1. adim: mod Mojang dogrulamasi icin tek kullanimlik serverId alir.
const Schema = z.object({ mcName: z.string().regex(/^[.*]?[A-Za-z0-9_]{3,16}$/) });

export const POST = handle(async (req) => {
  const { mcName } = await body(req, Schema);
  const serverId = newServerId();
  await rpc('mod_create_challenge', { p_server_id: serverId, p_mc_name: mcName });
  return { ok: true, serverId };
});
