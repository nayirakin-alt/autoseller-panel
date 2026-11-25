-- =====================================================================
-- AutoSeller Panel - 0005: Rutbeler, rutbe siparisleri, odeme talepleri,
--                    kazanc kayitlari (saatlik/gunluk), izole sifirlama,
--                    operator hesabi log duzeltmesi
--
-- Tekrar calistirilabilir (idempotent): IF NOT EXISTS / ON CONFLICT / DROP ... IF EXISTS / CREATE OR REPLACE.
-- Geri uyumlu: 0001-0004 uzerine calistirilir. Mevcut tablolara sadece NULL olabilen
-- sutun eklenir; mod uclari (mod_*) ve imzalari DEGISMEZ. Mod koduna dokunulmaz.
--
-- Degisen mevcut fonksiyonlar (ayni imza, create or replace):
--   _open_window          : pencere orani artik kullanicinin RUTBESINDEN gelir (Bronze %50 ...)
--   _try_match            : rutbe/talep odemesine eslesmis gelen odemeyi komisyona tekrar eslestirmez
--   security_log          : operator hesaplari log uretmez (ayarla acilabilir), 30 dk tekrar bastirma
--   expire_stale_sessions : ek olarak rutbe/talep odemelerini eslestirir, suresi dolan siparisleri kapatir
-- =====================================================================

-- ---------------------------------------------------------------- rutbeler
create table if not exists public.ranks (
  code            text primary key,
  name            text not null,
  sort            int not null unique,            -- buyuk = daha iyi rutbe
  commission_rate numeric(5,4) not null check (commission_rate >= 0 and commission_rate <= 1),
  weekly_price    bigint not null check (weekly_price >= 0),
  color           text,
  updated_at      timestamptz not null default now()
);
insert into public.ranks (code, name, sort, commission_rate, weekly_price, color) values
  ('BRONZE',  'Bronze',  0, 0.50,           0, '#cd7f32'),
  ('GOLD',    'Gold',    1, 0.40,  80000000, '#f5c542'),
  ('DIAMOND', 'Diamond', 2, 0.30, 150000000, '#5ad1e6'),
  ('AMETIS',  'Ametis',  3, 0.25, 200000000, '#a77bf3')
on conflict (code) do nothing;

-- Rutbe sureleri (satin alma, yukseltme, hediye). Aktif rutbe = su an gecerli en yuksek sort.
create table if not exists public.rank_grants (
  id          bigint generated always as identity primary key,
  user_id     uuid not null references public.profiles(id) on delete cascade,
  rank_code   text not null references public.ranks(code),
  source      text not null check (source in ('PURCHASE', 'UPGRADE', 'GIFT')),
  starts_at   timestamptz not null,
  ends_at     timestamptz not null check (ends_at > starts_at),
  price       bigint not null default 0,           -- odenen tutar (hediye = 0)
  order_id    bigint,
  status      text not null default 'ACTIVE' check (status in ('ACTIVE', 'SUPERSEDED', 'REVOKED')),
  created_by  uuid references public.profiles(id) on delete set null,
  note        text,
  created_at  timestamptz not null default now()
);
create index if not exists rank_grants_user_idx on public.rank_grants (user_id, status, ends_at desc);

-- Rutbe siparisleri: komisyon borcu / odemeleriyle KARISMAZ (ayri tablo, ayri eslestirme)
create table if not exists public.rank_orders (
  id               bigint generated always as identity primary key,
  user_id          uuid not null references public.profiles(id) on delete cascade,
  kind             text not null check (kind in ('PURCHASE', 'EXTEND', 'UPGRADE')),
  rank_code        text not null references public.ranks(code),
  from_rank_code   text references public.ranks(code),
  weeks            int not null default 0 check (weeks between 0 and 52),
  amount           bigint not null check (amount > 0),
  quote            jsonb not null,                 -- siparis anindaki hesap dokumu
  pay_to           text not null,                  -- kasa hesabi (siparis aninda)
  status           text not null default 'PENDING' check (status in ('PENDING', 'PAID', 'CANCELLED', 'EXPIRED')),
  created_at       timestamptz not null default now(),
  expires_at       timestamptz not null,
  paid_at          timestamptz,
  paid_via         text,                           -- 'RECEIVER:<kasa>' | 'OPERATOR:<id>'
  received_id      bigint references public.received_payments(id) on delete set null,
  grant_id         bigint references public.rank_grants(id) on delete set null,
  note             text
);
create index if not exists rank_orders_user_idx on public.rank_orders (user_id, created_at desc);
create index if not exists rank_orders_pending_idx on public.rank_orders (status) where status = 'PENDING';
alter table public.rank_grants drop constraint if exists rank_grants_order_fk;
alter table public.rank_grants add constraint rank_grants_order_fk
  foreign key (order_id) references public.rank_orders(id) on delete set null;

-- Operatorun kullaniciya gonderdigi odeme talepleri (kasa hesabina gonderilecek tutar)
create table if not exists public.payment_requests (
  id              bigint generated always as identity primary key,
  user_id         uuid not null references public.profiles(id) on delete cascade,
  mc_account_id   uuid references public.mc_accounts(id) on delete set null,
  amount          bigint not null check (amount > 0),
  pay_to          text not null,
  note            text,
  status          text not null default 'OPEN' check (status in ('OPEN', 'PAID', 'CANCELLED')),
  created_by      uuid references public.profiles(id) on delete set null,
  created_at      timestamptz not null default now(),
  due_at          timestamptz,
  paid_at         timestamptz,
  paid_via        text,
  received_id     bigint references public.received_payments(id) on delete set null,
  resolved_by     uuid references public.profiles(id) on delete set null,
  resolution_note text
);
create index if not exists payment_requests_user_idx on public.payment_requests (user_id, created_at desc);

-- Kasada gorulen odeme hangi kayda eslesti (komisyon odemesi = matched_payment_id, 0001)
alter table public.received_payments add column if not exists matched_rank_order_id bigint
  references public.rank_orders(id) on delete set null;
