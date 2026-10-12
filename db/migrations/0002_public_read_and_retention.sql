-- 0002_public_read_and_retention.sql
--
-- Replaces the security-definer public_observations view and the unconditional
-- delete ban with a least-privilege public read path and a source retention purge.
--
-- Public read:
--   * The view is security_invoker and security_barrier. It runs as the caller,
--     so row level security on inventory_observations applies. It does not bypass RLS.
--   * anon/authenticated receive SELECT on display columns only. reporter_id is not granted.
--   * observation_is_public_row is the single predicate, used by both the view and RLS:
--     non-synthetic, accepted community or verified trusted rows, from a VERIFIED
--     source whose kill switch is off, and not past a purge_after / do_not_retain rule.
--   * OFFSET 0 makes the view non-updatable. There is no INSERT/UPDATE/DELETE grant
--     and no write policy, so callers cannot change observations through the view.
--   * Table owner postgres (superuser) still bypasses RLS. That is the server role.
--     FORCE ROW LEVEL SECURITY covers a non-superuser owner. This migration does not
--     claim a hosted database has been configured.
--
-- Retention:
--   * Ordinary deletes still fail. purge_expired_source_data is SECURITY DEFINER,
--     executable only by retention_worker (and its owner), and sets a transaction-local
--     flag the trigger accepts only when current_user is the function owner.
--   * purge_after deletes the observation and derived rows that carry its quantities
--     (stock changes, notification events, moderation, abuse reports). The audit row
--     stores counts only.
--   * do_not_retain deletes every payload for that source.
--   * retain keeps rows. Community rows older than display_max_age are marked expired
--     so they leave the public predicate. History is not deleted.
--   * Best Buy stays unauthorized in the application registry. The 72-hour policy is
--     the contractual ceiling if rows ever exist; it is not permission to call the API.

select 'create role ' || quote_ident(rolname) || ' nologin'
from (values ('anon'), ('authenticated'), ('retention_worker')) as needed(rolname)
where not exists (select 1 from pg_roles where pg_roles.rolname = needed.rolname)
\gexec

begin;

grant usage on schema public to anon, authenticated, retention_worker;

-- ---------------------------------------------------------------- retention policies
create table source_retention_policies (
  source_id text primary key,
  mode text not null check (mode in ('retain', 'purge_after', 'do_not_retain')),
  max_age interval,
  display_max_age interval,
  contractual_basis text not null,
  provisional boolean not null,
  check (mode <> 'purge_after' or (max_age is not null and max_age > interval '0')),
  check (mode = 'purge_after' or max_age is null),
  check (display_max_age is null or display_max_age > interval '0')
);

-- Keep these rows aligned with src/domain/source-policy.js.
insert into source_retention_policies
  (source_id, mode, max_age, display_max_age, contractual_basis, provisional)
values
  ('walmart_affiliate_api', 'do_not_retain', null, null,
   'Store-level Walmart access is BLOCKED. API terms were not readable. Do not retain payloads.', true),
  ('target', 'do_not_retain', null, null,
   'No authorized Target inventory path. Site terms prohibit scraping. Do not retain payloads.', true),
  ('gamestop', 'do_not_retain', null, null,
   'GameStop terms could not be read. Access is UNVERIFIED. Do not retain payloads.', true),
  ('bestbuy_developer_api', 'purge_after', interval '72 hours', null,
   'Best Buy developer terms prohibit caching API content for more than 72 hours. Derived rows are deleted with the observation. The adapter stays disabled.', false),
  ('community', 'retain', null, interval '12 hours',
   'First-party sightings are kept. The 12-hour public display window is provisional, not a retailer cache limit.', true),
  ('synthetic_demo', 'retain', null, null,
   'Synthetic fixtures are for tests. Production inserts are rejected by reject_synthetic_in_prod.', true);

-- ---------------------------------------------------------------- public predicate
create or replace function observation_is_public_row(
  p_is_synthetic boolean,
  p_source_type text,
  p_verification_status text,
  p_source_id text,
  p_received_at timestamptz
) returns boolean
language sql
stable
security invoker
set search_path = pg_catalog, public
as $$
  select
    not p_is_synthetic
    and (
      (p_source_type <> 'community_report' and p_verification_status = 'verified')
      or (p_source_type = 'community_report' and p_verification_status = 'accepted')
    )
    and exists (
      select 1
      from public.inventory_sources s
      where s.id = p_source_id
        and s.authorization_status = 'VERIFIED'
        and s.kill_switch = false
    )
    and not exists (
      select 1
      from public.source_retention_policies p
      where p.source_id = p_source_id
        and (
          p.mode = 'do_not_retain'
          or (p.mode = 'purge_after' and p_received_at <= pg_catalog.now() - p.max_age)
        )
    );
$$;

revoke all on function observation_is_public_row(boolean, text, text, text, timestamptz) from public;
grant execute on function observation_is_public_row(boolean, text, text, text, timestamptz) to anon, authenticated;

