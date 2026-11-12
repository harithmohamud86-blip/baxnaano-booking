// =====================================================================
//  Supabase Edge Function: bx-pay
//  Patient pays the booking fee from their phone (EVC Plus / Zaad / Sahal)
//  through WaafiPay. The patient gets a PIN prompt on their phone; when they
//  approve, the booking is marked paid automatically (no reception step).
//
//  Deploy with JWT verification OFF (patients are not logged in).
//  Secrets (Supabase → Edge Functions → Secrets), from your WaafiPay merchant account:
//    WAAFI_MERCHANT_UID, WAAFI_API_USER_ID, WAAFI_API_KEY
//    WAAFI_URL (optional) = https://api.waafipay.net/asm  (sandbox: https://sandbox.waafipay.com/asm)
//  Also needs settings.online_pay = true (admin.html → Dejinta).
// =====================================================================
import { createClient } from "npm:@supabase/supabase-js@2";

const env = (k: string, d = "") => Deno.env.get(k) ?? d;
const db = createClient(env("SUPABASE_URL"), env("SUPABASE_SERVICE_ROLE_KEY"));
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const out = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });

// Somali messages for common WaafiPay answers
function friendly(msg: string) {
  const m = (msg || "").toLowerCase();
  if (m.includes("insufficient") || m.includes("balance")) return "Haraaga akoonkaagu kuma filna. Ku shubo lacag, kadib isku day mar kale.";
  if (m.includes("cancel") || m.includes("reject") || m.includes("declin")) return "Lacag bixinta waa la joojiyay (PIN lama gelin). Isku day mar kale.";
  if (m.includes("timeout") || m.includes("time out") || m.includes("expired")) return "Waqtigii PIN-ka wuu dhammaaday. Isku day mar kale oo PIN-ka si dhakhso ah u geli.";
  if (m.includes("account") || m.includes("subscriber") || m.includes("not found")) return "Lambarkan akoon EVC/Zaad/Sahal ah lagama helin. Hubi lambarka.";
  return "Lacag bixintu ma dhicin: " + msg;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return out({ ok: true });
  try {
    const { ref, phone } = await req.json().catch(() => ({}));
    if (!ref) return out({ ok: false, error: "Lambarka ballanka ayaa maqan." }, 400);

    const [{ data: s }, { data: b }] = await Promise.all([
      db.from("settings").select("online_pay").eq("id", 1).single(),
      db.from("bookings").select("*").eq("ref", String(ref).trim().toUpperCase()).maybeSingle(),
    ]);
    const MUID = env("WAAFI_MERCHANT_UID"), UID = env("WAAFI_API_USER_ID"), KEY = env("WAAFI_API_KEY");
    if (!s?.online_pay || !MUID || !UID || !KEY) return out({ ok: false, error: "Online payment wali lama furin. Isticmaal USSD-ga." }, 400);
    if (!b) return out({ ok: false, error: "Ballankan lama helin." }, 404);
    if (b.status === "paid" || b.status === "arrived") return out({ ok: true, status: b.status, already: true });
    if (b.status === "cancelled") return out({ ok: false, error: "Ballankan waa la joojiyay." }, 400);
    if (b.pay_attempts >= 5) return out({ ok: false, error: "Isku day badan. Fadlan wac isbitaalka ama isticmaal USSD-ga." }, 429);

    // phone: 06xxxxxxx / 6xxxxxxx / 2526xxxxxxx → 2526xxxxxxx
    let p = String(phone || b.phone).replace(/\D/g, "");
    if (p.startsWith("252")) p = p.slice(3);
    p = p.replace(/^0+/, "");
    if (p.length < 7 || p.length > 10) return out({ ok: false, error: "Lambarka taleefanka sax ma aha." }, 400);

    await db.from("bookings").update({ pay_attempts: b.pay_attempts + 1 }).eq("id", b.id);

    const body = {
      schemaVersion: "1.0",
      requestId: crypto.randomUUID(),
      timestamp: new Date().toISOString(),
      channelName: "WEB",
      serviceName: "API_PURCHASE",
      serviceParams: {
        merchantUid: MUID, apiUserId: UID, apiKey: KEY,
        paymentMethod: "MWALLET_ACCOUNT",
        payerInfo: { accountNo: "252" + p },
        transactionInfo: {
          referenceId: `${b.ref}-${b.pay_attempts + 1}`,
          invoiceId: b.ref,
          amount: Number(b.fee).toFixed(2),
          currency: "USD",
          description: `Baxnaano ballan ${b.ref} - ${b.doctor_name}`,
        },
      },
    };
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 110_000); // patient has time to enter PIN
    let r: any;
    try {
      const res = await fetch(env("WAAFI_URL", "https://api.waafipay.net/asm"), {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal: ctl.signal,
      });
      r = await res.json();
    } catch (_e) {
      return out({ ok: false, error: friendly("timeout") });
    } finally { clearTimeout(timer); }

    const state = String(r?.params?.state || "").toUpperCase();
    if (String(r?.responseCode) === "2001" && (state === "APPROVED" || state === "")) {
      const { data: up } = await db.from("bookings").update({
        status: "paid", paid_at: new Date().toISOString(), payment_method: "waafipay",
        payment_txn: String(r?.params?.transactionId || r?.params?.referenceId || ""), paid_by: "WaafiPay (auto)", updated_by: "WaafiPay (auto)",
      }).eq("id", b.id).eq("status", "pending").select("status").maybeSingle();
      return out({ ok: true, status: up?.status || "paid", txn: r?.params?.transactionId || null });
    }
    return out({ ok: false, error: friendly(String(r?.responseMsg || r?.params?.description || "unknown")) });
  } catch (e) {
    return out({ ok: false, error: String((e as Error).message || e) }, 500);
  }
});
