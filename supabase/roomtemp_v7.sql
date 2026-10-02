-- v7: 이슬점(최저/평균/최고) 집계·추이·히트맵 추가
create or replace function roomtemp._dew(t float8, h float8)
returns float8 language sql immutable set search_path = '' as $$
  select case when t is null or h is null then null
    else 243.12 * (ln(greatest(h,1)/100.0) + 17.62*t/(243.12+t)) / (17.62 - (ln(greatest(h,1)/100.0) + 17.62*t/(243.12+t))) end
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
    select json_build_object('samples', cnt, 'points', coalesce(json_agg(json_build_object('ts', (extract(epoch from ts)*1000)::bigint,
      'temp', temp, 'tmin', temp, 'tmax', temp, 'hum', hum, 'hmin', hum, 'hmax', hum,
      'dew', roomtemp._dew(temp::float8, hum::float8), 'dmin', roomtemp._dew(temp::float8, hum::float8), 'dmax', roomtemp._dew(temp::float8, hum::float8)) order by ts), '[]'::json), 'marks', '[]'::json)
      into res from roomtemp.readings where ts >= b.lo and ts < b.hi;
    return res;
  end if;
  step_s := extract(epoch from hi2 - lo2) / 150;
  select json_build_object('samples', cnt,
    'points', coalesce((select json_agg(json_build_object('ts', (extract(epoch from p.ts)*1000)::bigint,
        'temp', p.temp, 'tmin', least(p.temp, m.tmin), 'tmax', greatest(p.temp, m.tmax),
        'hum', p.hum, 'hmin', least(p.hum, m.hmin), 'hmax', greatest(p.hum, m.hmax),
        'dew', roomtemp._dew(p.temp, p.hum), 'dmin', least(roomtemp._dew(p.temp, p.hum), m.dmin), 'dmax', greatest(roomtemp._dew(p.temp, p.hum), m.dmax)) order by p.ts)
      from roomtemp._interp(lo2, hi2, 150) p
      left join lateral (select min(r.temp)::float8 tmin, max(r.temp)::float8 tmax, min(r.hum)::float8 hmin, max(r.hum)::float8 hmax,
                                min(roomtemp._dew(r.temp::float8, r.hum::float8)) dmin, max(roomtemp._dew(r.temp::float8, r.hum::float8)) dmax
                         from roomtemp.readings r
                         where r.ts >= p.ts - make_interval(secs => step_s / 2) and r.ts < p.ts + make_interval(secs => step_s / 2)) m on true), '[]'::json),
    'marks', case when cnt <= 300 then coalesce((select json_agg(json_build_object('ts', (extract(epoch from ts)*1000)::bigint, 'temp', temp, 'hum', hum,
                'dew', roomtemp._dew(temp::float8, hum::float8)) order by ts)
                from roomtemp.readings where ts >= lo2 and ts <= hi2), '[]'::json) else '[]'::json end)
    into res;
  return res;
end $$;

create or replace function roomtemp._agg(p_lo timestamptz, p_hi timestamptz, p_unit text)
returns json language sql stable set search_path = '' as $$
  with e as (select greatest(p_lo, (select min(ts) from roomtemp.readings)) as lo2, least(p_hi - interval '1 second', (select max(ts) from roomtemp.readings)) as hi2),
       g as (select i.* from e, lateral roomtemp._interp(e.lo2, e.hi2,
               least(3000, greatest(1, ceil(extract(epoch from e.hi2 - e.lo2) / 60)::int))) i where e.lo2 < e.hi2),
       rr as (select x.ts, x.temp::float8 as temp, x.hum::float8 as hum from roomtemp.readings x where x.ts >= p_lo and x.ts < p_hi),
       src as (select * from g union all select * from rr where not exists (select 1 from g)),
       pts as (select * from g union all select * from rr),
       ks as (select s.ts, s.temp, s.hum, roomtemp._dew(s.temp, s.hum) as dew, case p_unit
                when 'd' then to_char(s.ts at time zone 'Asia/Seoul', 'YYYY-MM-DD')
                when 'm' then to_char(s.ts at time zone 'Asia/Seoul', 'YYYY-MM')
                else to_char(s.ts at time zone 'Asia/Seoul', 'YYYY-MM') || '-' || least(4, ((extract(day from s.ts at time zone 'Asia/Seoul')::int - 1) / 7) + 1) end as k from src s),
       kp as (select s.ts, s.temp, s.hum, roomtemp._dew(s.temp, s.hum) as dew, case p_unit
                when 'd' then to_char(s.ts at time zone 'Asia/Seoul', 'YYYY-MM-DD')
                when 'm' then to_char(s.ts at time zone 'Asia/Seoul', 'YYYY-MM')
                else to_char(s.ts at time zone 'Asia/Seoul', 'YYYY-MM') || '-' || least(4, ((extract(day from s.ts at time zone 'Asia/Seoul')::int - 1) / 7) + 1) end as k from pts s),
       dm as (select to_char(s.ts at time zone 'Asia/Seoul', 'YYYY-MM-DD') as day, min(s.temp) as tmin, max(s.temp) as tmax, min(s.hum) as hmin, max(s.hum) as hmax,
                     min(roomtemp._dew(s.temp, s.hum)) as dmin, max(roomtemp._dew(s.temp, s.hum)) as dmax from pts s group by 1),
       dk as (select case p_unit when 'd' then day when 'm' then substr(day, 1, 7)
                else substr(day, 1, 7) || '-' || least(4, ((substr(day, 9, 2)::int - 1) / 7) + 1) end as k,
                avg(tmin) as tminavg, avg(tmax) as tmaxavg, avg(hmin) as hminavg, avg(hmax) as hmaxavg, avg(dmin) as dminavg, avg(dmax) as dmaxavg from dm group by 1)
  select coalesce(json_agg(x order by d), '[]'::json) from (
    select a.d, a.temp, a.hum, a.dew, m.tmin, m.tmax, m.hmin, m.hmax, m.dmin, m.dmax, dk.tminavg, dk.tmaxavg, dk.hminavg, dk.hmaxavg, dk.dminavg, dk.dmaxavg
    from (select k as d, avg(temp) as temp, avg(hum) as hum, avg(dew) as dew from ks group by k) a
    join (select k as d, min(temp) as tmin, max(temp) as tmax, min(hum) as hmin, max(hum) as hmax, min(dew) as dmin, max(dew) as dmax from kp group by k) m using (d)
    left join dk on dk.k = a.d) x
