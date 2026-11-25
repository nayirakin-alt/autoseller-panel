# AutoSeller Panel — Mimari

Bu belge lisans/komisyon sisteminin veri modelini, akışlarını, API sözleşmesini ve güvenlik
sınırlarını anlatır.

## 1. Genel bakış

```
 Minecraft istemcisi (AutoSeller modu)                 Tarayıcı (üye / operatör)
        │  HTTPS + imzalı istekler                             │  Supabase Auth çerezi
        ▼                                                      ▼
 ┌──────────────────────────── Vercel: Next.js (App Router) ────────────────────────────┐
 │  /api/mod/*    mod uçları (Bearer token + HMAC imza)                                  │
 │  /api/me/*     üye uçları (oturum + RLS)                                              │
 │  /api/admin/*  operatör uçları (rol kontrolü + DB içinde ikinci kontrol)              │
 │  /api/cron/*   Vercel Cron (her dakika: kopan oturumları kapat)                       │
 │  /login /panel /admin   panel sayfaları                                               │
 └───────────────────────────────┬──────────────────────────────────────────────────────┘
                                 │ service_role (sadece sunucuda)      ▲ sessionserver.mojang.com
                                 ▼                                     │ (hesap sahipliği)
 ┌──────────────────────────── Supabase: PostgreSQL ────────────────────────────────────┐
 │  Tablolar + RLS                                                                       │
 │  Motor: SECURITY DEFINER fonksiyonlar (tek işlemde süre/komisyon/ödeme hesabı)        │
 └──────────────────────────────────────────────────────────────────────────────────────┘
```

**Temel karar: bütün para ve süre hesabı PostgreSQL fonksiyonlarında yapılır.**
- Her çağrı tek bir işlemdir (transaction). Aynı anda gelen iki heartbeat aynı saati iki kez
  kapatamaz, aynı ödeme iki kez dağıtılamaz.
- Next.js katmanı sadece kimliği doğrular, gelen veriyi kontrol eder ve fonksiyonu çağırır.
  Vercel'in sunucusuz yapısında durum tutmaya gerek kalmaz.
- Motor gerçek PostgreSQL üzerinde test edilir (`tests/engine.test.mjs`, 45 senaryo).

## 2. Roller ve yetkiler

| Yetki | UYE | OPERATOR |
|---|---|---|
| Kendi MC hesaplarını, kazancını, kodunu, borcunu görme | ✔ | ✔ (herkesinkini) |
| MC hesabı ekleme (operatör onayı bekler) | ✔ | ✔ |
| Günlük erişim kodunu görme | kendi hesapları | tüm hesaplar |
| Erişimi açma/kapama, kullanıcıyı askıya alma, rol değiştirme | ✘ | ✔ |
| Operatör MC hesapları listesi | ✘ (göremez) | ✔ |
| Ödeme onaylama/reddetme, elle ödeme, komisyon silme | ✘ | ✔ |
| Ayarlar (oran, kasa hesabı, süreler) | okur | okur + değiştirir |

Yetkiler iki katmanlı uygulanır:
1. **API katmanı:** `requireUser` / `requireOperator` kontrolleri.
2. **Veritabanı katmanı:**
   - RLS politikaları: üye yalnızca kendi satırlarını okur.
   - `admin_*` fonksiyonlarının içindeki `_require_operator` kontrolü.
   - Tablolara doğrudan yazma hiçbir rolde yok.

API'de bir hata olsa bile bir üye, örneğin borcunu silemez. Bu testlerde doğrulanır.

## 3. Veri modeli

