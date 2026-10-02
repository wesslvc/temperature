-- v5 (v4 + 주 단위 구간, 구간 끝 제외, 최고/최저 습도 시각, 구간별 히트맵): 측정값 사이를 직선으로 보간한 값(사잇값)으로 집계/차트 생성

-- [lo, hi] 를 n 등분한 시각마다, 앞뒤 실측값을 직선으로 이은 값을 돌려준다.
create or replace function roomtemp._interp(p_lo timestamptz, p_hi timestamptz, p_n int)
returns table(ts timestamptz, temp float8, hum float8)
language sql stable set search_path = '' as $$
  select g.t,
    case when n.ts is null or n.ts = p.ts then p.temp::float8
         else p.temp + (n.temp - p.temp) * extract(epoch from g.t - p.ts) / extract(epoch from n.ts - p.ts) end,
    case when n.ts is null or n.ts = p.ts then p.hum::float8
         else p.hum + (n.hum - p.hum) * extract(epoch from g.t - p.ts) / extract(epoch from n.ts - p.ts) end
  from (select p_lo + (p_hi - p_lo) * (i::float8 / greatest(p_n, 1)) as t from generate_series(0, greatest(p_n, 1)) i) g
  cross join lateral (select r.ts, r.temp, r.hum from roomtemp.readings r where r.ts <= g.t order by r.ts desc limit 1) p
  left join lateral (select r.ts, r.temp, r.hum from roomtemp.readings r where r.ts > g.t order by r.ts asc limit 1) n on true
$$;

create or replace function public.roomtemp_current()
returns json language sql security definer set search_path = '' stable as $$
  with l as (select ts, temp, hum from roomtemp.readings order by ts desc limit 2),
       a as (select * from l order by ts desc limit 1),
       b as (select * from l order by ts asc limit 1)
  select case when not exists (select 1 from a) then 'null'::json else json_build_object(
    'ts', (select (extract(epoch from ts)*1000)::bigint from a), 'temp', (select temp from a), 'hum', (select hum from a),
    'prev', case when (select count(*) from l) < 2 then null else
       (select json_build_object('ts', (extract(epoch from ts)*1000)::bigint, 'temp', temp, 'hum', hum) from b) end) end
$$;

create or replace function public.roomtemp_history(p_range text)
returns json language plpgsql security definer set search_path = '' stable as $$
declare b record; first_ts timestamptz; last_ts timestamptz; lo2 timestamptz; hi2 timestamptz; step_s float8; cnt int; res json;
begin
  select * into b from roomtemp._bounds(p_range);
  select min(ts), max(ts) into first_ts, last_ts from roomtemp.readings;
  select count(*) into cnt from roomtemp.readings where ts >= b.lo and ts < b.hi;
  lo2 := greatest(b.lo, first_ts); hi2 := least(b.hi - interval '1 second', last_ts);
  if lo2 is null or lo2 >= hi2 then
    -- 구간 안에 보간할 두 지점이 없으면 실측값만 돌려준다
    select json_build_object('samples', cnt, 'points', coalesce(json_agg(json_build_object('ts', (extract(epoch from ts)*1000)::bigint,
      'temp', temp, 'tmin', temp, 'tmax', temp, 'hum', hum, 'hmin', hum, 'hmax', hum) order by ts), '[]'::json), 'marks', '[]'::json)
      into res from roomtemp.readings where ts >= b.lo and ts < b.hi;
    return res;
  end if;
  step_s := extract(epoch from hi2 - lo2) / 150;
  select json_build_object('samples', cnt,
    'points', coalesce((select json_agg(json_build_object('ts', (extract(epoch from p.ts)*1000)::bigint,
        'temp', p.temp, 'tmin', least(p.temp, m.tmin), 'tmax', greatest(p.temp, m.tmax),
        'hum', p.hum, 'hmin', least(p.hum, m.hmin), 'hmax', greatest(p.hum, m.hmax)) order by p.ts)
      from roomtemp._interp(lo2, hi2, 150) p
      left join lateral (select min(r.temp)::float8 tmin, max(r.temp)::float8 tmax, min(r.hum)::float8 hmin, max(r.hum)::float8 hmax
                         from roomtemp.readings r
                         where r.ts >= p.ts - make_interval(secs => step_s / 2) and r.ts < p.ts + make_interval(secs => step_s / 2)) m on true), '[]'::json),
    'marks', case when cnt <= 300 then coalesce((select json_agg(json_build_object('ts', (extract(epoch from ts)*1000)::bigint, 'temp', temp, 'hum', hum) order by ts)
                from roomtemp.readings where ts >= lo2 and ts <= hi2), '[]'::json) else '[]'::json end)
    into res;
  return res;
