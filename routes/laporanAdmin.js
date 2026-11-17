const express = require("express");
const db = require("../db_config");
const { wajibAdmin } = require("../middleware/auth");

const router = express.Router();

// Semua endpoint di file ini khusus admin
router.use(wajibAdmin);

// ----- Bantuan tanggal (format YYYY-MM-DD, dihitung dengan UTC supaya tidak terpengaruh zona waktu) -----
function tanggalValid(t) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(t)) {
    return false;
  }
  const d = new Date(t + "T00:00:00Z");
  return !isNaN(d.getTime()) && d.toISOString().slice(0, 10) === t;
}

function geser(t, hari) {
  const d = new Date(t + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + hari);
  return d.toISOString().slice(0, 10);
}

function selisihHari(a, b) {
  return Math.round(
    (new Date(b + "T00:00:00Z") - new Date(a + "T00:00:00Z")) / 86400000,
  );
}

// GET /api/admin/laporan?dari=2026-11-07&sampai=2026-11-13
// Kalau dari/sampai tidak diisi: 7 hari terakhir sampai hari ini.
router.get("/", async (req, res) => {
  try {
    const hariIni = new Date().toLocaleDateString("sv-SE");
    const sampai = req.query.sampai || hariIni;
    const dari = req.query.dari || geser(sampai, -6);

    if (!tanggalValid(dari) || !tanggalValid(sampai)) {
      return res.status(400).json({ error: "Format tanggal tidak valid." });
    }
    if (dari > sampai) {
      return res
        .status(400)
        .json({ error: "Tanggal awal tidak boleh setelah tanggal akhir." });
    }
    const jumlahHari = selisihHari(dari, sampai) + 1;
    if (jumlahHari > 366) {
      return res.status(400).json({ error: "Rentang tanggal maksimal 1 tahun." });
    }

    // Periode pembanding: panjangnya sama, tepat sebelum periode ini
    const laluSampai = geser(dari, -1);
    const laluDari = geser(dari, -jumlahHari);

    const [perHari, lalu, menu, channel, metode] = await Promise.all([
      // Penjualan, HPP, dan jumlah transaksi per tanggal
      db
        .query(
          `SELECT DATE_FORMAT(tanggal, '%Y-%m-%d') AS tanggal,
                  COUNT(*) AS transaksi,
                  SUM(total_harga) AS penjualan,
                  SUM(total_hpp) AS hpp
           FROM transaksi
           WHERE status = 'selesai' AND tanggal BETWEEN ? AND ?
           GROUP BY tanggal`,
          [dari, sampai],
        )
        .then((r) => r[0]),

      // Total periode sebelumnya (untuk perbandingan)
      db
        .query(
          `SELECT COUNT(*) AS transaksi, COALESCE(SUM(total_harga), 0) AS penjualan
           FROM transaksi
           WHERE status = 'selesai' AND tanggal BETWEEN ? AND ?`,
          [laluDari, laluSampai],
        )
        .then((r) => r[0][0]),

      // Rincian per menu (harga dan HPP diambil dari saat transaksi terjadi)
      db
        .query(
          `SELECT m.nama_menu AS nama,
                  SUM(d.qty) AS terjual,
                  SUM(d.qty * d.harga_satuan) AS penjualan,
                  SUM(d.qty * d.hpp_satuan) AS hpp
           FROM detail_transaksi d
           JOIN transaksi t ON t.id_transaksi = d.id_transaksi
           JOIN menu m ON m.kode_menu = d.kode_menu
           WHERE t.status = 'selesai' AND t.tanggal BETWEEN ? AND ?
           GROUP BY m.kode_menu, m.nama_menu
           ORDER BY terjual DESC, penjualan DESC`,
          [dari, sampai],
        )
        .then((r) => r[0]),

      // Penjualan per channel
      db
        .query(
          `SELECT c.nama_channel AS nama, SUM(t.total_harga) AS total
           FROM transaksi t
           JOIN channel c ON c.id_channel = t.id_channel
           WHERE t.status = 'selesai' AND t.tanggal BETWEEN ? AND ?
           GROUP BY c.id_channel, c.nama_channel
           ORDER BY total DESC`,
          [dari, sampai],
        )
        .then((r) => r[0]),

      // Penjualan per metode pembayaran
      db
        .query(
          `SELECT mp.nama_metode AS nama, SUM(t.total_harga) AS total
           FROM transaksi t
           JOIN metode_pembayaran mp ON mp.id_metode = t.id_metode
           WHERE t.status = 'selesai' AND t.tanggal BETWEEN ? AND ?
           GROUP BY mp.id_metode, mp.nama_metode
           ORDER BY total DESC`,
          [dari, sampai],
        )
        .then((r) => r[0]),
    ]);

    // Susun semua tanggal dalam periode (hari tanpa transaksi diisi 0)
    const grafik = [];
    let penjualan = 0;
    let hpp = 0;
    let transaksi = 0;
    for (let i = 0; i < jumlahHari; i++) {
      const tgl = geser(dari, i);
      const b = perHari.find((x) => x.tanggal === tgl);
      const p = b ? Number(b.penjualan) : 0;
      const h = b ? Number(b.hpp) : 0;
      grafik.push({ tanggal: tgl, penjualan: p, hpp: h });
      penjualan += p;
      hpp += h;
      transaksi += b ? Number(b.transaksi) : 0;
    }

    res.json({
      dari: dari,
      sampai: sampai,
      jumlahHari: jumlahHari,
      total: {
        penjualan: penjualan,
        hpp: hpp,
        laba: penjualan - hpp,
        transaksi: transaksi,
      },
      sebelumnya: {
        penjualan: Number(lalu.penjualan),
        transaksi: Number(lalu.transaksi),
      },
      grafik: grafik,
      menu: menu.map((x) => ({
        nama: x.nama,
        terjual: Number(x.terjual),
        penjualan: Number(x.penjualan),
        hpp: Number(x.hpp),
        laba: Number(x.penjualan) - Number(x.hpp),
      })),
      channel: channel.map((x) => ({ nama: x.nama, total: Number(x.total) })),
      metode: metode.map((x) => ({ nama: x.nama, total: Number(x.total) })),
    });
  } catch (err) {
    console.log("Gagal ambil laporan:", err.message);
    res.status(500).json({ error: "Gagal mengambil data laporan" });
  }
});

module.exports = router;