alter table public.received_payments add column if not exists matched_request_id bigint
  references public.payment_requests(id) on delete set null;

-- ---------------------------------------------------------------- kazanc kayitlari
-- Her heartbeat'teki kar degisimi (mod koduna dokunmadan, tetikleyiciyle). Mod urun adi /
-- birim fiyat bildirmedigi icin kayit "hangi hesap, ne zaman, ne kadar net kar" seviyesindedir.
create table if not exists public.profit_events (
  id                  bigint generated always as identity primary key,
  at                  timestamptz not null,
  mc_account_id       uuid references public.mc_accounts(id) on delete cascade,
  operator_account_id uuid references public.operator_mc_accounts(id) on delete cascade,
  delta               bigint not null,
  balance             bigint,
  check ((mc_account_id is null) <> (operator_account_id is null))
);
create index if not exists profit_events_acc_idx on public.profit_events (mc_account_id, at desc);
create index if not exists profit_events_op_idx on public.profit_events (operator_account_id, at desc);
create index if not exists profit_events_at_idx on public.profit_events (at desc);

create or replace function public._log_profit_event() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.profit_total is distinct from old.profit_total then
    if tg_table_name = 'mc_accounts' then
      insert into public.profit_events (at, mc_account_id, delta, balance)
      values (coalesce(new.last_seen_at, now()), new.id, new.profit_total - old.profit_total, new.last_balance);
    else
      insert into public.profit_events (at, operator_account_id, delta)
      values (coalesce(new.last_seen_at, now()), new.id, new.profit_total - old.profit_total);
    end if;
  end if;
  return new;
end $$;
drop trigger if exists mc_accounts_profit_event on public.mc_accounts;
create trigger mc_accounts_profit_event after update of profit_total on public.mc_accounts
  for each row execute function public._log_profit_event();
drop trigger if exists operator_accounts_profit_event on public.operator_mc_accounts;
create trigger operator_accounts_profit_event after update of profit_total on public.operator_mc_accounts
  for each row execute function public._log_profit_event();

-- Izole sifirlama: her goruntuleyen (uye ya da tek tek operator) kendi sifirlama noktasini tutar.
-- Hicbir kayit silinmez; sadece o kisinin gorunumu o andan itibaren hesaplanir.
--   scope MEMBER   : uyenin kendi paneli      scope OPERATOR : operatorun paneli
--   kind  STATS    : satis/islem kayitlari + toplamlar + son 1 saat
--   kind  EARNINGS : saatlik / gunluk kazanc notu
--   target         : '*' (tum hesaplar) ya da hesap id'si
create table if not exists public.view_resets (
  viewer_id uuid not null references public.profiles(id) on delete cascade,
  scope     text not null check (scope in ('MEMBER', 'OPERATOR')),
  kind      text not null check (kind in ('STATS', 'EARNINGS')),
  target    text not null default '*',
  reset_at  timestamptz not null,
  primary key (viewer_id, scope, kind, target)
);

insert into public.settings (key, value) values
  ('rank_order_ttl_min',     '360'),     -- rutbe siparisi odenmezse kac dk sonra duser
  ('log_operator_accounts',  'false'),   -- operator MC hesaplari guvenlik logu uretsin mi
  ('security_dedupe_min',    '30')       -- ayni oturum + ayni tur olay bu sure icinde tekrar yazilmaz
on conflict (key) do nothing;

-- ---------------------------------------------------------------- rutbe motoru

create or replace function public._rank_code_at(p_user uuid, p_at timestamptz)
returns text language sql stable as $$
  select coalesce((
    select g.rank_code from public.rank_grants g join public.ranks r on r.code = g.rank_code
     where g.user_id = p_user and g.status = 'ACTIVE' and g.starts_at <= p_at and g.ends_at > p_at
     order by r.sort desc, g.ends_at desc limit 1), 'BRONZE')
$$;

create or replace function public.user_commission_rate(p_user uuid, p_at timestamptz default null)
returns numeric language sql stable as $$
  select commission_rate from public.ranks where code = public._rank_code_at(p_user, coalesce(p_at, now()))
$$;

-- 0002'deki _open_window ile ayni; tek fark oran = hesap sahibinin o anki rutbe orani.
create or replace function public._open_window(p_account uuid, p_now timestamptz)
returns public.commission_windows language plpgsql as $$
declare
  w public.commission_windows;
  v_total bigint;
  v_owner uuid;
begin
  select * into w from public.commission_windows
   where mc_account_id = p_account and status = 'OPEN' for update;
  if found then return w; end if;

  select profit_total, owner_id into v_total, v_owner from public.mc_accounts where id = p_account;
  insert into public.commission_windows (mc_account_id, window_no, profit_start, rate, opened_at, balance_start)
  values (p_account,
          coalesce((select max(window_no) from public.commission_windows where mc_account_id = p_account), 0) + 1,
          v_total, public.user_commission_rate(v_owner, p_now), p_now,
          (select last_balance from public.mc_accounts where id = p_account))
  returning * into w;
  return w;
end $$;

-- Rutbe yukselince acik saatlik pencerenin orani hemen dusurulur (yukselmez: o saat kullanici lehine).
create or replace function public._refresh_open_rates(p_user uuid, p_now timestamptz)
returns void language sql as $$
  update public.commission_windows w
     set rate = least(w.rate, public.user_commission_rate(p_user, p_now))
    from public.mc_accounts a
   where a.id = w.mc_account_id and a.owner_id = p_user and w.status = 'OPEN';
$$;