| Tablo | Amaç | Önemli alanlar |
|---|---|---|
| `profiles` | Panel kullanıcısı (Supabase Auth) | `role` UYE/OPERATOR, `status`, `consent_at` |
| `mc_accounts` | Üyenin MC hesabı (komisyona tabi) | `access_enabled`, `profit_total` (kümülatif net kâr), `active_seconds_total` |
| `operator_mc_accounts` | Operatör MC hesapları | kod istemez, komisyon üretmez; istatistik tutulur |
| `daily_codes` | Hesap başına, İstanbul günü başına bir kod | `id` = **kod numarası**, `code`, `use_count` |
| `bot_sessions` | Mod oturumu | `daily_code_id` (kullanılan kod), `token_hash`, `hmac_secret`, `mode` FULL/PAY_ONLY, `last_seq` |
| `commission_windows` | 60 dk aktif çalışma penceresi | `active_seconds`, `profit_start/end/delta`, `rate`, `commission` |
| `commissions` | Kapanan pencerenin borcu (> 0 ise) | `amount`, `paid`, `status` PENDING/PARTIAL/PAID/WAIVED |
| `payments` | Mod "/pay gönderdim" kaydı | `client_tx_id` (tekil), `status` CLAIMED/VERIFIED/REJECTED, `unallocated` |
| `payment_allocations` | Ödeme → komisyon dağıtımı | en eski borçtan başlar |
| `received_payments` | Kasa hesabının gördüğü "X paid you $Y" | ödeme doğrulaması için |
| `settings` | `commission_rate` 0.40, `window_seconds` 3600, `commission_receiver`, `commission_grace_min`… | |
| `audit_log` | Kim ne yaptı | erişim, ödeme, ayar değişiklikleri |
| `mod_challenges` | Mojang doğrulaması için tek kullanımlık `serverId` | |

Para birimi oyun içi $'dır, `bigint` olarak tutulur. Zaman `timestamptz` (UTC); günlük kod sınırı Europe/Istanbul.

## 4. Akışlar

### 4.1 Oturum açma (kod + hesap sahipliği)

```
mod  ── POST /api/mod/challenge {mcName} ───────────────▶  serverId
mod  ── MinecraftClient.getSessionService().joinServer(profil, accessToken, serverId)  ─▶ Mojang
mod  ── POST /api/mod/session/start {mcName, code, modVersion, serverId} ─▶
        API: hasJoined(mcName, serverId) → gerçek UUID ve ad      (hesap gerçekten bu oyuncunun mu?)
        DB : mod_session_start(...)
              1. mod sürümü ≥ min_mod_version
              2. operatör hesabı mı? → kod sorulmaz, exempt oturum
              3. üye hesabı: kullanıcı aktif, hesap açık, onay (consent) verilmiş
              4. bugünün kodu eşleşiyor mu (büyük/küçük harf fark etmez)
              5. aynı hesabın eski oturumu kapanır (tek aktif oturum)
              6. oturuma kullanılan kod numarası yazılır
◀──  {token, hmacSecret, mode, window, due, ...}           (token yalnızca bu yanıtta bir kez döner)
```

Mojang doğrulaması sayesinde biri başkasının MC adını yazarak oturum açamaz. Kendi hesabının
"operatör hesabıyım" demesi de mümkün değil. `require_mojang_auth` ayarıyla kapatılabilir ama
kapatılması önerilmez.

### 4.2 Heartbeat ve 60 dakikalık pencere

Mod yaklaşık her 30 saniyede şunu gönderir:

```json
{ "seq": 42, "running": true, "profitDelta": 1350000, "balance": 37764758 }
```

- **`seq`:** Artan sıra numarası. Aynı ya da daha küçük `seq` uygulanmaz; ağ hatasında güvenle tekrar gönderilebilir.
- **`profitDelta`:** Son **onaylanan** heartbeat'ten beri **satışlardan** gelen net kâr değişimi. Hesap şöyle yapılır: satış geliri − mal maliyeti (orders `each × 1.02`) − ilan vergisi. `/pay` transferleri, komisyon ödemeleri dahil, ve onların vergileri bu hesaba **girmez**. Negatif olabilir.
- **Süre:** Sunucunun saatine göre ölçülür: iki heartbeat arası, en fazla 90 sn, sadece `running=true` iken. Mod süreyi kendisi bildirmez.

