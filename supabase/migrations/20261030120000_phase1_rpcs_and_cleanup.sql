-- Phase 1: seed split, cleanup, carry link, logged_date in Lisbon time, RPCs.
-- Already applied to project yvsjchzvoikqlpbqsphs; kept here as a record.

-- 1. Float junk out: value is whole cents, so make the type say so.
alter table public.bottle_log drop constraint bottle_log_source_check;
update public.bottle_log set value = round(value, 2);
alter table public.bottle_log alter column value type numeric(12,2);
update public.bottle_log set unit_value = round(value / qty, 4);

-- 2. Split the mixed seed (61.00) into two rows, same dates, 36.10 + 24.90.
insert into public.bottle_log (created_at, logged_date, qty, source, unit_value, value, invested_at)
select created_at, logged_date, 1, 'seed_profit', 36.10, 36.10, invested_at from public.bottle_log where source = 'seed'
union all
select created_at, logged_date, 1, 'seed_deposit', 24.90, 24.90, invested_at from public.bottle_log where source = 'seed';
delete from public.bottle_log where source = 'seed';

alter table public.bottle_log add constraint bottle_log_source_check
  check (source in ('profit', 'deposit', 'seed_profit', 'seed_deposit', 'carry', 'expense'));
-- expenses are negative, everything else is not
alter table public.bottle_log add constraint bottle_log_value_sign_check
  check ((source = 'expense') = (value < 0));
-- a bottle row is always qty * 0.10
alter table public.bottle_log add constraint bottle_log_bottle_value_check
  check (source not in ('profit', 'deposit') or value = round(qty * 0.10, 2));

-- 3. Link a carry row to the buy that created it. created_at is not reliable
--    (old carries sit 1 to 80 seconds after the buy), a foreign key is.
alter table public.bottle_log add column carry_from uuid references public.investments (id) on delete set null;
update public.bottle_log b
set carry_from = (select i.id from public.investments i where i.invested_at <= b.created_at order by i.invested_at desc limit 1)
where b.source = 'carry';
alter table public.bottle_log add constraint bottle_log_carry_from_check
  check (carry_from is null or source = 'carry');

-- 4. logged_date is the Europe/Lisbon day of created_at, always.
alter table public.bottle_log alter column logged_date set default ((now() at time zone 'Europe/Lisbon')::date);
create function public.bottle_log_set_logged_date() returns trigger
language plpgsql set search_path = public as $$
begin
  new.logged_date := (new.created_at at time zone 'Europe/Lisbon')::date;
  return new;
end $$;
create trigger bottle_log_logged_date before insert or update of created_at on public.bottle_log
  for each row execute function public.bottle_log_set_logged_date();
update public.bottle_log set logged_date = (created_at at time zone 'Europe/Lisbon')::date
where logged_date <> (created_at at time zone 'Europe/Lisbon')::date;

-- 5. Comments.
comment on column public.bottle_log.source is
  'profit = found or machine over-count (new money). deposit = own bottles or returned for someone else. seed_profit / seed_deposit = opening balance, split by the profit:deposit ratio of the first weeks. carry = leftover cents from a buy (see carry_from). expense = a cost, negative value, described in note.';
comment on column public.bottle_log.value is
  'Cash added to the pot, in euros with 2 decimals. Source of truth for every total. profit and deposit: qty * 0.10 (enforced). carry and seed_*: free. expense: negative.';
comment on column public.bottle_log.unit_value is
  'Informational only, never summed: round(value / qty, 4). 0.10 for bottles, the full value for carry and seed_* (qty 1), the price per unit (negative) for expense.';
comment on column public.bottle_log.qty is
  'Bottles for profit and deposit. For expense, the quantity bought. 1 for carry and seed_*.';
comment on column public.bottle_log.note is 'Description of an expense. Null otherwise.';
comment on column public.bottle_log.carry_from is 'Only for carry: the investments row whose leftover cents this row holds.';

-- 6. Owner can edit and delete buys (insert and select policies already exist).
create policy owner_update on public.investments for update to authenticated
  using ((select auth.uid()) = 'c1008bcf-c954-4032-9fbb-67a5479b9ca0'::uuid)
  with check ((select auth.uid()) = 'c1008bcf-c954-4032-9fbb-67a5479b9ca0'::uuid);
create policy owner_delete on public.investments for delete to authenticated
  using ((select auth.uid()) = 'c1008bcf-c954-4032-9fbb-67a5479b9ca0'::uuid);

