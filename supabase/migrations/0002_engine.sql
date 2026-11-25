-- =====================================================================
-- AutoSeller Panel - Cekirdek motor (SECURITY DEFINER fonksiyonlar)
--
-- Butun para/sure hesabi burada, TEK islemde (transaction) yapilir:
-- ayni anda gelen iki istek ayni pencereyi iki kez kapatamaz, ayni odeme
-- iki kez sayilmaz. API katmani (Next.js) sadece kimlik dogrulayip cagirir.
-- Bu fonksiyonlar yalnizca service_role ile cagrilabilir (en altta GRANT).
-- p_now parametresi testler icindir; API her zaman NULL (= now()) gecer.
-- =====================================================================

-- ---------------------------------------------------------------- yardimcilar

create or replace function public.setting_num(p_key text) returns numeric
language sql stable as $$
  select (value #>> '{}')::numeric from public.settings where key = p_key
$$;

create or replace function public.setting_text(p_key text) returns text
language sql stable as $$
  select value #>> '{}' from public.settings where key = p_key
$$;

create or replace function public.istanbul_day(p_at timestamptz) returns date
language sql stable as $$
  select (p_at at time zone 'Europe/Istanbul')::date
$$;

-- "0.6.4" >= "0.7.0" ?
create or replace function public.version_gte(p_a text, p_b text) returns boolean
language sql immutable as $$
  select coalesce(
    string_to_array(regexp_replace(coalesce(p_a, '0'), '[^0-9.]', '', 'g'), '.')::int[]
      >= string_to_array(regexp_replace(coalesce(p_b, '0'), '[^0-9.]', '', 'g'), '.')::int[],
    false)
$$;

create or replace function public._audit(p_actor text, p_action text, p_target text, p_data jsonb)
returns void language sql as $$
  insert into public.audit_log (actor, action, target, data) values (p_actor, p_action, p_target, p_data)
$$;

create or replace function public._require_operator(p_actor uuid) returns void
language plpgsql stable as $$
begin
  if not exists (select 1 from public.profiles where id = p_actor and role = 'OPERATOR' and status = 'ACTIVE') then
    raise exception 'FORBIDDEN' using errcode = '42501';
  end if;
end $$;

-- ---------------------------------------------------------------- pencere

-- Hesabin acik penceresini kilitleyerek dondurur; yoksa acar (profit_start = su anki toplam).
create or replace function public._open_window(p_account uuid, p_now timestamptz)
returns public.commission_windows language plpgsql as $$
declare
  w public.commission_windows;
  v_total bigint;
begin
  select * into w from public.commission_windows
   where mc_account_id = p_account and status = 'OPEN' for update;
  if found then return w; end if;

  select profit_total into v_total from public.mc_accounts where id = p_account;
  insert into public.commission_windows (mc_account_id, window_no, profit_start, rate, opened_at, balance_start)
  values (p_account,
          coalesce((select max(window_no) from public.commission_windows where mc_account_id = p_account), 0) + 1,
          v_total, public.setting_num('commission_rate'), p_now,
          (select last_balance from public.mc_accounts where id = p_account))
  returning * into w;
  return w;
end $$;

-- Aktif sureyi pencereye ekler; 3600 sn dolunca pencereyi kapatir, %40 komisyon yazar,
-- tasan saniyelerle yeni pencere acar. Kapanan pencereleri dondurur.
create or replace function public._accrue(p_account uuid, p_seconds int, p_now timestamptz)
returns jsonb language plpgsql as $$
declare
  w public.commission_windows;
  v_win int := public.setting_num('window_seconds')::int;
  v_total bigint;
  v_left int := greatest(p_seconds, 0);
  v_room int;
  v_delta bigint;
  v_comm bigint;
  v_closed jsonb := '[]'::jsonb;
begin
  select profit_total into v_total from public.mc_accounts where id = p_account;
  loop
    w := public._open_window(p_account, p_now);
    v_room := v_win - w.active_seconds;
    if v_left < v_room then
      update public.commission_windows set active_seconds = active_seconds + v_left where id = w.id;
      exit;
    end if;

    -- Pencere doldu: bu saatte saglanan YENI kar = simdiki toplam - pencere basindaki toplam
    v_delta := v_total - w.profit_start;
    v_comm := floor(greatest(v_delta, 0) * w.rate)::bigint;
    update public.commission_windows
       set active_seconds = v_win, profit_end = v_total, profit_delta = v_delta,
           commission = v_comm, status = 'CLOSED', closed_at = p_now,
           balance_end = (select last_balance from public.mc_accounts where id = p_account)
     where id = w.id;
    perform public._check_balance(w.id);   -- 0004: bakiye-kar tutarsizligi
    if v_comm > 0 then
      insert into public.commissions (window_id, mc_account_id, amount, created_at)
      values (w.id, p_account, v_comm, p_now);
    end if;
    v_closed := v_closed || jsonb_build_object('window_no', w.window_no, 'profit_delta', v_delta, 'commission', v_comm);
    v_left := v_left - v_room;
    -- yeni pencere bir sonraki turda acilir (profit_start = v_total)
    perform public._open_window(p_account, p_now);
    if v_left = 0 then exit; end if;
  end loop;
  return v_closed;
end $$;

-- ---------------------------------------------------------------- erisim

-- Uye hesabinin bot erisimi: (izin, mod, sebep)
--   FULL     : normal calisir
--   PAY_ONLY : vadesi gecmis komisyon var; bot satis yapmaz, sadece borcu oder
create or replace function public._access(p_account uuid, p_now timestamptz,
  out allowed boolean, out mode text, out reason text)
language plpgsql stable as $$
declare
  a public.mc_accounts;
  pr public.profiles;
begin
  select * into a from public.mc_accounts where id = p_account;
  select * into pr from public.profiles where id = a.owner_id;
  if pr.status <> 'ACTIVE' then
    allowed := false; mode := null; reason := coalesce('USER_SUSPENDED: ' || pr.suspended_reason, 'USER_SUSPENDED'); return;
  end if;
  if not a.access_enabled then
    allowed := false; mode := null; reason := coalesce('ACCESS_DISABLED: ' || a.blocked_reason, 'ACCESS_DISABLED'); return;
  end if;
  if a.tamper_flag and public.setting_text('tamper_action') = 'PAY_ONLY' then
    allowed := true; mode := 'PAY_ONLY'; reason := coalesce('TAMPER_REVIEW: ' || a.tamper_reason, 'TAMPER_REVIEW'); return;
  end if;
  if exists (select 1 from public.commissions
              where mc_account_id = p_account and status in ('PENDING', 'PARTIAL')
                and created_at < p_now - make_interval(mins => public.setting_num('commission_grace_min')::int)) then
    allowed := true; mode := 'PAY_ONLY'; reason := 'COMMISSION_OVERDUE'; return;
  end if;
  allowed := true; mode := 'FULL'; reason := null;
end $$;

-- Bekleyen komisyonlar (en eski once) + odenecek oyuncu
create or replace function public._due(p_account uuid) returns jsonb
language sql stable as $$
  select jsonb_build_object(
    'pay_to', public.setting_text('commission_receiver'),
    'total', coalesce(sum(amount - paid), 0),
    'items', coalesce(jsonb_agg(jsonb_build_object('commission_id', id, 'remaining', amount - paid,
                                                   'created_at', created_at) order by created_at), '[]'::jsonb))
  from public.commissions
  where mc_account_id = p_account and status in ('PENDING', 'PARTIAL')
$$;

-- Moda donulen ortak durum
create or replace function public._session_state(p_session uuid, p_now timestamptz) returns jsonb
language plpgsql as $$
declare
  s public.bot_sessions;
  w public.commission_windows;
  a public.mc_accounts;
  acc record;
begin
  select * into s from public.bot_sessions where id = p_session;
  if s.is_exempt then
    return jsonb_build_object('ok', true, 'session_id', s.id, 'exempt', true, 'allowed', true, 'mode', 'FULL',
      'heartbeat_sec', 30, 'commission_rate', 0,
      'receiver', lower(s.mc_name) = lower(coalesce(public.setting_text('commission_receiver'), '')),
      'due', jsonb_build_object('total', 0, 'items', '[]'::jsonb, 'pay_to', public.setting_text('commission_receiver')));
  end if;
  select * into a from public.mc_accounts where id = s.mc_account_id;
  w := public._open_window(s.mc_account_id, p_now);
  acc := public._access(s.mc_account_id, p_now);
  return jsonb_build_object(
    'ok', true, 'session_id', s.id, 'exempt', false,
    'allowed', acc.allowed, 'mode', acc.mode, 'reason', acc.reason,
    'heartbeat_sec', 30,
    'commission_rate', w.rate,
    'window', jsonb_build_object('no', w.window_no, 'active_seconds', w.active_seconds,
                                 'window_seconds', public.setting_num('window_seconds'),
                                 'profit_so_far', a.profit_total - w.profit_start),
    'account', jsonb_build_object('profit_total', a.profit_total, 'active_seconds_total', a.active_seconds_total),
    'due', public._due(s.mc_account_id));
end $$;

-- ---------------------------------------------------------------- gunluk kod

-- Hesabin bugunku (Istanbul) kodu; yoksa p_candidate ile olusturur. API rastgele aday uretir.
create or replace function public.get_or_create_daily_code(p_account uuid, p_candidate text, p_now timestamptz default null)
returns public.daily_codes language plpgsql security definer set search_path = public as $$
declare
  v_now timestamptz := coalesce(p_now, now());
  v_day date := public.istanbul_day(v_now);
  c public.daily_codes;
begin
  insert into public.daily_codes (mc_account_id, day, code)
  values (p_account, v_day, upper(p_candidate))
  on conflict (mc_account_id, day) do nothing;
  select * into c from public.daily_codes where mc_account_id = p_account and day = v_day;
  return c;
end $$;

-- ---------------------------------------------------------------- mod: oturum

-- Mojang dogrulamasi icin meydan okuma kaydi (tek kullanimlik)
create or replace function public.mod_create_challenge(p_server_id text, p_mc_name text)
returns void language sql security definer set search_path = public as $$
  delete from public.mod_challenges where created_at < now() - interval '10 minutes';
  insert into public.mod_challenges (server_id, mc_name) values (p_server_id, p_mc_name);
$$;

create or replace function public.mod_use_challenge(p_server_id text, p_mc_name text)
returns boolean language plpgsql security definer set search_path = public as $$
begin
  update public.mod_challenges set used_at = now()
   where server_id = p_server_id and lower(mc_name) = lower(p_mc_name)
     and used_at is null and created_at > now() - interval '2 minutes';
  return found;
end $$;

-- Mod oturumu acar. p_mc_uuid, API tarafinda Mojang ile dogrulanmis UUID'dir.
create or replace function public.mod_session_start(
  p_mc_name text, p_mc_uuid uuid, p_code text, p_token_hash text, p_hmac_secret text,
  p_mod_version text, p_ip text, p_now timestamptz default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_now timestamptz := coalesce(p_now, now());
  op public.operator_mc_accounts;
  a public.mc_accounts;
  dc public.daily_codes;
  acc record;
  v_sid uuid;
begin
  if not public.version_gte(p_mod_version, public.setting_text('min_mod_version')) then
    return jsonb_build_object('ok', false, 'reason', 'MOD_OUTDATED', 'min_version', public.setting_text('min_mod_version'));
  end if;

  -- 1) Operator hesabi mi? (kod yok, komisyon yok)
  select * into op from public.operator_mc_accounts
   where (p_mc_uuid is not null and mc_uuid = p_mc_uuid) or lower(mc_name) = lower(p_mc_name)
   order by (mc_uuid is not distinct from p_mc_uuid) desc limit 1;
  if found then
    if op.mc_uuid is not null and p_mc_uuid is not null and op.mc_uuid <> p_mc_uuid then
      return jsonb_build_object('ok', false, 'reason', 'UUID_MISMATCH');
    end if;
    update public.operator_mc_accounts
       set mc_uuid = coalesce(mc_uuid, p_mc_uuid), mc_name = p_mc_name, last_seen_at = v_now where id = op.id;
    update public.bot_sessions set ended_at = v_now, end_reason = 'REPLACED'
     where operator_account_id = op.id and ended_at is null;
    insert into public.bot_sessions (operator_account_id, mc_name, mc_uuid, is_exempt, token_hash, hmac_secret,
                                     mod_version, client_ip, started_at, last_heartbeat_at)
    values (op.id, p_mc_name, p_mc_uuid, true, p_token_hash, p_hmac_secret, p_mod_version, p_ip, v_now, v_now)
    returning id into v_sid;
    perform public._audit('MOD:' || p_mc_name, 'session_start', v_sid::text, jsonb_build_object('exempt', true));
    return public._session_state(v_sid, v_now);
  end if;

  -- 2) Uye hesabi
  select * into a from public.mc_accounts
   where (p_mc_uuid is not null and mc_uuid = p_mc_uuid) or lower(mc_name) = lower(p_mc_name)
   order by (mc_uuid is not distinct from p_mc_uuid) desc limit 1
   for update;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'UNKNOWN_ACCOUNT');
  end if;
  if a.mc_uuid is not null and p_mc_uuid is not null and a.mc_uuid <> p_mc_uuid then
    return jsonb_build_object('ok', false, 'reason', 'UUID_MISMATCH');
  end if;

  acc := public._access(a.id, v_now);
  if not acc.allowed then
    return jsonb_build_object('ok', false, 'reason', acc.reason);
  end if;
  if (select consent_at from public.profiles where id = a.owner_id) is null then
    return jsonb_build_object('ok', false, 'reason', 'CONSENT_REQUIRED');  -- panelde onay verilmemis
  end if;

  -- 3) Gunluk kod (Istanbul gunu)
  select * into dc from public.daily_codes
   where mc_account_id = a.id and day = public.istanbul_day(v_now) and code = upper(trim(p_code));
  if not found then
    perform public._audit('MOD:' || p_mc_name, 'session_denied', a.id::text, jsonb_build_object('reason', 'INVALID_CODE'));
    return jsonb_build_object('ok', false, 'reason', 'INVALID_CODE');
  end if;

  -- 4) Ayni hesapta tek aktif oturum
  update public.bot_sessions set ended_at = v_now, end_reason = 'REPLACED'
   where mc_account_id = a.id and ended_at is null;

  insert into public.bot_sessions (mc_account_id, mc_name, mc_uuid, is_exempt, daily_code_id, token_hash, hmac_secret,
                                   mod_version, client_ip, mode, started_at, last_heartbeat_at)
  values (a.id, p_mc_name, p_mc_uuid, false, dc.id, p_token_hash, p_hmac_secret, p_mod_version, p_ip, acc.mode, v_now, v_now)
  returning id into v_sid;

  update public.daily_codes set use_count = use_count + 1, last_used_at = v_now where id = dc.id;
  update public.mc_accounts set mc_uuid = coalesce(mc_uuid, p_mc_uuid), mc_name = p_mc_name, last_seen_at = v_now
   where id = a.id;
  perform public._open_window(a.id, v_now);
  perform public._audit('MOD:' || p_mc_name, 'session_start', v_sid::text,
                        jsonb_build_object('code_id', dc.id, 'mode', acc.mode, 'version', p_mod_version));
  return public._session_state(v_sid, v_now);
