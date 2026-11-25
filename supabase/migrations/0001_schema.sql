-- =====================================================================
-- AutoSeller Panel - Sema
-- Para birimleri: oyun ici $ tam sayi (bigint). Zaman: timestamptz (UTC).
-- Gun sinirlari (gunluk kod): Europe/Istanbul.
-- Butun yazmalar 0002'deki SECURITY DEFINER fonksiyonlarla yapilir;
-- istemciler tablolara dogrudan yazamaz (0003 RLS).
-- =====================================================================

-- ---------------------------------------------------------------------
-- Kullanicilar ve roller (Supabase Auth: auth.users)
-- ---------------------------------------------------------------------
create table public.profiles (
  id               uuid primary key references auth.users(id) on delete cascade,
  display_name     text not null default '',
  role             text not null default 'UYE' check (role in ('UYE', 'OPERATOR')),
  status           text not null default 'ACTIVE' check (status in ('ACTIVE', 'SUSPENDED')),
  suspended_reason text,
  consent_at       timestamptz,               -- "mod veri gonderir / uzaktan kapatilabilir" onayi
  created_at       timestamptz not null default now()
);

-- ---------------------------------------------------------------------
-- Uyelerin Minecraft hesaplari (komisyona tabi)
-- ---------------------------------------------------------------------
create table public.mc_accounts (
  id                   uuid primary key default gen_random_uuid(),
  owner_id             uuid not null references public.profiles(id) on delete cascade,
  mc_name              text not null check (mc_name ~ '^[.*]?[A-Za-z0-9_]{3,16}$'),
  mc_uuid              uuid,
  -- Yeni eklenen hesap operator onayi bekler
  access_enabled       boolean not null default false,
  blocked_reason       text default 'Operatör onayı bekleniyor',
  created_at           timestamptz not null default now(),
  last_seen_at         timestamptz,
  -- Sayaclar (mod raporlarindan; sadece fonksiyonlar gunceller)
  profit_total         bigint not null default 0,   -- komisyona esas KUMULATIF net kar
  active_seconds_total bigint not null default 0,   -- toplam aktif calisma
  last_balance         bigint,
  last_balance_at      timestamptz,
  -- Kurcalama: kritik olay goruldu ve tamper_action=PAY_ONLY ise hesap "sadece odeme"ye duser
  tamper_flag          boolean not null default false,
  tamper_reason        text
);
create unique index mc_accounts_name_uq on public.mc_accounts (lower(mc_name));
create unique index mc_accounts_uuid_uq on public.mc_accounts (mc_uuid) where mc_uuid is not null;
create index mc_accounts_owner_idx on public.mc_accounts (owner_id);

-- ---------------------------------------------------------------------
-- Operator Minecraft hesaplari: kod istemez, komisyon uretmez
-- ---------------------------------------------------------------------
create table public.operator_mc_accounts (
  id                   uuid primary key default gen_random_uuid(),
  mc_name              text not null check (mc_name ~ '^[.*]?[A-Za-z0-9_]{3,16}$'),
  mc_uuid              uuid,
  note                 text,
  created_by           uuid references public.profiles(id) on delete set null,
  created_at           timestamptz not null default now(),
  last_seen_at         timestamptz,
  profit_total         bigint not null default 0,   -- sadece istatistik
  active_seconds_total bigint not null default 0
);
create unique index operator_mc_name_uq on public.operator_mc_accounts (lower(mc_name));
create unique index operator_mc_uuid_uq on public.operator_mc_accounts (mc_uuid) where mc_uuid is not null;

-- ---------------------------------------------------------------------
-- Gunluk erisim kodlari: hesap basina, Istanbul takvim gunu basina bir kod
-- id = panelde gosterilen "kod numarasi"
-- ---------------------------------------------------------------------
create table public.daily_codes (
  id            bigint generated always as identity primary key,
  mc_account_id uuid not null references public.mc_accounts(id) on delete cascade,
  day           date not null,
  code          text not null,
  created_at    timestamptz not null default now(),
  use_count     int not null default 0,
  last_used_at  timestamptz,
  unique (mc_account_id, day)
);

