// supabase/functions/reset-member-password/index.ts
// Koperasi Keluarga — v4.2
// Reset password anggota via Supabase Admin API (bypass Argon2 issue)

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });

  try {
    // ── 1. Ambil JWT dari request (dikirim oleh frontend) ───────────────────
    const authHeader = req.headers.get("Authorization") ?? "";
    if (!authHeader.startsWith("Bearer ")) {
      return json({ success: false, message: "Unauthorized" }, 401);
    }

    // ── 2. Client pakai anon key + JWT caller (untuk verify admin) ──────────
    const supabaseUrl  = Deno.env.get("SUPABASE_URL")!;
    const anonKey      = Deno.env.get("SUPABASE_ANON_KEY")!;
    const serviceKey   = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

    // Client untuk verifikasi identity caller
    const callerClient = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: authHeader } },
      auth: { autoRefreshToken: false, persistSession: false },
    });

    // Client admin pakai service role (bisa update auth.users)
    const adminClient = createClient(supabaseUrl, serviceKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });

    // ── 3. Verifikasi caller & pastikan admin ───────────────────────────────
    const { data: { user: caller }, error: callerErr } = await callerClient.auth.getUser();
    if (callerErr || !caller) return json({ success: false, message: "Sesi tidak valid" }, 401);

    const { data: callerProfile } = await adminClient
      .from("profiles")
      .select("role")
      .eq("id", caller.id)
      .single();

    if (callerProfile?.role !== "admin") {
      return json({ success: false, message: "Hanya admin yang dapat mereset password anggota" }, 403);
    }

    // ── 4. Parse payload ────────────────────────────────────────────────────
    const body = await req.json().catch(() => ({}));
    const { member_id, new_password, reason } = body as {
      member_id: string;
      new_password: string;
      reason?: string;
    };

    if (!member_id) return json({ success: false, message: "member_id wajib diisi" }, 400);
    if (!new_password || new_password.length < 6) {
      return json({ success: false, message: "Password minimal 6 karakter" }, 400);
    }

    // ── 5. Ambil profile target ─────────────────────────────────────────────
    // profiles.id === auth.users.id (Supabase default)
    const { data: target, error: targetErr } = await adminClient
      .from("profiles")
      .select("id, full_name, username, role, status")
      .eq("id", member_id)
      .single();

    if (targetErr || !target) {
      return json({ success: false, message: `Anggota tidak ditemukan: ${member_id}` }, 404);
    }

    // ── 6. Update password via Admin API ────────────────────────────────────
    // Ini yang BENAR — tidak pakai crypt() atau bcrypt, langsung ke Auth API
    const { error: updateErr } = await adminClient.auth.admin.updateUserById(
      member_id, // profiles.id === auth.users.id
      { password: new_password }
    );

    if (updateErr) {
      console.error("Auth update error:", updateErr);
      return json({
        success: false,
        message: "Gagal update password: " + updateErr.message,
      }, 500);
    }

    // ── 7. Reset hitungan percobaan gagal ────────────────────────────────────
    // `pending_password` adalah sisa mekanisme lama yang tidak pernah lagi
    // ditulis aplikasi (dan sudah kosong di seluruh baris). Rujukannya dilepas
    // agar kolomnya bisa dibuang tanpa mematahkan reset password.
    await adminClient
      .from("profiles")
      .update({ failed_attempts: 0 })
      .eq("id", member_id);

    // ── 8. Log ke adjustments ───────────────────────────────────────────────
    const logReason = reason
      ? `[RESET PASSWORD] ${target.full_name} | Alasan: ${reason}`
      : `[RESET PASSWORD] ${target.full_name} | Direset oleh admin`;

    await adminClient.from("adjustments").insert({
      member_id,
      type: "savings",
      value_before: 0,
      value_after: 0,
      difference: 0,
      reason: logReason,
      admin_id: caller.id,
    });

    console.log(`[reset-pw] Admin ${caller.id} reset password ${target.full_name}`);

    return json({
      success: true,
      message: `Password ${target.full_name} berhasil direset`,
    });

  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[reset-pw] Unexpected:", msg);
    return json({ success: false, message: "Internal error: " + msg }, 500);
  }
});

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}
