-- v6: 월 기준 주 블록(k:YYYY-MM:n, 1~7/8~14/15~21/22~말일), 날짜·주·월 전체 기준 집계, 클릭 지점 조회, 쾌적 온도 22.5~28°C

create or replace function roomtemp._bounds(p_range text)
returns table(lo timestamptz, hi timestamptz) language sql stable set search_path = '' as $$
  select
    case
      when p_range ~ '^r:\d{10,13}:\d{10,13}$' then to_timestamp(split_part(p_range, ':', 2)::bigint / 1000.0)
      when p_range ~ '^k:\d{4}-\d{2}:[1-4]$' then ((substr(p_range,3,7) || '-01')::date + 7 * (split_part(p_range, ':', 3)::int - 1))::timestamp at time zone 'Asia/Seoul'
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
      when p_range ~ '^k:\d{4}-\d{2}:[1-3]$' then ((substr(p_range,3,7) || '-01')::date + 7 * split_part(p_range, ':', 3)::int)::timestamp at time zone 'Asia/Seoul'
      when p_range ~ '^k:\d{4}-\d{2}:4$' then (((substr(p_range,3,7) || '-01')::date) + interval '1 month')::timestamp at time zone 'Asia/Seoul'
      when p_range ~ '^d:\d{4}-\d{2}-\d{2}$' then ((substr(p_range,3)::date) + 1)::timestamp at time zone 'Asia/Seoul'
      when p_range ~ '^w:\d{4}-\d{2}-\d{2}$' then ((substr(p_range,3)::date) + 7)::timestamp at time zone 'Asia/Seoul'
      when p_range ~ '^m:\d{4}-\d{2}$' then (((substr(p_range,3) || '-01')::date) + interval '1 month')::timestamp at time zone 'Asia/Seoul'
      when p_range ~ '^y:\d{4}$' then (((substr(p_range,3) || '-01-01')::date) + interval '1 year')::timestamp at time zone 'Asia/Seoul'
      else 'infinity'::timestamptz end
$$;

-- 클릭한 시각에 가장 가까운 실측값과 그 직전 실측값
create or replace function public.roomtemp_point(p_ts bigint)
returns json language sql security definer set search_path = '' stable as $$
  with t as (select to_timestamp(p_ts / 1000.0) as t),
       a as (select r.ts, r.temp, r.hum from roomtemp.readings r, t where r.ts <= t.t order by r.ts desc limit 1),
       b as (select r.ts, r.temp, r.hum from roomtemp.readings r, t where r.ts > t.t order by r.ts asc limit 1),
       n as (select * from (select * from a union all select * from b) u, t order by abs(extract(epoch from u.ts - t.t)) limit 1),
       p as (select r.ts, r.temp, r.hum from roomtemp.readings r, n where r.ts < n.ts order by r.ts desc limit 1)
  select case when not exists (select 1 from n) then 'null'::json else json_build_object(
    'ts', (select (extract(epoch from ts)*1000)::bigint from n), 'temp', (select temp from n), 'hum', (select hum from n),
    'prev', (select json_build_object('ts', (extract(epoch from ts)*1000)::bigint, 'temp', temp, 'hum', hum) from p)) end
$$;
revoke all on function public.roomtemp_point(bigint) from public;
grant execute on function public.roomtemp_point(bigint) to anon;

-- 선택 구간을 날짜/주/월 경계까지 넓힌다 (집계가 구간 밖 같은 날 데이터까지 포함하도록)
create or replace function roomtemp._expand(p_lo timestamptz, p_hi timestamptz, p_unit text)
returns table(xlo timestamptz, xhi timestamptz) language plpgsql stable set search_path = '' as $$
declare f timestamptz; l timestamptz; a timestamptz; z timestamptz; la timestamp; lz timestamp; n int; s timestamp; e timestamp;
begin
  select min(ts), max(ts) into f, l from roomtemp.readings;
  if f is null then return; end if;
  a := greatest(p_lo, f); z := least(p_hi, l + interval '1 second');
  if a >= z then return query select a, a; return; end if;
  la := a at time zone 'Asia/Seoul'; lz := (z - interval '1 second') at time zone 'Asia/Seoul';
  if p_unit = 'd' then
    s := date_trunc('day', la); e := date_trunc('day', lz) + interval '1 day';
  elsif p_unit = 'm' then
    s := date_trunc('month', la); e := date_trunc('month', lz) + interval '1 month';
  else
    n := least(3, (extract(day from la)::int - 1) / 7);
    s := date_trunc('month', la) + make_interval(days => 7 * n);
    n := (extract(day from lz)::int - 1) / 7;
    e := case when n >= 3 then date_trunc('month', lz) + interval '1 month' else date_trunc('month', lz) + make_interval(days => 7 * (n + 1)) end;
  end if;
  return query select s at time zone 'Asia/Seoul', e at time zone 'Asia/Seoul';
