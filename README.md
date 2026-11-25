# AutoSeller Panel

AutoSeller Fabric modu için lisans, günlük erişim kodu ve %40 komisyon sistemi.
Next.js (Vercel) + Supabase (PostgreSQL).

- Mimari, akışlar, API sözleşmesi: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)
- Veritabanı: `supabase/migrations/` (sırayla çalıştır)
- Testler: `npm install && npm test` (motor gerçek PostgreSQL üzerinde, PGlite)

```
supabase/migrations/
  0001_schema.sql   tablolar, ayarlar
  0002_engine.sql   motor: oturum, heartbeat, 60 dk pencere, %40, ödeme eşleştirme, operatör işlemleri, görünümler
  0003_rls.sql      yetkiler (UYE / OPERATOR), yeni kullanıcı tetikleyicisi
  0004_security.sql güvenlik / kurcalama logları, bütünlük raporu, bakiye-kâr tutarlılığı
  0005_ranks_requests_earnings.sql  rütbeler, rütbe siparişi/yükseltme/hediye, ödeme talepleri,
                    kazanç kayıtları, izole sıfırlama, operatör hesabı log düzeltmesi
src/
  app/api/mod/      mod uçları (Bearer token + HMAC imza, Mojang doğrulaması)
  app/api/me/       üye uçları
  app/api/admin/    operatör uçları
  app/api/cron/     Vercel Cron
  app/login, app/panel, app/admin   panel sayfaları
  lib/              supabase istemcileri, rol kontrolü, mod kimlik doğrulama
tests/
  engine.test.mjs   92 senaryo (komisyon, süre, ödeme, erişim, RLS, kurcalama, rütbe, talep, kazanç, sıfırlama)
  modauth.test.ts   imza / token / kod
```

## Hızlı kurulum (özet)

1. Supabase: 5 migration dosyasını sırayla çalıştır (mevcut kurulumda sadece `0005`), e-posta kaydını kapat, kullanıcıları davet et, kendini OPERATOR yap.
2. Vercel: repoyu bağla, `.env.example`'daki 4 değişkeni gir, deploy.
3. Operatör paneli → Operatör Hesapları: kasa hesabını ekle ve "Kasa" olarak seç.
4. Mod: `gradle.properties` → `panel_url=…`, derle, çıkan SHA-256'yı Ayarlar → İzinli mod jar listesine ekle.
5. Üye: panele girer, onay kutusunu işaretler, MC hesabını ekler → operatör "Onayla" der → üye günlük kodu moddaki Lisans sekmesine girer.

Ayrıntı: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) §7.
