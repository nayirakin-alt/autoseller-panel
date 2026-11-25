import 'server-only';
import { userClient, serviceClient } from './supabase';
import { HttpError } from './http';

export type Role = 'UYE' | 'OPERATOR';
export interface Me {
  id: string;
  email: string | null;
  role: Role;
  status: 'ACTIVE' | 'SUSPENDED';
  displayName: string;
  consentAt: string | null;
  remotePayConsentAt: string | null;
}

/** Panel istegi: oturum acmis ve askida olmayan kullanici. */
export async function requireUser(): Promise<Me> {
  const sb = await userClient();
  const { data: { user } } = await sb.auth.getUser();
  if (!user) throw new HttpError(401, 'Giriş yapılmamış');
  // Rol bilgisini servis istemcisiyle oku (istemcinin degistirebilecegi metadata'ya guvenme)
  const { data: p, error } = await serviceClient()
    .from('profiles').select('id, role, status, display_name, consent_at, remote_pay_consent_at').eq('id', user.id).single();
  if (error || !p) throw new HttpError(403, 'Profil bulunamadı');
  if (p.status !== 'ACTIVE') throw new HttpError(403, 'Hesabın askıya alınmış');
  return { id: p.id, email: user.email ?? null, role: p.role, status: p.status,
           displayName: p.display_name, consentAt: p.consent_at,
           remotePayConsentAt: p.remote_pay_consent_at ?? null };
}

/** Sadece OPERATOR. (Veritabani fonksiyonlari da ayrica _require_operator ile kontrol eder.) */
export async function requireOperator(): Promise<Me> {
  const me = await requireUser();
  if (me.role !== 'OPERATOR') throw new HttpError(403, 'Bu işlem sadece operatörler içindir');
  return me;
}
