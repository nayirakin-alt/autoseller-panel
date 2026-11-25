import { NextResponse, type NextRequest } from 'next/server';
import { createServerClient, type CookieOptions } from '@supabase/ssr';

// Supabase oturum cerezlerini yeniler; /panel ve /admin icin giris zorunlu.
export async function middleware(req: NextRequest) {
  let res = NextResponse.next({ request: req });
  const sb = createServerClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!, {
    cookies: {
      getAll: () => req.cookies.getAll(),
      setAll: (list: { name: string; value: string; options: CookieOptions }[]) => {
        list.forEach(({ name, value }) => req.cookies.set(name, value));
        res = NextResponse.next({ request: req });
        list.forEach(({ name, value, options }) => res.cookies.set(name, value, options));
      },
    },
  });
  const { data: { user } } = await sb.auth.getUser();
  const p = req.nextUrl.pathname;
  if (!user && (p.startsWith('/panel') || p.startsWith('/admin'))) {
    return NextResponse.redirect(new URL('/login', req.url));
  }
  return res;
}

// Mod API'si (/api/mod) cerez kullanmaz; middleware'den gecmesine gerek yok
export const config = { matcher: ['/panel/:path*', '/admin/:path*', '/login', '/api/me/:path*', '/api/admin/:path*'] };
