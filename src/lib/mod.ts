import 'server-only';
import { rpc, serviceClient } from './supabase';
import { HttpError } from './http';
import { dashUuid, sha256, verifySignature } from './modauth';

export interface ModSession {
  id: string;
  mcName: string;
  tokenHash: string;
}

/**
 * Mod istegini dogrular: Authorization: Bearer <token>, X-AS-Signature: HMAC(ham govde).
 * Ham govdeyi ve JSON'u dondurur. Gecersizse 401.
 */
export async function authenticateMod(req: Request): Promise<{ session: ModSession; raw: string; json: unknown }> {
  const auth = req.headers.get('authorization') ?? '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
  if (!token) throw new HttpError(401, 'NO_TOKEN');
  const raw = await req.text();
  const tokenHash = sha256(token);
  const { data, error } = await serviceClient()
    .from('bot_sessions').select('id, mc_name, hmac_secret, ended_at').eq('token_hash', tokenHash).maybeSingle();
  if (error || !data) throw new HttpError(401, 'NO_SESSION');
  if (!verifySignature(data.hmac_secret, raw, req.headers.get('x-as-signature'))) {
    // Token dogru ama govde imzasi tutmuyor: istek yolda degistirilmis ya da istemci kurcalanmis
    await rpc('security_log', {
      p_session: data.id, p_token_hash: null, p_kind: 'BAD_SIGNATURE', p_severity: 'WARN',
      p_detail: { path: new URL(req.url).pathname, ip: clientIp(req), bytes: raw.length },
    }).catch(() => undefined);
    throw new HttpError(401, 'BAD_SIGNATURE');
  }
  let json: unknown;
  try { json = JSON.parse(raw); } catch { throw new HttpError(400, 'JSON gövde bekleniyor'); }
  return { session: { id: data.id, mcName: data.mc_name, tokenHash }, raw, json };
}

/**
 * Mojang oturum sunucusu: oyuncu gercekten bu hesabin sahibi mi?
 * Mod once client.getSessionService().joinServer(profil, accessToken, serverId) cagirir;
 * burada hasJoined ile dogrulanir. Basariliysa gercek UUID ve ad doner.
 */
export async function verifyMojang(mcName: string, serverId: string): Promise<{ uuid: string; name: string }> {
  const u = `https://sessionserver.mojang.com/session/minecraft/hasJoined?username=${encodeURIComponent(mcName)}&serverId=${encodeURIComponent(serverId)}`;
  const res = await fetch(u, { cache: 'no-store' });
  if (res.status !== 200) throw new HttpError(401, 'MOJANG_NOT_JOINED');
  const j = (await res.json()) as { id: string; name: string };
  return { uuid: dashUuid(j.id), name: j.name };
}

export function clientIp(req: Request): string | null {
  return req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? null;
}
