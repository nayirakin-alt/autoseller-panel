import { NextResponse } from 'next/server';
import { ZodError, type ZodTypeAny, type z } from 'zod';
import { RpcError } from './supabase';

export class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

/** Route handler sarmalayici: hatalari tutarli JSON'a cevirir. */
export function handle<Ctx = unknown>(fn: (req: Request, ctx: Ctx) => Promise<unknown>) {
  return async (req: Request, ctx: Ctx) => {
    try {
      const out = await fn(req, ctx);
      return out instanceof Response ? out : NextResponse.json(out ?? { ok: true });
    } catch (e) {
      if (e instanceof HttpError) return NextResponse.json({ ok: false, error: e.message }, { status: e.status });
      if (e instanceof ZodError) return NextResponse.json({ ok: false, error: 'Geçersiz istek', issues: e.issues }, { status: 400 });
      if (e instanceof RpcError) {
        const status = e.code === '42501' ? 403 : 400;
        return NextResponse.json({ ok: false, error: e.message }, { status });
      }
      console.error(e);
      return NextResponse.json({ ok: false, error: 'Sunucu hatası' }, { status: 500 });
    }
  };
}

export async function body<S extends ZodTypeAny>(req: Request, schema: S): Promise<z.infer<S>> {
  let json: unknown;
  try { json = await req.json(); } catch { throw new HttpError(400, 'JSON gövde bekleniyor'); }
  return schema.parse(json);
}