end $$;

create or replace function public.roomtemp_stats(p_range text)
returns json language sql security definer set search_path = '' stable as $$
  with b as (select * from roomtemp._bounds(p_range)),
       e as (select greatest(b.lo, min(r.ts)) as lo2, least(b.hi - interval '1 second', max(r.ts)) as hi2 from b, roomtemp.readings r group by b.lo, b.hi),
       g as (select i.* from e, lateral roomtemp._interp(e.lo2, e.hi2,
               least(2000, greatest(1, ceil(extract(epoch from e.hi2 - e.lo2) / 60)::int))) i where e.lo2 < e.hi2),
       rr as (select x.ts, x.temp::float8 as temp, x.hum::float8 as hum from roomtemp.readings x, b where x.ts >= b.lo and x.ts < b.hi),
       avgsrc as (select * from g union all select * from rr where not exists (select 1 from g)),
       pts as (select * from g union all select * from rr)
  select json_build_object(
    'overall', json_build_object(
      'n', (select count(*) from rr),
      'temp', (select avg(temp) from avgsrc), 'hum', (select avg(hum) from avgsrc),
      'tmin', (select min(temp) from pts), 'tmax', (select max(temp) from pts),
      'hmin', (select min(hum) from pts), 'hmax', (select max(hum) from pts),
      'tstd', (select stddev_pop(temp) from avgsrc), 'hstd', (select stddev_pop(hum) from avgsrc),
      'tmax_ts', (select (extract(epoch from ts)*1000)::bigint from pts where temp is not null order by temp desc, ts desc limit 1),
      'tmin_ts', (select (extract(epoch from ts)*1000)::bigint from pts where temp is not null order by temp asc, ts desc limit 1),
      'hmax_ts', (select (extract(epoch from ts)*1000)::bigint from pts where hum is not null order by hum desc, ts desc limit 1),
      'hmin_ts', (select (extract(epoch from ts)*1000)::bigint from pts where hum is not null order by hum asc, ts desc limit 1),
      'comfort', (select avg((temp between 22.5 and 27.5 and hum between 40 and 55)::int) * 100 from avgsrc),
      'dew', (select avg(243.12 * (ln(greatest(hum,1)/100.0) + 17.62*temp/(243.12+temp))
                         / (17.62 - (ln(greatest(hum,1)/100.0) + 17.62*temp/(243.12+temp)))) from avgsrc)),
    'hourly', coalesce((select json_agg(x order by h) from (
        select extract(hour from ts at time zone 'Asia/Seoul')::int as h, avg(temp) as temp, avg(hum) as hum from avgsrc group by 1) x), '[]'::json),
    'daily', coalesce((select json_agg(x order by d) from (
        select a.d, a.temp, a.hum, m.tmin, m.tmax, m.hmin, m.hmax
        from (select to_char(ts at time zone 'Asia/Seoul', 'YYYY-MM-DD') d, avg(temp) temp, avg(hum) hum from avgsrc group by 1) a
        join (select to_char(ts at time zone 'Asia/Seoul', 'YYYY-MM-DD') d, min(temp) tmin, max(temp) tmax, min(hum) hmin, max(hum) hmax from pts group by 1) m using (d)) x), '[]'::json),
    'monthly', coalesce((select json_agg(x order by d) from (
        select a.d, a.temp, a.hum, m.tmin, m.tmax, m.hmin, m.hmax
        from (select to_char(ts at time zone 'Asia/Seoul', 'YYYY-MM') d, avg(temp) temp, avg(hum) hum from avgsrc group by 1) a
        join (select to_char(ts at time zone 'Asia/Seoul', 'YYYY-MM') d, min(temp) tmin, max(temp) tmax, min(hum) hmin, max(hum) hmax from pts group by 1) m using (d)) x), '[]'::json)
  )
