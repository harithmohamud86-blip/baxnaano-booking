-- =====================================================================
--  BAXNAANO ONLINE BOOKING — Supabase database (run ONCE)
--  Supabase → SQL Editor → New query → paste this whole file → Run
-- =====================================================================

create extension if not exists pg_net;      -- lets the database call the Odoo sync function
create extension if not exists pgcrypto;

-- ---------- 1. Hospital settings (one row) ----------
create table if not exists public.settings (
  id              int primary key default 1 check (id = 1),
  hospital_name   text    not null default 'Baxnaano Hospital',
  tagline         text    not null default 'Treatment and beyond',
  phones          text[]  not null default '{}',
  whatsapp        text    not null default '252613490055',
  email           text,
  address         text    not null default 'Muqdisho, Soomaaliya',
  open_time       time    not null default '08:00',
  close_time      time    not null default '19:00',
  slot_minutes    int     not null default 15 check (slot_minutes between 5 and 120),
  ussd_prefix     text    not null default '*712*',
  ussd_number     text    not null default '684003333',
  booking_open    boolean not null default true,
  announcement    text,
  updated_at      timestamptz not null default now()
);
insert into public.settings (id) values (1) on conflict do nothing;

-- ---------- 2. Doctors ----------
create table if not exists public.doctors (
  id              uuid primary key default gen_random_uuid(),
  name            text    not null,
  specialty       text    not null,
  fee             numeric(8,2) not null default 10 check (fee >= 0),
  photo_url       text,
  bio             text,
  odoo_doctor_id  int,                                  -- id of this doctor in Odoo (nuro.doctor)
  work_days       int[]   not null default '{0,1,2,3,4,5,6}', -- 0=Axad … 6=Sabti
  daily_limit     int     not null default 40 check (daily_limit > 0),
  active          boolean not null default true,
  sort_order      int     not null default 0,
  created_at      timestamptz not null default now()
);

-- ---------- 3. Bookings ----------
create table if not exists public.bookings (
  id                  uuid primary key default gen_random_uuid(),
  ref                 text unique not null,
  doctor_id           uuid not null references public.doctors(id),
  doctor_name         text not null,
  specialty           text not null,
  patient_name        text not null,
  phone               text not null,
  age                 int  check (age between 0 and 120),
  gender              text check (gender in ('male','female')),
  district            text,
  is_returning        boolean not null default false,
  notes               text,
  visit_date          date not null,
  visit_time          time not null,
  queue_number        int  not null,
  fee                 numeric(8,2) not null,
  status              text not null default 'pending'
                      check (status in ('pending','paid','arrived','cancelled')),
  paid_at             timestamptz,
  odoo_status         text not null default 'waiting'
                      check (odoo_status in ('waiting','sent','error')),
  odoo_appointment_id int,
  odoo_error          text,
  created_at          timestamptz not null default now()
);
create index if not exists bookings_doctor_day on public.bookings (doctor_id, visit_date);
create index if not exists bookings_day on public.bookings (visit_date);
create index if not exists bookings_phone on public.bookings (phone, created_at);

-- ---------- 4. Staff who may log in to admin.html ----------
create table if not exists public.staff (
  email      text primary key,
  full_name  text,
  created_at timestamptz not null default now()
);
create or replace function public.is_staff() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.staff where lower(email) = lower(auth.jwt() ->> 'email'));
$$;

-- ---------- 5. Security (Row Level Security) ----------
alter table public.settings enable row level security;
alter table public.doctors  enable row level security;
alter table public.bookings enable row level security;
alter table public.staff    enable row level security;

drop policy if exists "public read settings" on public.settings;
create policy "public read settings" on public.settings for select using (true);
drop policy if exists "staff update settings" on public.settings;
create policy "staff update settings" on public.settings for update to authenticated using (public.is_staff()) with check (public.is_staff());

drop policy if exists "public read active doctors" on public.doctors;
create policy "public read active doctors" on public.doctors for select using (active or public.is_staff());
drop policy if exists "staff manage doctors" on public.doctors;
create policy "staff manage doctors" on public.doctors for all to authenticated using (public.is_staff()) with check (public.is_staff());