$$;

create or replace function public.roomtemp_stats(p_range text)
returns json language sql security definer set search_path = '' stable as $$
  with b as (select * from roomtemp._bounds(p_range)),
       e as (select greatest(b.lo, min(r.ts)) as lo2, least(b.hi - interval '1 second', max(r.ts)) as hi2 from b, roomtemp.readings r group by b.lo, b.hi),
       g as (select i.* from e, lateral roomtemp._interp(e.lo2, e.hi2,
               least(2000, greatest(1, ceil(extract(epoch from e.hi2 - e.lo2) / 60)::int))) i where e.lo2 < e.hi2),
       rr as (select x.ts, x.temp::float8 as temp, x.hum::float8 as hum from roomtemp.readings x, b where x.ts >= b.lo and x.ts < b.hi),
       avgsrc as (select * from g union all select * from rr where not exists (select 1 from g)),
       pts as (select ts, temp, hum, roomtemp._dew(temp, hum) as dew from (select * from g union all select * from rr) u)
  select json_build_object(
    'overall', json_build_object(
      'n', (select count(*) from rr),
      'temp', (select avg(temp) from avgsrc), 'hum', (select avg(hum) from avgsrc), 'dew', (select avg(roomtemp._dew(temp, hum)) from avgsrc),
      'tmin', (select min(temp) from pts), 'tmax', (select max(temp) from pts),
      'hmin', (select min(hum) from pts), 'hmax', (select max(hum) from pts),
      'dmin', (select min(dew) from pts), 'dmax', (select max(dew) from pts),
      'tstd', (select stddev_pop(temp) from avgsrc), 'hstd', (select stddev_pop(hum) from avgsrc),
      'tmax_ts', (select (extract(epoch from ts)*1000)::bigint from pts where temp is not null order by temp desc, ts desc limit 1),
      'tmin_ts', (select (extract(epoch from ts)*1000)::bigint from pts where temp is not null order by temp asc, ts desc limit 1),
      'hmax_ts', (select (extract(epoch from ts)*1000)::bigint from pts where hum is not null order by hum desc, ts desc limit 1),
      'hmin_ts', (select (extract(epoch from ts)*1000)::bigint from pts where hum is not null order by hum asc, ts desc limit 1),
      'dmax_ts', (select (extract(epoch from ts)*1000)::bigint from pts where dew is not null order by dew desc, ts desc limit 1),
      'dmin_ts', (select (extract(epoch from ts)*1000)::bigint from pts where dew is not null order by dew asc, ts desc limit 1),
      'comfort', (select avg((temp between 22.5 and 28 and hum between 40 and 55)::int) * 100 from avgsrc),
      'comfort_t', (select avg((temp between 22.5 and 28)::int) * 100 from avgsrc),
      'comfort_h', (select avg((hum between 40 and 55)::int) * 100 from avgsrc)),
    'hourly', coalesce((select json_agg(x order by h) from (
        select extract(hour from ts at time zone 'Asia/Seoul')::int as h, avg(temp) as temp, avg(hum) as hum, avg(roomtemp._dew(temp, hum)) as dew from avgsrc group by 1) x), '[]'::json),
    'daily', (select roomtemp._agg(ex.xlo, ex.xhi, 'd') from b, lateral roomtemp._expand(b.lo, b.hi, 'd') ex),
    'weekly', (select roomtemp._agg(ex.xlo, ex.xhi, 'w') from b, lateral roomtemp._expand(b.lo, b.hi, 'w') ex),
    'monthly', (select roomtemp._agg(ex.xlo, ex.xhi, 'm') from b, lateral roomtemp._expand(b.lo, b.hi, 'm') ex)
  )
$$;

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
           extract(hour from ts at time zone 'Asia/Seoul')::int as h, avg(temp) as temp, avg(hum) as hum, avg(roomtemp._dew(temp, hum)) as dew
    from g group by 1, 2) x
$$;
