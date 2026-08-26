// ══════════════════════════════════════════════════════════════
// SERVICE WORKER — Koperasi Keluarga
//
// Dua tugas saja: menerima push notification, dan membuka halaman yang
// tepat saat notifikasinya diketuk.
//
// SENGAJA TIDAK MENYIMPAN CACHE APA PUN.
// Aplikasi ini satu berkas yang sering diperbarui, dan isinya logika uang.
// Service worker yang menyajikan index.html basi berarti ada anggota
// keluarga memakai aturan cicilan versi lama tanpa menyadarinya — jauh
// lebih berbahaya daripada sekadar tidak bisa dibuka saat offline.
// Karena itu setiap permintaan diteruskan apa adanya ke jaringan.
// ══════════════════════════════════════════════════════════════

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

// Diteruskan apa adanya. Handler ini ada supaya aplikasinya memenuhi syarat
// dipasang ke homescreen — bukan untuk menyimpan apa pun.
self.addEventListener('fetch', (e) => {
  e.respondWith(fetch(e.request));
});

self.addEventListener('push', (event) => {
  let d = {};
  try { d = event.data ? event.data.json() : {}; } catch (_) { d = {}; }
  const judul = d.judul || 'Koperasi Keluarga';
  const opsi = {
    body: d.pesan || '',
    // Ikon harus GAMBAR. Sebelumnya fallback-nya '/manifest.json' — berkas
    // JSON — sehingga ikon notifikasi rusak/kosong di banyak platform.
    icon: d.ikon || '/icon-192.png',
    tag: d.tag || 'koperasi',          // notifikasi sejenis saling menimpa
    renotify: true,
    data: { url: d.url || '/' },
    requireInteraction: false
  };
  event.waitUntil(self.registration.showNotification(judul, opsi));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const tujuan = (event.notification.data && event.notification.data.url) || '/';
  event.waitUntil((async () => {
    const daftar = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    // Kalau aplikasinya sudah terbuka, fokuskan saja — jangan buka tab kedua
    for (const c of daftar) {
      if ('focus' in c) { await c.focus(); return; }
    }
    if (self.clients.openWindow) await self.clients.openWindow(tujuan);
  })());
});