-- Patients can NOT read the bookings table; they book only through create_booking().
drop policy if exists "staff read bookings" on public.bookings;
create policy "staff read bookings" on public.bookings for select to authenticated using (public.is_staff());
drop policy if exists "staff update bookings" on public.bookings;
create policy "staff update bookings" on public.bookings for update to authenticated using (public.is_staff()) with check (public.is_staff());

drop policy if exists "staff read staff" on public.staff;
create policy "staff read staff" on public.staff for select to authenticated using (public.is_staff());

-- ---------- 6. Booking function (gives date, time and queue number) ----------
create or replace function public.create_booking(
  p_doctor uuid, p_name text, p_phone text, p_age int, p_gender text,
  p_district text, p_returning boolean, p_notes text default null
) returns json
language plpgsql security definer set search_path = public, extensions as $$
declare
  s        public.settings;
  d        public.doctors;
  v_now    timestamp := now() at time zone 'Africa/Mogadishu';
  v_date   date;
  v_count  int;
  v_time   time;
  v_last   time;
  v_maxq   int;
  v_found  boolean := false;
  v_phone  text := regexp_replace(coalesce(p_phone,''), '\D', '', 'g');
  v_ref    text;
  b        public.bookings;
begin
  select * into s from public.settings where id = 1;
  if not s.booking_open then raise exception 'BOOKING_CLOSED'; end if;

  select * into d from public.doctors where id = p_doctor and active;
  if not found then raise exception 'DOCTOR_NOT_FOUND'; end if;

  if length(trim(coalesce(p_name,''))) < 3 or length(p_name) > 120 then raise exception 'BAD_NAME'; end if;
  if v_phone like '252%' then v_phone := substr(v_phone, 4); end if;
  if v_phone <> '' and left(v_phone,1) <> '0' then v_phone := '0' || v_phone; end if;
  if length(v_phone) < 7 or length(v_phone) > 15 then raise exception 'BAD_PHONE'; end if;
  if p_gender is not null and p_gender not in ('male','female') then raise exception 'BAD_GENDER'; end if;
  if (select count(*) from public.bookings where phone = v_phone and created_at > now() - interval '1 day') >= 5 then
    raise exception 'TOO_MANY';
  end if;

  v_date := v_now::date;
  for i in 0..14 loop
    if extract(dow from v_date)::int = any(d.work_days) then
      perform pg_advisory_xact_lock(hashtext(p_doctor::text || v_date::text));
      select count(*), max(visit_time), coalesce(max(queue_number),0) into v_count, v_last, v_maxq from public.bookings
        where doctor_id = p_doctor and visit_date = v_date and status <> 'cancelled';
      if v_count < d.daily_limit then
        -- next slot = after the last booked patient, never before opening time
        v_time := case when v_last is null then s.open_time
                       else v_last + make_interval(mins => s.slot_minutes) end;
        if v_date = v_now::date then
          -- today: never give a time that has already passed (round up to the next slot)
          v_time := greatest(v_time, s.open_time + make_interval(mins =>
            greatest(0, ceil(extract(epoch from (v_now::time - s.open_time)) / 60 / s.slot_minutes))::int * s.slot_minutes));
        end if;
        if v_time <= s.close_time - make_interval(mins => s.slot_minutes) then
          v_found := true; exit;
        end if;
      end if;
    end if;
    v_date := v_date + 1;
  end loop;
  if not v_found then raise exception 'NO_SLOT'; end if;

  loop
    v_ref := 'BX-' || upper(substr(encode(gen_random_bytes(4), 'hex'), 1, 6));
    exit when not exists (select 1 from public.bookings where ref = v_ref);
  end loop;

  insert into public.bookings (ref, doctor_id, doctor_name, specialty, patient_name, phone, age, gender,
                               district, is_returning, notes, visit_date, visit_time, queue_number, fee)
  values (v_ref, d.id, d.name, d.specialty, upper(trim(p_name)), v_phone, p_age, p_gender,
          nullif(trim(p_district),''), coalesce(p_returning,false), nullif(trim(p_notes),''),
          v_date, v_time, v_maxq + 1, d.fee)
  returning * into b;

  return json_build_object('ref', b.ref, 'doctor', b.doctor_name, 'specialty', b.specialty,
    'patient', b.patient_name, 'date', b.visit_date, 'time', to_char(b.visit_time,'HH24:MI'),
    'queue', b.queue_number, 'fee', b.fee, 'status', b.status);
