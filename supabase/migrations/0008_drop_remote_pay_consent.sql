-- =====================================================================
-- AutoSeller Panel - 0008: "Odeme al" is emrinden uzaktan odeme onayi sartini kaldir
-- Tekrar calistirilabilir. 0001-0007 uzerine calistirilir.
--
--  * admin_create_job: NO_REMOTE_PAY_CONSENT kontrolu kaldirildi. Operator tutar yazinca
--    dogrudan PAY emri olusur. Diger korumalar (kasa secili olmali, tek acik PAY emri,
--    gecerli tutar) ve mod tarafi odeme/dogrulama mekanigi aynen korunur.
--  * remote_pay_consent sutunu ve member_remote_pay_consent fonksiyonu geriye donuk uyumluluk
--    icin birakildi; artik hicbir yerde sart degil.
-- =====================================================================

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
    -- 0008: uzaktan odeme onayi (remote_pay_consent) sarti kaldirildi.
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

do $$
declare f record;
begin
  for f in select p.oid::regprocedure as sig from pg_proc p join pg_namespace n on n.oid = p.pronamespace
            where n.nspname = 'public' and p.proname = 'admin_create_job' loop
    execute format('revoke all on function %s from public', f.sig);
    if exists (select 1 from pg_roles where rolname = 'service_role') then
      execute format('grant execute on function %s to service_role', f.sig);
    end if;
  end loop;
end $$;