-- ---------------------------------------------------------------- purge
create or replace function obs_guard() returns trigger
language plpgsql
as $$
begin
  if tg_op = 'DELETE' then
    if current_setting('app.retention_purge', true) = 'on'
       and current_user = pg_get_userbyid((
         select proowner
         from pg_proc
         where proname = 'purge_expired_source_data'
           and pronamespace = 'public'::regnamespace
         limit 1
       ))
    then
      return old;
    end if;
    raise exception 'inventory_observations are append-only';
  end if;
  if tg_op = 'UPDATE' then
    if (to_jsonb(new) - 'verification_status') <> (to_jsonb(old) - 'verification_status') then
      raise exception 'only verification_status may change on an observation';
    end if;
    if old.source_type <> 'community_report' and new.verification_status <> old.verification_status then
      raise exception 'trusted observations cannot be re-moderated';
    end if;
  end if;
  return new;
end $$;

create or replace function purge_expired_source_data(p_now timestamptz default now())
returns table(source_id text, deleted_observations integer, expired_observations integer)
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  pol public.source_retention_policies%rowtype;
  v_ids uuid[];
  v_deleted integer;
  v_expired integer;
  v_audit jsonb := '[]'::jsonb;
  owner_name name;
begin
  select pg_get_userbyid(proowner) into owner_name
  from pg_proc
  where proname = 'purge_expired_source_data'
    and pronamespace = 'public'::regnamespace;

  if session_user is distinct from owner_name
     and not pg_has_role(session_user, 'retention_worker', 'member') then
    raise exception 'retention purge is restricted';
  end if;

  perform set_config('app.retention_purge', 'on', true);

  for pol in select * from public.source_retention_policies loop
    select coalesce(array_agg(o.id), '{}'::uuid[]) into v_ids
    from public.inventory_observations o
    where o.source_id = pol.source_id
      and (
        pol.mode = 'do_not_retain'
        or (pol.mode = 'purge_after' and o.received_at <= p_now - pol.max_age)
      );

    v_deleted := cardinality(v_ids);
    if v_deleted > 0 then
      delete from public.delivery_attempts da
      using public.notification_events ne
      where da.notification_event_id = ne.id
        and ne.observation_id = any(v_ids);

      delete from public.notification_events where observation_id = any(v_ids);
      delete from public.stock_changes
      where previous_observation_id = any(v_ids)
         or new_observation_id = any(v_ids);
      delete from public.moderation_actions where observation_id = any(v_ids);
      delete from public.abuse_reports where observation_id = any(v_ids);
      delete from public.inventory_observations where id = any(v_ids);
    end if;

    v_expired := 0;
    if pol.mode = 'retain' and pol.display_max_age is not null then
      update public.inventory_observations as obs
      set verification_status = 'expired'
      where obs.source_id = pol.source_id
        and obs.source_type = 'community_report'
        and obs.verification_status in ('pending', 'accepted')
        and obs.received_at <= p_now - pol.display_max_age;
      get diagnostics v_expired = row_count;
    end if;

    v_audit := v_audit || jsonb_build_array(jsonb_build_object(
      'source_id', pol.source_id,
      'deleted', v_deleted,
      'expired', v_expired
    ));

    source_id := pol.source_id;
    deleted_observations := v_deleted;
    expired_observations := v_expired;
    return next;
  end loop;

  perform set_config('app.retention_purge', 'off', true);

  insert into public.audit_log (actor, action, subject, detail)
  values (session_user, 'retention_purge', 'source_retention',
          jsonb_build_object('at', p_now, 'sources', v_audit));
end $$;

revoke all on function purge_expired_source_data(timestamptz) from public;
grant execute on function purge_expired_source_data(timestamptz) to retention_worker;

-- ---------------------------------------------------------------- public read grants
revoke all on inventory_observations from public, anon, authenticated;
alter table inventory_observations force row level security;

drop policy if exists observations_public_read on inventory_observations;
create policy observations_public_read on inventory_observations
  for select
  to anon, authenticated
  using (observation_is_public_row(
    is_synthetic, source_type, verification_status, source_id, received_at
  ));

grant select (
  id, product_id, store_id, source_id, source_type, availability,
  quantity_kind, quantity_exact, quantity_min, quantity_max,
  source_timestamp, received_at, verification_status, is_synthetic
) on inventory_observations to anon, authenticated;

grant select (id, authorization_status, kill_switch) on inventory_sources to anon, authenticated;
grant select (source_id, mode, max_age) on source_retention_policies to anon, authenticated;

drop view if exists public_observations;
create view public_observations
with (security_invoker = true, security_barrier = true) as
select id, product_id, store_id, source_id, source_type, availability,
       quantity_kind, quantity_exact, quantity_min, quantity_max,
       source_timestamp, received_at, verification_status,
       (source_type = 'community_report') as community_reported
from inventory_observations
where observation_is_public_row(
  is_synthetic, source_type, verification_status, source_id, received_at
)
offset 0;

revoke all on public_observations from public;
grant select on public_observations to anon, authenticated;

revoke all on subscriptions, moderation_actions, abuse_reports, audit_log,
  notification_events, delivery_attempts, stock_changes
  from public, anon, authenticated;

comment on view public_observations is
  'Security-invoker projection of explicitly public observations. Hides reporter_id. Not a resolved stock status: callers must not treat the newest community row as authoritative.';

commit;
