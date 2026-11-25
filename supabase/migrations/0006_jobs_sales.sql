-- =====================================================================
-- AutoSeller Panel - 0006: Bot is emirleri (bildirim + kasaya odeme) ve urun bazli satis kayitlari
--
-- Tekrar calistirilabilir (idempotent). 0001-0005 uzerine calistirilir.
--
--  * bot_jobs   : operatorun "Odeme al" / "Bildirim" emirleri. Mod (v0.7.1+) heartbeat cevabinda
--                 "jobs" alanindan alir, /api/mod/jobs/ack ile sonucu bildirir. Eski mod alani yok sayar.
--                 Teslim en az bir kez yapilir (ack gelene kadar tekrar gonderilir); mod is no ile
--                 tekrar calistirmayi engeller. PAY emri uyenin "uzaktan odeme" onayini gerektirir.
--  * mod_sales  : modun bildirdigi tek tek satislar (urun, adet, fiyat, maliyet, vergi, net kar).
--                 Sadece gosterim icindir; komisyon yine heartbeat'teki profitDelta'dan hesaplanir.
--  * Odeme talebi olusturma (admin_create_payment_request) devre disi; eski kayitlar okunabilir/kapatilabilir.
--
-- Degisen mevcut fonksiyonlar (ayni imza): _try_match, match_extra_payments, expire_stale_sessions,
--   admin_create_payment_request (artik hata verir).
-- =====================================================================

alter table public.profiles add column if not exists remote_pay_consent_at timestamptz;

create table if not exists public.bot_jobs (
  id                  bigint generated always as identity primary key,
  mc_account_id       uuid not null references public.mc_accounts(id) on delete cascade,
  kind                text not null check (kind in ('NOTIFY', 'PAY')),
  amount              bigint check (amount is null or amount > 0),
  pay_to              text,
  message             text,
  apply_to_commission boolean not null default true,     -- PAY: komisyon borcundan dus (payments tablosuna yazilir)
  tx_id               uuid not null default gen_random_uuid(),
  status              text not null default 'QUEUED'
                      check (status in ('QUEUED', 'DELIVERED', 'RECEIVED', 'DONE', 'FAILED', 'UNVERIFIED', 'CANCELLED', 'EXPIRED')),
  created_by          uuid references public.profiles(id) on delete set null,
  created_at          timestamptz not null default now(),
  expires_at          timestamptz not null,
  delivered_at        timestamptz,
  delivered_count     int not null default 0,
  session_id          uuid references public.bot_sessions(id) on delete set null,
  received_at         timestamptz,
  finished_at         timestamptz,
  tax                 bigint,
  chat_line           text,
  result_note         text,
  payment_id          bigint references public.payments(id) on delete set null,
  received_id         bigint references public.received_payments(id) on delete set null,
  verified_at         timestamptz
);
create index if not exists bot_jobs_account_idx on public.bot_jobs (mc_account_id, created_at desc);
create index if not exists bot_jobs_open_idx on public.bot_jobs (mc_account_id) where status in ('QUEUED', 'DELIVERED', 'RECEIVED');
create unique index if not exists bot_jobs_tx_uq on public.bot_jobs (tx_id);

alter table public.received_payments add column if not exists matched_job_id bigint
  references public.bot_jobs(id) on delete set null;

create table if not exists public.mod_sales (
  id                  bigint generated always as identity primary key,
  client_id           uuid not null,
  mc_account_id       uuid references public.mc_accounts(id) on delete cascade,
  operator_account_id uuid references public.operator_mc_accounts(id) on delete cascade,
  session_id          uuid references public.bot_sessions(id) on delete set null,
  at                  timestamptz not null,
  item_id             text,
  item_name           text,
  amount              int,
  revenue             bigint not null,
  cost                bigint,
  tax                 bigint,
  net                 bigint,
  how                 text,          -- single | batch | unmatched | early
  check ((mc_account_id is null) <> (operator_account_id is null))
);
create unique index if not exists mod_sales_client_uq on public.mod_sales (client_id);
create index if not exists mod_sales_acc_idx on public.mod_sales (mc_account_id, at desc);
create index if not exists mod_sales_op_idx on public.mod_sales (operator_account_id, at desc);
create index if not exists mod_sales_at_idx on public.mod_sales (at desc);

