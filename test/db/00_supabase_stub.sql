-- Local-test stub for Supabase's auth schema. Never apply to a real Supabase project.
create schema if not exists auth;
create or replace function auth.uid() returns uuid language sql stable as
  $$ select nullif(current_setting('test.uid', true), '')::uuid $$;
