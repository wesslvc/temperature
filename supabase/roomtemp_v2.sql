-- v2: 통계 확장(최고/최저 시각, 쾌적 비율, 이슬점) + 히트맵
create or replace function public.roomtemp_stats(p_range text)
returns json language sql security definer set search_path = '' stable as $$
  with r as (select * from roomtemp.readings where ts >= roomtemp._since(p_range))
  select json_build_object(
    'overall', (select json_build_object(
        'n', count(*), 'temp', avg(temp), 'tmin', min(temp), 'tmax', max(temp),
        'hum', avg(hum), 'hmin', min(hum), 'hmax', max(hum),
        'tstd', stddev_pop(temp),
        'tmax_ts', (select (extract(epoch from ts)*1000)::bigint from r where temp is not null order by temp desc, ts desc limit 1),
        'tmin_ts', (select (extract(epoch from ts)*1000)::bigint from r where temp is not null order by temp asc, ts desc limit 1),
        'hmax_ts', (select (extract(epoch from ts)*1000)::bigint from r where hum is not null order by hum desc, ts desc limit 1),
        'hmin_ts', (select (extract(epoch from ts)*1000)::bigint from r where hum is not null order by hum asc, ts desc limit 1),
        'comfort', avg((temp between 20 and 26 and hum between 40 and 60)::int) * 100,
        'dew', avg(243.12 * (ln(greatest(hum,1)/100.0) + 17.62*temp/(243.12+temp))
                   / (17.62 - (ln(greatest(hum,1)/100.0) + 17.62*temp/(243.12+temp))))
      ) from r),
    'hourly', coalesce((select json_agg(x order by h) from (
        select extract(hour from ts at time zone 'Asia/Seoul')::int as h, avg(temp)::float as temp, avg(hum)::float as hum
        from r group by 1) x), '[]'::json),
    'daily', coalesce((select json_agg(x order by d) from (
        select to_char(ts at time zone 'Asia/Seoul', 'YYYY-MM-DD') as d, avg(temp)::float as temp, avg(hum)::float as hum,
               min(temp)::float as tmin, max(temp)::float as tmax, min(hum)::float as hmin, max(hum)::float as hmax
        from r group by 1) x), '[]'::json)
  )
$$;

create or replace function public.roomtemp_heatmap(p_days int default 14)
returns json language sql security definer set search_path = '' stable as $$
  select coalesce(json_agg(x order by d, h), '[]'::json) from (
    select to_char(ts at time zone 'Asia/Seoul', 'YYYY-MM-DD') as d,
           extract(hour from ts at time zone 'Asia/Seoul')::int as h,
           avg(temp)::float as temp, avg(hum)::float as hum
    from roomtemp.readings
    where ts >= now() - make_interval(days => least(greatest(p_days, 1), 60))
    group by 1, 2) x
$$;

revoke all on function public.roomtemp_heatmap(int) from public;
grant execute on function public.roomtemp_heatmap(int) to anon;