insert into public.settings (key, value) values
  ('job_ttl_min',         '30'),       -- teslim edilmeyen is emri kac dk sonra duser
  ('job_min_mod_version', '"0.7.1"')   -- is emirlerini anlayan en dusuk mod surumu
on conflict (key) do nothing;

-- ---------------------------------------------------------------- uye onayi

create or replace function public.member_remote_pay_consent(p_user uuid, p_on boolean)
returns void language sql security definer set search_path = public as $$
  update public.profiles set remote_pay_consent_at = case when p_on then coalesce(remote_pay_consent_at, now()) else null end
   where id = p_user;
$$;

-- ---------------------------------------------------------------- operator: is emri

create or replace function public.admin_create_job(p_actor uuid, p_account uuid, p_kind text, p_amount bigint,
                                                   p_message text, p_apply_commission boolean, p_now timestamptz default null)
returns bigint language plpgsql security definer set search_path = public as $$
declare
  v_now timestamptz := coalesce(p_now, now());
  a public.mc_accounts;
  v_receiver text := public.setting_text('commission_receiver');
  v_id bigint;
begin
  perform public._require_operator(p_actor);
  select * into a from public.mc_accounts where id = p_account;
  if not found then raise exception 'UNKNOWN_ACCOUNT'; end if;
  if p_kind not in ('NOTIFY', 'PAY') then raise exception 'INVALID_KIND'; end if;
  if p_kind = 'NOTIFY' and coalesce(trim(p_message), '') = '' then raise exception 'MESSAGE_REQUIRED'; end if;
  if p_kind = 'PAY' then
    if p_amount is null or p_amount <= 0 then raise exception 'INVALID_AMOUNT'; end if;
    if v_receiver is null or v_receiver = '' then raise exception 'NO_RECEIVER: önce kasa hesabını seç'; end if;
    if (select remote_pay_consent_at from public.profiles where id = a.owner_id) is null then
      raise exception 'NO_REMOTE_PAY_CONSENT: kullanıcı panelde uzaktan ödeme onayı vermemiş';
    end if;
    if exists (select 1 from public.bot_jobs where mc_account_id = p_account and kind = 'PAY'
                and status in ('QUEUED', 'DELIVERED', 'RECEIVED')) then
      raise exception 'JOB_PENDING: bu hesapta bitmemiş bir ödeme emri var';
    end if;
  end if;
  insert into public.bot_jobs (mc_account_id, kind, amount, pay_to, message, apply_to_commission, created_by, created_at, expires_at)
  values (p_account, p_kind, case when p_kind = 'PAY' then p_amount end, case when p_kind = 'PAY' then v_receiver end,
          left(p_message, 200), coalesce(p_apply_commission, true), p_actor, v_now,
          v_now + make_interval(mins => coalesce(public.setting_num('job_ttl_min'), 30)::int))
  returning id into v_id;
  perform public._audit(p_actor::text, 'job_create', v_id::text,
                        jsonb_build_object('account', p_account, 'kind', p_kind, 'amount', p_amount));
  return v_id;
end $$;

-- Sadece mod henuz teslim almadiysa iptal edilir (aldiysa /pay gitmis olabilir)
create or replace function public.admin_cancel_job(p_actor uuid, p_job bigint, p_note text)
returns void language plpgsql security definer set search_path = public as $$
begin
  perform public._require_operator(p_actor);
  update public.bot_jobs set status = 'CANCELLED', finished_at = now(), result_note = coalesce(p_note, 'operatör iptal etti')
   where id = p_job and status in ('QUEUED', 'DELIVERED');
  if not found then raise exception 'JOB_NOT_CANCELLABLE: mod emri teslim aldı ya da emir bitti'; end if;
  perform public._audit(p_actor::text, 'job_cancel', p_job::text, null);
