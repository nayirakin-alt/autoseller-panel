-- =====================================================================
-- AutoSeller Panel - Satir Duzeyi Guvenlik (RLS)
--   UYE      : sadece kendi profili, kendi MC hesaplari ve onlara bagli kayitlar (SADECE OKUMA)
--   OPERATOR : her sey (OKUMA); degisiklikler admin_* fonksiyonlariyla (API rol kontrolu + fonksiyon
--              icinde _require_operator, iki katmanli)
-- Hicbir rol tablolara dogrudan INSERT/UPDATE/DELETE yapamaz; yazmalar 0002 fonksiyonlarindan gecer.
-- =====================================================================

create or replace function public.is_operator() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.profiles where id = auth.uid() and role = 'OPERATOR' and status = 'ACTIVE')
$$;

create or replace function public.owns_account(p_account uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.mc_accounts where id = p_account and owner_id = auth.uid())
$$;

alter table public.profiles             enable row level security;
alter table public.mc_accounts          enable row level security;
alter table public.operator_mc_accounts enable row level security;
alter table public.daily_codes          enable row level security;
alter table public.bot_sessions         enable row level security;
alter table public.commission_windows   enable row level security;
alter table public.commissions          enable row level security;
alter table public.payments             enable row level security;
alter table public.payment_allocations  enable row level security;
alter table public.received_payments    enable row level security;
alter table public.settings             enable row level security;
alter table public.audit_log            enable row level security;
alter table public.mod_challenges       enable row level security;

-- profiles
create policy profiles_read on public.profiles for select
  using (id = auth.uid() or public.is_operator());

-- mc_accounts
create policy mc_accounts_read on public.mc_accounts for select
  using (owner_id = auth.uid() or public.is_operator());

-- operator_mc_accounts: SADECE operator
create policy operator_accounts_read on public.operator_mc_accounts for select
  using (public.is_operator());

-- daily_codes / sessions / windows / commissions / payments: hesap sahibi ya da operator
create policy daily_codes_read on public.daily_codes for select
  using (public.owns_account(mc_account_id) or public.is_operator());

create policy sessions_read on public.bot_sessions for select
  using ((mc_account_id is not null and public.owns_account(mc_account_id)) or public.is_operator());

create policy windows_read on public.commission_windows for select
  using (public.owns_account(mc_account_id) or public.is_operator());

create policy commissions_read on public.commissions for select
  using (public.owns_account(mc_account_id) or public.is_operator());

create policy payments_read on public.payments for select
  using (public.owns_account(mc_account_id) or public.is_operator());

create policy allocations_read on public.payment_allocations for select
  using (public.is_operator() or exists (
    select 1 from public.payments p where p.id = payment_id and public.owns_account(p.mc_account_id)));

-- Sadece operator
create policy received_read on public.received_payments for select using (public.is_operator());
create policy audit_read    on public.audit_log         for select using (public.is_operator());
-- Ayarlar: herkes okuyabilir (komisyon orani, alici adi uyeye de gosterilir)
create policy settings_read on public.settings for select using (auth.uid() is not null);
-- mod_challenges: politika yok -> sadece servis rolu

-- bot_sessions'taki gizli alanlari (token_hash, hmac_secret, client_ip) uyelerden gizle
revoke select on public.bot_sessions from anon, authenticated;
grant select (id, mc_account_id, operator_account_id, mc_name, mc_uuid, is_exempt, daily_code_id, mod_version,
              mode, running, started_at, last_heartbeat_at, last_seq, ended_at, end_reason)
  on public.bot_sessions to authenticated;

-- Okuma izinleri (yazma yok)
grant select on public.profiles, public.mc_accounts, public.operator_mc_accounts, public.daily_codes,
                public.commission_windows, public.commissions, public.payments, public.payment_allocations,
                public.received_payments, public.settings, public.audit_log
  to authenticated;
grant select on public.v_account_overview, public.v_operator_account_overview to authenticated;
revoke insert, update, delete on all tables in schema public from anon, authenticated;

-- ---------------------------------------------------------------- yeni kullanici -> profil
-- Kayit sadece operator davetiyle (Supabase: "Allow new users to sign up" KAPALI, Invite user).
create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, display_name)
  values (new.id, coalesce(new.raw_user_meta_data ->> 'display_name', split_part(new.email, '@', 1)));
  return new;
end $$;

create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();

-- Uye kendi MC hesabini ekler (operator onayi bekler). API cagirir (servis rolu).
create or replace function public.member_add_account(p_user uuid, p_mc_name text)
returns public.mc_accounts language plpgsql security definer set search_path = public as $$
declare a public.mc_accounts;
begin
  if exists (select 1 from public.operator_mc_accounts where lower(mc_name) = lower(p_mc_name)) then
    raise exception 'NAME_IS_OPERATOR_ACCOUNT';
  end if;
  if (select count(*) from public.mc_accounts where owner_id = p_user) >= 10 then
    raise exception 'TOO_MANY_ACCOUNTS';
  end if;
  insert into public.mc_accounts (owner_id, mc_name) values (p_user, p_mc_name) returning * into a;
  perform public._audit(p_user::text, 'account_add', a.id::text, jsonb_build_object('mc_name', p_mc_name));
  return a;
end $$;

create or replace function public.member_consent(p_user uuid) returns void
language sql security definer set search_path = public as $$
  update public.profiles set consent_at = coalesce(consent_at, now()) where id = p_user;
$$;

revoke all on function public.member_add_account(uuid, text) from public;
revoke all on function public.member_consent(uuid) from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    grant execute on function public.member_add_account(uuid, text) to service_role;
    grant execute on function public.member_consent(uuid) to service_role;
  end if;
end $$;
