// =====================================================================
//  Supabase Edge Function: odoo-sync
//  Sends online bookings into Baxnaano's Odoo 13 (nuro.patient + nuro.appointment)
//
//  Called automatically by the database (trigger "bookings_to_odoo") and by the
//  "↻" button in admin.html. Deploy with JWT verification OFF (it checks access itself).
//
//  Secrets (Supabase → Edge Functions → Secrets):
//    ODOO_URL       = https://baxnaano.softprimeconsulting.com
//    ODOO_DB        = baxnaano_hms_live
//    ODOO_USER      = login of the limited "Online Booking" Odoo user
//    ODOO_PASSWORD  = that user's password
//    WEBHOOK_SECRET = long random text (same value as private.config 'odoo_sync_secret')
//    PUSH_WHEN      = "paid" (default: only after staff marks it paid) or "any"
//  SUPABASE_URL, SUPABASE_ANON_KEY and SUPABASE_SERVICE_ROLE_KEY are provided automatically.
// =====================================================================
import { createClient } from "npm:@supabase/supabase-js@2";

const env = (k: string, d = "") => Deno.env.get(k) ?? d;
const ODOO_URL = env("ODOO_URL").replace(/\/$/, "");
const ODOO_DB = env("ODOO_DB");
const ODOO_USER = env("ODOO_USER");
const ODOO_PASSWORD = env("ODOO_PASSWORD");
const PUSH_WHEN = env("PUSH_WHEN", "paid");
const OPD_TYPE_ID = Number(env("ODOO_OPD_TYPE_ID", "1")); // appointment.type.master "OPD"

const admin = createClient(env("SUPABASE_URL"), env("SUPABASE_SERVICE_ROLE_KEY"));
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-webhook-secret",
};

// ---------- Odoo JSON-RPC ----------
async function odoo(service: string, method: string, args: unknown[]) {
  const r = await fetch(`${ODOO_URL}/jsonrpc`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", method: "call", params: { service, method, args }, id: Date.now() }),
  });
  if (!r.ok) throw new Error(`Odoo HTTP ${r.status}`);
  const j = await r.json();
  if (j.error) throw new Error(j.error.data?.message ?? j.error.message ?? JSON.stringify(j.error));
  return j.result;
}
let uidCache: number | null = null;
async function uid() {
  if (!uidCache) uidCache = await odoo("common", "login", [ODOO_DB, ODOO_USER, ODOO_PASSWORD]);
  if (!uidCache) throw new Error("Odoo login failed — check ODOO_USER / ODOO_PASSWORD");
  return uidCache;
}
const kw = async (model: string, method: string, args: unknown[], kwargs: Record<string, unknown> = {}) =>
  odoo("object", "execute_kw", [ODOO_DB, await uid(), ODOO_PASSWORD, model, method, args, kwargs]);

// ---------- helpers ----------
function dobFromAge(age?: number | null) {
  const y = new Date().getUTCFullYear() - (Number.isFinite(age as number) ? Number(age) : 0);
  return `${y}-01-01`;
}
// Mogadishu = UTC+3; Odoo stores datetimes in UTC
function utcDatetime(date: string, time: string) {
  const [h, m] = time.slice(0, 5).split(":").map((x) => parseInt(x, 10) || 0);
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCHours(h - 3, m, 0, 0);
  return d.toISOString().slice(0, 19).replace("T", " ");
}

async function findOrCreatePatient(b: any) {
  const ids = await kw("nuro.patient", "search", [["|", ["mobile", "=", b.phone], ["phone", "=", b.phone]]], { limit: 1 });
  if (ids.length) return ids[0];
  const vals: Record<string, unknown> = { name: b.patient_name, mobile: b.phone, dob: dobFromAge(b.age) };
  if (b.gender) vals.gender = b.gender;
  try {
    return await kw("nuro.patient", "create", [vals]);
  } catch (_e) {
    delete vals.gender; // some setups don't have gender on the patient
    return await kw("nuro.patient", "create", [vals]);
  }
}

async function sync(bookingId: string) {
  const { data: b, error } = await admin.from("bookings").select("*").eq("id", bookingId).single();
  if (error || !b) throw new Error("booking not found");
  if (b.odoo_status === "sent") return { skipped: "already in Odoo", appointment: b.odoo_appointment_id };
  if (b.status === "cancelled") return { skipped: "cancelled" };
  if (PUSH_WHEN === "paid" && !["paid", "arrived"].includes(b.status)) return { skipped: "not paid yet" };

  const { data: doc } = await admin.from("doctors").select("odoo_doctor_id,name").eq("id", b.doctor_id).single();
  if (!doc?.odoo_doctor_id) throw new Error(`Doctor "${b.doctor_name}" has no Odoo Doctor ID (set it in admin → Dhakhaatiirta)`);

  const patientId = await findOrCreatePatient(b);
  const apptId = await kw("nuro.appointment", "create", [{
    patient_id: patientId,
    doctor_id: doc.odoo_doctor_id,
    appointment_date: utcDatetime(b.visit_date, b.visit_time),
    date_of_appointment: b.visit_date,
    appointment_type: "normal",
    appointment_type_id: OPD_TYPE_ID,
    type: b.is_returning ? "follow_up" : "new",
    bill_to_type: "patient",
    payment_type: "cash",
    mobile: b.phone,
    age: b.age != null ? `${b.age}  Y` : false,
    gender: b.gender || false,
  }]);
  await kw("nuro.appointment", "message_post", [[apptId]], {
    body: `🌐 Online booking ${b.ref} · queue #${b.queue_number} · ${b.visit_time.slice(0, 5)} · fee $${b.fee} · ` +
      `${b.paid_at ? "PAID (USSD) " + b.paid_at.slice(0, 16).replace("T", " ") : "NOT PAID"}` +
      (b.district ? ` · ${b.district}` : "") + (b.notes ? ` · Notes: ${b.notes}` : ""),
  }).catch(() => {}); // the note is nice-to-have

  await admin.from("bookings").update({ odoo_status: "sent", odoo_appointment_id: apptId, odoo_error: null }).eq("id", bookingId);
  return { created: apptId, patient: patientId };
}

async function allowed(req: Request) {
  const secret = env("WEBHOOK_SECRET");
  if (secret && req.headers.get("x-webhook-secret") === secret) return true;
  const auth = req.headers.get("authorization") ?? "";
  if (!auth.startsWith("Bearer ")) return false;
  const user = createClient(env("SUPABASE_URL"), env("SUPABASE_ANON_KEY"), { global: { headers: { Authorization: auth } } });
  const { data } = await user.rpc("is_staff");
  return data === true;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (!(await allowed(req))) return new Response("forbidden", { status: 403, headers: CORS });
  let id = "";
  try {
    const body = await req.json();
    id = String(body?.booking_id ?? body?.record?.id ?? "");
    if (!id) return Response.json({ ok: false, error: "no booking_id" }, { status: 400, headers: CORS });
    const result = await sync(id);
    return Response.json({ ok: true, ...result }, { headers: CORS });
  } catch (e) {
    const msg = String((e as Error)?.message ?? e).slice(0, 500);
    console.error(id, msg);
    if (id) await admin.from("bookings").update({ odoo_status: "error", odoo_error: msg }).eq("id", id);
    return Response.json({ ok: false, error: msg }, { headers: CORS });
  }
});
