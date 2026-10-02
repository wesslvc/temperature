-- 온습도 대시보드용 스키마 (다른 테이블과 분리된 roomtemp 스키마)
create schema if not exists roomtemp;
create table if not exists roomtemp.readings (
  ts timestamptz not null default now(),
  temp numeric(5,1),
  hum numeric(5,1)
);
create index if not exists readings_ts_idx on roomtemp.readings (ts);
create table if not exists roomtemp.config (k text primary key, v text not null);
alter table roomtemp.readings enable row level security;
alter table roomtemp.config enable row level security;

create or replace function public.roomtemp_ingest(p_token text, p_temp numeric, p_hum numeric)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if p_token is distinct from (select v from roomtemp.config where k = 'ingest_token') then
    raise exception 'unauthorized';
  end if;
  insert into roomtemp.readings (temp, hum) values (p_temp, p_hum);
end $$;

create or replace function public.roomtemp_current()
returns json language sql security definer set search_path = '' stable as $$
  select coalesce((select json_build_object('ts', (extract(epoch from ts)*1000)::bigint, 'temp', temp, 'hum', hum)
         from roomtemp.readings order by ts desc limit 1), 'null'::json)
$$;

create or replace function roomtemp._since(p_range text)
returns timestamptz language sql stable set search_path = '' as $$
  select case p_range when '1h' then now() - interval '1 hour' when '24h' then now() - interval '24 hours'
    when '7d' then now() - interval '7 days' when '30d' then now() - interval '30 days'
    when 'all' then '-infinity'::timestamptz else now() - interval '24 hours' end
$$;

create or replace function public.roomtemp_history(p_range text)
returns json language plpgsql security definer set search_path = '' stable as $$
declare since timestamptz := roomtemp._since(p_range); first_ts timestamptz; bucket_s int; res json;
begin
  select coalesce(min(ts), now()) into first_ts from roomtemp.readings where ts >= since;
  bucket_s := greatest(60, ceil(extract(epoch from (now() - first_ts)) / 160 / 60)::int * 60);
  select json_build_object('bucketMs', bucket_s * 1000, 'points', coalesce(json_agg(p order by p.ts), '[]'::json)) into res
  from (
    select (floor(extract(epoch from ts) / bucket_s) * bucket_s * 1000)::bigint as ts,
      avg(temp)::float as temp, min(temp)::float as tmin, max(temp)::float as tmax,
      avg(hum)::float as hum, min(hum)::float as hmin, max(hum)::float as hmax
    from roomtemp.readings where ts >= since group by 1
  ) p;
  return res;
end $$;

create or replace function public.roomtemp_stats(p_range text)
returns json language sql security definer set search_path = '' stable as $$
  with r as (select * from roomtemp.readings where ts >= roomtemp._since(p_range))
  select json_build_object(
    'overall', (select json_build_object('n', count(*), 'temp', avg(temp), 'tmin', min(temp), 'tmax', max(temp),
                 'hum', avg(hum), 'hmin', min(hum), 'hmax', max(hum)) from r),
    'hourly', coalesce((select json_agg(x order by h) from (
        select extract(hour from ts at time zone 'Asia/Seoul')::int as h, avg(temp)::float as temp, avg(hum)::float as hum
        from r group by 1) x), '[]'::json),
    'daily', coalesce((select json_agg(x order by d) from (
        select to_char(ts at time zone 'Asia/Seoul', 'YYYY-MM-DD') as d, avg(temp)::float as temp, avg(hum)::float as hum,
               min(temp)::float as tmin, max(temp)::float as tmax
        from r group by 1) x), '[]'::json)
  )
$$;

revoke all on function public.roomtemp_ingest(text,numeric,numeric), public.roomtemp_current(),
  public.roomtemp_history(text), public.roomtemp_stats(text) from public;
grant execute on function public.roomtemp_ingest(text,numeric,numeric), public.roomtemp_current(),
  public.roomtemp_history(text), public.roomtemp_stats(text) to anon;