-- Fiyat teklifi. Kurallar:
--   PURCHASE : Bronze'dayken (ya da sadece hediye rutbesi varken) yeni rutbe; hafta x haftalik ucret.
--              Hedef rutbe mevcut aktif rutbeden dusukse, ustteki rutbe bitince baslar (sira).
--   EXTEND   : ayni rutbe; mevcut surenin sonuna eklenir.
--   UPGRADE  : odenmis daha dusuk rutbe aktifken daha yukseginine gecis. Kalan sure boyunca
--              fark = (yeni haftalik - eski haftalik) x kalan_sn / 604800 (yukari yuvarlanir);
--              istege bagli ek hafta x yeni haftalik. Bitis tarihi korunur (+ ek haftalar).
create or replace function public.rank_quote(p_user uuid, p_rank text, p_weeks int, p_now timestamptz default null)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  v_now timestamptz := coalesce(p_now, now());
  cur public.ranks;
  tgt public.ranks;
  v_paid_end timestamptz;
  v_same_end timestamptz;
  v_higher_end timestamptz;
  v_week constant numeric := 604800;
  v_rem numeric;
  v_cur_val bigint; v_tgt_val bigint; v_diff bigint;
  v_amount bigint;
  v_start timestamptz; v_end timestamptz;
  v_weeks int := coalesce(p_weeks, 0);
begin
  select * into cur from public.ranks where code = public._rank_code_at(p_user, v_now);
  select * into tgt from public.ranks where code = upper(p_rank);
  if not found or tgt.weekly_price <= 0 then
    return jsonb_build_object('ok', false, 'reason', 'INVALID_RANK');
  end if;
  if v_weeks < 0 or v_weeks > 52 then return jsonb_build_object('ok', false, 'reason', 'INVALID_WEEKS'); end if;

  select max(ends_at) into v_paid_end from public.rank_grants
   where user_id = p_user and status = 'ACTIVE' and rank_code = cur.code
     and source in ('PURCHASE', 'UPGRADE') and ends_at > v_now;

  if tgt.sort > cur.sort and cur.code <> 'BRONZE' and v_paid_end is not null then
    v_rem := extract(epoch from (v_paid_end - v_now));
    v_cur_val := ceil(cur.weekly_price * v_rem / v_week);
    v_tgt_val := ceil(tgt.weekly_price * v_rem / v_week);
    v_diff := v_tgt_val - v_cur_val;
    v_amount := v_diff + v_weeks * tgt.weekly_price;
    v_start := v_now;
    v_end := v_paid_end + make_interval(secs => v_weeks * v_week);
    return jsonb_build_object('ok', true, 'kind', 'UPGRADE', 'rank', tgt.code, 'from_rank', cur.code,
      'weeks', v_weeks, 'amount', v_amount, 'remaining_seconds', floor(v_rem),
      'current_remaining_value', v_cur_val, 'target_value_for_remaining', v_tgt_val, 'difference', v_diff,
      'extra_weeks_price', v_weeks * tgt.weekly_price,
      'starts_at', v_start, 'ends_at', v_end, 'commission_rate', tgt.commission_rate);
  end if;

  if v_weeks < 1 then return jsonb_build_object('ok', false, 'reason', 'INVALID_WEEKS'); end if;
  v_amount := v_weeks * tgt.weekly_price;

  if tgt.code = cur.code then
    select max(ends_at) into v_same_end from public.rank_grants
     where user_id = p_user and status = 'ACTIVE' and rank_code = tgt.code and ends_at > v_now;
    v_start := greatest(v_now, coalesce(v_same_end, v_now));
    v_end := v_start + make_interval(secs => v_weeks * v_week);
    return jsonb_build_object('ok', true, 'kind', 'EXTEND', 'rank', tgt.code, 'from_rank', cur.code,
      'weeks', v_weeks, 'amount', v_amount, 'starts_at', v_start, 'ends_at', v_end,
      'commission_rate', tgt.commission_rate);
  end if;

  -- yeni rutbe; daha yuksek bir rutbe aktifse onun bitisinden sonra baslar
  select max(g.ends_at) into v_higher_end from public.rank_grants g join public.ranks r on r.code = g.rank_code
   where g.user_id = p_user and g.status = 'ACTIVE' and r.sort > tgt.sort and g.ends_at > v_now;
  v_start := greatest(v_now, coalesce(v_higher_end, v_now));
  select greatest(v_start, coalesce(max(ends_at), v_start)) into v_start from public.rank_grants
   where user_id = p_user and status = 'ACTIVE' and rank_code = tgt.code and ends_at > v_now;
  v_end := v_start + make_interval(secs => v_weeks * v_week);
  return jsonb_build_object('ok', true, 'kind', 'PURCHASE', 'rank', tgt.code, 'from_rank', cur.code,
    'weeks', v_weeks, 'amount', v_amount, 'starts_at', v_start, 'ends_at', v_end,
    'queued', v_start > v_now, 'commission_rate', tgt.commission_rate);
end $$;