end $$;

-- ---------------------------------------------------------------- mod: is cekme / sonuc

-- Heartbeat sonrasi cagrilir: bu hesabin acik emirlerini dondurur (QUEUED -> DELIVERED).
-- DELIVERED emirler mod "RECEIVED" diyene kadar her heartbeat'te tekrar gonderilir.
create or replace function public.mod_pull_jobs(p_token_hash text, p_now timestamptz default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_now timestamptz := coalesce(p_now, now());
  s public.bot_sessions;
  v_out jsonb;
begin
  select * into s from public.bot_sessions where token_hash = p_token_hash and ended_at is null;
  if not found or s.mc_account_id is null then return '[]'::jsonb; end if;
  update public.bot_jobs set status = 'EXPIRED', finished_at = v_now, result_note = 'mod teslim almadı'
   where mc_account_id = s.mc_account_id and status in ('QUEUED', 'DELIVERED') and expires_at < v_now;
  if not public.version_gte(coalesce(s.mod_version, '0'), coalesce(public.setting_text('job_min_mod_version'), '0.7.1')) then
    return '[]'::jsonb;
  end if;
  with j as (
    update public.bot_jobs set status = 'DELIVERED', delivered_at = coalesce(delivered_at, v_now),
                               delivered_count = delivered_count + 1, session_id = s.id
     where mc_account_id = s.mc_account_id and status in ('QUEUED', 'DELIVERED') and expires_at >= v_now
    returning *
  )
  select coalesce(jsonb_agg(jsonb_build_object('id', id, 'kind', kind, 'amount', amount, 'payTo', pay_to,
                                               'message', message, 'txId', tx_id) order by id), '[]'::jsonb)
    into v_out from j;
  return v_out;
end $$;

-- Mod sonuc bildirimi. status: RECEIVED (teslim aldi) | DONE (/pay onaylandi) | UNVERIFIED (onay gorulmedi,
-- gonderildi varsayilir) | FAILED (yapilamadi: bakiye yetersiz, sunucu reddetti...). Tekrar gelirse yok sayilir.
create or replace function public.mod_job_ack(p_token_hash text, p_job bigint, p_status text, p_tax bigint,
                                              p_line text, p_note text, p_now timestamptz default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_now timestamptz := coalesce(p_now, now());
  s public.bot_sessions;
  j public.bot_jobs;
  v_pay jsonb;
begin
  select * into s from public.bot_sessions where token_hash = p_token_hash and ended_at is null;
  if not found then return jsonb_build_object('ok', false, 'reason', 'NO_SESSION'); end if;
  select * into j from public.bot_jobs where id = p_job and mc_account_id = s.mc_account_id for update;
  if not found then return jsonb_build_object('ok', false, 'reason', 'UNKNOWN_JOB'); end if;
  if p_status not in ('RECEIVED', 'DONE', 'UNVERIFIED', 'FAILED') then
    return jsonb_build_object('ok', false, 'reason', 'INVALID_STATUS');
  end if;
  if j.status in ('DONE', 'UNVERIFIED', 'FAILED') then
    return jsonb_build_object('ok', true, 'duplicate', true, 'status', j.status);
  end if;
  if p_status = 'RECEIVED' then
    -- iptal edilmis olsa bile mod aldiysa kaydet (iptal yarisi): mod iptal edilen isi calistirmaz
    if j.status in ('CANCELLED', 'EXPIRED') then return jsonb_build_object('ok', true, 'cancelled', true); end if;
    update public.bot_jobs set status = 'RECEIVED', received_at = v_now where id = j.id;
    return jsonb_build_object('ok', true, 'status', 'RECEIVED');
  end if;

  update public.bot_jobs set status = p_status, finished_at = v_now, tax = p_tax, chat_line = left(p_line, 300),
                             result_note = left(p_note, 300), received_at = coalesce(received_at, v_now)
   where id = j.id;

  if j.kind = 'PAY' and p_status in ('DONE', 'UNVERIFIED') then
    if j.apply_to_commission then
      -- Komisyon odemesi gibi kaydet: borca FIFO dusulur, kasa "paid you" ile dogrulanir
      v_pay := public.mod_report_payment(p_token_hash, j.tx_id, j.pay_to, j.amount, p_tax,
                                         coalesce(p_line, 'iş emri #' || j.id), v_now);
      if (v_pay ->> 'ok')::boolean then
        update public.bot_jobs set payment_id = (v_pay ->> 'payment_id')::bigint,
               verified_at = case when v_pay ->> 'status' = 'VERIFIED' then v_now end
         where id = j.id;
      else
        update public.bot_jobs set result_note = coalesce(result_note || ' | ', '') || 'ödeme kaydı: ' || (v_pay ->> 'reason')
         where id = j.id;
      end if;
    else
      perform public.match_job_payments(v_now);
    end if;
  end if;
  perform public._audit('MOD:' || s.mc_name, 'job_' || lower(p_status), j.id::text,
                        jsonb_build_object('tax', p_tax, 'note', p_note));
  return jsonb_build_object('ok', true, 'status', p_status, 'payment', v_pay, 'due', public._due(s.mc_account_id));
end $$;

-- Komisyona sayilmayan PAY emirlerini kasada gorulen odemeyle eslestir (dogrulama)
create or replace function public.match_job_payments(p_now timestamptz default null)
returns int language plpgsql security definer set search_path = public as $$
declare
  v_now timestamptz := coalesce(p_now, now());
  v_win interval := make_interval(mins => public.setting_num('payment_match_window_min')::int);
  j record;
  r public.received_payments;
  n int := 0;
begin
  for j in select b.*, a.mc_name from public.bot_jobs b join public.mc_accounts a on a.id = b.mc_account_id
            where b.kind = 'PAY' and not b.apply_to_commission and b.status in ('DONE', 'UNVERIFIED')
              and b.verified_at is null and b.finished_at > v_now - interval '3 days' loop
    select * into r from public.received_payments
     where matched_payment_id is null and matched_rank_order_id is null and matched_request_id is null and matched_job_id is null
       and lower(from_player) = lower(j.mc_name) and lower(receiver_mc) = lower(j.pay_to)
       and abs(amount - j.amount) <= greatest(tolerance, 1)
       and seen_at between j.delivered_at - v_win and coalesce(j.finished_at, v_now) + v_win
     order by seen_at limit 1 for update skip locked;
    continue when not found;
    update public.received_payments set matched_job_id = j.id where id = r.id;
    update public.bot_jobs set received_id = r.id, verified_at = r.seen_at where id = j.id;
    n := n + 1;
  end loop;
  return n;
end $$;

-- Mod satis kayitlari (heartbeat ile en fazla 100 tane). client_id ile tekrar gonderim cift kayit yapmaz.
create or replace function public.mod_report_sales(p_token_hash text, p_sales jsonb)
returns int language plpgsql security definer set search_path = public as $$
declare
  s public.bot_sessions;
  e jsonb;
  n int := 0;
  v_rows int;
begin
  select * into s from public.bot_sessions where token_hash = p_token_hash and ended_at is null;
  if not found or jsonb_typeof(p_sales) <> 'array' then return 0; end if;
  for e in select * from jsonb_array_elements(p_sales) limit 100 loop
    begin
      insert into public.mod_sales (client_id, mc_account_id, operator_account_id, session_id, at, item_id, item_name,
                                    amount, revenue, cost, tax, net, how)
      values ((e ->> 'id')::uuid, s.mc_account_id, s.operator_account_id, s.id,
              least(now(), coalesce(to_timestamp((e ->> 'at')::bigint / 1000.0), now())),
              left(e ->> 'itemId', 80), left(e ->> 'itemName', 120),
              (e ->> 'amount')::int, (e ->> 'revenue')::bigint, (e ->> 'cost')::bigint, (e ->> 'tax')::bigint,
              (e ->> 'net')::bigint, left(e ->> 'how', 20))
      on conflict (client_id) do nothing;
      get diagnostics v_rows = row_count;
      n := n + v_rows;
    exception when others then
      raise warning 'mod_report_sales: gecersiz kayit atlandi: %', sqlerrm;
    end;
  end loop;
  return n;
end $$;

-- Satis gecmisi (uye: kendi hesaplari; operator: hepsi). STATS sifirlamasina tabi (0005 view_resets).
create or replace function public.sales_report(p_viewer uuid, p_scope text, p_account uuid default null,
                                               p_limit int default 300, p_now timestamptz default null)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare v_now timestamptz := coalesce(p_now, now());
begin
  if p_scope = 'OPERATOR' then
    perform public._require_operator(p_viewer);
  elsif p_scope <> 'MEMBER' then
    raise exception 'INVALID_SCOPE';
  end if;
  return (
    with acc as (
      select a.id, a.mc_name, p.display_name as owner_name, 'MEMBER'::text as kind
        from public.mc_accounts a join public.profiles p on p.id = a.owner_id
       where (p_scope = 'OPERATOR' or a.owner_id = p_viewer) and (p_account is null or a.id = p_account)
      union all
      select o.id, o.mc_name, 'operatör', 'OPERATOR' from public.operator_mc_accounts o
       where p_scope = 'OPERATOR' and (p_account is null or o.id = p_account)
    ),
    sl as (
      select m.*, acc.mc_name, acc.owner_name, acc.kind as acc_kind, acc.id as acc_id
        from public.mod_sales m join acc on acc.id = coalesce(m.mc_account_id, m.operator_account_id)
       where m.at > public._reset_at(p_viewer, p_scope, 'STATS', acc.id) and m.at <= v_now
    )
    select jsonb_build_object(
      'ok', true,
      'sales', coalesce((select jsonb_agg(x order by at desc, id desc) from (
          select at, id, jsonb_build_object('at', at, 'account_id', acc_id, 'mc_name', mc_name, 'owner_name', owner_name,
                   'kind', acc_kind, 'item_id', item_id, 'item_name', item_name, 'amount', amount, 'revenue', revenue,
                   'unit_price', case when amount > 0 then round(revenue::numeric / amount) end,
                   'cost', cost, 'tax', tax, 'net', net, 'how', how) as x
            from sl order by at desc, id desc limit greatest(1, least(coalesce(p_limit, 300), 2000))) t), '[]'::jsonb),
      'by_item', coalesce((select jsonb_agg(jsonb_build_object('item', item, 'mc_name', mc_name, 'count', c, 'amount', q,
                                              'revenue', rv, 'net', nt) order by rv desc) from (
          select coalesce(item_name, item_id, '?') as item, mc_name, count(*) c, sum(coalesce(amount, 0)) q,
                 sum(revenue) rv, sum(coalesce(net, 0)) nt
            from sl where at > v_now - interval '7 days' group by 1, 2) t), '[]'::jsonb),
      'total_count', (select count(*) from sl)
    ));
end $$;

-- ---------------------------------------------------------------- odeme talebi: devre disi

create or replace function public.admin_create_payment_request(p_actor uuid, p_user uuid, p_account uuid,
                                                               p_amount bigint, p_note text, p_due timestamptz)
returns bigint language plpgsql security definer set search_path = public as $$
begin
  perform public._require_operator(p_actor);
  raise exception 'DISABLED: ödeme talebi kaldırıldı; bunun yerine "Ödeme al" (bot iş emri) kullan';
end $$;

-- ---------------------------------------------------------------- eslestirme guncellemeleri

-- 0005 _try_match + is emrine eslesmis gelen odemeyi kullanmama
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
   where matched_payment_id is null and matched_rank_order_id is null and matched_request_id is null and matched_job_id is null
     and lower(from_player) = lower(a.mc_name)
     and lower(receiver_mc) = lower(p.to_player)
     and abs(amount - p.amount) <= greatest(tolerance, 1)
     and seen_at between p.claimed_at - v_win and p.claimed_at + v_win
   order by abs(extract(epoch from (seen_at - p.claimed_at))) limit 1 for update;
  if not found then return false; end if;
  update public.received_payments set matched_payment_id = p.id where id = r.id;
  update public.payments set status = 'VERIFIED', verified_at = r.seen_at, verified_by = 'RECEIVER:' || r.receiver_mc
   where id = p.id;
  update public.bot_jobs set verified_at = r.seen_at where payment_id = p.id;
  return true;
end $$;

-- 0005 match_extra_payments + is emri korumasi (ayni tutarda bitmemis/dogrulanmamis PAY emri varsa dokunma)
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
  perform public.match_job_payments(v_now);
  for r in select * from public.received_payments
            where matched_payment_id is null and matched_rank_order_id is null and matched_request_id is null
              and matched_job_id is null
              and seen_at <= v_now - interval '2 minutes' and seen_at > v_now - interval '3 days'
            order by seen_at for update skip locked loop
    v_acc := null; v_owner := null;
    select id, owner_id into v_acc, v_owner from public.mc_accounts where lower(mc_name) = lower(r.from_player);
    continue when v_owner is null;
    continue when exists (select 1 from public.payments p
                           where p.mc_account_id = v_acc and p.status = 'CLAIMED'
                             and abs(p.amount - r.amount) <= greatest(r.tolerance, 1)
                             and p.claimed_at between r.seen_at - v_win and r.seen_at + v_win);
    continue when exists (select 1 from public.bot_jobs b
                           where b.mc_account_id = v_acc and b.kind = 'PAY' and b.verified_at is null
                             and b.status in ('DELIVERED', 'RECEIVED', 'DONE', 'UNVERIFIED')
                             and abs(b.amount - r.amount) <= greatest(r.tolerance, 1)
                             and r.seen_at between coalesce(b.delivered_at, b.created_at) - v_win
                                               and coalesce(b.finished_at, v_now) + v_win);

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
  update public.bot_jobs set status = 'EXPIRED', finished_at = v_now, result_note = 'mod teslim almadı'
   where status in ('QUEUED', 'DELIVERED') and expires_at < v_now;
  return n;
end $$;

-- ---------------------------------------------------------------- RLS + yetkiler

alter table public.bot_jobs  enable row level security;
alter table public.mod_sales enable row level security;

drop policy if exists bot_jobs_read on public.bot_jobs;
create policy bot_jobs_read on public.bot_jobs for select using (public.owns_account(mc_account_id) or public.is_operator());
drop policy if exists mod_sales_read on public.mod_sales;
create policy mod_sales_read on public.mod_sales for select
  using ((mc_account_id is not null and public.owns_account(mc_account_id)) or public.is_operator());

grant select on public.bot_jobs, public.mod_sales to authenticated;
revoke insert, update, delete on public.bot_jobs, public.mod_sales from anon, authenticated;

do $$
declare f record;
begin
  for f in select p.oid::regprocedure as sig from pg_proc p join pg_namespace n on n.oid = p.pronamespace
            where n.nspname = 'public'
              and p.proname in ('member_remote_pay_consent', 'admin_create_job', 'admin_cancel_job', 'mod_pull_jobs',
                                'mod_job_ack', 'match_job_payments', 'mod_report_sales', 'sales_report',
                                'admin_create_payment_request', '_try_match', 'match_extra_payments') loop
    execute format('revoke all on function %s from public', f.sig);
    if exists (select 1 from pg_roles where rolname = 'service_role') then
      execute format('grant execute on function %s to service_role', f.sig);
    end if;
  end loop;
end $$;