Motor (`_accrue`) her heartbeat'te şunları yapar:

```
pencere.aktif += dt
eğer pencere.aktif ≥ 3600:
    saatlik_kâr = hesap.profit_total − pencere.profit_start
    komisyon    = floor(max(0, saatlik_kâr) × 0.40)
    pencereyi kapat; komisyon > 0 ise borç yaz
    taşan saniyelerle yeni pencere aç (profit_start = şimdiki toplam)
```

- **50 + 10 dk:** Açık pencere oturumlar arasında kalır. Mod kapanıp açılınca aynı pencere 3000. saniyeden devam eder. Aradaki kapalı süre sayılmaz.
- **Örnek:** 1. saat sonunda toplam 50M → **20M**. 2. saat sonunda toplam 150M → yeni kâr 100M → **40M**.
- **Zarar eden saat** 0 komisyon üretir. Zarar sonraki saate taşınmaz.

### 4.3 Bekleyen komisyon ve ödeme

1. Heartbeat yanıtındaki `due` alanı borcu gösterir: `{pay_to, total, items[]}` (en eski borç önce).
2. Mod bakiyesi yettiğinde önce bir `clientTxId` (UUID) üretir ve diske yazar. Sonra `/pay <pay_to> <tutar>` gönderir.
3. "You paid … (+ $ vergi)" mesajını görünce `POST /api/mod/payments {clientTxId, toPlayer, amount, tax, chatLine}` gönderir.
   - Aynı `clientTxId` ikinci kez gelirse yeni ödeme yazılmaz. Mod çökse de, internet kopsa da ödeme iki kez sayılmaz.
   - Tutar en eski borçtan başlayarak dağıtılır. Borçtan fazlası `unallocated` alanına yazılır ve operatör karar verir.
   - Durum `CLAIMED` olur: mod "ödedim" der ama henüz kanıt yok.
4. **Doğrulama:** Kasa hesabında da mod çalışıyorsa, "Friend1 paid you $20M" mesajını `POST /api/mod/payments/received` ile bildirir. Gönderen adı, tutar (yuvarlama payıyla) ve ±15 dakika uyuyorsa ödeme `VERIFIED` olur. Eşleşmeyenler operatör panelinde "Doğrulanmamış ödemeler" listesine düşer:
   - **Onayla:** ödeme `VERIFIED` olur.
   - **Reddet:** dağıtım geri alınır ve borç yeniden açılır.
5. **Vade:** `commission_grace_min` (varsayılan 120 dk) içinde ödenmeyen borç oturumu `PAY_ONLY` moduna geçirir. Bu modda bot satış yapmaz; sadece borcu öder. Borç kapanınca normal moda döner.

### 4.4 Erişimi kapatma

Kapatma yolları:
- Operatör bir hesabı kapatabilir (`admin_set_account_access`).
- Operatör bir kullanıcıyı askıya alabilir (`admin_set_user_status`).

Kapatılınca:
- Açık oturum **anında** biter; sonraki heartbeat `NO_SESSION` alır ve mod otomasyonu durdurur.
- Yeni oturum da reddedilir.
- Heartbeat kesilirse (mod kapalı, internet yok, oturum zaman aşımı 180 sn) oturum düşer. Mod çevrimdışı çalışamaz.

## 5. API sözleşmesi

Tüm yanıtlar JSON'dur, hatalarda `{ ok: false, error | reason }` döner.

### Mod uçları
Oturum açıldıktan sonraki her istek şu başlıkları taşır:
- `Authorization: Bearer <token>`
- `X-AS-Signature: hex(HMAC_SHA256(hmacSecret, ham_gövde))`

