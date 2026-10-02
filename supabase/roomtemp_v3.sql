-- v3: 센서가 실제로 측정한 시각(ts)으로 저장 + 중복 방지, 일/월/연 조회
create unique index if not exists readings_ts_uniq on roomtemp.readings (ts);

drop function if exists public.roomtemp_ingest(text, numeric, numeric);
create or replace function public.roomtemp_ingest(p_token text, p_temp numeric, p_hum numeric, p_measured_ms bigint)
returns boolean language plpgsql security definer set search_path = '' as $$
declare n int;
begin
  if p_token is distinct from (select v from roomtemp.config where k = 'ingest_token') then
    raise exception 'unauthorized';
  end if;
  insert into roomtemp.readings (ts, temp, hum) values (to_timestamp(p_measured_ms / 1000.0), p_temp, p_hum)
  on conflict (ts) do nothing;
  get diagnostics n = row_count;
  return n > 0;
end $$;
revoke all on function public.roomtemp_ingest(text, numeric, numeric, bigint) from public;
grant execute on function public.roomtemp_ingest(text, numeric, numeric, bigint) to anon;

-- 조회 구간: 1h/24h/7d/30d/all, d:YYYY-MM-DD, m:YYYY-MM, y:YYYY (서울 시간 기준)
create or replace function roomtemp._bounds(p_range text)
returns table(lo timestamptz, hi timestamptz) language sql stable set search_path = '' as $$
  select
    case
      when p_range ~ '^d:\d{4}-\d{2}-\d{2}$' then (substr(p_range,3)::date)::timestamp at time zone 'Asia/Seoul'
      when p_range ~ '^m:\d{4}-\d{2}$' then ((substr(p_range,3) || '-01')::date)::timestamp at time zone 'Asia/Seoul'
      when p_range ~ '^y:\d{4}$' then ((substr(p_range,3) || '-01-01')::date)::timestamp at time zone 'Asia/Seoul'
      when p_range = '1h' then now() - interval '1 hour'
      when p_range = '7d' then now() - interval '7 days'
      when p_range = '30d' then now() - interval '30 days'
      when p_range = 'all' then '-infinity'::timestamptz
      else now() - interval '24 hours' end,
    case
      when p_range ~ '^d:\d{4}-\d{2}-\d{2}$' then ((substr(p_range,3)::date) + 1)::timestamp at time zone 'Asia/Seoul'
      when p_range ~ '^m:\d{4}-\d{2}$' then (((substr(p_range,3) || '-01')::date) + interval '1 month')::timestamp at time zone 'Asia/Seoul'
      when p_range ~ '^y:\d{4}$' then (((substr(p_range,3) || '-01-01')::date) + interval '1 year')::timestamp at time zone 'Asia/Seoul'
      else 'infinity'::timestamptz end
$$;

create or replace function public.roomtemp_history(p_range text)
returns json language plpgsql security definer set search_path = '' stable as $$
declare b record; first_ts timestamptz; last_ts timestamptz; bucket_s int; res json;
begin
  select * into b from roomtemp._bounds(p_range);
  select min(ts), max(ts) into first_ts, last_ts from roomtemp.readings where ts >= b.lo and ts < b.hi;
  bucket_s := greatest(60, ceil(extract(epoch from (coalesce(last_ts, now()) - coalesce(first_ts, now()))) / 160 / 60)::int * 60);
  select json_build_object('bucketMs', bucket_s * 1000, 'points', coalesce(json_agg(p order by p.ts), '[]'::json)) into res
  from (
    select (floor(extract(epoch from ts) / bucket_s) * bucket_s * 1000)::bigint as ts,
      avg(temp)::float as temp, min(temp)::float as tmin, max(temp)::float as tmax,
      avg(hum)::float as hum, min(hum)::float as hmin, max(hum)::float as hmax
    from roomtemp.readings where ts >= b.lo and ts < b.hi group by 1
  ) p;
  return res;
end $$;

create or replace function public.roomtemp_stats(p_range text)
returns json language sql security definer set search_path = '' stable as $$
  with b as (select * from roomtemp._bounds(p_range)),
       r as (select x.* from roomtemp.readings x, b where x.ts >= b.lo and x.ts < b.hi)
  select json_build_object(
    'overall', (select json_build_object(
        'n', count(*), 'temp', avg(temp), 'tmin', min(temp), 'tmax', max(temp),
        'hum', avg(hum), 'hmin', min(hum), 'hmax', max(hum), 'tstd', stddev_pop(temp),
        'tmax_ts', (select (extract(epoch from ts)*1000)::bigint from r where temp is not null order by temp desc, ts desc limit 1),
        'tmin_ts', (select (extract(epoch from ts)*1000)::bigint from r where temp is not null order by temp asc, ts desc limit 1),
        'comfort', avg((temp between 22 and 27 and hum between 40 and 55)::int) * 100,
        'dew', avg(243.12 * (ln(greatest(hum,1)/100.0) + 17.62*temp/(243.12+temp))
                   / (17.62 - (ln(greatest(hum,1)/100.0) + 17.62*temp/(243.12+temp))))
      ) from r),
    'hourly', coalesce((select json_agg(x order by h) from (
        select extract(hour from ts at time zone 'Asia/Seoul')::int as h, avg(temp)::float as temp, avg(hum)::float as hum
        from r group by 1) x), '[]'::json),
    'daily', coalesce((select json_agg(x order by d) from (
        select to_char(ts at time zone 'Asia/Seoul', 'YYYY-MM-DD') as d, avg(temp)::float as temp, avg(hum)::float as hum,
               min(temp)::float as tmin, max(temp)::float as tmax, min(hum)::float as hmin, max(hum)::float as hmax
        from r group by 1) x), '[]'::json),
    'monthly', coalesce((select json_agg(x order by d) from (
        select to_char(ts at time zone 'Asia/Seoul', 'YYYY-MM') as d, avg(temp)::float as temp, avg(hum)::float as hum,
               min(temp)::float as tmin, max(temp)::float as tmax, min(hum)::float as hmin, max(hum)::float as hmax
        from r group by 1) x), '[]'::json)
  )
$$;

-- 데이터가 있는 가장 이른/늦은 측정 시각 (날짜 선택기 범위용)
create or replace function public.roomtemp_bounds()
returns json language sql security definer set search_path = '' stable as $$
  select json_build_object('first', (extract(epoch from min(ts))*1000)::bigint, 'last', (extract(epoch from max(ts))*1000)::bigint) from roomtemp.readings
$$;
revoke all on function public.roomtemp_bounds() from public;
grant execute on function public.roomtemp_bounds() to anon;