-- Uye: siparis olustur (onceki bekleyen siparisi iptal eder). Odeme oyunda /pay <kasa> <tutar>.
create or replace function public.member_create_rank_order(p_user uuid, p_rank text, p_weeks int, p_now timestamptz default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_now timestamptz := coalesce(p_now, now());
  q jsonb;
  v_receiver text := public.setting_text('commission_receiver');
  v_id bigint;
begin
  if (select status from public.profiles where id = p_user) is distinct from 'ACTIVE' then
    raise exception 'USER_NOT_ACTIVE';
  end if;
  if v_receiver is null or v_receiver = '' then raise exception 'NO_RECEIVER: operatör kasa hesabı seçmemiş'; end if;
  q := public.rank_quote(p_user, p_rank, p_weeks, v_now);
  if not (q ->> 'ok')::boolean then raise exception '%', q ->> 'reason'; end if;
  if (q ->> 'amount')::bigint <= 0 then raise exception 'NOTHING_TO_PAY'; end if;
  update public.rank_orders set status = 'CANCELLED', note = 'yeni sipariş verildi'
   where user_id = p_user and status = 'PENDING';
  insert into public.rank_orders (user_id, kind, rank_code, from_rank_code, weeks, amount, quote, pay_to,
                                  created_at, expires_at)
  values (p_user, q ->> 'kind', q ->> 'rank', q ->> 'from_rank', (q ->> 'weeks')::int, (q ->> 'amount')::bigint,
          q, v_receiver, v_now, v_now + make_interval(mins => coalesce(public.setting_num('rank_order_ttl_min'), 360)::int))
  returning id into v_id;
  perform public._audit(p_user::text, 'rank_order', v_id::text, q);
  return (select to_jsonb(o) from public.rank_orders o where id = v_id);
end $$;

create or replace function public.member_cancel_rank_order(p_user uuid, p_order bigint)
returns void language plpgsql security definer set search_path = public as $$
begin
  update public.rank_orders set status = 'CANCELLED', note = 'kullanıcı iptal etti'
   where id = p_order and user_id = p_user and status = 'PENDING';
  if not found then raise exception 'ORDER_NOT_PENDING'; end if;
end $$;

-- Odenen siparisi rutbeye cevir (tutar siparisteki gibi; sure odeme anina gore hesaplanir)
create or replace function public._activate_rank_order(p_order bigint, p_now timestamptz, p_via text, p_received bigint)
returns bigint language plpgsql as $$
declare
  o public.rank_orders;
  tgt public.ranks;
  v_week constant numeric := 604800;
  v_old_end timestamptz;
  v_start timestamptz;
  v_end timestamptz;
  v_higher_end timestamptz;
  v_gid bigint;
begin
  select * into o from public.rank_orders where id = p_order for update;
  if o.status <> 'PENDING' then return null; end if;
  select * into tgt from public.ranks where code = o.rank_code;

  if o.kind = 'UPGRADE' then
    select max(ends_at) into v_old_end from public.rank_grants
     where user_id = o.user_id and status = 'ACTIVE' and rank_code = o.from_rank_code
       and source in ('PURCHASE', 'UPGRADE') and ends_at > p_now;
    -- eski rutbenin odenmis sureleri bu andan itibaren yeni rutbeye donusur
    update public.rank_grants set status = 'SUPERSEDED'
     where user_id = o.user_id and status = 'ACTIVE' and rank_code = o.from_rank_code
       and source in ('PURCHASE', 'UPGRADE') and starts_at >= p_now;
    update public.rank_grants set ends_at = p_now, status = 'SUPERSEDED'
     where user_id = o.user_id and status = 'ACTIVE' and rank_code = o.from_rank_code
       and source in ('PURCHASE', 'UPGRADE') and starts_at < p_now and ends_at > p_now;
    v_start := p_now;
    v_end := greatest(coalesce(v_old_end, p_now), p_now) + make_interval(secs => o.weeks * v_week);
    if v_end <= v_start then v_end := v_start + interval '1 minute'; end if;
  elsif o.kind = 'EXTEND' then
    select greatest(p_now, coalesce(max(ends_at), p_now)) into v_start from public.rank_grants
     where user_id = o.user_id and status = 'ACTIVE' and rank_code = o.rank_code and ends_at > p_now;
    v_end := v_start + make_interval(secs => o.weeks * v_week);
  else
    select max(g.ends_at) into v_higher_end from public.rank_grants g join public.ranks r on r.code = g.rank_code
     where g.user_id = o.user_id and g.status = 'ACTIVE' and r.sort > tgt.sort and g.ends_at > p_now;
    v_start := greatest(p_now, coalesce(v_higher_end, p_now));
    select greatest(v_start, coalesce(max(ends_at), v_start)) into v_start from public.rank_grants
     where user_id = o.user_id and status = 'ACTIVE' and rank_code = o.rank_code and ends_at > p_now;
    v_end := v_start + make_interval(secs => o.weeks * v_week);
  end if;

  insert into public.rank_grants (user_id, rank_code, source, starts_at, ends_at, price, order_id, note, created_at)
  values (o.user_id, o.rank_code, case when o.kind = 'UPGRADE' then 'UPGRADE' else 'PURCHASE' end,
          v_start, v_end, o.amount, o.id, o.kind, p_now)
  returning id into v_gid;
  update public.rank_orders set status = 'PAID', paid_at = p_now, paid_via = p_via,
                                received_id = p_received, grant_id = v_gid
   where id = o.id;
  perform public._refresh_open_rates(o.user_id, p_now);
  perform public._audit(p_via, 'rank_order_paid', o.id::text,
                        jsonb_build_object('grant', v_gid, 'rank', o.rank_code, 'starts_at', v_start, 'ends_at', v_end));
  return v_gid;
end $$;

-- Operator: siparisi elle "odendi" isaretle (kasayi kendisi kontrol etti)
create or replace function public.admin_rank_order_paid(p_actor uuid, p_order bigint, p_note text, p_now timestamptz default null)
returns bigint language plpgsql security definer set search_path = public as $$
declare v_gid bigint;
begin
  perform public._require_operator(p_actor);
  update public.rank_orders set note = p_note where id = p_order and status in ('PENDING', 'EXPIRED');
  update public.rank_orders set status = 'PENDING' where id = p_order and status = 'EXPIRED';
  v_gid := public._activate_rank_order(p_order, coalesce(p_now, now()), 'OPERATOR:' || p_actor, null);
  if v_gid is null then raise exception 'ORDER_NOT_PENDING'; end if;
  return v_gid;
end $$;

create or replace function public.admin_rank_order_cancel(p_actor uuid, p_order bigint, p_note text)
returns void language plpgsql security definer set search_path = public as $$
begin
  perform public._require_operator(p_actor);
  update public.rank_orders set status = 'CANCELLED', note = coalesce(p_note, 'operatör iptal etti')
   where id = p_order and status = 'PENDING';
  if not found then raise exception 'ORDER_NOT_PENDING'; end if;
  perform public._audit(p_actor::text, 'rank_order_cancel', p_order::text, null);
end $$;

-- Operator: ucretsiz rutbe hediye et (saat / gun / hafta / ozel saniye). Ayni rutbe aktifse sonuna eklenir.
create or replace function public.admin_gift_rank(p_actor uuid, p_user uuid, p_rank text, p_seconds int, p_note text,
                                                  p_now timestamptz default null)
returns bigint language plpgsql security definer set search_path = public as $$
declare
  v_now timestamptz := coalesce(p_now, now());
  v_start timestamptz;
  v_id bigint;
begin
  perform public._require_operator(p_actor);
  if not exists (select 1 from public.ranks where code = upper(p_rank) and code <> 'BRONZE') then
    raise exception 'INVALID_RANK';
  end if;
  if p_seconds is null or p_seconds < 60 or p_seconds > 366 * 86400 then raise exception 'INVALID_DURATION'; end if;
  if not exists (select 1 from public.profiles where id = p_user) then raise exception 'UNKNOWN_USER'; end if;
  select greatest(v_now, coalesce(max(ends_at), v_now)) into v_start from public.rank_grants
   where user_id = p_user and status = 'ACTIVE' and rank_code = upper(p_rank) and ends_at > v_now;
  insert into public.rank_grants (user_id, rank_code, source, starts_at, ends_at, price, created_by, note, created_at)
  values (p_user, upper(p_rank), 'GIFT', v_start, v_start + make_interval(secs => p_seconds), 0, p_actor, p_note, v_now)
  returning id into v_id;
  perform public._refresh_open_rates(p_user, v_now);
  perform public._audit(p_actor::text, 'rank_gift', p_user::text,
                        jsonb_build_object('rank', upper(p_rank), 'seconds', p_seconds, 'grant', v_id));
  return v_id;
end $$;

create or replace function public.admin_revoke_rank_grant(p_actor uuid, p_grant bigint, p_note text)
returns void language plpgsql security definer set search_path = public as $$
begin
  perform public._require_operator(p_actor);
  update public.rank_grants set status = 'REVOKED', ends_at = greatest(starts_at + interval '1 second', least(ends_at, now())),
                                note = coalesce(note || ' | ', '') || coalesce('iptal: ' || p_note, 'iptal')
   where id = p_grant and status = 'ACTIVE';
  if not found then raise exception 'GRANT_NOT_ACTIVE'; end if;
  perform public._audit(p_actor::text, 'rank_revoke', p_grant::text, null);
end $$;

-- Operator: rutbe orani / haftalik ucret degistir (Bronze ucreti 0 kalir)
create or replace function public.admin_set_rank(p_actor uuid, p_code text, p_rate numeric, p_weekly bigint)
returns void language plpgsql security definer set search_path = public as $$
begin
  perform public._require_operator(p_actor);
  if p_rate < 0 or p_rate > 1 then raise exception 'INVALID_VALUE: oran 0..1'; end if;
  if p_weekly < 0 or (upper(p_code) = 'BRONZE' and p_weekly <> 0) then raise exception 'INVALID_VALUE: ücret'; end if;
  update public.ranks set commission_rate = p_rate, weekly_price = p_weekly, updated_at = now() where code = upper(p_code);
  if not found then raise exception 'INVALID_RANK'; end if;
  perform public._audit(p_actor::text, 'rank_set', upper(p_code), jsonb_build_object('rate', p_rate, 'weekly', p_weekly));
end $$;

-- ---------------------------------------------------------------- odeme talepleri

create or replace function public.admin_create_payment_request(p_actor uuid, p_user uuid, p_account uuid,
                                                               p_amount bigint, p_note text, p_due timestamptz)
returns bigint language plpgsql security definer set search_path = public as $$
declare
  v_receiver text := public.setting_text('commission_receiver');
  v_id bigint;
begin
  perform public._require_operator(p_actor);
  if v_receiver is null or v_receiver = '' then raise exception 'NO_RECEIVER: önce kasa hesabını seç'; end if;
  if p_amount is null or p_amount <= 0 then raise exception 'INVALID_AMOUNT'; end if;
  if not exists (select 1 from public.profiles where id = p_user) then raise exception 'UNKNOWN_USER'; end if;
  if p_account is not null and not exists (select 1 from public.mc_accounts where id = p_account and owner_id = p_user) then
    raise exception 'ACCOUNT_NOT_OWNED';
  end if;
  insert into public.payment_requests (user_id, mc_account_id, amount, pay_to, note, created_by, due_at)
  values (p_user, p_account, p_amount, v_receiver, left(p_note, 500), p_actor, p_due)
  returning id into v_id;
  perform public._audit(p_actor::text, 'payment_request', v_id::text, jsonb_build_object('user', p_user, 'amount', p_amount));
  return v_id;
end $$;

create or replace function public.admin_resolve_payment_request(p_actor uuid, p_request bigint, p_status text, p_note text)
returns void language plpgsql security definer set search_path = public as $$
begin
  perform public._require_operator(p_actor);
  if p_status not in ('PAID', 'CANCELLED') then raise exception 'INVALID_STATUS'; end if;
  update public.payment_requests
     set status = p_status, resolved_by = p_actor, resolution_note = p_note,
         paid_at = case when p_status = 'PAID' then now() else null end,
         paid_via = case when p_status = 'PAID' then 'OPERATOR:' || p_actor else null end
   where id = p_request and status = 'OPEN';
  if not found then raise exception 'REQUEST_NOT_OPEN'; end if;
  perform public._audit(p_actor::text, 'payment_request_' || lower(p_status), p_request::text, null);
end $$;

-- ---------------------------------------------------------------- kasa eslestirmesi (rutbe + talep)

-- 0002'deki _try_match + rutbe/talebe eslesmis gelen odemeyi kullanmama sarti
create or replace function public._try_match(p_payment bigint) returns boolean
language plpgsql as $$
declare
  p public.payments;
  a public.mc_accounts;
  r public.received_payments;
  v_win interval := make_interval(mins => public.setting_num('payment_match_window_min')::int);
begin
  select * into p from public.payments where id = p_payment for update;
  if p.status <> 'CLAIMED' then return false; end if;
  select * into a from public.mc_accounts where id = p.mc_account_id;
  select * into r from public.received_payments
   where matched_payment_id is null and matched_rank_order_id is null and matched_request_id is null
     and lower(from_player) = lower(a.mc_name)
     and lower(receiver_mc) = lower(p.to_player)
     and abs(amount - p.amount) <= greatest(tolerance, 1)
     and seen_at between p.claimed_at - v_win and p.claimed_at + v_win
   order by abs(extract(epoch from (seen_at - p.claimed_at))) limit 1 for update;
  if not found then return false; end if;
  update public.received_payments set matched_payment_id = p.id where id = r.id;
  update public.payments set status = 'VERIFIED', verified_at = r.seen_at, verified_by = 'RECEIVER:' || r.receiver_mc
   where id = p.id;
  return true;
end $$;

-- Kasada gorulup komisyona eslesmeyen odemeleri (en az 2 dk bekletilir ki modun komisyon
-- bildirimi once gelsin) bekleyen rutbe siparisine, yoksa acik odeme talebine eslestirir.
-- Gonderen MC hesabi siparis/talep sahibinin hesaplarindan biri olmali.
create or replace function public.match_extra_payments(p_now timestamptz default null)
returns int language plpgsql security definer set search_path = public as $$
declare
  v_now timestamptz := coalesce(p_now, now());
  r record;
  o public.rank_orders;
  pr public.payment_requests;
  v_owner uuid;
  v_acc uuid;
  n int := 0;
  v_win interval := make_interval(mins => public.setting_num('payment_match_window_min')::int);
begin
  for r in select * from public.received_payments
            where matched_payment_id is null and matched_rank_order_id is null and matched_request_id is null
              and seen_at <= v_now - interval '2 minutes' and seen_at > v_now - interval '3 days'
            order by seen_at for update skip locked loop
    v_acc := null; v_owner := null;
    select id, owner_id into v_acc, v_owner from public.mc_accounts where lower(mc_name) = lower(r.from_player);
    continue when v_owner is null;
    -- ayni tutarda bekleyen komisyon odemesi iddiasi varsa ona birak
    continue when exists (select 1 from public.payments p
                           where p.mc_account_id = v_acc and p.status = 'CLAIMED'
                             and abs(p.amount - r.amount) <= greatest(r.tolerance, 1)
                             and p.claimed_at between r.seen_at - v_win and r.seen_at + v_win);

    select * into o from public.rank_orders
     where user_id = v_owner and status = 'PENDING' and lower(pay_to) = lower(r.receiver_mc)
       and r.amount >= amount - greatest(r.tolerance, 1)
       and r.seen_at between created_at - interval '5 minutes' and expires_at
     order by created_at limit 1 for update;
    if found then
      update public.received_payments set matched_rank_order_id = o.id where id = r.id;
      perform public._activate_rank_order(o.id, v_now, 'RECEIVER:' || r.receiver_mc, r.id);
      n := n + 1;
      continue;
    end if;

    select * into pr from public.payment_requests
     where user_id = v_owner and status = 'OPEN' and lower(pay_to) = lower(r.receiver_mc)
       and (mc_account_id is null or mc_account_id = v_acc)
       and r.amount >= amount - greatest(r.tolerance, 1)
       and r.seen_at >= created_at - interval '5 minutes'
     order by created_at limit 1 for update;
    if found then
      update public.received_payments set matched_request_id = pr.id where id = r.id;
      update public.payment_requests set status = 'PAID', paid_at = r.seen_at, paid_via = 'RECEIVER:' || r.receiver_mc,
                                         received_id = r.id
       where id = pr.id;
      perform public._audit('RECEIVER:' || r.receiver_mc, 'payment_request_paid', pr.id::text,
                            jsonb_build_object('received', r.id, 'amount', r.amount));
      n := n + 1;
    end if;
  end loop;

  update public.rank_orders set status = 'EXPIRED' where status = 'PENDING' and expires_at < v_now;
  return n;
end $$;

-- Cron (her dakika): 0002'deki oturum kapatma + ek eslestirme. Ek is hata verse de oturum kapatma etkilenmez.
create or replace function public.expire_stale_sessions() returns int
language plpgsql security definer set search_path = public as $$
declare n int;
begin
  update public.bot_sessions set ended_at = now(), end_reason = 'TIMEOUT', running = false
   where ended_at is null and last_heartbeat_at < now() - make_interval(secs => public.setting_num('session_timeout_sec'));
  get diagnostics n = row_count;
  begin
    perform public.match_extra_payments(now());
  exception when others then
    raise warning 'match_extra_payments: %', sqlerrm;
  end;
  return n;
end $$;

-- ---------------------------------------------------------------- guvenlik logu duzeltmesi

-- 0004'teki security_log ile ayni davranis + iki duzeltme:
--   1) Operator MC hesaplari (muaf oturumlar) log uretmez (ayar log_operator_accounts=true ile acilir).
--      Operatorun kendi gelistirme/test kurulumu yuzunden JAR/agent/INTEGRITY_OK gurultusu biter.
--   2) Ayni oturum + ayni tur olay security_dedupe_min (30 dk) icinde bir kez yazilir
--      (5 dk'lik butunluk raporu ayni bulguyu tekrar tekrar yazmasin). Eylem (PAY_ONLY/BLOCK) yine uygulanir.
create or replace function public.security_log(p_session uuid, p_token_hash text, p_kind text, p_severity text, p_detail jsonb)
returns text language plpgsql security definer set search_path = public as $$
declare
  s public.bot_sessions;
  v_owner uuid;
  v_action text := 'LOGGED';
  v_mode text := public.setting_text('tamper_action');
begin
  if p_session is not null then
    select * into s from public.bot_sessions where id = p_session;
  elsif p_token_hash is not null then
    select * into s from public.bot_sessions where token_hash = p_token_hash;
  end if;

  if s.is_exempt and coalesce(public.setting_text('log_operator_accounts'), 'false') <> 'true' then
    return 'SKIPPED';
  end if;

  if s.mc_account_id is not null then
    select owner_id into v_owner from public.mc_accounts where id = s.mc_account_id;
  end if;

  if p_severity = 'CRITICAL' and s.mc_account_id is not null then
    if v_mode = 'BLOCK' then
      update public.mc_accounts set access_enabled = false, blocked_reason = 'Kurcalama tespit edildi: ' || p_kind,
                                    tamper_flag = true, tamper_reason = p_kind
       where id = s.mc_account_id;
      update public.bot_sessions set ended_at = now(), end_reason = 'TAMPER_BLOCK', running = false
       where mc_account_id = s.mc_account_id and ended_at is null;
      v_action := 'BLOCKED';
    elsif v_mode = 'PAY_ONLY' then
      update public.mc_accounts set tamper_flag = true, tamper_reason = p_kind where id = s.mc_account_id;
      v_action := 'PAY_ONLY';
    end if;
  end if;

  if s.id is not null and exists (
       select 1 from public.security_events e
        where e.session_id = s.id and e.kind = p_kind
          and e.at > now() - make_interval(mins => coalesce(public.setting_num('security_dedupe_min'), 30)::int)) then
    return case when v_action = 'LOGGED' then 'DUPLICATE' else v_action end;
  end if;

  insert into public.security_events (kind, severity, session_id, mc_account_id, operator_account_id, owner_id,
                                      mc_name, daily_code_id, action_taken, detail)
  values (p_kind, p_severity, s.id, s.mc_account_id, s.operator_account_id, v_owner,
          s.mc_name, s.daily_code_id, v_action, p_detail);
  return v_action;
end $$;

-- Operator: daha once operator hesaplari icin yazilmis loglari temizle
create or replace function public.admin_purge_operator_security_events(p_actor uuid)
returns int language plpgsql security definer set search_path = public as $$
declare n int;
begin
  perform public._require_operator(p_actor);
  delete from public.security_events where operator_account_id is not null;
  get diagnostics n = row_count;
  perform public._audit(p_actor::text, 'security_purge_operator', null, jsonb_build_object('deleted', n));
  return n;
end $$;

-- ---------------------------------------------------------------- izole sifirlama + kazanc raporu

create or replace function public.view_reset(p_viewer uuid, p_scope text, p_kind text, p_target uuid, p_now timestamptz default null)
returns timestamptz language plpgsql security definer set search_path = public as $$
declare v_at timestamptz := coalesce(p_now, now());
begin
  if p_scope = 'OPERATOR' then
    perform public._require_operator(p_viewer);
  elsif p_scope = 'MEMBER' then
    if p_target is not null and not exists (select 1 from public.mc_accounts where id = p_target and owner_id = p_viewer) then
      raise exception 'ACCOUNT_NOT_OWNED';
    end if;
  else
    raise exception 'INVALID_SCOPE';
  end if;
  if p_kind not in ('STATS', 'EARNINGS') then raise exception 'INVALID_KIND'; end if;
  insert into public.view_resets (viewer_id, scope, kind, target, reset_at)
  values (p_viewer, p_scope, p_kind, coalesce(p_target::text, '*'), v_at)
  on conflict (viewer_id, scope, kind, target) do update set reset_at = excluded.reset_at;
  return v_at;
end $$;

create or replace function public._reset_at(p_viewer uuid, p_scope text, p_kind text, p_target uuid)
returns timestamptz language sql stable as $$
  select coalesce(max(reset_at), '-infinity'::timestamptz) from public.view_resets
   where viewer_id = p_viewer and scope = p_scope and kind = p_kind and target in ('*', p_target::text)
$$;

-- Kazanc raporu (uye: kendi hesaplari; operator: tum uye + operator hesaplari).
--   accounts : hesap basina sifirlamadan beri kar, islem sayisi, son 60 dk, bugun (Istanbul)
--   events   : son islemler (zaman, hesap, net kar degisimi, bakiye)   -> STATS sifirlamasina tabi
--   hourly   : son 48 saatin saatlik kazanci (hesap + saat)           -> EARNINGS sifirlamasina tabi
--   daily    : son 31 gunun gunluk kazanci (hesap + gun)              -> EARNINGS sifirlamasina tabi
create or replace function public.earnings_report(p_viewer uuid, p_scope text, p_account uuid default null,
                                                  p_now timestamptz default null, p_limit int default 200)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  v_now timestamptz := coalesce(p_now, now());
  v_today date := public.istanbul_day(v_now);
  v_out jsonb;
begin
  if p_scope = 'OPERATOR' then
    perform public._require_operator(p_viewer);
  elsif p_scope <> 'MEMBER' then
    raise exception 'INVALID_SCOPE';
  end if;

  with acc as (
    select a.id, 'MEMBER'::text as kind, a.mc_name, p.display_name as owner_name
      from public.mc_accounts a join public.profiles p on p.id = a.owner_id
     where (p_scope = 'OPERATOR' or a.owner_id = p_viewer) and (p_account is null or a.id = p_account)
    union all
    select o.id, 'OPERATOR', o.mc_name, 'operatör'
      from public.operator_mc_accounts o
     where p_scope = 'OPERATOR' and (p_account is null or o.id = p_account)
  ),
  ev as (
    select e.*, acc.id as acc_id, acc.mc_name, acc.kind as acc_kind,
           public._reset_at(p_viewer, p_scope, 'STATS', acc.id) as stats_reset,
           public._reset_at(p_viewer, p_scope, 'EARNINGS', acc.id) as earn_reset
      from public.profit_events e
      join acc on acc.id = coalesce(e.mc_account_id, e.operator_account_id)
     where e.at <= v_now
  ),
  per_acc as (
    select acc.*,
           public._reset_at(p_viewer, p_scope, 'STATS', acc.id) as stats_reset_at,
           public._reset_at(p_viewer, p_scope, 'EARNINGS', acc.id) as earnings_reset_at,
           coalesce((select sum(delta) from ev where ev.acc_id = acc.id and ev.at > ev.stats_reset), 0) as profit_since_reset,
           coalesce((select count(*) from ev where ev.acc_id = acc.id and ev.at > ev.stats_reset), 0) as events_since_reset,
           coalesce((select sum(delta) from ev where ev.acc_id = acc.id and ev.at > ev.stats_reset
                       and ev.at > v_now - interval '1 hour' and ev.at <= v_now), 0) as last_hour,
           coalesce((select sum(delta) from ev where ev.acc_id = acc.id and ev.at > ev.earn_reset
                       and public.istanbul_day(ev.at) = v_today), 0) as today
      from acc
  )
  select jsonb_build_object(
    'ok', true, 'now', v_now, 'scope', p_scope,
    'accounts', coalesce((select jsonb_agg(jsonb_build_object(
        'id', id, 'kind', kind, 'mc_name', mc_name, 'owner_name', owner_name,
        'stats_reset_at', case when stats_reset_at = '-infinity' then null else stats_reset_at end,
        'earnings_reset_at', case when earnings_reset_at = '-infinity' then null else earnings_reset_at end,
        'profit_since_reset', profit_since_reset, 'events_since_reset', events_since_reset,
        'last_hour', last_hour, 'today', today) order by kind, mc_name) from per_acc), '[]'::jsonb),
    'events', coalesce((select jsonb_agg(t.x order by t.at desc, t.id desc) from (
        select ev.at, ev.id, jsonb_build_object('at', at, 'account_id', acc_id, 'mc_name', mc_name, 'kind', acc_kind,
                                  'delta', delta, 'balance', balance) as x
          from ev where at > stats_reset order by at desc, id desc limit greatest(1, least(coalesce(p_limit, 200), 1000))) t), '[]'::jsonb),
    'hourly', coalesce((select jsonb_agg(jsonb_build_object('hour', h, 'account_id', acc_id, 'mc_name', mc_name, 'profit', s, 'events', c)
                                         order by h desc, mc_name) from (
        select date_trunc('hour', at at time zone 'Europe/Istanbul') as h, acc_id, mc_name, sum(delta) as s, count(*) as c
          from ev where at > earn_reset and at > v_now - interval '48 hours'
         group by 1, 2, 3) t), '[]'::jsonb),
    'daily', coalesce((select jsonb_agg(jsonb_build_object('day', d, 'account_id', acc_id, 'mc_name', mc_name, 'profit', s, 'events', c)
                                        order by d desc, mc_name) from (
        select public.istanbul_day(at) as d, acc_id, mc_name, sum(delta) as s, count(*) as c
          from ev where at > earn_reset and at > v_now - interval '31 days'
         group by 1, 2, 3) t), '[]'::jsonb)
  ) into v_out;
  return v_out;
end $$;

-- Uye/operator panelinde rutbe ozeti
create or replace function public.rank_status(p_user uuid, p_now timestamptz default null)
returns jsonb language sql stable security definer set search_path = public as $$
  with r as (select * from public.ranks where code = public._rank_code_at(p_user, coalesce(p_now, now())))
  select jsonb_build_object(
    'code', r.code, 'name', r.name, 'commission_rate', r.commission_rate, 'weekly_price', r.weekly_price, 'color', r.color,
    'ends_at', (select max(g.ends_at) from public.rank_grants g
                 where g.user_id = p_user and g.status = 'ACTIVE' and g.rank_code = r.code and g.ends_at > coalesce(p_now, now())),
    'source', (select g.source from public.rank_grants g
                where g.user_id = p_user and g.status = 'ACTIVE' and g.rank_code = r.code
                  and g.starts_at <= coalesce(p_now, now()) and g.ends_at > coalesce(p_now, now())
                order by g.ends_at desc limit 1))
  from r
$$;

-- ---------------------------------------------------------------- RLS + yetkiler

alter table public.ranks            enable row level security;
alter table public.rank_grants      enable row level security;
alter table public.rank_orders      enable row level security;
alter table public.payment_requests enable row level security;
alter table public.profit_events    enable row level security;
alter table public.view_resets      enable row level security;

drop policy if exists ranks_read on public.ranks;
create policy ranks_read on public.ranks for select using (auth.uid() is not null);
drop policy if exists rank_grants_read on public.rank_grants;
create policy rank_grants_read on public.rank_grants for select using (user_id = auth.uid() or public.is_operator());
drop policy if exists rank_orders_read on public.rank_orders;
create policy rank_orders_read on public.rank_orders for select using (user_id = auth.uid() or public.is_operator());
drop policy if exists payment_requests_read on public.payment_requests;
create policy payment_requests_read on public.payment_requests for select using (user_id = auth.uid() or public.is_operator());
drop policy if exists profit_events_read on public.profit_events;
create policy profit_events_read on public.profit_events for select
  using ((mc_account_id is not null and public.owns_account(mc_account_id)) or public.is_operator());
drop policy if exists view_resets_read on public.view_resets;
create policy view_resets_read on public.view_resets for select using (viewer_id = auth.uid());

grant select on public.ranks, public.rank_grants, public.rank_orders, public.payment_requests,
                public.profit_events, public.view_resets to authenticated;
revoke insert, update, delete on public.ranks, public.rank_grants, public.rank_orders, public.payment_requests,
                                 public.profit_events, public.view_resets from anon, authenticated;

do $$
declare f record;
begin
  for f in select p.oid::regprocedure as sig from pg_proc p join pg_namespace n on n.oid = p.pronamespace
            where n.nspname = 'public'
              and p.proname in ('_rank_code_at', 'user_commission_rate', '_open_window', '_refresh_open_rates', 'rank_quote',
                                'member_create_rank_order', 'member_cancel_rank_order', '_activate_rank_order',
                                'admin_rank_order_paid', 'admin_rank_order_cancel', 'admin_gift_rank', 'admin_revoke_rank_grant',
                                'admin_set_rank', 'admin_create_payment_request', 'admin_resolve_payment_request',
                                '_try_match', 'match_extra_payments', 'expire_stale_sessions', 'security_log',
                                'admin_purge_operator_security_events', 'view_reset', '_reset_at', 'earnings_report',
                                'rank_status', '_log_profit_event') loop
    execute format('revoke all on function %s from public', f.sig);
    if exists (select 1 from pg_roles where rolname = 'service_role') then
      execute format('grant execute on function %s to service_role', f.sig);
    end if;
  end loop;
end $$;
