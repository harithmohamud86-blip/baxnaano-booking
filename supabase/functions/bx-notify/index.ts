// =====================================================================
//  Supabase Edge Function: bx-notify
//  Sends SMS to patients through Hormuud SMS API:
//    • "booked"    – right after booking (ref, time, queue, how to pay)
//    • "paid"      – when payment is confirmed
//    • "reminders" – every morning 06:30 for today's patients (pg_cron)
//  Called only by the database (x-hook-secret checked against private.config).
//  Deploy with JWT verification OFF.
//  Secrets: HORMUUD_SMS_USER, HORMUUD_SMS_PASSWORD, HORMUUD_SENDER_ID (optional)
//  Also needs settings.sms_enabled = true (admin.html → Dejinta).
// =====================================================================
import { createClient } from "npm:@supabase/supabase-js@2";

const env = (k: string, d = "") => Deno.env.get(k) ?? d;
const db = createClient(env("SUPABASE_URL"), env("SUPABASE_SERVICE_ROLE_KEY"));
const out = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { "Content-Type": "application/json" } });

const WEEK = ["Axad", "Isniin", "Talaado", "Arbaco", "Khamiis", "Jimce", "Sabti"];
const t12 = (t: string) => { const [h, m] = String(t).split(":").map(Number); return `${((h + 11) % 12) + 1}:${String(m).padStart(2, "0")} ${h >= 12 ? "PM" : "AM"}`; };
const day = (d: string) => { const x = new Date(d + "T00:00:00Z"); return `${WEEK[x.getUTCDay()]} ${x.getUTCDate()}/${x.getUTCMonth() + 1}`; };
const today = () => new Date(Date.now() + 3 * 3600_000).toISOString().slice(0, 10);

let token = "", tokenAt = 0;
async function smsToken() {
  if (token && Date.now() - tokenAt < 50 * 60_000) return token;
  const res = await fetch("https://smsapi.hormuud.com/token", {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ username: env("HORMUUD_SMS_USER"), password: env("HORMUUD_SMS_PASSWORD"), grant_type: "password" }),
  });
  const j = await res.json();
  if (!j.access_token) throw new Error("Hormuud token: " + JSON.stringify(j).slice(0, 200));
  token = j.access_token; tokenAt = Date.now(); return token;
}
async function sendSMS(phone: string, message: string, refid: string) {
  let p = String(phone).replace(/\D/g, ""); if (p.startsWith("252")) p = p.slice(3); p = p.replace(/^0+/, "");
  const res = await fetch("https://smsapi.hormuud.com/api/SendSMS", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer " + await smsToken() },
    body: JSON.stringify({ mobile: p, message, senderid: env("HORMUUD_SENDER_ID", "Baxnaano"), refid, validity: 0 }),
  });
  const j = await res.json().catch(() => ({}));
  if (String(j.ResponseCode) !== "200") throw new Error("SMS: " + (j.ResponseMessage || res.status));
  return j;
}

function text(event: string, b: any, s: any) {
  const pay = `${s.ussd_prefix || "*712*"}${s.ussd_number || ""}*${Number(b.fee)}#`;
  if (event === "booked")
    return `Baxnaano Hospital: Ballankaaga ${b.ref} waa la qabtay. ${b.doctor_name}, ${day(b.visit_date)} ${t12(b.visit_time)}, safka #${b.queue_number}. Bixi $${Number(b.fee)}: ${pay}`;
  if (event === "paid")
    return `Baxnaano: Lacagtii ballanka ${b.ref} waa la helay. ${day(b.visit_date)} ${t12(b.visit_time)}, safka #${b.queue_number}. Fadlan kaalay 15 daqiiqo ka hor. Mahadsanid!`;
  return `Baxnaano: Xusuusin - maanta ballankaaga ${b.ref} waa ${t12(b.visit_time)}, ${b.doctor_name}, safka #${b.queue_number}. Ku soo dhowow waqtiga. Mahadsanid!`;
}
const COL: Record<string, string> = { booked: "sms_booked_at", paid: "sms_paid_at", reminder: "sms_reminder_at" };

Deno.serve(async (req) => {
  try {
    const { data: ok } = await db.rpc("hook_ok", { p: req.headers.get("x-hook-secret") || "" });
    if (!ok) return out({ ok: false, error: "forbidden" }, 403);
    if (!env("HORMUUD_SMS_USER") || !env("HORMUUD_SMS_PASSWORD")) return out({ ok: true, skipped: "SMS account not set" });

    const { event, booking_id } = await req.json();
    const { data: s } = await db.from("settings").select("*").eq("id", 1).single();
    if (!s?.sms_enabled) return out({ ok: true, skipped: "sms disabled" });

    let list: any[] = [];
    let kind = event;
    if (event === "reminders") {
      kind = "reminder";
      const { data } = await db.from("bookings").select("*").eq("visit_date", today()).in("status", ["pending", "paid"]).is("sms_reminder_at", null);
      list = data || [];
    } else if (event === "booked" || event === "paid") {
      const { data } = await db.from("bookings").select("*").eq("id", booking_id).maybeSingle();
      if (data && !data[COL[event]]) list = [data];
    } else return out({ ok: false, error: "bad event" }, 400);

    const results = [];
    for (const b of list) {
      // don't send "booked" for a same-day reminder later; skip reminder if booked within last 2h
      if (kind === "reminder" && Date.now() - new Date(b.created_at).getTime() < 2 * 3600_000) continue;
      try {
        await sendSMS(b.phone, text(kind, b, s), b.ref);
        await db.from("bookings").update({ [COL[kind]]: new Date().toISOString() }).eq("id", b.id);
        results.push({ ref: b.ref, ok: true });
      } catch (e) { results.push({ ref: b.ref, ok: false, error: String((e as Error).message) }); }
    }
    return out({ ok: true, sent: results });
  } catch (e) {
    return out({ ok: false, error: String((e as Error).message || e) }, 500);
  }
});
