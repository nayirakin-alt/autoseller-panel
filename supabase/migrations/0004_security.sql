-- =====================================================================
-- AutoSeller Panel - Guvenlik / kurcalama tespiti
--   Moddan gelen butunluk raporu (jar hash, java agent, debugger, gelistirme ortami),
--   sunucu tarafi anomaliler (imza hatasi, geri giden sira no, bakiye-kar tutarsizligi).
--   Kritik olayda tamper_action: LOG (sadece kayit) | PAY_ONLY (sadece odeme) | BLOCK (erisimi kapat)
-- =====================================================================

-- Olay kaydet. Oturum (id ya da token ozeti) verilirse hesap, sahip, gunluk kod otomatik baglanir.
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
  if s.mc_account_id is not null then
    select owner_id into v_owner from public.mc_accounts where id = s.mc_account_id;
  end if;

  -- Kritik olay + uye hesabi -> ayarlanan eylem (operator hesaplari sadece kaydedilir)
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

  insert into public.security_events (kind, severity, session_id, mc_account_id, operator_account_id, owner_id,
                                      mc_name, daily_code_id, action_taken, detail)
  values (p_kind, p_severity, s.id, s.mc_account_id, s.operator_account_id, v_owner,
          s.mc_name, s.daily_code_id, v_action, p_detail);
  return v_action;
end $$;

