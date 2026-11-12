// =====================================================================
//  Supabase Edge Function: bx-staff
//  Lets an ADMIN (admin.html → 👥 Shaqaalaha) add receptionists, reset their
//  passwords, change roles and switch accounts off — without the Supabase dashboard.
//  The caller must be logged in and have role 'admin' in public.staff.
//  Uses the service-role key that Supabase gives the function automatically
//  (it never reaches the browser).
// =====================================================================
import { createClient } from "npm:@supabase/supabase-js@2";

const env = (k: string, d = "") => Deno.env.get(k) ?? d;
const svc = createClient(env("SUPABASE_URL"), env("SUPABASE_SERVICE_ROLE_KEY"), { auth: { persistSession: false } });
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const out = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { ...CORS, "Content-Type": "application/json" } });
const STAFF_DOMAIN = "staff.baxnaano.com"; // usernames without @ become user@staff.baxnaano.com
const toEmail = (login: string) => { const l = String(login || "").trim().toLowerCase(); return l.includes("@") ? l : `${l.replace(/[^a-z0-9._-]/g, "")}@${STAFF_DOMAIN}`; };

async function findUser(email: string) {
  for (let page = 1; page < 20; page++) {
    const { data, error } = await svc.auth.admin.listUsers({ page, perPage: 200 });
    if (error) throw error;
    const u = data.users.find((x) => (x.email || "").toLowerCase() === email);
    if (u) return u;
    if (data.users.length < 200) return null;
  }
  return null;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return out({ ok: true });
  try {
    const auth = req.headers.get("Authorization") || "";
    const caller = createClient(env("SUPABASE_URL"), env("SUPABASE_ANON_KEY"), { global: { headers: { Authorization: auth } }, auth: { persistSession: false } });
    const { data: isAdmin } = await caller.rpc("is_admin");
    if (!isAdmin) return out({ ok: false, error: "Admin kaliya ayaa samayn kara." }, 403);
    const { data: me } = await caller.rpc("my_staff");

    const { action, login, password, full_name, role, active } = await req.json();
    const email = login ? toEmail(login) : "";

    if (action === "list") {
      const { data } = await svc.from("staff").select("*").order("created_at");
      const { data: users } = await svc.auth.admin.listUsers({ page: 1, perPage: 500 });
      const seen = new Map((users?.users || []).map((u) => [String(u.email).toLowerCase(), u.last_sign_in_at]));
      return out({ ok: true, staff: (data || []).map((s) => ({ ...s, last_sign_in_at: seen.get(s.email.toLowerCase()) || null, has_login: seen.has(s.email.toLowerCase()) })) });
    }
    if (!email) return out({ ok: false, error: "Geli username ama email." }, 400);
    if (email === String(me?.email || "").toLowerCase() && (action === "set_active" || action === "set_role"))
      return out({ ok: false, error: "Akoonkaaga ma bedeli kartid halkan." }, 400);

    if (action === "create") {
      if (!password || String(password).length < 8) return out({ ok: false, error: "Password-ku ugu yaraan 8 xaraf." }, 400);
      const r = ["admin", "reception"].includes(role) ? role : "reception";
      let u = await findUser(email);
      if (!u) {
        const { data, error } = await svc.auth.admin.createUser({ email, password, email_confirm: true, user_metadata: { full_name } });
        if (error) return out({ ok: false, error: error.message }, 400);
        u = data.user;
      } else {
        await svc.auth.admin.updateUserById(u.id, { password });
      }
      const { error } = await svc.from("staff").upsert({ email, full_name: full_name || null, role: r, active: true });
      if (error) return out({ ok: false, error: error.message }, 400);
      return out({ ok: true, email });
    }
    if (action === "reset_password") {
      if (!password || String(password).length < 8) return out({ ok: false, error: "Password-ku ugu yaraan 8 xaraf." }, 400);
      const u = await findUser(email); if (!u) return out({ ok: false, error: "Akoonkan lama helin." }, 404);
      const { error } = await svc.auth.admin.updateUserById(u.id, { password });
      return error ? out({ ok: false, error: error.message }, 400) : out({ ok: true });
    }
    if (action === "set_active") {
      const { error } = await svc.from("staff").update({ active: !!active }).eq("email", email);
      return error ? out({ ok: false, error: error.message }, 400) : out({ ok: true });
    }
    if (action === "set_role") {
      const { error } = await svc.from("staff").update({ role: role === "admin" ? "admin" : "reception" }).eq("email", email);
      return error ? out({ ok: false, error: error.message }, 400) : out({ ok: true });
    }
    return out({ ok: false, error: "bad action" }, 400);
  } catch (e) {
    return out({ ok: false, error: String((e as Error).message || e) }, 500);
  }
});