end $$;

-- ---------------------------------------------------------------- mod: heartbeat

-- Mod her ~30 sn'de bir cagirir.
--  p_seq          : artan sira no; tekrar gelen (<= last_seq) uygulanmaz (idempotent)
--  p_running      : otomasyon bu aralikta calisiyor muydu (sadece calisirken sure sayilir)
--  p_profit_delta : son onaylanan heartbeat'ten beri SATISLARDAN gelen net kar degisimi
--                   (gelir - mal maliyeti - ilan vergisi; /pay transferleri HARIC). Negatif olabilir.
--  p_balance      : bilgi amacli bakiye
-- Sure sunucu saatine gore hesaplanir: iki heartbeat arasi, en fazla heartbeat_max_gap_sec.
create or replace function public.mod_heartbeat(
  p_token_hash text, p_seq bigint, p_running boolean, p_profit_delta bigint, p_balance bigint,
  p_now timestamptz default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_now timestamptz := coalesce(p_now, now());
  s public.bot_sessions;
  v_gap numeric;
  v_dt int;
  v_closed jsonb := '[]'::jsonb;
  acc record;
  st jsonb;
begin
  select * into s from public.bot_sessions where token_hash = p_token_hash and ended_at is null for update;
  if not found then
    -- Oturum bitmisse sebebini de don (orn. operator erisimi kapatti) ki mod kullaniciya gostersin
    select * into s from public.bot_sessions where token_hash = p_token_hash;
    return jsonb_build_object('ok', false, 'reason', 'NO_SESSION', 'end_reason',
      case when s.end_reason = 'ACCESS_DISABLED' or s.end_reason like 'ACCESS_DISABLED%'
           then coalesce((select 'ACCESS_DISABLED: ' || blocked_reason from public.mc_accounts where id = s.mc_account_id), s.end_reason)
           else s.end_reason end);
  end if;

  v_gap := extract(epoch from (v_now - s.last_heartbeat_at));
  if v_gap > public.setting_num('session_timeout_sec') then
    update public.bot_sessions set ended_at = v_now, end_reason = 'TIMEOUT' where id = s.id;
    return jsonb_build_object('ok', false, 'reason', 'SESSION_TIMEOUT');
  end if;

  -- Geriye giden sira no (tekrar oynatma / iki istemci ayni token): kaydet
  if p_seq < s.last_seq then
    perform public.security_log(s.id, null, 'SEQ_REGRESSION', 'WARN',
                                jsonb_build_object('got', p_seq, 'last', s.last_seq));
  end if;
  -- Tekrar gelen istek: hicbir sey uygulamadan durumu don
  if p_seq <= s.last_seq then
    return public._session_state(s.id, v_now) || jsonb_build_object('duplicate', true);
  end if;
  if v_gap < public.setting_num('heartbeat_min_interval') then
    return public._session_state(s.id, v_now) || jsonb_build_object('throttled', true);
  end if;
  if abs(coalesce(p_profit_delta, 0)) > 1000000000000 then
    return jsonb_build_object('ok', false, 'reason', 'INVALID_DELTA');
  end if;

  v_dt := case when p_running then least(greatest(v_gap, 0), public.setting_num('heartbeat_max_gap_sec'))::int else 0 end;

  if s.is_exempt then
    update public.operator_mc_accounts
       set profit_total = profit_total + coalesce(p_profit_delta, 0),
           active_seconds_total = active_seconds_total + v_dt, last_seen_at = v_now
     where id = s.operator_account_id;
  else
    update public.mc_accounts
       set profit_total = profit_total + coalesce(p_profit_delta, 0),
           active_seconds_total = active_seconds_total + v_dt,
           last_seen_at = v_now,
           last_balance = coalesce(p_balance, last_balance),
           last_balance_at = case when p_balance is not null then v_now else last_balance_at end
     where id = s.mc_account_id;
    if p_balance is not null then   -- pencerenin ilk bakiye bilgisi (tutarlilik kontrolu icin)
      update public.commission_windows set balance_start = p_balance
       where mc_account_id = s.mc_account_id and status = 'OPEN' and balance_start is null;
    end if;
    v_closed := public._accrue(s.mc_account_id, v_dt, v_now);
  end if;

  update public.bot_sessions set last_heartbeat_at = v_now, last_seq = p_seq, running = coalesce(p_running, false)
   where id = s.id;

  if not s.is_exempt then
    acc := public._access(s.mc_account_id, v_now);
    if not acc.allowed then
      -- Operator erisimi kapatti / kullanici askida: oturum aninda biter, bot durmali
      update public.bot_sessions set ended_at = v_now, end_reason = acc.reason, running = false where id = s.id;
      perform public._audit('SYSTEM', 'session_revoked', s.id::text, jsonb_build_object('reason', acc.reason));
      return jsonb_build_object('ok', true, 'allowed', false, 'reason', acc.reason, 'closed_windows', v_closed);
    end if;
    update public.bot_sessions set mode = acc.mode where id = s.id;
  end if;

  st := public._session_state(s.id, v_now);
  return st || jsonb_build_object('closed_windows', v_closed);
end $$;

-- Mod kapanirken son heartbeat + oturum sonu
create or replace function public.mod_session_end(
  p_token_hash text, p_seq bigint, p_running boolean, p_profit_delta bigint, p_balance bigint,
  p_now timestamptz default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_now timestamptz := coalesce(p_now, now());
  r jsonb;
begin
  r := public.mod_heartbeat(p_token_hash, p_seq, p_running, p_profit_delta, p_balance, v_now);
  update public.bot_sessions set ended_at = v_now, end_reason = coalesce(end_reason, 'CLIENT_END'), running = false
   where token_hash = p_token_hash and ended_at is null;
  return r || jsonb_build_object('ended', true);
end $$;

-- ---------------------------------------------------------------- odemeler

-- Odemeyi bekleyen komisyonlara en eskiden baslayarak dagitir; dagitilamayan kismi dondurur.
create or replace function public._allocate(p_payment bigint, p_account uuid, p_amount bigint, p_now timestamptz)
returns bigint language plpgsql as $$
declare
  c record;
  v_left bigint := p_amount;
  v_take bigint;
begin
  for c in select * from public.commissions
            where mc_account_id = p_account and status in ('PENDING', 'PARTIAL')
            order by created_at, id for update loop
    exit when v_left <= 0;
    v_take := least(c.amount - c.paid, v_left);
    if v_take <= 0 then continue; end if;
    insert into public.payment_allocations (payment_id, commission_id, amount) values (p_payment, c.id, v_take);
    update public.commissions
       set paid = paid + v_take,
           status = case when paid + v_take >= amount then 'PAID' else 'PARTIAL' end,
           settled_at = case when paid + v_take >= amount then p_now else null end
     where id = c.id;
    v_left := v_left - v_take;
  end loop;
  update public.payments set unallocated = v_left where id = p_payment;
  return v_left;
end $$;

-- Alici tarafinin "X paid you" kaydiyla eslestir (gonderen adi + tutar + zaman penceresi)
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
   where matched_payment_id is null
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

-- Mod: "/pay <alici> <tutar>" gonderildi ve "You paid ..." goruldu.
create or replace function public.mod_report_payment(
  p_token_hash text, p_client_tx uuid, p_to_player text, p_amount bigint, p_tax bigint, p_line text,
  p_now timestamptz default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_now timestamptz := coalesce(p_now, now());
  s public.bot_sessions;
  v_pid bigint;
  v_left bigint;
  v_matched boolean;
  v_receiver text := public.setting_text('commission_receiver');
begin
  select * into s from public.bot_sessions where token_hash = p_token_hash and ended_at is null;
  if not found then return jsonb_build_object('ok', false, 'reason', 'NO_SESSION'); end if;
  if s.is_exempt then return jsonb_build_object('ok', false, 'reason', 'EXEMPT_ACCOUNT'); end if;

  select id into v_pid from public.payments where client_tx_id = p_client_tx;
  if found then
    return jsonb_build_object('ok', true, 'duplicate', true, 'payment_id', v_pid,
                              'status', (select status from public.payments where id = v_pid),
                              'due', public._due(s.mc_account_id));
  end if;
  if v_receiver is null or v_receiver = '' or lower(p_to_player) <> lower(v_receiver) then
    return jsonb_build_object('ok', false, 'reason', 'WRONG_RECEIVER', 'pay_to', v_receiver);
  end if;
  if p_amount is null or p_amount <= 0 then
    return jsonb_build_object('ok', false, 'reason', 'INVALID_AMOUNT');
  end if;

  insert into public.payments (mc_account_id, session_id, client_tx_id, to_player, amount, tax, chat_line, claimed_at)
  values (s.mc_account_id, s.id, p_client_tx, p_to_player, p_amount, p_tax, left(p_line, 300), v_now)
  returning id into v_pid;
  v_left := public._allocate(v_pid, s.mc_account_id, p_amount, v_now);
  v_matched := public._try_match(v_pid);
  perform public._audit('MOD:' || s.mc_name, 'payment_claimed', v_pid::text,
                        jsonb_build_object('amount', p_amount, 'unallocated', v_left, 'verified', v_matched));
  return jsonb_build_object('ok', true, 'payment_id', v_pid, 'status', case when v_matched then 'VERIFIED' else 'CLAIMED' end,
                            'unallocated', v_left, 'due', public._due(s.mc_account_id));
end $$;

-- Alici (operator) hesabindaki mod: "X paid you $Y" goruldu.
create or replace function public.mod_report_received(
  p_token_hash text, p_from_player text, p_amount bigint, p_tolerance bigint, p_line text,
  p_now timestamptz default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_now timestamptz := coalesce(p_now, now());
  s public.bot_sessions;
  v_rid bigint;
  p record;
  v_win interval := make_interval(mins => public.setting_num('payment_match_window_min')::int);
begin
  select * into s from public.bot_sessions where token_hash = p_token_hash and ended_at is null;
  if not found then return jsonb_build_object('ok', false, 'reason', 'NO_SESSION'); end if;
  if not s.is_exempt or lower(s.mc_name) <> lower(public.setting_text('commission_receiver')) then
    return jsonb_build_object('ok', false, 'reason', 'NOT_RECEIVER');
  end if;

  insert into public.received_payments (receiver_session, receiver_mc, from_player, amount, tolerance, chat_line, seen_at)
  values (s.id, s.mc_name, p_from_player, p_amount, greatest(coalesce(p_tolerance, 0), 0), left(p_line, 300), v_now)
  returning id into v_rid;

  -- Bekleyen iddia edilmis odemeyle eslestir
  select pay.id into p from public.payments pay join public.mc_accounts a on a.id = pay.mc_account_id
   where pay.status = 'CLAIMED' and lower(a.mc_name) = lower(p_from_player)
     and lower(pay.to_player) = lower(s.mc_name)
     and abs(pay.amount - p_amount) <= greatest(coalesce(p_tolerance, 0), 1)
     and pay.claimed_at between v_now - v_win and v_now + v_win
   order by abs(extract(epoch from (pay.claimed_at - v_now))) limit 1;
  if found then
    perform public._try_match(p.id);
    return jsonb_build_object('ok', true, 'received_id', v_rid, 'matched_payment_id', p.id);
  end if;
  return jsonb_build_object('ok', true, 'received_id', v_rid, 'matched_payment_id', null);
end $$;

-- ---------------------------------------------------------------- operator islemleri

create or replace function public.admin_set_account_access(p_actor uuid, p_account uuid, p_enabled boolean, p_reason text)
returns void language plpgsql security definer set search_path = public as $$
begin
  perform public._require_operator(p_actor);
  update public.mc_accounts
     set access_enabled = p_enabled, blocked_reason = case when p_enabled then null else coalesce(p_reason, 'Operatör kapattı') end
   where id = p_account;
  if not p_enabled then
    -- Acik oturum bir sonraki heartbeat'i beklemeden kapatilir
    update public.bot_sessions set ended_at = now(), end_reason = 'ACCESS_DISABLED', running = false
     where mc_account_id = p_account and ended_at is null;
  end if;
  perform public._audit(p_actor::text, case when p_enabled then 'access_enable' else 'access_disable' end,
                        p_account::text, jsonb_build_object('reason', p_reason));
end $$;

create or replace function public.admin_set_user_status(p_actor uuid, p_user uuid, p_status text, p_reason text)
returns void language plpgsql security definer set search_path = public as $$
begin
  perform public._require_operator(p_actor);
  if p_user = p_actor and p_status <> 'ACTIVE' then raise exception 'CANNOT_SUSPEND_SELF'; end if;
  update public.profiles set status = p_status, suspended_reason = case when p_status = 'ACTIVE' then null else p_reason end
   where id = p_user;
  if p_status <> 'ACTIVE' then
    update public.bot_sessions set ended_at = now(), end_reason = 'USER_SUSPENDED', running = false
     where ended_at is null and mc_account_id in (select id from public.mc_accounts where owner_id = p_user);
  end if;
  perform public._audit(p_actor::text, 'user_status', p_user::text, jsonb_build_object('status', p_status, 'reason', p_reason));
end $$;

create or replace function public.admin_set_role(p_actor uuid, p_user uuid, p_role text)
returns void language plpgsql security definer set search_path = public as $$
begin
  perform public._require_operator(p_actor);
  if p_role = 'UYE' and (select count(*) from public.profiles where role = 'OPERATOR' and status = 'ACTIVE' and id <> p_user) = 0 then
    raise exception 'LAST_OPERATOR';
  end if;
  update public.profiles set role = p_role where id = p_user;
  perform public._audit(p_actor::text, 'set_role', p_user::text, jsonb_build_object('role', p_role));
end $$;

create or replace function public.admin_add_operator_account(p_actor uuid, p_mc_name text, p_mc_uuid uuid, p_note text)
returns public.operator_mc_accounts language plpgsql security definer set search_path = public as $$
declare o public.operator_mc_accounts;
begin
  perform public._require_operator(p_actor);
  if exists (select 1 from public.mc_accounts where lower(mc_name) = lower(p_mc_name)) then
    raise exception 'NAME_IS_MEMBER_ACCOUNT';  -- once uye hesabindan cikarilmali (komisyon gecmisi korunur)
  end if;
  insert into public.operator_mc_accounts (mc_name, mc_uuid, note, created_by)
  values (p_mc_name, p_mc_uuid, p_note, p_actor) returning * into o;
  perform public._audit(p_actor::text, 'operator_account_add', o.id::text, jsonb_build_object('mc_name', p_mc_name));
  return o;
end $$;

create or replace function public.admin_remove_operator_account(p_actor uuid, p_id uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  perform public._require_operator(p_actor);
  update public.bot_sessions set ended_at = now(), end_reason = 'OPERATOR_ACCOUNT_REMOVED'
   where operator_account_id = p_id and ended_at is null;
  delete from public.operator_mc_accounts where id = p_id;
  perform public._audit(p_actor::text, 'operator_account_remove', p_id::text, null);
end $$;

-- Odemeyi onayla / reddet. Red: dagitim geri alinir, borc yeniden acilir.
create or replace function public.admin_verify_payment(p_actor uuid, p_payment bigint, p_accept boolean, p_note text)
returns void language plpgsql security definer set search_path = public as $$
declare al record;
begin
  perform public._require_operator(p_actor);
  if p_accept then
    update public.payments set status = 'VERIFIED', verified_at = now(), verified_by = p_actor::text, note = p_note
     where id = p_payment and status <> 'VERIFIED';
  else
    for al in select * from public.payment_allocations where payment_id = p_payment loop
      update public.commissions
         set paid = paid - al.amount,
             status = case when paid - al.amount <= 0 then 'PENDING' else 'PARTIAL' end,
             settled_at = null
       where id = al.commission_id and status <> 'WAIVED';
    end loop;
    delete from public.payment_allocations where payment_id = p_payment;
    update public.payments set status = 'REJECTED', verified_at = now(), verified_by = p_actor::text, note = p_note
     where id = p_payment;
  end if;
  perform public._audit(p_actor::text, case when p_accept then 'payment_verify' else 'payment_reject' end,
                        p_payment::text, jsonb_build_object('note', p_note));
end $$;

-- Mod disinda (elle) yapilmis odeme kaydi
create or replace function public.admin_manual_payment(p_actor uuid, p_account uuid, p_amount bigint, p_note text)
returns bigint language plpgsql security definer set search_path = public as $$
declare v_pid bigint;
begin
  perform public._require_operator(p_actor);
  insert into public.payments (mc_account_id, client_tx_id, to_player, amount, source, status, verified_at, verified_by, note)
  values (p_account, gen_random_uuid(), coalesce(public.setting_text('commission_receiver'), ''), p_amount,
          'MANUAL', 'VERIFIED', now(), p_actor::text, p_note)
  returning id into v_pid;
  perform public._allocate(v_pid, p_account, p_amount, now());
  perform public._audit(p_actor::text, 'payment_manual', v_pid::text, jsonb_build_object('amount', p_amount));
  return v_pid;
end $$;

create or replace function public.admin_waive_commission(p_actor uuid, p_commission bigint, p_note text)
returns void language plpgsql security definer set search_path = public as $$
begin
  perform public._require_operator(p_actor);
  update public.commissions set status = 'WAIVED', settled_at = now() where id = p_commission and status <> 'PAID';
  perform public._audit(p_actor::text, 'commission_waive', p_commission::text, jsonb_build_object('note', p_note));
end $$;

create or replace function public.admin_set_setting(p_actor uuid, p_key text, p_value jsonb)
returns void language plpgsql security definer set search_path = public as $$
begin
  perform public._require_operator(p_actor);
  if p_key not in (select key from public.settings) then raise exception 'UNKNOWN_SETTING'; end if;
  if p_key = 'tamper_action' and (p_value #>> '{}') not in ('LOG', 'PAY_ONLY', 'BLOCK') then
    raise exception 'INVALID_VALUE: LOG | PAY_ONLY | BLOCK';
  end if;
  if p_key = 'allowed_mod_hashes' and jsonb_typeof(p_value) <> 'array' then
    raise exception 'INVALID_VALUE: dizi bekleniyor';
  end if;
  if p_key = 'commission_rate' and ((p_value #>> '{}')::numeric < 0 or (p_value #>> '{}')::numeric > 1) then
    raise exception 'INVALID_VALUE: 0..1';
  end if;
  update public.settings set value = p_value, updated_at = now(), updated_by = p_actor where key = p_key;
  perform public._audit(p_actor::text, 'setting', p_key, jsonb_build_object('value', p_value));
end $$;

-- Uzun suredir heartbeat gelmeyen oturumlari kapatir (cron: her dakika)
create or replace function public.expire_stale_sessions() returns int
language plpgsql security definer set search_path = public as $$
declare n int;
begin
  update public.bot_sessions set ended_at = now(), end_reason = 'TIMEOUT', running = false
   where ended_at is null and last_heartbeat_at < now() - make_interval(secs => public.setting_num('session_timeout_sec'));
  get diagnostics n = row_count;
  return n;
end $$;

-- ---------------------------------------------------------------- panel gorunumleri
-- security_invoker: okuyanin RLS haklari gecerli (uye sadece kendi satirlarini gorur)

create or replace view public.v_account_overview with (security_invoker = true) as
select
  a.id, a.owner_id, p.display_name as owner_name, a.mc_name, a.mc_uuid,
  a.access_enabled, a.blocked_reason, a.last_seen_at,
  (s.id is not null) as online, coalesce(s.running, false) as running, s.mode as session_mode,
  s.started_at as session_started_at, s.daily_code_id as session_code_id, s.mod_version,
  a.profit_total, a.active_seconds_total, a.last_balance,
  w.window_no as open_window_no, coalesce(w.active_seconds, 0) as open_window_active_seconds,
  coalesce(a.profit_total - w.profit_start, 0) as open_window_profit,
  lw.profit_delta as last_hour_profit, lw.commission as last_hour_commission, lw.closed_at as last_hour_closed_at,
  coalesce(c.total, 0) as commission_total,
  coalesce(c.paid, 0) as commission_paid_claimed,
  coalesce(pv.verified, 0) as payments_verified,
  coalesce(c.open_debt, 0) as pending_debt,
  coalesce(c.overdue, false) as overdue,
  lc.id as last_code_id, lc.day as last_code_day, lc.last_used_at as last_code_used_at, lc.code as last_code,
  a.tamper_flag, a.tamper_reason, a.created_at
from public.mc_accounts a
join public.profiles p on p.id = a.owner_id
left join lateral (select bs.id, bs.running, bs.mode, bs.started_at, bs.daily_code_id, bs.mod_version
                   from public.bot_sessions bs where bs.mc_account_id = a.id and bs.ended_at is null
                   order by bs.started_at desc limit 1) s on true
left join public.commission_windows w on w.mc_account_id = a.id and w.status = 'OPEN'
left join lateral (select * from public.commission_windows cw where cw.mc_account_id = a.id and cw.status = 'CLOSED'
                   order by window_no desc limit 1) lw on true
left join lateral (select sum(amount) filter (where status <> 'WAIVED') as total,
                          sum(paid) as paid,
                          sum(amount - paid) filter (where status in ('PENDING', 'PARTIAL')) as open_debt,
                          bool_or(status in ('PENDING', 'PARTIAL')
                                  and created_at < now() - make_interval(mins => public.setting_num('commission_grace_min')::int)) as overdue
                   from public.commissions cm where cm.mc_account_id = a.id) c on true
left join lateral (select sum(amount) as verified from public.payments py
                   where py.mc_account_id = a.id and py.status = 'VERIFIED') pv on true
left join lateral (select * from public.daily_codes dc where dc.mc_account_id = a.id and dc.last_used_at is not null
                   order by last_used_at desc limit 1) lc on true;

create or replace view public.v_operator_account_overview with (security_invoker = true) as
select o.id, o.mc_name, o.mc_uuid, o.note, o.last_seen_at, o.profit_total, o.active_seconds_total,
       (s.id is not null) as online, coalesce(s.running, false) as running
from public.operator_mc_accounts o
left join lateral (select bs.id, bs.running from public.bot_sessions bs
                   where bs.operator_account_id = o.id and bs.ended_at is null
                   order by bs.started_at desc limit 1) s on true;

-- ---------------------------------------------------------------- yetkiler
-- Motor fonksiyonlari sadece servis rolu (Next.js sunucusu) tarafindan cagrilir.
do $$
declare f record;
begin
  for f in select p.oid::regprocedure as sig from pg_proc p join pg_namespace n on n.oid = p.pronamespace
            where n.nspname = 'public'
              and (p.proname like 'mod\_%' or p.proname like 'admin\_%' or p.proname like '\_%'
                   or p.proname in ('get_or_create_daily_code', 'expire_stale_sessions')) loop
    execute format('revoke all on function %s from public', f.sig);
    if exists (select 1 from pg_roles where rolname = 'service_role') then
      execute format('grant execute on function %s to service_role', f.sig);
    end if;
  end loop;
end $$;
