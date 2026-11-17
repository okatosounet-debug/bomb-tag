-- ばくおに！ weekly ranking: stop forged / flooded scores.
-- Run this once in the Supabase dashboard (SQL Editor) of the project the site uses.
-- It is safe to run again.
--
-- What it does
--   * scores can no longer be written straight into the table with the public key;
--     the page writes through bt_submit(), which checks every value
--   * one row per player, week and mode (their best of the week)
--   * at most one write per player every 20 s, and at most 5 different player ids per
--     IP address per week (so one person can't fill the table with fake players)
--
-- What it can't do: the game decides the score in the players' browsers (there is no
-- game server), so a determined cheater can still send a made-up score for themselves
-- (up to the 2000 cap). They can no longer push everyone else off the board.

alter table public.bt_scores add column if not exists ip text;
alter table public.bt_scores add column if not exists at timestamptz not null default now();

-- keep only each player's best row, then make that the rule
delete from public.bt_scores a
  using public.bt_scores b
  where a.week = b.week and a.mode = b.mode and a.player = b.player
    and (a.pts < b.pts or (a.pts = b.pts and a.ctid < b.ctid));
create unique index if not exists bt_scores_one_per_player on public.bt_scores (week, mode, player);

-- reading stays public; writing only through the function below
alter table public.bt_scores enable row level security;
revoke insert, update, delete on public.bt_scores from anon, authenticated;
drop policy if exists bt_scores_read on public.bt_scores;
create policy bt_scores_read on public.bt_scores for select to anon, authenticated using (true);
-- the IP column is for the limit only: nobody reads it from the page
revoke select on public.bt_scores from anon, authenticated;
grant select (week, name, ch, pts, mode, player) on public.bt_scores to anon, authenticated;

create or replace function public.bt_submit(p_week text, p_name text, p_ch int, p_pts int, p_mode text, p_player text)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  hdr json := coalesce(nullif(current_setting('request.headers', true), ''), '{}')::json;
  v_ip text := trim(split_part(coalesce(hdr->>'cf-connecting-ip', hdr->>'x-real-ip', hdr->>'x-forwarded-for', ''), ',', 1));
  jst timestamp := now() at time zone 'Asia/Tokyo';
  v_row public.bt_scores%rowtype;
begin
  if p_mode not in ('online', 'practice') then return false; end if;
  if p_player is null or p_player !~ '^[a-z0-9]{6,32}$' then return false; end if;
  -- this week only (or last week, for a match that ended just after Monday 0:00 JST)
  if p_week not in (to_char(jst, 'IYYY-"W"IW'), to_char(jst - interval '1 hour', 'IYYY-"W"IW')) then return false; end if;
  p_name := left(regexp_replace(coalesce(p_name, ''), '[<>"''`[:cntrl:]]', '', 'g'), 10);
  p_ch := greatest(0, least(5, coalesce(p_ch, 0)));
  p_pts := greatest(-2000, least(2000, coalesce(p_pts, 0)));

  select * into v_row from public.bt_scores where week = p_week and mode = p_mode and player = p_player;
  if found then
    if v_row.at > now() - interval '20 seconds' then return false; end if;
    if p_pts <= v_row.pts then return true; end if;
    update public.bt_scores set pts = p_pts, name = p_name, ch = p_ch, at = now()
      where week = p_week and mode = p_mode and player = p_player;
    return true;
  end if;

  if v_ip <> '' and (select count(distinct player) from public.bt_scores where week = p_week and ip = v_ip) >= 5 then
    return false;
  end if;
  insert into public.bt_scores (week, name, ch, pts, mode, player, ip, at)
    values (p_week, p_name, p_ch, p_pts, p_mode, p_player, nullif(v_ip, ''), now())
    on conflict (week, mode, player) do nothing;
  return true;
end;
$$;

revoke all on function public.bt_submit(text, text, int, int, text, text) from public;
grant execute on function public.bt_submit(text, text, int, int, text, text) to anon, authenticated;