end $$;

-- Patients can check their booking with the reference number (no phone shown)
create or replace function public.get_booking(p_ref text) returns json
language sql stable security definer set search_path = public as $$
  select json_build_object('ref', ref, 'doctor', doctor_name, 'specialty', specialty,
    'patient', split_part(patient_name,' ',1), 'date', visit_date, 'time', to_char(visit_time,'HH24:MI'),
    'queue', queue_number, 'fee', fee, 'status', status)
  from public.bookings where ref = upper(trim(p_ref));
$$;

revoke all on function public.create_booking(uuid,text,text,int,text,text,boolean,text) from public;
grant execute on function public.create_booking(uuid,text,text,int,text,text,boolean,text) to anon, authenticated;
grant execute on function public.get_booking(text) to anon, authenticated;

-- Staff marking a booking paid stamps the time automatically
create or replace function public.stamp_paid() returns trigger language plpgsql as $$
begin
  if new.status in ('paid','arrived') and new.paid_at is null then new.paid_at := now(); end if;
  return new;
end $$;
drop trigger if exists bookings_stamp_paid on public.bookings;
create trigger bookings_stamp_paid before update on public.bookings
  for each row execute function public.stamp_paid();

-- ---------- 7. Send bookings to Odoo automatically ----------
-- Private settings (not visible to the website). Fill in after deploying the odoo-sync function.
create schema if not exists private;
create table if not exists private.config (key text primary key, value text not null);
revoke all on schema private from anon, authenticated;

create or replace function public.notify_odoo() returns trigger
language plpgsql security definer set search_path = public, private as $$
declare v_url text; v_secret text;
begin
  if new.odoo_status = 'sent' then return new; end if;
  select value into v_url    from private.config where key = 'odoo_sync_url';
  select value into v_secret from private.config where key = 'odoo_sync_secret';
  if v_url is null then return new; end if;
  perform net.http_post(
    url     := v_url,
    body    := jsonb_build_object('booking_id', new.id),
    headers := jsonb_build_object('Content-Type','application/json','x-webhook-secret', coalesce(v_secret,'')),
    timeout_milliseconds := 15000);
  return new;
end $$;
drop trigger if exists bookings_to_odoo on public.bookings;
create trigger bookings_to_odoo after insert or update of status on public.bookings
  for each row execute function public.notify_odoo();

-- ---------- 8. Storage for doctor photos ----------
insert into storage.buckets (id, name, public) values ('doctor-photos','doctor-photos', true)
  on conflict (id) do nothing;
drop policy if exists "staff upload doctor photos" on storage.objects;
create policy "staff upload doctor photos" on storage.objects for all to authenticated
  using (bucket_id = 'doctor-photos' and public.is_staff())
  with check (bucket_id = 'doctor-photos' and public.is_staff());

-- ---------- 9. Starting data ----------
insert into public.doctors (name, specialty, fee, photo_url, odoo_doctor_id, sort_order)
select * from (values
  ('Dr. Yahye Shoole',             'Carruurta (Pediatrician)',            10, 'photos/dr-yahye.jpg',  23, 1),
  ('Dr. Harith Abdikadir Mohamud', 'Neerfaha (Neurologist)',              10, 'photos/dr-harith.jpg', 22, 2),
  ('Dr. Hersi',                    'Cudurrada Guud & Uurkujirta',         10, 'photos/dr-hersi.jpg',  49, 3),
  ('Dr. Sadio Omar',               'Daaweynta Hadalka (Speech Therapy)',  21, 'photos/dr-sadio.jpg',  46, 4)
) as v(name, specialty, fee, photo_url, odoo_doctor_id, sort_order)
where not exists (select 1 from public.doctors);

-- Admin login (create the same user in Authentication → Users)
insert into public.staff (email, full_name) values ('harithmohamud86@gmail.com', 'Admin')
  on conflict do nothing;