end $$;

-- [lo, hi) 를 사잇값 보간으로 날짜(d)/주 블록(w)/월(m) 단위 평균·최저·최고로 집계
create or replace function roomtemp._agg(p_lo timestamptz, p_hi timestamptz, p_unit text)
returns json language sql stable set search_path = '' as $$
  with e as (select greatest(p_lo, (select min(ts) from roomtemp.readings)) as lo2, least(p_hi - interval '1 second', (select max(ts) from roomtemp.readings)) as hi2),
       g as (select i.* from e, lateral roomtemp._interp(e.lo2, e.hi2,
               least(3000, greatest(1, ceil(extract(epoch from e.hi2 - e.lo2) / 60)::int))) i where e.lo2 < e.hi2),
       rr as (select x.ts, x.temp::float8 as temp, x.hum::float8 as hum from roomtemp.readings x where x.ts >= p_lo and x.ts < p_hi),
       src as (select * from g union all select * from rr where not exists (select 1 from g)),
       pts as (select * from g union all select * from rr),
       ks as (select s.ts, s.temp, s.hum, case p_unit
                when 'd' then to_char(s.ts at time zone 'Asia/Seoul', 'YYYY-MM-DD')
                when 'm' then to_char(s.ts at time zone 'Asia/Seoul', 'YYYY-MM')
                else to_char(s.ts at time zone 'Asia/Seoul', 'YYYY-MM') || '-' || least(4, ((extract(day from s.ts at time zone 'Asia/Seoul')::int - 1) / 7) + 1) end as k from src s),
       kp as (select s.ts, s.temp, s.hum, case p_unit
                when 'd' then to_char(s.ts at time zone 'Asia/Seoul', 'YYYY-MM-DD')
                when 'm' then to_char(s.ts at time zone 'Asia/Seoul', 'YYYY-MM')
                else to_char(s.ts at time zone 'Asia/Seoul', 'YYYY-MM') || '-' || least(4, ((extract(day from s.ts at time zone 'Asia/Seoul')::int - 1) / 7) + 1) end as k from pts s)
  select coalesce(json_agg(x order by d), '[]'::json) from (
    select a.d, a.temp, a.hum, m.tmin, m.tmax, m.hmin, m.hmax
    from (select k as d, avg(temp) as temp, avg(hum) as hum from ks group by k) a
    join (select k as d, min(temp) as tmin, max(temp) as tmax, min(hum) as hmin, max(hum) as hmax from kp group by k) m using (d)) x
$$;

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
      'comfort', (select avg((temp between 22.5 and 28 and hum between 40 and 55)::int) * 100 from avgsrc),
      'dew', (select avg(243.12 * (ln(greatest(hum,1)/100.0) + 17.62*temp/(243.12+temp))
                         / (17.62 - (ln(greatest(hum,1)/100.0) + 17.62*temp/(243.12+temp)))) from avgsrc)),
    'hourly', coalesce((select json_agg(x order by h) from (
        select extract(hour from ts at time zone 'Asia/Seoul')::int as h, avg(temp) as temp, avg(hum) as hum from avgsrc group by 1) x), '[]'::json),
    'daily', (select roomtemp._agg(ex.xlo, ex.xhi, 'd') from b, lateral roomtemp._expand(b.lo, b.hi, 'd') ex),
    'weekly', (select roomtemp._agg(ex.xlo, ex.xhi, 'w') from b, lateral roomtemp._expand(b.lo, b.hi, 'w') ex),
    'monthly', (select roomtemp._agg(ex.xlo, ex.xhi, 'm') from b, lateral roomtemp._expand(b.lo, b.hi, 'm') ex)
  )
$$;