-- ---------------------------------------------------------------------
-- Bot oturumlari (mod -> sunucu)
-- ---------------------------------------------------------------------
create table public.bot_sessions (
  id                  uuid primary key default gen_random_uuid(),
  mc_account_id       uuid references public.mc_accounts(id) on delete cascade,
  operator_account_id uuid references public.operator_mc_accounts(id) on delete cascade,
  mc_name             text not null,
  mc_uuid             uuid,
  is_exempt           boolean not null,           -- operator hesabi
  daily_code_id       bigint references public.daily_codes(id) on delete set null,
  token_hash          text not null unique,       -- sha256(token); token'in kendisi saklanmaz
  hmac_secret         text not null,              -- istek imzasi icin (sadece servis rolu okur)
  mod_version         text,
  client_ip           text,
  mode                text not null default 'FULL' check (mode in ('FULL', 'PAY_ONLY')),
  running             boolean not null default false,
  started_at          timestamptz not null default now(),
  last_heartbeat_at   timestamptz not null default now(),
  last_seq            bigint not null default 0,
  ended_at            timestamptz,
  end_reason          text,
  check ((mc_account_id is null) <> (operator_account_id is null))
);
create index bot_sessions_account_idx on public.bot_sessions (mc_account_id, started_at desc);
create index bot_sessions_open_idx on public.bot_sessions (last_heartbeat_at) where ended_at is null;

-- ---------------------------------------------------------------------
-- Komisyon pencereleri: AKTIF calisma suresi 3600 sn'ye ulasinca kapanir.
-- Kapanmayan pencere oturumlar arasinda devam eder (50 dk + 10 dk = 60 dk).
-- ---------------------------------------------------------------------
create table public.commission_windows (
  id             bigint generated always as identity primary key,
  mc_account_id  uuid not null references public.mc_accounts(id) on delete cascade,
  window_no      int not null,
  active_seconds int not null default 0,
  profit_start   bigint not null,                -- pencere acilirken profit_total
  profit_end     bigint,                         -- kapanirken profit_total
  profit_delta   bigint,                         -- bu saatte saglanan YENI net kar
  rate           numeric(6,4) not null,          -- 0.4000
  commission     bigint,                         -- floor(max(0, delta) * rate)
  balance_start  bigint,                         -- bakiye-kar tutarlilik kontrolu icin (mod bildirir)
  balance_end    bigint,
  status         text not null default 'OPEN' check (status in ('OPEN', 'CLOSED')),
  opened_at      timestamptz not null default now(),
  closed_at      timestamptz,
  unique (mc_account_id, window_no)
);
create unique index commission_windows_one_open on public.commission_windows (mc_account_id) where status = 'OPEN';

-- ---------------------------------------------------------------------
-- Komisyon borclari (kapanan pencere basina, tutar > 0 ise)
-- ---------------------------------------------------------------------
create table public.commissions (
  id            bigint generated always as identity primary key,
  window_id     bigint not null unique references public.commission_windows(id) on delete cascade,
  mc_account_id uuid not null references public.mc_accounts(id) on delete cascade,
  amount        bigint not null check (amount >= 0),
  paid          bigint not null default 0 check (paid >= 0),   -- iddia edilen + dogrulanan odemeler
  status        text not null default 'PENDING' check (status in ('PENDING', 'PARTIAL', 'PAID', 'WAIVED')),
  created_at    timestamptz not null default now(),
  settled_at    timestamptz
);
create index commissions_open_idx on public.commissions (mc_account_id, created_at) where status in ('PENDING', 'PARTIAL');

-- ---------------------------------------------------------------------
-- Odemeler: mod "/pay gonderdim" der (CLAIMED); alici tarafin "X paid you"
-- mesaji ya da operator onayi ile VERIFIED olur. Reddedilirse dagitim geri alinir.
-- ---------------------------------------------------------------------
create table public.payments (
  id            bigint generated always as identity primary key,
  mc_account_id uuid not null references public.mc_accounts(id) on delete cascade,
  session_id    uuid references public.bot_sessions(id) on delete set null,
  client_tx_id  uuid not null unique,            -- modun urettigi; tekrar gonderimde ikinci kayit olmaz
  to_player     text not null,
  amount        bigint not null check (amount > 0),
  tax           bigint,
  chat_line     text,
  source        text not null default 'MOD' check (source in ('MOD', 'MANUAL')),
  status        text not null default 'CLAIMED' check (status in ('CLAIMED', 'VERIFIED', 'REJECTED')),
  claimed_at    timestamptz not null default now(),
  verified_at   timestamptz,
  verified_by   text,                            -- 'RECEIVER:<mc>' ya da operator id
  unallocated   bigint not null default 0,       -- borctan fazla gonderilen kisim (operator karar verir)
  note          text
);
create index payments_account_idx on public.payments (mc_account_id, claimed_at desc);
create index payments_claimed_idx on public.payments (lower(to_player), claimed_at) where status = 'CLAIMED';