| Uç | Gövde | Yanıt / not |
|---|---|---|
| `POST /api/mod/challenge` | `{mcName}` | `{serverId}` |
| `POST /api/mod/session/start` | `{mcName, code, modVersion, serverId, integrity:{jarSha256, agents[], debugger, devEnv}}` | `{token, hmacSecret, mode, allowed, window, due, heartbeat_sec}` ya da `{ok:false, reason}`: `INVALID_CODE`, `ACCESS_DISABLED…`, `USER_SUSPENDED…`, `CONSENT_REQUIRED`, `UNKNOWN_ACCOUNT`, `UUID_MISMATCH`, `MOD_OUTDATED` |
| `POST /api/mod/heartbeat` | `{seq, running, profitDelta, balance}` | durum + `closed_windows`; `allowed:false` gelirse **bot hemen durur** |
| `POST /api/mod/session/end` | heartbeat ile aynı | son heartbeat + oturum sonu |
| `POST /api/mod/payments` | `{clientTxId, toPlayer, amount, tax, chatLine}` | `{status, unallocated, due}` |
| `POST /api/mod/payments/received` | `{fromPlayer, amount, tolerance, chatLine}` | sadece kasa (operatör) hesabı |
| `POST /api/mod/security` | `{integrity?, events?[]}` | ~5 dk'da bir bütünlük raporu; istemci olayları en fazla WARN |

Biten bir oturumla gelen heartbeat `{ok:false, reason:'NO_SESSION', end_reason}` döner; `end_reason` modda kullanıcıya gösterilir (örn. `ACCESS_DISABLED: Komisyon ödenmedi`).

### Üye uçları (oturum çerezi)
| Uç | Açıklama |
|---|---|
| `GET /api/me` | profil, hesaplar (aktiflik, toplam ve son saat kârı, %40, ödenen, borç, kod no), ayarlar |
| `POST /api/me/consent` | veri gönderimi + uzaktan kapatma + komisyon onayı |
| `POST /api/me/accounts` | `{mcName}`; operatör onayı bekler |
| `GET /api/me/accounts/:id/code` | bugünün kodu ve numarası |
| `GET /api/me/accounts/:id/history` | pencereler, komisyonlar, ödemeler, oturumlar |

### Operatör uçları
| Uç | Açıklama |
|---|---|
| `GET /api/admin/overview` | tüm hesaplar + toplamlar + operatör hesapları + doğrulanmamış ödemeler + kullanıcılar |
| `POST /api/admin/accounts/:id/access` | `{enabled, reason}` |
| `POST /api/admin/accounts/:id/manual-payment` | `{amount, note}` |
| `GET /api/admin/accounts/:id/code` | herhangi bir hesabın bugünkü kodu |
| `POST /api/admin/users/:id/status` | `{status: ACTIVE\|SUSPENDED, reason}` |
| `POST /api/admin/users/:id/role` | `{role}`; son operatör düşürülemez |
| `GET/POST /api/admin/operator-accounts`, `DELETE …/:id` | operatör MC hesapları |
| `GET /api/admin/payments`, `POST …/:id/verify` | `{accept, note}` |
| `POST /api/admin/commissions/:id/waive` | borcu sil |
| `GET/PUT /api/admin/settings` | `{key, value}` |
| `GET /api/admin/security?severity=&account=` | güvenlik / kurcalama logları (kullanıcı, MC hesabı, günlük kod, zaman, detay) |
| `POST /api/admin/accounts/:id/clear-tamper` | inceleme sonrası kurcalama bayrağını kaldır |

## 6. Güvenlik ve güven sınırları

**Önlenen riskler:**
- **Başkasının adına oturum açma:** Mojang `hasJoined` doğrulaması bunu engeller.
- **Kodun başkasına verilmesi:** Kod her gün değişir; hesap da Mojang ile doğrulanır.
- **Kurcalanmış ya da tekrar oynatılan istek:** Her isteğin HMAC imzası ve artan `seq` numarası var.
- **Çift ödeme sayımı:** `client_tx_id` tekil olduğu için aynı ödeme iki kez yazılamaz.
- **Süre şişirme:** Süre sunucu saatiyle ölçülür ve iki heartbeat arası en fazla 90 sn sayılır.
- **Üyenin borcunu silmesi ya da erişimini açması:** RLS ve fonksiyon içi rol kontrolü engeller.
- **Token sızıntısı:** Sunucuda sadece token'ın `sha256` özeti saklanır; üyeler oturum sırlarını okuyamaz.

