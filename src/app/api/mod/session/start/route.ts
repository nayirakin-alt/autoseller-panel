import { z } from 'zod';
import { body, handle, HttpError } from '@/lib/http';
import { rpc } from '@/lib/supabase';
import { newSessionSecrets } from '@/lib/modauth';
import { clientIp, verifyMojang } from '@/lib/mod';

// 2. adim: mod joinServer(serverId) yaptiktan sonra oturum acar.
const Schema = z.object({
  mcName: z.string().regex(/^[.*]?[A-Za-z0-9_]{3,16}$/),
  code: z.string().max(32).default(''),       // operator hesaplarinda bos olabilir
  modVersion: z.string().max(32),
  serverId: z.string().max(64).optional(),
  // Butunluk raporu (rizaya dahil): jar SHA-256, java agent/debugger, gelistirme ortami
  integrity: z.object({
    jarSha256: z.string().max(128).default(''),
    agents: z.array(z.string().max(300)).max(20).default([]),
    debugger: z.boolean().default(false),
    devEnv: z.boolean().default(false),
    modVersion: z.string().max(32).optional(),
    loader: z.string().max(64).optional(),
  }).optional(),
});

export const POST = handle(async (req) => {
  const b = await body(req, Schema);
  const requireMojang = (await rpc<string | null>('setting_text', { p_key: 'require_mojang_auth' })) !== 'false';

  let mcName = b.mcName;
  let mcUuid: string | null = null;
  if (requireMojang) {
    if (!b.serverId) throw new HttpError(400, 'SERVER_ID_REQUIRED');
    const used = await rpc<boolean>('mod_use_challenge', { p_server_id: b.serverId, p_mc_name: b.mcName });
    if (!used) throw new HttpError(401, 'CHALLENGE_INVALID');
    const who = await verifyMojang(b.mcName, b.serverId);   // gercek hesap sahibi
    mcName = who.name;
    mcUuid = who.uuid;
  }

  const s = newSessionSecrets();
  const state = await rpc<Record<string, unknown>>('mod_session_start', {
    p_mc_name: mcName, p_mc_uuid: mcUuid, p_code: b.code, p_token_hash: s.tokenHash,
    p_hmac_secret: s.hmacSecret, p_mod_version: b.modVersion, p_ip: clientIp(req), p_now: null,
  });
  if (!state.ok) return { ...state };
  const integrity = await rpc<{ ok: boolean; flags: string[]; blocked: boolean }>('mod_report_integrity', {
    p_token_hash: s.tokenHash,
    p_report: { ...(b.integrity ?? { jarSha256: '', agents: [], debugger: false, devEnv: false, missing: true }), initial: true },
  });
  if (integrity.blocked) return { ok: false, reason: 'TAMPER_BLOCKED', flags: integrity.flags };
  // token ve hmacSecret SADECE burada, bir kez doner
  return { ...state, integrity, token: s.token, hmacSecret: s.hmacSecret };
});