create table public.payment_allocations (
  payment_id    bigint not null references public.payments(id) on delete cascade,
  commission_id bigint not null references public.commissions(id) on delete cascade,
  amount        bigint not null check (amount > 0),
  primary key (payment_id, commission_id)
);

-- Alici (operator) hesabinin gordugu "X paid you $Y" mesajlari
create table public.received_payments (
  id                 bigint generated always as identity primary key,
  receiver_session   uuid references public.bot_sessions(id) on delete set null,
  receiver_mc        text not null,
  from_player        text not null,
  amount             bigint not null check (amount > 0),
  tolerance          bigint not null default 0,
  chat_line          text,
  seen_at            timestamptz not null default now(),
  matched_payment_id bigint references public.payments(id) on delete set null
);
create index received_unmatched_idx on public.received_payments (lower(from_player), seen_at) where matched_payment_id is null;

-- ---------------------------------------------------------------------
-- Ayarlar ve denetim kaydi
-- ---------------------------------------------------------------------
create table public.settings (
  key        text primary key,
  value      jsonb not null,
  updated_at timestamptz not null default now(),
  updated_by uuid references public.profiles(id) on delete set null
);

create table public.audit_log (
  id       bigint generated always as identity primary key,
  actor    text not null,          -- profil id, 'MOD:<mc>', 'SYSTEM'
  action   text not null,
  target   text,
  data     jsonb,
  at       timestamptz not null default now()
);
create index audit_log_at_idx on public.audit_log (at desc);

-- Guvenlik / kurcalama olaylari (sadece operator gorur)
create table public.security_events (
  id                  bigint generated always as identity primary key,
  at                  timestamptz not null default now(),
  kind                text not null,        -- JAR_HASH_MISMATCH, JAVA_AGENT, DEBUGGER, DEV_ENVIRONMENT,
                                            -- BAD_SIGNATURE, SEQ_REGRESSION, BALANCE_PROFIT_MISMATCH, CLIENT_REPORT ...
  severity            text not null check (severity in ('INFO', 'WARN', 'CRITICAL')),
  session_id          uuid references public.bot_sessions(id) on delete set null,
  mc_account_id       uuid references public.mc_accounts(id) on delete cascade,
  operator_account_id uuid references public.operator_mc_accounts(id) on delete cascade,
  owner_id            uuid references public.profiles(id) on delete set null,
  mc_name             text,
  daily_code_id       bigint references public.daily_codes(id) on delete set null,
  action_taken        text,                 -- LOGGED / PAY_ONLY / BLOCKED
  detail              jsonb
);
create index security_events_at_idx on public.security_events (at desc);
create index security_events_account_idx on public.security_events (mc_account_id, at desc);

-- Mod oturum acarken Mojang dogrulamasi (hesap sahipligi) icin tek kullanimlik meydan okuma
create table public.mod_challenges (
  server_id  text primary key,
  mc_name    text not null,
  created_at timestamptz not null default now(),
  used_at    timestamptz
);

insert into public.settings (key, value) values
  ('commission_rate',        '0.40'),          -- %40
  ('window_seconds',         '3600'),          -- 60 dk aktif calisma
  ('heartbeat_max_gap_sec',  '90'),            -- iki heartbeat arasi en fazla bu kadar sayilir
  ('heartbeat_min_interval', '5'),             -- bundan sik heartbeat reddedilir
  ('session_timeout_sec',    '180'),           -- bu kadar heartbeat gelmezse oturum duser
  ('commission_receiver',    '""'),            -- komisyonun /pay ile gonderilecegi operator MC adi
  ('commission_grace_min',   '120'),           -- odenmeyen komisyon bu sureyi asinca PAY_ONLY
  ('payment_match_window_min','15'),           -- gonderen/alici mesaj eslestirme penceresi
  ('min_mod_version',        '"0.7.0"'),
  ('require_mojang_auth',    'true'),          -- mod hesabin gercek sahibi mi (Mojang hasJoined)
  ('allowed_mod_hashes',     '[]'),            -- izinli AutoSeller jar SHA-256 listesi; bos = kontrol yok
  ('tamper_action',          '"LOG"'),         -- kritik kurcalamada: LOG | PAY_ONLY | BLOCK
  ('balance_mismatch_min',   '5000000');       -- saatlik aciklanamayan bakiye artisi bu tutari asarsa uyari