$$;


-- 조회 구간: 주(w:YYYY-MM-DD, 7일), 임의 구간(r:시작ms:끝ms) 추가
create or replace function roomtemp._bounds(p_range text)
returns table(lo timestamptz, hi timestamptz) language sql stable set search_path = '' as $$
  select
    case
      when p_range ~ '^r:\d{10,13}:\d{10,13}$' then to_timestamp(split_part(p_range, ':', 2)::bigint / 1000.0)
      when p_range ~ '^[dw]:\d{4}-\d{2}-\d{2}$' then (substr(p_range,3)::date)::timestamp at time zone 'Asia/Seoul'
      when p_range ~ '^m:\d{4}-\d{2}$' then ((substr(p_range,3) || '-01')::date)::timestamp at time zone 'Asia/Seoul'
      when p_range ~ '^y:\d{4}$' then ((substr(p_range,3) || '-01-01')::date)::timestamp at time zone 'Asia/Seoul'
      when p_range = '1h' then now() - interval '1 hour'
      when p_range = '7d' then now() - interval '7 days'
      when p_range = '30d' then now() - interval '30 days'
      when p_range = 'all' then '-infinity'::timestamptz
      else now() - interval '24 hours' end,
    case
      when p_range ~ '^r:\d{10,13}:\d{10,13}$' then to_timestamp(split_part(p_range, ':', 3)::bigint / 1000.0)
      when p_range ~ '^d:\d{4}-\d{2}-\d{2}$' then ((substr(p_range,3)::date) + 1)::timestamp at time zone 'Asia/Seoul'
      when p_range ~ '^w:\d{4}-\d{2}-\d{2}$' then ((substr(p_range,3)::date) + 7)::timestamp at time zone 'Asia/Seoul'
      when p_range ~ '^m:\d{4}-\d{2}$' then (((substr(p_range,3) || '-01')::date) + interval '1 month')::timestamp at time zone 'Asia/Seoul'
      when p_range ~ '^y:\d{4}$' then (((substr(p_range,3) || '-01-01')::date) + interval '1 year')::timestamp at time zone 'Asia/Seoul'
      else 'infinity'::timestamptz end
$$;

-- 선택 구간의 날짜(연/전체는 월) × 시간대 평균
create or replace function public.roomtemp_heatmap(p_range text)
returns json language sql security definer set search_path = '' stable as $$
  with b as (select case when p_range in ('24h','1h','7d','30d') then now() - interval '14 days' else lo end as lo,
                    case when p_range in ('24h','1h','7d','30d') then 'infinity'::timestamptz else hi end as hi from roomtemp._bounds(p_range)),
       e as (select greatest(b.lo, min(r.ts)) as lo2, least(b.hi - interval '1 second', max(r.ts)) as hi2 from b, roomtemp.readings r group by b.lo, b.hi),
       g as (select i.* from e, lateral roomtemp._interp(e.lo2, e.hi2,
               least(10000, greatest(1, ceil(extract(epoch from e.hi2 - e.lo2) / 600)::int))) i where e.lo2 < e.hi2)
  select coalesce(json_agg(x order by d, h), '[]'::json) from (
    select case when p_range = 'all' or p_range ~ '^y:' then to_char(ts at time zone 'Asia/Seoul', 'YYYY-MM')
                else to_char(ts at time zone 'Asia/Seoul', 'YYYY-MM-DD') end as d,
           extract(hour from ts at time zone 'Asia/Seoul')::int as h, avg(temp) as temp, avg(hum) as hum
    from g group by 1, 2) x
$$;
revoke all on function public.roomtemp_heatmap(text) from public;
grant execute on function public.roomtemp_heatmap(text) to anon;