**Kurcalama tespiti (`0004_security.sql`, tablo `security_events`):**

| Tür | Kaynak | Seviye |
|---|---|---|
| `JAR_HASH_MISMATCH` | mod jar SHA-256'sı `allowed_mod_hashes` listesinde yok (liste boşsa kontrol yok) | CRITICAL |
| `JAVA_AGENT` | JVM argümanlarında `-javaagent` / `-agentpath` / `-agentlib` (ayrıca `JAVA_TOOL_OPTIONS`) | CRITICAL |
| `DEBUGGER` | `-agentlib:jdwp`, `-Xdebug` | CRITICAL |
| `DEV_ENVIRONMENT` | Fabric geliştirme ortamı | WARN |
| `BAD_SIGNATURE` | token doğru, gövde imzası yanlış (sunucu tespiti) | WARN |
| `SEQ_REGRESSION` | geri giden sıra no: tekrar oynatma ya da aynı token iki istemcide (sunucu) | WARN |
| `BALANCE_PROFIT_MISMATCH` | kapanan saatte (bakiye_son − bakiye_baş + giden ödemeler) − bildirilen kâr > `balance_mismatch_min` (sunucu) | WARN |
| `CLIENT_*` | modun gözlemlediği olaylar (örn. `CLIENT_PROFIT_REWIND`: istatistik dosyası geri alınmış) | ≤ WARN |
| `INTEGRITY_OK` | oturum açılışında temiz rapor | INFO |

Kritik olayda `tamper_action` ayarı uygulanır: `LOG` (varsayılan, sadece kayıt), `PAY_ONLY` (hesap işaretlenir, bot sadece borç öder;
operatör "bayrağı kaldır" diyene kadar), `BLOCK` (erişim kapanır, oturum biter). Operatör hesapları hiçbir zaman otomatik cezalandırılmaz.

**Önlenemeyen risk (dürüst sınır):** Kâr ve `running` durumu yine istemcinin bildirimidir. İstemci kontrolleri, modu
yeniden derleyebilen birini tamamen durduramaz (kontrol kodunu da silebilir); bu yüzden asıl güvence sunucu tarafındaki
bakiye-kâr tutarlılığı, kasa doğrulaması ve modu yalnızca güvendiğin kişilere vermektir. Java agent tespiti, agent kullanan
bazı başlatıcılarda yanlış alarm verebilir; bu yüzden varsayılan eylem `LOG`'dur.

## 7. Kurulum

1. **Supabase projesi:** SQL Editor'de sırasıyla `supabase/migrations/0001_schema.sql`, `0002_engine.sql`, `0003_rls.sql`, `0004_security.sql` ve `0005_ranks_requests_earnings.sql` dosyalarını çalıştır. (Önceki sürüm kuruluysa sadece `0005`'i çalıştırman yeterli.) Supabase CLI varsa `supabase db push` de olur.
2. **Kayıtları kapat:** Authentication → Providers → Email: "Allow new users to sign up" seçeneğini **kapat**. Kullanıcıları Authentication → Users → **Invite user** ile davet et.
3. **İlk operatör:** Kendini davet edip giriş yaptıktan sonra SQL Editor'de şunu çalıştır:
   `update profiles set role = 'OPERATOR' where id = (select id from auth.users where email = 'sen@ornek.com');`