-- Moddan butunluk raporu (oturum acilisinda ve ~5 dk'da bir):
--   { "jarSha256": "...", "agents": ["-javaagent:x.jar"], "debugger": false, "devEnv": false,
--     "modVersion": "0.7.0", "loader": "fabric 0.16.10" }
create or replace function public.mod_report_integrity(p_token_hash text, p_report jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  s public.bot_sessions;
  v_allowed jsonb := coalesce(public.settings_json('allowed_mod_hashes'), '[]'::jsonb);
  v_hash text := lower(coalesce(p_report ->> 'jarSha256', ''));
  v_flags jsonb := '[]'::jsonb;
  v_action text;
  v_blocked boolean := false;
begin
  select * into s from public.bot_sessions where token_hash = p_token_hash and ended_at is null;
  if not found then return jsonb_build_object('ok', false, 'reason', 'NO_SESSION'); end if;

  if jsonb_array_length(v_allowed) > 0 and not (v_allowed ? v_hash) then
    v_action := public.security_log(s.id, null, 'JAR_HASH_MISMATCH', 'CRITICAL',
                                    jsonb_build_object('jarSha256', v_hash, 'report', p_report));
    v_flags := v_flags || '"JAR_HASH_MISMATCH"'; v_blocked := v_blocked or v_action = 'BLOCKED';
  end if;
  if jsonb_array_length(coalesce(p_report -> 'agents', '[]'::jsonb)) > 0 then
    v_action := public.security_log(s.id, null, 'JAVA_AGENT', 'CRITICAL', jsonb_build_object('agents', p_report -> 'agents'));
    v_flags := v_flags || '"JAVA_AGENT"'; v_blocked := v_blocked or v_action = 'BLOCKED';
  end if;
  if coalesce((p_report ->> 'debugger')::boolean, false) then
    v_action := public.security_log(s.id, null, 'DEBUGGER', 'CRITICAL', jsonb_build_object('report', p_report));
    v_flags := v_flags || '"DEBUGGER"'; v_blocked := v_blocked or v_action = 'BLOCKED';
  end if;
  if coalesce((p_report ->> 'devEnv')::boolean, false) then
    perform public.security_log(s.id, null, 'DEV_ENVIRONMENT', 'WARN', jsonb_build_object('report', p_report));
    v_flags := v_flags || '"DEV_ENVIRONMENT"';
  end if;
  if jsonb_array_length(v_flags) = 0 and coalesce((p_report ->> 'initial')::boolean, false) then
    perform public.security_log(s.id, null, 'INTEGRITY_OK', 'INFO', jsonb_build_object('jarSha256', v_hash,
                                'modVersion', p_report ->> 'modVersion'));
  end if;
  return jsonb_build_object('ok', true, 'flags', v_flags, 'blocked', v_blocked);
end $$;

-- Modun kendi gozlemledigi olaylar (orn. calisirken eklenen agent). Istemci beyanidir -> en fazla WARN.
create or replace function public.mod_report_events(p_token_hash text, p_events jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  s public.bot_sessions;
  e jsonb;
  n int := 0;
begin
  select * into s from public.bot_sessions where token_hash = p_token_hash and ended_at is null;
  if not found then return jsonb_build_object('ok', false, 'reason', 'NO_SESSION'); end if;
  for e in select * from jsonb_array_elements(coalesce(p_events, '[]'::jsonb)) loop
    exit when n >= 20;
    perform public.security_log(s.id, null, 'CLIENT_' || upper(left(coalesce(e ->> 'kind', 'REPORT'), 40)),
                                case when e ->> 'severity' = 'INFO' then 'INFO' else 'WARN' end, e -> 'detail');
    n := n + 1;
  end loop;
  return jsonb_build_object('ok', true, 'logged', n);
end $$;

create or replace function public.settings_json(p_key text) returns jsonb
language sql stable as $$ select value from public.settings where key = p_key $$;

-- Kapanan pencerede bakiye ile bildirilen kar tutarli mi?
--   aciklanamayan = (bakiye_son - bakiye_bas) + o saatte giden odemeler - bildirilen kar
-- Bakiye cok daha fazla arttiysa (kar az bildirilmis olabilir) WARN. Otomatik ceza yok; operator inceler.
create or replace function public._check_balance(p_window bigint) returns void
language plpgsql as $$
declare
  w public.commission_windows;
  v_out bigint;
  v_unexplained bigint;
  v_min bigint := coalesce(public.setting_num('balance_mismatch_min'), 5000000)::bigint;
  v_sid uuid;
begin
  select * into w from public.commission_windows where id = p_window;
  if w.balance_start is null or w.balance_end is null then return; end if;
  select coalesce(sum(amount + coalesce(tax, 0)), 0) into v_out from public.payments
   where mc_account_id = w.mc_account_id and status <> 'REJECTED'
     and claimed_at between w.opened_at and coalesce(w.closed_at, now());
  v_unexplained := (w.balance_end - w.balance_start) + v_out - coalesce(w.profit_delta, 0);
  if v_unexplained > greatest(v_min, abs(coalesce(w.profit_delta, 0)) / 2) then
    select id into v_sid from public.bot_sessions where mc_account_id = w.mc_account_id
     order by started_at desc limit 1;
    perform public.security_log(v_sid, null, 'BALANCE_PROFIT_MISMATCH', 'WARN', jsonb_build_object(
      'window_no', w.window_no, 'balance_start', w.balance_start, 'balance_end', w.balance_end,
      'payments_out', v_out, 'reported_profit', w.profit_delta, 'unexplained', v_unexplained));
  end if;
end $$;

-- Operator: kurcalama bayragini kaldir (inceleme sonrasi)
create or replace function public.admin_clear_tamper(p_actor uuid, p_account uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  perform public._require_operator(p_actor);
  update public.mc_accounts set tamper_flag = false, tamper_reason = null where id = p_account;
  perform public._audit(p_actor::text, 'tamper_clear', p_account::text, null);
end $$;

-- Panel: guvenlik loglari (kullanici, MC hesabi, gunluk kod, zaman, detay)
create or replace view public.v_security_events with (security_invoker = true) as
select e.id, e.at, e.kind, e.severity, e.action_taken, e.detail, e.session_id,
       e.mc_account_id, e.operator_account_id, e.mc_name, e.daily_code_id,
       dc.code as daily_code, p.display_name as owner_name, e.owner_id,
       (e.operator_account_id is not null) as is_operator_account
from public.security_events e
left join public.profiles p on p.id = e.owner_id
left join public.daily_codes dc on dc.id = e.daily_code_id;

alter table public.security_events enable row level security;
create policy security_events_read on public.security_events for select using (public.is_operator());
grant select on public.security_events, public.v_security_events to authenticated;

-- Hesap gorunumune kurcalama bayragi
create or replace view public.v_account_flags with (security_invoker = true) as
select a.id, a.tamper_flag, a.tamper_reason,
       (select count(*) from public.security_events e where e.mc_account_id = a.id and e.severity = 'CRITICAL') as critical_events,
       (select max(at) from public.security_events e where e.mc_account_id = a.id and e.severity <> 'INFO') as last_event_at
from public.mc_accounts a;
grant select on public.v_account_flags to authenticated;

do $$
declare f record;
begin
  for f in select p.oid::regprocedure as sig from pg_proc p join pg_namespace n on n.oid = p.pronamespace
            where n.nspname = 'public'
              and p.proname in ('security_log', 'mod_report_integrity', 'mod_report_events', '_check_balance',
                                'admin_clear_tamper', 'settings_json') loop
    execute format('revoke all on function %s from public', f.sig);
    if exists (select 1 from pg_roles where rolname = 'service_role') then
      execute format('grant execute on function %s to service_role', f.sig);
    end if;
  end loop;
end $$;
