-- =====================================================================
-- AutoSeller Panel - 0007: "+odeme" korumasi (sadece panel/borc mantigi; mod uclari degismez)
-- Tekrar calistirilabilir. 0001-0006 uzerine calistirilir.
--
--  * admin_manual_payment (eski "+odeme") artik borcu kanitsiz dusmez: hata verir.
--  * Yerine admin_manual_payment_from_received: kasa hesabinda GORULMUS ama hicbir kayda
--    eslesmemis bir gelen odemeyi (received_payments) secip uyenin borcuna dusurur.
--    Kanit olmadan borc dusmenin tek yolu yine "Odeme al" bot is emri (0006) ya da komisyon affidir.
-- =====================================================================

create or replace function public.admin_manual_payment(p_actor uuid, p_account uuid, p_amount bigint, p_note text)
returns bigint language plpgsql security definer set search_path = public as $$
begin
  perform public._require_operator(p_actor);
  raise exception 'MANUAL_PAYMENT_NEEDS_PROOF: kasada görülmüş bir ödeme seç ya da "Ödeme al" iş emri oluştur';
end $$;

-- Hesabin MC adindan kasaya gelen, henuz hicbir kayda baglanmamis odemeler
create or replace function public.admin_unmatched_received(p_actor uuid, p_account uuid)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare v_name text;
begin
  perform public._require_operator(p_actor);
  select mc_name into v_name from public.mc_accounts where id = p_account;
  if v_name is null then raise exception 'UNKNOWN_ACCOUNT'; end if;
  return coalesce((select jsonb_agg(jsonb_build_object('id', r.id, 'amount', r.amount, 'receiver_mc', r.receiver_mc,
                                                       'seen_at', r.seen_at, 'chat_line', r.chat_line) order by r.seen_at desc)
                     from public.received_payments r
                    where lower(r.from_player) = lower(v_name)
                      and r.matched_payment_id is null and r.matched_rank_order_id is null
                      and r.matched_request_id is null and r.matched_job_id is null
                      and r.seen_at > now() - interval '30 days'), '[]'::jsonb);
end $$;

-- Kasada gorulmus odemeyi borca say: dogrulanmis odeme kaydi olusturur ve gelen odemeye baglar
create or replace function public.admin_manual_payment_from_received(p_actor uuid, p_account uuid, p_received bigint, p_note text)
returns bigint language plpgsql security definer set search_path = public as $$
declare
  r public.received_payments;
  v_name text;
  v_pid bigint;
begin
  perform public._require_operator(p_actor);
  select mc_name into v_name from public.mc_accounts where id = p_account;
  if v_name is null then raise exception 'UNKNOWN_ACCOUNT'; end if;
  select * into r from public.received_payments where id = p_received for update;
  if not found then raise exception 'UNKNOWN_RECEIVED'; end if;
  if lower(r.from_player) <> lower(v_name) then raise exception 'RECEIVED_FROM_OTHER_PLAYER'; end if;
  if r.matched_payment_id is not null or r.matched_rank_order_id is not null
     or r.matched_request_id is not null or r.matched_job_id is not null then
    raise exception 'RECEIVED_ALREADY_USED';
  end if;
  insert into public.payments (mc_account_id, client_tx_id, to_player, amount, source, status, verified_at, verified_by, note, claimed_at)
  values (p_account, gen_random_uuid(), r.receiver_mc, r.amount, 'MANUAL', 'VERIFIED', r.seen_at,
          'OPERATOR:' || p_actor || ' / RECEIVED:' || r.id, left(p_note, 200), r.seen_at)
  returning id into v_pid;
  update public.received_payments set matched_payment_id = v_pid where id = r.id;
  perform public._allocate(v_pid, p_account, r.amount, now());
  perform public._audit(p_actor::text, 'payment_manual_received', v_pid::text,
                        jsonb_build_object('received', r.id, 'amount', r.amount));
  return v_pid;
end $$;

do $$
declare f record;
begin
  for f in select p.oid::regprocedure as sig from pg_proc p join pg_namespace n on n.oid = p.pronamespace
            where n.nspname = 'public'
              and p.proname in ('admin_manual_payment', 'admin_unmatched_received', 'admin_manual_payment_from_received') loop
    execute format('revoke all on function %s from public', f.sig);
    if exists (select 1 from pg_roles where rolname = 'service_role') then
      execute format('grant execute on function %s to service_role', f.sig);
    end if;
  end loop;
end $$;