4. **Kasa hesabı:** Operatör paneli → Operatör Hesapları: kasa MC hesabını ekle ve "Kasa (alıcı) hesabı" listesinden seç. Kasa hesabında da modu açık tutarsan gelen ödemeler otomatik doğrulanır.
5. **Vercel:** Repoyu bağla ve Environment Variables bölümüne `.env.example` dosyasındaki dört değişkeni gir. `SUPABASE_SERVICE_ROLE_KEY` asla istemciye ya da moda verilmez. `vercel.json` içindeki cron her dakika kopan oturumları kapatır.
6. **Mod:** `AutoSeller/gradle.properties` içinde `panel_url=https://<proje>.vercel.app` yaz, `KUR_VE_CALISTIR.bat` ile derle. Ekrana (ve `HAZIR/*.sha256.txt`'ye) yazılan SHA-256'yı Ayarlar → İzinli mod jar listesine ekle. Bu jar'ı üyelere dağıt.
7. **Test:** `npm install && npm test` komutu motor testlerini gerçek PostgreSQL'de (PGlite) çalıştırır.

## 8. Mod istemcisi (v0.7.0)

Paket `dev.autoseller.license`:
- `LicenseClient`: challenge → Mojang `joinServer` → `session/start` (kod + bütünlük). Dünyaya girişte bugünün kodu önbellekteyse otomatik bağlanır; operatör hesabı kodsuz bağlanır; üyeye kod sorulur (O → Lisans).
- Heartbeat 30 sn; ilk heartbeat 6 sn sonra (sunucu 5 sn'den sık olanı yok sayar). Gönderilip cevabı alınamayan kâr aynı `seq` ile tekrar denenir; `throttled` cevabı uygulanmamış sayılır.
- Durdurma: `allowed:false`, biten oturum (`end_reason`) ya da 90 sn panele ulaşılamaması → otomasyon durur. FULL → PAY_ONLY geçişinde satış durur.
- Kâr sayacı: `SessionStats.licenseProfitTotal()` = satış − maliyet − ilan vergisi; istatistik sıfırlamasından etkilenmez (`licenseCarry`).
- Komisyon: `due.total > 0` ise döngü başında / ilan beklemesinde / boştayken bakiye okunur, `min(borç, bakiye/(1+vergi))` kadar `/pay <kasa>`; `clientTxId` komuttan önce `config/autoseller-license.json`'a yazılır. Red → 5 dk sonra tekrar; onay görülmezse "gönderildi" bildirilir, kasa doğrulaması eşleştirir. Borç varken kullanıcının kendi otomatik transferi bekler.
- Kasa hesabı: "X paid you $Y" / "You received $Y from X" → `/api/mod/payments/received`.
- `Integrity`: jar SHA-256, agent/debugger argümanları, geliştirme ortamı; 5 dk'da bir yeniden.

## 9. Rütbeler, ödeme talepleri, kazanç kayıtları (0005)

Mod koduna ve mod uçlarına dokunulmadı; mod komisyon oranını zaten sunucudan okuyor.

**Rütbeler** (`ranks`, operatör Rütbeler sekmesinden düzenler):

| Rütbe | Komisyon | Haftalık |
|---|---|---|
| Bronze (varsayılan) | %50 | 0 |
| Gold | %40 | 80M |
| Diamond | %30 | 150M |
| Ametis | %25 | 200M |

- Aktif rütbe, `rank_grants` içinde şu an geçerli olan en yüksek rütbedir; yoksa Bronze.
- Saatlik pencere açılırken oran kullanıcının o anki rütbesinden alınır (`_open_window`). Pencere içinde rütbe yükselirse açık pencerenin oranı hemen düşer. Rütbe bitince o saat eski oranla kapanır, yani kullanıcı lehine.
- **Satın alma:** N hafta × haftalık ücret. Daha yüksek bir rütbe aktifse yeni rütbe onun bitişinden sonra başlar (sıraya girer).
- **Uzatma:** aynı rütbeyi almak, mevcut sürenin sonuna ekler.
- **Yükseltme:** ödenmiş, daha düşük bir rütbe aktifken daha yükseğe geçiştir. Ödenecek tutar, kalan süre boyunca haftalık ücret farkıdır, saniye bazında yukarı yuvarlanır; istenirse ek hafta eklenir. Bitiş tarihi korunur, eski rütbe `SUPERSEDED` olur.
  - Örnek: Gold 3 haftalık alınmış, 18 gün kalmış. Diamond'a geçiş farkı (150M − 80M) × 18/7 = 180M.
- **Sipariş:** `rank_orders` tablosunda durur ve komisyon borcuyla karışmaz. Üye oyunda `/pay <kasa> <tutar>` gönderir.
  - Kasada görülen ödeme önce komisyon iddiasıyla eşleşir. Eşleşmeyen ödeme en az 2 dk bekletilir, sonra `match_extra_payments` onu siparişe, o da yoksa açık ödeme talebine eşleştirir. Gönderen hesap, siparişin sahibine ait olmalıdır.
  - Aynı tutarda bekleyen bir komisyon iddiası varsa ödemeye dokunulmaz.
  - Eşleştirme hem cron'da hem panel açılırken çalışır. Operatör "Ödendi" ile elle de onaylayabilir.
- **Hediye:** operatör saat, gün veya hafta seçerek ücretsiz verir (`source = GIFT`). Aynı rütbe aktifse süresinin sonuna eklenir.

**Ödeme talebi** (`payment_requests`):
- Operatör bir kullanıcıya, isteğe bağlı olarak belirli bir MC hesabına, tutar, açıklama ve son tarih gönderir.
- Talep üyenin panelinde `/pay <kasa> <tutar>` olarak görünür; kasa ödemeyi görünce kapanır.
- Komisyon borcuna eklenmez; mod bu tutarı otomatik ödemez.

**Satış/kazanç kayıtları** (`profit_events`):
- Her heartbeat'teki net kâr değişimi bir tetikleyiciyle kaydedilir.
- Mod ürün adı ve birim fiyat göndermez. Ürün bazında döküm için mod sürümü gerekir; bu sürümde istenmediği için eklenmedi.
- `earnings_report` şunları verir: hesap başına son 60 dk, bugün, sıfırlamadan beri toplam, son işlemler, saatlik (48 sa) ve günlük (31 gün) not.

**İzole sıfırlama** (`view_resets`):
- Her görüntüleyen (üye ya da tek tek her operatör) kendi sıfırlama noktasını tutar. Hiçbir kayıt silinmez.
- `STATS` sıfırlaması satış kayıtlarını ve toplamları, `EARNINGS` sıfırlaması saatlik/günlük kazanç notunu etkiler.
- Komisyon, borç ve ödeme kayıtları sıfırlanmaz.

**Operatör hesabı logları:**
- `security_log` artık muaf (operatör) oturumlar için kayıt yazmaz. Gerekirse `log_operator_accounts=true` ayarıyla açılır.
- Aynı oturum ve aynı tür olay 30 dk içinde bir kez yazılır.
- Eski operatör logları Güvenlik sekmesindeki "Operatör hesabı loglarını temizle" butonuyla silinir.

**Yeni uçlar:**
- Üye: `GET/POST /api/me/rank` (`quote`, `order`, `cancel`) ve `GET/POST /api/me/earnings` (sıfırlama).
- Operatör:
  - `GET/POST /api/admin/ranks` (`gift`, `order_paid`, `order_cancel`, `revoke`, `set_rank`)
  - `GET/POST /api/admin/payment-requests` (`create`, `resolve`)
  - `GET/POST /api/admin/earnings` (sıfırlama)
  - `POST /api/admin/security/purge-operator`

## 10. Bot iş emirleri ve ürün bazlı satış kayıtları (0006, mod v0.7.1)

**Ödeme al (ödeme talebinin yerine geçer):**
- Operatör bir MC hesabı ve tutar seçer → `bot_jobs` tablosuna `PAY` emri yazılır. Onay bekleme adımı yoktur.
- Mod emri heartbeat cevabının `jobs` alanından alır (en geç ~30 sn). Önce `POST /api/mod/jobs/ack {status: RECEIVED}` gönderir; bundan sonra emir iptal edilemez.
- Ardından oyunda bildirim gösterir, bakiyeyi kontrol eder ve `/pay <kasa> <tutar>` gönderir. Sonucu `DONE`, `UNVERIFIED` ya da `FAILED` (bakiye yetersiz / sunucu reddetti) olarak bildirir.
- Teslim en az bir kez yapılır: RECEIVED gelene kadar emir her heartbeat'te tekrar gönderilir. Mod emir numarasıyla aynı emri iki kez çalıştırmaz. `/pay` gönderilmeden önce emir diske `PAYING` olarak yazılır; oyun kapanırsa tekrar ödenmez, `UNVERIFIED` bildirilir.
- **"Komisyon borcundan düş" açık (varsayılan):** sonuç, emrin `tx_id`'siyle `mod_report_payment` üzerinden `payments` tablosuna yazılır. Borçtan FIFO düşülür ve kasa "paid you" ile doğrular.
- **Kapalı:** ayrı tahsilattır. Kasada görülen ödeme `match_job_payments` ile emre eşleştirilir. Bu ödeme rütbe siparişine ya da eski talebe eşleşmez.
- **Koşullar:**
  - Üyenin panelde "uzaktan ödeme" onayı vermiş olması (`profiles.remote_pay_consent_at`); onay geri alınabilir.
  - Mod sürümünün `job_min_mod_version` (0.7.1) veya üstü olması.
  - Hesap başına aynı anda en fazla 1 açık PAY emri.
  - 30 dk içinde teslim alınmayan emir `EXPIRED` olur.
- **Bildirim (`NOTIFY`):** oyuncunun ekranında `[Operatör]` mesajı olarak görünür; onay gerektirmez.
- `admin_create_payment_request` artık hata verir. Eski talepler listelenip kapatılabilir.

**Satış geçmişi (`mod_sales`):**
- Mod v0.7.1, oyundaki satış mesajlarından her satış için şu bilgileri heartbeat'le gönderir (en fazla 50'şer): ürün (itemId ve ad), adet, satış fiyatı, maliyet, ilan vergisi, net kâr ve eşleşme türü (`single`, `batch`, `early`, `unmatched`).
- `client_id` sayesinde tekrar gönderim çift kayıt yapmaz.
- Kayıtlar yalnızca gösterim içindir; komisyon yine `profitDelta`'dan hesaplanır.
- `sales_report`, 0005'teki `STATS` sıfırlamasına tabidir; izole sıfırlama burada da geçerlidir.

**Yeni uçlar:**
- Mod: `POST /api/mod/jobs/ack`. Heartbeat isteğine `sales[]` alanı, cevabına `jobs[]` ve `sales_saved` alanları eklendi; eski mod bunları yok sayar.
- Operatör: `GET/POST /api/admin/jobs`, `DELETE /api/admin/jobs/:id`, `GET /api/admin/sales`.
- Üye: `GET /api/me/sales`, `POST /api/me/remote-pay-consent`.

## 11. "+ödeme" koruması ve hesap satırı "Ödeme al" (0007, sadece panel)

- Üye Hesapları satırındaki **Ödeme al** butonu, satırın altında bir form açar: kasa, tutar, "komisyon borcundan düş" seçeneği ve not.
  - Bu form bir `PAY` bot iş emri oluşturur (bkz. bölüm 10).
  - Üye "uzaktan ödeme" onayı vermemişse form kilitli kalır ve bir uyarı gösterir.
- **+ödeme** artık borcu kanıtsız düşmez; `admin_manual_payment` hata verir.
  - Yalnızca kasada görülmüş ve hiçbir kayda bağlanmamış bir gelen ödeme (`received_payments`) seçilebilir.
  - Seçilen ödeme `admin_manual_payment_from_received` ile doğrulanmış ödeme olarak borca sayılır. Aynı gelen ödeme ikinci kez kullanılamaz.
- Eski "ödeme talebi" arayüzü gizlendi. Tablo ve eski kayıtlar veritabanında duruyor; kasa ödemesi gelirse eşleştirme yine çalışır.
