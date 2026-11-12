/* =====================================================
   BAXNAANO BOOKING — data layer
   LIVE mode: your Supabase (config.js filled in)
   DEMO mode: everything stored in this browser only
   ===================================================== */
(function () {
  const CFG = window.BAXNAANO_CONFIG || {};
  const LIVE = !!(CFG.supabaseUrl && CFG.supabaseAnonKey);
  const TZ_OFFSET_MIN = 180; // Mogadishu = UTC+3

  const DEFAULT_SETTINGS = {
    hospital_name: 'Baxnaano Hospital', tagline: 'Treatment and beyond',
    phones: [], whatsapp: '252613490055', email: '', address: 'Muqdisho, Soomaaliya',
    open_time: '08:00', close_time: '19:00', slot_minutes: 15,
    ussd_prefix: '*712*', ussd_number: '684003333', booking_open: true, announcement: ''
  };
  const ERRORS = {
    BOOKING_CLOSED: 'Ballamaha online-ka hadda waa xidhan yihiin. Fadlan wac isbitaalka.',
    DOCTOR_NOT_FOUND: 'Dhakhtarkan hadda lama heli karo. Fadlan dooro mid kale.',
    BAD_NAME: 'Fadlan geli magaca oo dhammaystiran.',
    BAD_PHONE: 'Lambarka taleefanka sax maaha.',
    BAD_GENDER: 'Fadlan dooro jinsiga.',
    TOO_MANY: 'Lambarkan ballamo badan ayuu maanta sameeyay. Fadlan wac isbitaalka.',
    NO_SLOT: 'Dhakhtarkan ballan bannaan uma hayo 2-da toddobaad ee soo socda.'
  };
  function friendly(err) {
    const m = String((err && (err.message || err.error_description)) || err || '');
    for (const k in ERRORS) if (m.includes(k)) return new Error(ERRORS[k]);
    if (/Failed to fetch|NetworkError|network/i.test(m)) return new Error('Internet ma jiro. Fadlan isku day mar kale.');
    return new Error(m || 'Khalad ayaa dhacay. Fadlan isku day mar kale.');
  }
  const hm = (t) => String(t || '').slice(0, 5);
  const toMin = (t) => { const [h, m] = hm(t).split(':').map(Number); return h * 60 + (m || 0); };
  const fromMin = (n) => String(Math.floor(n / 60)).padStart(2, '0') + ':' + String(n % 60).padStart(2, '0');
  function mogNow() { const d = new Date(Date.now() + TZ_OFFSET_MIN * 60000); return { date: d.toISOString().slice(0, 10), min: d.getUTCHours() * 60 + d.getUTCMinutes(), dow: d.getUTCDay() }; }
  function addDays(iso, n) { const d = new Date(iso + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }
  function normPhone(p) { let d = String(p || '').replace(/\D/g, ''); if (d.startsWith('252')) d = d.slice(3); if (d && d[0] !== '0') d = '0' + d; return d; }

  /* ---------------- LIVE (Supabase) ---------------- */
  let sbPromise = null;
  function sb() {
    if (!sbPromise) sbPromise = new Promise((res, rej) => {
      if (window.supabase) return res(window.supabase.createClient(CFG.supabaseUrl, CFG.supabaseAnonKey));
      const s = document.createElement('script');
      s.src = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/dist/umd/supabase.min.js';
      s.onload = () => res(window.supabase.createClient(CFG.supabaseUrl, CFG.supabaseAnonKey));
      s.onerror = () => rej(new Error('Internet ma jiro. Fadlan isku day mar kale.'));
      document.head.appendChild(s);
    });
    return sbPromise;
  }
  async function q(promise) { const { data, error } = await promise; if (error) throw friendly(error); return data; }

  const live = {
    async settings() { const c = await sb(); const r = await q(c.from('settings').select('*').eq('id', 1).maybeSingle()); return Object.assign({}, DEFAULT_SETTINGS, r || {}); },
    async doctors() { const c = await sb(); return q(c.from('doctors').select('*').eq('active', true).order('sort_order').order('name')); },
    async book(p) {
      const c = await sb();
      try {
        return await q(c.rpc('create_booking', { p_doctor: p.doctor_id, p_name: p.name, p_phone: p.phone, p_age: p.age ? +p.age : null,
          p_gender: p.gender || null, p_district: p.district || null, p_returning: !!p.returning, p_notes: p.notes || null }));
      } catch (e) { throw friendly(e); }
    },
    async lookup(ref) { const c = await sb(); return q(c.rpc('get_booking', { p_ref: ref })); },
    // ---- staff ----
    async session() { const c = await sb(); const { data } = await c.auth.getSession(); return data.session; },
    async login(email, password) { const c = await sb(); const { data, error } = await c.auth.signInWithPassword({ email, password }); if (error) throw new Error('Email ama password khaldan.'); const ok = await q(c.rpc('is_staff')); if (!ok) { await c.auth.signOut(); throw new Error('Akoonkan looma oggola admin-ka. Ku dar email-ka miiska "staff".'); } return data.session; },
    async logout() { const c = await sb(); await c.auth.signOut(); },
    async allDoctors() { const c = await sb(); return q(c.from('doctors').select('*').order('sort_order').order('name')); },
    async saveDoctor(d) { const c = await sb(); const row = Object.assign({}, d); if (!row.id) delete row.id; return q(c.from('doctors').upsert(row).select().single()); },
    async deleteDoctor(id) { const c = await sb(); return q(c.from('doctors').update({ active: false }).eq('id', id)); },
    async uploadPhoto(file) { const c = await sb(); const path = `dr-${Date.now()}.${(file.name.split('.').pop() || 'jpg').toLowerCase()}`; await q(c.storage.from('doctor-photos').upload(path, file, { upsert: true, contentType: file.type })); return c.storage.from('doctor-photos').getPublicUrl(path).data.publicUrl; },
    async bookings(from, to) { const c = await sb(); return q(c.from('bookings').select('*').gte('visit_date', from).lte('visit_date', to).order('visit_date').order('visit_time').order('queue_number')); },
    async setStatus(id, status) { const c = await sb(); return q(c.from('bookings').update({ status }).eq('id', id).select().single()); },
    async saveSettings(s) { const c = await sb(); const row = Object.assign({}, s, { id: 1, updated_at: new Date().toISOString() }); return q(c.from('settings').upsert(row).select().single()); },
    async resendOdoo(id) { const c = await sb(); const { data, error } = await c.functions.invoke('odoo-sync', { body: { booking_id: id } }); if (error) throw friendly(error); return data; },
    async watchBookings(cb) { const c = await sb(); return c.channel('bookings').on('postgres_changes', { event: '*', schema: 'public', table: 'bookings' }, cb).subscribe(); }
  };

  /* ---------------- DEMO (this browser only) ---------------- */
  const K = { s: 'bxd_settings', d: 'bxd_doctors', b: 'bxd_bookings', a: 'bxd_admin' };
  const load = (k, f) => { try { const v = JSON.parse(localStorage.getItem(k)); return v == null ? f : v; } catch (e) { return f; } };
  const save = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} };
  const uid = () => (crypto.randomUUID ? crypto.randomUUID() : 'id-' + Math.random().toString(36).slice(2));
  const SEED = [
    { name: 'Dr. Yahye Shoole', specialty: 'Carruurta (Pediatrician)', fee: 10, photo_url: 'photos/dr-yahye.jpg', odoo_doctor_id: 23, sort_order: 1 },
    { name: 'Dr. Harith Abdikadir Mohamud', specialty: 'Neerfaha (Neurologist)', fee: 10, photo_url: 'photos/dr-harith.jpg', odoo_doctor_id: 22, sort_order: 2, bio: 'Senior Consultant Neurologist · Dhakhtarka neerfaha iyo madaxa\n12+ sano khibrad\n- Madax xanuun (migraine, tension, cluster)\n- Dhabar xanuunka\n- Wareer (vertigo)\n- Dhaga guuxa (tinnitus)\n- Indha kala qallooca neerfaha\n- Faaliga (stroke)\n- Ilmaha kafka ku daaha (cerebral palsy, birth asphyxia)' },
    { name: 'Dr. Hersi', specialty: 'Cudurrada Guud & Uurkujirta', fee: 10, photo_url: 'photos/dr-hersi.jpg', odoo_doctor_id: 49, sort_order: 3 },
    { name: 'Dr. Sadio Omar', specialty: 'Daaweynta Hadalka (Speech Therapy)', fee: 21, photo_url: 'photos/dr-sadio.jpg', odoo_doctor_id: 46, sort_order: 4 }
  ].map((d) => Object.assign({ id: uid(), bio: '', work_days: [0, 1, 2, 3, 4, 5, 6], daily_limit: 40, active: true }, d));
  const dDoctors = () => { let l = load(K.d, null); if (!l) { l = SEED; save(K.d, l); } return l; };
  const delay = (v) => new Promise((r) => setTimeout(() => r(v), 250));
  const demo = {
    async settings() { return delay(Object.assign({}, DEFAULT_SETTINGS, load(K.s, {}))); },
    async doctors() { return delay(dDoctors().filter((d) => d.active).sort((a, b) => a.sort_order - b.sort_order)); },
    async book(p) {
      const s = await demo.settings(); const d = dDoctors().find((x) => x.id === p.doctor_id && x.active);
      if (!s.booking_open) throw friendly('BOOKING_CLOSED'); if (!d) throw friendly('DOCTOR_NOT_FOUND');
      if (String(p.name || '').trim().length < 3) throw friendly('BAD_NAME');
      const phone = normPhone(p.phone); if (phone.length < 7 || phone.length > 15) throw friendly('BAD_PHONE');
      const all = load(K.b, []); const now = mogNow(); const slot = +s.slot_minutes || 15;
      let date = now.date, time = null, queue = 0;
      for (let i = 0; i < 15 && !time; i++, date = addDays(date, 1)) {
        const dow = new Date(date + 'T00:00:00Z').getUTCDay(); if (!d.work_days.includes(dow)) continue;
        const day = all.filter((b) => b.doctor_id === d.id && b.visit_date === date && b.status !== 'cancelled');
        if (day.length >= d.daily_limit) continue;
        let t = day.length ? Math.max(...day.map((b) => toMin(b.visit_time))) + slot : toMin(s.open_time);
        if (date === now.date) t = Math.max(t, toMin(s.open_time) + Math.max(0, Math.ceil((now.min - toMin(s.open_time)) / slot)) * slot);
        if (t <= toMin(s.close_time) - slot) { time = fromMin(t); queue = (day.length ? Math.max(...day.map((b) => b.queue_number)) : 0) + 1; break; }
      }
      if (!time) throw friendly('NO_SLOT');
      const b = { id: uid(), ref: 'BX-' + Math.random().toString(16).slice(2, 8).toUpperCase(), doctor_id: d.id, doctor_name: d.name, specialty: d.specialty,
        patient_name: String(p.name).trim().toUpperCase(), phone, age: p.age ? +p.age : null, gender: p.gender || null, district: p.district || null,
        is_returning: !!p.returning, notes: p.notes || null, visit_date: date, visit_time: time, queue_number: queue, fee: +d.fee, status: 'pending',
        paid_at: null, odoo_status: 'waiting', odoo_appointment_id: null, odoo_error: null, created_at: new Date().toISOString() };
      all.push(b); save(K.b, all);
      return delay({ ref: b.ref, doctor: b.doctor_name, specialty: b.specialty, patient: b.patient_name, date: b.visit_date, time: b.visit_time, queue: b.queue_number, fee: b.fee, status: b.status });
    },
    async lookup(ref) { const b = load(K.b, []).find((x) => x.ref === String(ref).trim().toUpperCase()); return delay(b ? { ref: b.ref, doctor: b.doctor_name, specialty: b.specialty, patient: b.patient_name.split(' ')[0], date: b.visit_date, time: b.visit_time, queue: b.queue_number, fee: b.fee, status: b.status } : null); },
    async session() { return load(K.a, null); },
    async login(email, password) { if (!email || !password) throw new Error('Geli email iyo password.'); const s = { user: { email } }; save(K.a, s); return s; },
    async logout() { localStorage.removeItem(K.a); },
    async allDoctors() { return delay(dDoctors().slice().sort((a, b) => a.sort_order - b.sort_order)); },
    async saveDoctor(d) { const l = dDoctors(); const row = Object.assign({ id: uid(), work_days: [0, 1, 2, 3, 4, 5, 6], daily_limit: 40, active: true, sort_order: l.length + 1 }, d); if (!d.id) row.id = uid(); const i = l.findIndex((x) => x.id === row.id); if (i >= 0) l[i] = row; else l.push(row); save(K.d, l); return delay(row); },
    async deleteDoctor(id) { const l = dDoctors(); const d = l.find((x) => x.id === id); if (d) d.active = false; save(K.d, l); return delay(true); },
    async uploadPhoto(file) { return new Promise((res) => { const r = new FileReader(); r.onload = () => res(r.result); r.readAsDataURL(file); }); },
    async bookings(from, to) { return delay(load(K.b, []).filter((b) => b.visit_date >= from && b.visit_date <= to).sort((a, b) => (a.visit_date + a.visit_time + String(a.queue_number).padStart(3, '0')).localeCompare(b.visit_date + b.visit_time + String(b.queue_number).padStart(3, '0')))); },
    async setStatus(id, status) { const l = load(K.b, []); const b = l.find((x) => x.id === id); if (b) { b.status = status; if ((status === 'paid' || status === 'arrived') && !b.paid_at) b.paid_at = new Date().toISOString(); if (status === 'paid') { b.odoo_status = 'sent'; b.odoo_appointment_id = 1000 + l.indexOf(b); } } save(K.b, l); return delay(b); },
    async saveSettings(s) { save(K.s, Object.assign({}, load(K.s, {}), s)); return delay(true); },
    async resendOdoo(id) { return demo.setStatus(id, 'paid'); },
    async watchBookings() { return null; }
  };

  window.BX = Object.assign({ LIVE, DEFAULT_SETTINGS, mogNow, addDays, normPhone, hm }, LIVE ? live : demo);
})();