-- 7. mark_invested: one transaction, total computed here and never taken from the client.
--    LOCK TABLE serialises two buys and blocks writes to bottle_log until commit.
create function public.mark_invested(p_share_price numeric default null, p_shares numeric default null)
returns jsonb language plpgsql security invoker set search_path = public as $$
declare
  v_now timestamptz := now();
  v_cents bigint;
  v_amount bigint;
  v_rem bigint;
  v_id uuid;
begin
  if p_share_price is not null and p_share_price <= 0 then raise exception 'share price must be positive'; end if;
  if p_shares is not null and p_shares <= 0 then raise exception 'shares must be positive'; end if;

  lock table public.bottle_log in share row exclusive mode;
  select coalesce(sum(round(value * 100)), 0)::bigint into v_cents from public.bottle_log where invested_at is null;
  v_amount := floor(v_cents / 100.0)::bigint;
  if v_amount < 1 then
    raise exception 'pending total is below 1 euro (% cents)', v_cents;
  end if;
  v_rem := v_cents - v_amount * 100;

  insert into public.investments (invested_at, amount, share_price, shares)
  values (v_now, v_amount, p_share_price, p_shares) returning id into v_id;
  update public.bottle_log set invested_at = v_now where invested_at is null;
  if v_rem > 0 then
    insert into public.bottle_log (created_at, qty, source, unit_value, value, carry_from)
    values (v_now, 1, 'carry', v_rem / 100.0, v_rem / 100.0, v_id);
  end if;
  return jsonb_build_object('amount', v_amount, 'remainder', v_rem / 100.0);
end $$;

-- 8. edit_investment: amount is fixed. Moving the date moves the stamp on the
--    rows of that buy and the created_at of the carry it generated. The new date
--    must stay between the neighbouring buys.
create function public.edit_investment(p_id uuid, p_invested_at timestamptz, p_share_price numeric, p_shares numeric)
returns void language plpgsql security invoker set search_path = public as $$
declare
  v_old timestamptz;
  v_prev timestamptz;
  v_next timestamptz;
begin
  if p_invested_at is null then raise exception 'date is required'; end if;
  if p_share_price is not null and p_share_price <= 0 then raise exception 'share price must be positive'; end if;
  if p_shares is not null and p_shares <= 0 then raise exception 'shares must be positive'; end if;

  lock table public.bottle_log in share row exclusive mode;
  select invested_at into v_old from public.investments where id = p_id for update;
  if not found then raise exception 'buy not found'; end if;

  if p_invested_at <> v_old then
    if p_invested_at > now() then raise exception 'date is in the future'; end if;
    select max(invested_at) into v_prev from public.investments where invested_at < v_old;
    select min(invested_at) into v_next from public.investments where invested_at > v_old;
    if (v_prev is not null and p_invested_at <= v_prev) or (v_next is not null and p_invested_at >= v_next) then
      raise exception 'date must stay between the neighbouring buys';
    end if;
    update public.bottle_log set invested_at = p_invested_at where invested_at = v_old;
    update public.bottle_log set created_at = p_invested_at where carry_from = p_id;
  end if;

  update public.investments set invested_at = p_invested_at, share_price = p_share_price, shares = p_shares where id = p_id;
end $$;

-- 9. undo_last_investment: only the newest buy. Its rows go back to pending and
--    the carry it created (carry_from) is deleted.
create function public.undo_last_investment() returns jsonb
language plpgsql security invoker set search_path = public as $$
declare
  v_id uuid;
  v_at timestamptz;
  v_amount numeric;
  v_restored int;
begin
  lock table public.bottle_log in share row exclusive mode;
  select id, invested_at, amount into v_id, v_at, v_amount
  from public.investments order by invested_at desc limit 1 for update;
  if not found then raise exception 'no buys to undo'; end if;

  delete from public.bottle_log where carry_from = v_id and invested_at is null;
  update public.bottle_log set invested_at = null where invested_at = v_at;
  get diagnostics v_restored = row_count;
  delete from public.investments where id = v_id;
  return jsonb_build_object('amount', v_amount, 'restored', v_restored);
end $$;

revoke all on function public.mark_invested(numeric, numeric) from public, anon;
revoke all on function public.edit_investment(uuid, timestamptz, numeric, numeric) from public, anon;
revoke all on function public.undo_last_investment() from public, anon;
grant execute on function public.mark_invested(numeric, numeric) to authenticated;
grant execute on function public.edit_investment(uuid, timestamptz, numeric, numeric) to authenticated;
grant execute on function public.undo_last_investment() to authenticated;
