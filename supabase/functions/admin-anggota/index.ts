// ═══════════════════════════════════════════════════════════════
// Edge Function: admin-anggota
//
// Menggantikan pemakaian service key di dalam index.html.
//
// LATAR BELAKANG
//   Aplikasi memerlukan Admin API untuk dua hal: mengonfirmasi email
//   anggota baru agar bisa langsung login, dan menghapus akun. Keduanya
//   dulu memakai service key yang ditanam di berkas HTML.
//
//   Service key melewati SELURUH Row Level Security. Siapa pun yang
//   membuka DevTools bisa merangkainya kembali dan mengubah apa pun di
//   database — termasuk saldo dan pinjaman.
//
//   Di sini kuncinya tinggal di server, tidak pernah sampai ke peramban.
//
// PENJAGAAN
//   Setiap permintaan diverifikasi dua lapis:
//     1. Token pemanggil harus sah (diperiksa ke Supabase Auth)
//     2. Pemanggil harus berperan admin (dibaca dari tabel profiles)
//   Tanpa keduanya, permintaan ditolak sebelum menyentuh Admin API.
//
// CARA MEMASANG
//   Supabase Dashboard → Edge Functions → Deploy a new function → Via Editor
//   1. Ganti "Function name" di kanan bawah menjadi: admin-anggota
//   2. Hapus seluruh isi index.ts, tempel berkas ini
//   3. Klik Deploy function
//
//   Variabel SUPABASE_URL dan SUPABASE_SERVICE_ROLE_KEY sudah tersedia
//   otomatis di lingkungan Edge Function — tidak perlu diisi manual.
// ═══════════════════════════════════════════════════════════════

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function jawab(status: number, isi: Record<string, unknown>) {
  return new Response(JSON.stringify(isi), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}

// Memakai Deno.serve bawaan, bukan pustaka dari deno.land. Satu ketergantungan
// luar lebih sedikit berarti satu hal lebih sedikit yang bisa gagal saat deploy.
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return jawab(405, { success: false, message: "Metode tidak didukung" });

  const URL_SUPABASE = Deno.env.get("SUPABASE_URL")!;
  const KUNCI_SERVICE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

  try {
    // ── Lapis 1: token pemanggil harus sah ──
    const otorisasi = req.headers.get("Authorization") ?? "";
    const token = otorisasi.replace("Bearer ", "").trim();
    if (!token) return jawab(401, { success: false, message: "Tidak ada token" });

    const resPengguna = await fetch(`${URL_SUPABASE}/auth/v1/user`, {
      headers: { apikey: KUNCI_SERVICE, Authorization: `Bearer ${token}` },
    });
    if (!resPengguna.ok) return jawab(401, { success: false, message: "Sesi tidak sah" });
    const pengguna = await resPengguna.json();
    if (!pengguna?.id) return jawab(401, { success: false, message: "Sesi tidak sah" });

    // ── Lapis 2: pemanggil harus admin ──
    // Dibaca dari tabel, bukan dari isi token. Isi token bisa dibuat saat
    // pendaftaran dan tidak boleh dipercaya untuk menentukan peran.
    const resProfil = await fetch(
      `${URL_SUPABASE}/rest/v1/profiles?id=eq.${pengguna.id}&select=role&limit=1`,
      { headers: { apikey: KUNCI_SERVICE, Authorization: `Bearer ${KUNCI_SERVICE}` } },
    );
    const profil = await resProfil.json();
    if (!Array.isArray(profil) || profil[0]?.role !== "admin") {
      return jawab(403, { success: false, message: "Hanya admin yang boleh melakukan tindakan ini" });
    }

    const { aksi, user_id } = await req.json();
    if (!user_id) return jawab(400, { success: false, message: "user_id wajib diisi" });

    // ── Konfirmasi email anggota baru ──
    if (aksi === "konfirmasi_email") {
      const res = await fetch(`${URL_SUPABASE}/auth/v1/admin/users/${user_id}`, {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          apikey: KUNCI_SERVICE,
          Authorization: `Bearer ${KUNCI_SERVICE}`,
        },
        body: JSON.stringify({ email_confirm: true }),
      });
      if (!res.ok) {
        const galat = await res.text();
        return jawab(500, { success: false, message: "Gagal mengonfirmasi email: " + galat });
      }
      return jawab(200, { success: true });
    }

    // ── Hapus akun ──
    if (aksi === "hapus_akun") {
      // Admin tidak boleh menghapus akunnya sendiri — kalau itu terjadi dan
      // dia satu-satunya admin, koperasi kehilangan seluruh akses pengelolaan.
      if (user_id === pengguna.id) {
        return jawab(400, { success: false, message: "Tidak bisa menghapus akun sendiri" });
      }

      // ── Penjaga riwayat keuangan ──
      // Foreign key savings/loans/loan_payments ke profiles bersifat CASCADE:
      // menghapus akun MELENYAPKAN seluruh riwayat keuangannya. Bukan sekadar
      // kehilangan data — bunga yang pernah dibayar anggota itu ikut terhapus,
      // sehingga total kas koperasi menyusut surut padahal uangnya masih ada.
      //
      // Pemeriksaan yang sama ada di sisi peramban, tetapi penjaga untuk
      // tindakan yang TIDAK BISA DIBATALKAN tidak boleh hanya hidup di tempat
      // yang bisa dilewati dengan satu panggilan langsung.
      const cek = async (tabel: string) => {
        const r = await fetch(
          `${URL_SUPABASE}/rest/v1/${tabel}?member_id=eq.${user_id}&select=id&limit=1`,
          { headers: { apikey: KUNCI_SERVICE, Authorization: `Bearer ${KUNCI_SERVICE}` } },
        );
        if (!r.ok) return null;              // gagal memeriksa → jangan lanjut
        const baris = await r.json();
        return Array.isArray(baris) ? baris.length > 0 : null;
      };

      for (const tabel of ["savings", "loans", "loan_payments"]) {
        const ada = await cek(tabel);
        if (ada === null) {
          return jawab(500, { success: false, message: `Gagal memeriksa riwayat ${tabel}. Penghapusan dibatalkan demi keamanan.` });
        }
        if (ada) {
          return jawab(409, {
            success: false,
            message: "Anggota ini punya riwayat keuangan (simpanan/pinjaman/cicilan). Riwayat koperasi harus tetap utuh — gunakan Nonaktifkan, bukan Hapus.",
          });
        }
      }
      const res = await fetch(`${URL_SUPABASE}/auth/v1/admin/users/${user_id}`, {
        method: "DELETE",
        headers: { apikey: KUNCI_SERVICE, Authorization: `Bearer ${KUNCI_SERVICE}` },
      });
      if (!res.ok) {
        const galat = await res.text();
        return jawab(500, { success: false, message: "Gagal menghapus akun: " + galat });
      }
      return jawab(200, { success: true });
    }

    return jawab(400, { success: false, message: "Aksi tidak dikenali" });
  } catch (e) {
    return jawab(500, { success: false, message: (e as Error).message });
  }
});