// ══════════════════════════════════════════════════════════════
// EDGE FUNCTION — kirim-push
//
// Mengirim push notification ke perangkat anggota.
//
// Yang dikirim BUKAN teks bebas dari peramban, melainkan sebuah KEJADIAN
// beserta id pinjamannya. Fungsi ini sendiri yang menentukan siapa
// penerimanya dan apa bunyi pesannya, setelah memastikan pemanggilnya
// memang berhak. Kalau teksnya boleh dikirim dari peramban, siapa pun yang
// sudah masuk bisa mengirim pesan apa pun ke HP anggota lain.
//
// Langganan yang sudah mati (410/404) dihapus, supaya tabelnya tidak
// menumpuk alamat yang tidak pernah bisa dihubungi lagi.
// ══════════════════════════════════════════════════════════════
import webpush from 'npm:web-push@3.6.7'
import { createClient } from 'npm:@supabase/supabase-js@2'

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS'
}
const jawab = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } })

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS })

  try {
    const URL_SB   = Deno.env.get('SUPABASE_URL')!
    const SERVICE  = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    const VAPID_PU = Deno.env.get('VAPID_PUBLIC_KEY')!
    const VAPID_PR = Deno.env.get('VAPID_PRIVATE_KEY')!
    const SUBJECT  = Deno.env.get('VAPID_SUBJECT') || 'mailto:admin@koperasi.internal'
    if (!VAPID_PU || !VAPID_PR) return jawab({ success: false, message: 'VAPID key belum diset' }, 500)

    webpush.setVapidDetails(SUBJECT, VAPID_PU, VAPID_PR)

    // Identitas pemanggil diverifikasi dari tokennya, bukan dari body
    const auth = req.headers.get('Authorization') || ''
    const db = createClient(URL_SB, SERVICE)
    const { data: userData } = await db.auth.getUser(auth.replace('Bearer ', ''))
    const pemanggil = userData?.user?.id
    if (!pemanggil) return jawab({ success: false, message: 'Tidak dikenali' }, 401)

    const { kejadian, loan_id } = await req.json()
    if (!kejadian || !loan_id) return jawab({ success: false, message: 'kejadian & loan_id wajib' }, 400)

    const { data: loan } = await db.from('loans')
      .select('id, member_id, principal, total_amount, installment_amount, installment_count, status')
      .eq('id', loan_id).maybeSingle()
    if (!loan) return jawab({ success: false, message: 'Pinjaman tidak ditemukan' }, 404)

    const { data: profilPemanggil } = await db.from('profiles')
      .select('id, full_name, role').eq('id', pemanggil).maybeSingle()
    const pemanggilAdmin = profilPemanggil?.role === 'admin'

    const rupiah = (n: number) =>
      'Rp ' + Number(n || 0).toLocaleString('id-ID', { maximumFractionDigits: 0 })

    let penerima: string[] = []
    let judul = 'Koperasi Keluarga'
    let pesan = ''
    let tag = 'koperasi'

    if (kejadian === 'pengajuan_baru') {
      // Hanya pemilik pinjaman yang boleh memberitahukan pengajuannya sendiri
      if (loan.member_id !== pemanggil) return jawab({ success: false, message: 'Bukan pengaju pinjaman ini' }, 403)
      const { data: admins } = await db.from('profiles').select('id').eq('role', 'admin').eq('status', 'active')
      penerima = (admins || []).map((a: { id: string }) => a.id)
      judul = 'Pengajuan pinjaman baru'
      pesan = `${profilPemanggil?.full_name || 'Anggota'} mengajukan ${rupiah(loan.principal)}`
      tag = 'ajuan-' + loan.id

    } else if (kejadian === 'perlu_konfirmasi') {
      // Hanya admin yang mengirim syarat untuk dikonfirmasi
      if (!pemanggilAdmin) return jawab({ success: false, message: 'Hanya admin' }, 403)
      penerima = [loan.member_id]
      judul = 'Syarat pinjaman perlu persetujuan Anda'
      pesan = `Pokok ${rupiah(loan.principal)}, cicilan ${rupiah(loan.installment_amount)} × ${loan.installment_count}. Uang belum cair.`
      tag = 'konfirmasi-' + loan.id

    } else if (kejadian === 'dikonfirmasi') {
      // Hanya pemilik pinjaman yang baru saja menyetujui syaratnya
      if (loan.member_id !== pemanggil) return jawab({ success: false, message: 'Bukan pemilik pinjaman' }, 403)
      const { data: admins } = await db.from('profiles').select('id').eq('role', 'admin').eq('status', 'active')
      penerima = (admins || []).map((a: { id: string }) => a.id)
      judul = 'Syarat pinjaman disetujui'
      pesan = `${profilPemanggil?.full_name || 'Anggota'} menyetujui syarat ${rupiah(loan.principal)} — pinjaman berjalan`
      tag = 'dikonfirmasi-' + loan.id

    } else {
      return jawab({ success: false, message: 'Kejadian tidak dikenal' }, 400)
    }

    if (!penerima.length) return jawab({ success: true, terkirim: 0, catatan: 'Tidak ada penerima' })

    const { data: langganan } = await db.from('push_subscriptions')
      .select('id, endpoint, p256dh, auth').in('member_id', penerima)
    if (!langganan?.length) return jawab({ success: true, terkirim: 0, catatan: 'Belum ada perangkat terdaftar' })

    const muatan = JSON.stringify({ judul, pesan, tag, url: '/' })
    let terkirim = 0
    const mati: string[] = []

    await Promise.all(langganan.map(async (s) => {
      try {
        await webpush.sendNotification(
          { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, muatan)
        terkirim++
      } catch (e) {
        const kode = (e as { statusCode?: number }).statusCode
        if (kode === 404 || kode === 410) mati.push(s.id)   // langganan sudah tidak berlaku
      }
    }))

    if (mati.length) await db.from('push_subscriptions').delete().in('id', mati)

    return jawab({ success: true, terkirim, dibersihkan: mati.length })
  } catch (e) {
    return jawab({ success: false, message: String((e as Error)?.message || e) }, 500)
  }
})
