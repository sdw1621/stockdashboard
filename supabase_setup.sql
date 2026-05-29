-- ════════════════════════════════════════════════════════════════════
--  StockVision — Supabase 초기 설정 SQL
--  ────────────────────────────────────────────────────────────────────
--  사용법:
--    1) Supabase 대시보드 → SQL Editor → New query
--    2) 이 파일 내용을 붙여넣고 RUN
--    3) Project Settings → API 에서 Project URL / anon key 를 복사해
--       index.html 최상단의 SUPABASE_URL / SUPABASE_ANON_KEY 에 입력
--
--  인증은 Supabase 기본 이메일/비밀번호 인증을 사용합니다
--  (Authentication → Providers → Email 활성화 — 기본 켜져 있음).
-- ════════════════════════════════════════════════════════════════════

-- ── 보유 종목(holdings) 테이블 ──────────────────────────────────────
create table if not exists public.holdings (
  id            uuid        primary key default gen_random_uuid(),
  user_id       uuid        not null references auth.users (id) on delete cascade,
  ticker        text        not null,                 -- 티커 심볼 (예: AAPL, 005930.KS)
  name          text,                                 -- 종목명 (예: 삼성전자)
  quantity      numeric     not null default 0,        -- 보유 수량
  avg_price     numeric     not null default 0,        -- 평균 매수가
  purchase_date date,                                 -- 매수일
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

comment on table  public.holdings              is 'StockVision 사용자별 보유 종목';
comment on column public.holdings.ticker        is '티커 심볼 (Yahoo Finance 기준)';
comment on column public.holdings.avg_price      is '평균 매수가 (종목 통화 기준)';

-- ── updated_at 자동 갱신 트리거 ─────────────────────────────────────
create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists trg_holdings_updated_at on public.holdings;
create trigger trg_holdings_updated_at
  before update on public.holdings
  for each row execute function public.set_updated_at();

-- ── 조회 성능용 인덱스 ──────────────────────────────────────────────
create index if not exists holdings_user_id_idx on public.holdings (user_id);

-- ── Row Level Security (본인 데이터만 접근) ─────────────────────────
alter table public.holdings enable row level security;

drop policy if exists "holdings_select_own" on public.holdings;
create policy "holdings_select_own"
  on public.holdings for select
  using (auth.uid() = user_id);

drop policy if exists "holdings_insert_own" on public.holdings;
create policy "holdings_insert_own"
  on public.holdings for insert
  with check (auth.uid() = user_id);

drop policy if exists "holdings_update_own" on public.holdings;
create policy "holdings_update_own"
  on public.holdings for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

drop policy if exists "holdings_delete_own" on public.holdings;
create policy "holdings_delete_own"
  on public.holdings for delete
  using (auth.uid() = user_id);
