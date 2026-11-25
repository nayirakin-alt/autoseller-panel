import 'server-only';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { createServerClient, type CookieOptions } from '@supabase/ssr';
import { cookies } from 'next/headers';

const url = () => must('NEXT_PUBLIC_SUPABASE_URL');

function must(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Ortam degiskeni eksik: ${name}`);
  return v;
}

/** Servis rolu: RLS'yi asar. SADECE sunucuda, yetki kontrolunden SONRA kullanilir. */
let service: SupabaseClient | null = null;
export function serviceClient(): SupabaseClient {
  if (!service) {
    service = createClient(url(), must('SUPABASE_SERVICE_ROLE_KEY'), {
      auth: { persistSession: false, autoRefreshToken: false },
    });
  }
  return service;
}

/** Oturum acmis panel kullanicisi adina istemci: RLS uygulanir (uye sadece kendi verisini gorur). */
export async function userClient(): Promise<SupabaseClient> {
  const store = await cookies();
  return createServerClient(url(), must('NEXT_PUBLIC_SUPABASE_ANON_KEY'), {
    cookies: {
      getAll: () => store.getAll(),
      setAll: (list: { name: string; value: string; options: CookieOptions }[]) => {
        try {
          list.forEach(({ name, value, options }) => store.set(name, value, options));
        } catch {
          // Server Component icinde cookie yazilamaz; middleware yeniler.
        }
      },
    },
  });
}

/** RPC sonucu hatasizsa veriyi dondurur, hata varsa firlatir. */
export async function rpc<T = unknown>(fn: string, args: Record<string, unknown>): Promise<T> {
  const { data, error } = await serviceClient().rpc(fn, args);
  if (error) throw new RpcError(error.message, error.code);
  return data as T;
}

export class RpcError extends Error {
  constructor(message: string, public code?: string) {
    super(message);
  }
}
