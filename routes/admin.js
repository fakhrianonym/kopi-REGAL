const express = require("express");
const bcrypt = require("bcryptjs");
const db = require("../db_config");
const { wajibAdmin } = require("../middleware/auth");

const router = express.Router();

router.post("/login", async (req, res) => {
  try {
    const { username, password } = req.body;

    if (!username || !password) {
      return res.status(400).json({
        error: "Username dan password wajib diisi."
      });
    }

    // Periksa akun admin terlebih dahulu
    const [adminRows] = await db.query(
      "SELECT * FROM admin WHERE username = ?",
      [username]
    );

    if (adminRows.length > 0) {
      const admin = adminRows[0];
      const cocok = await bcrypt.compare(password, admin.password);

      if (cocok) {
        delete req.session.kasir;   // satu sesi hanya boleh satu peran
        req.session.admin = {
          id: admin.id_admin,
          username: admin.username
        };

        req.session.user = {
          id: admin.id_admin,
          username: admin.username,
          role: "admin"
        };

        return res.json({
          message: "Login admin berhasil.",
          role: "admin"
        });
      }
    }

    // Jika bukan admin, periksa akun kasir
    const [kasirRows] = await db.query(
      "SELECT * FROM kasir WHERE username = ?",
      [username]
    );

    if (kasirRows.length > 0) {
      const kasir = kasirRows[0];
      const cocok = await bcrypt.compare(password, kasir.password);

      if (cocok) {
        delete req.session.admin;   // satu sesi hanya boleh satu peran
        req.session.kasir = {
          id: kasir.id_kasir,
          username: kasir.username
        };

        req.session.user = {
          id: kasir.id_kasir,
          username: kasir.username,
          role: "kasir"
        };

        return res.json({
          message: "Login kasir berhasil.",
          role: "kasir"
        });
      }
    }

    return res.status(401).json({
      error: "Username atau password salah."
    });

  } catch (err) {
    console.log("Login gagal:", err.message);

    res.status(500).json({
      error: "Terjadi kesalahan pada server."
    });
  }
});

router.get("/check", (req, res) => {
  if (!req.session.admin) {
    return res.status(401).json({
      login: false,
      message: "Admin belum login."
    });
  }

  res.json({
    login: true,
    admin: req.session.admin
  });
});

router.post("/logout", (req, res) => {
  req.session.destroy((err) => {
    if (err) {
      return res.status(500).json({
        error: "Gagal logout."
      });
    }

    res.clearCookie("connect.sid");
    res.json({
      message: "Logout berhasil."
    });
  });
});

// ===== Data untuk halaman dashboard (khusus admin) =====

// Tanggal lokal server dalam format YYYY-MM-DD. selisih = 0 hari ini, -1 kemarin, dst.
function tanggalLokal(selisih) {
  const d = new Date();
  d.setDate(d.getDate() + selisih);
  return d.toLocaleDateString("sv-SE");
}

router.get("/ringkasan", wajibAdmin, async (req, res) => {
  try {
    const hari = tanggalLokal(0);
    const kemarin = tanggalLokal(-1);
    const awal = tanggalLokal(-6);

    const [perHari, [jual], terbaru, terlaris, perChannel] = await Promise.all([
      // Penjualan, jumlah transaksi, dan HPP per tanggal untuk 7 hari terakhir
      db.query(
        `SELECT DATE_FORMAT(tanggal, '%Y-%m-%d') AS tanggal,
                COUNT(*) AS transaksi,
                SUM(total_harga) AS penjualan,
                SUM(total_hpp) AS hpp
         FROM transaksi
         WHERE status = 'selesai' AND tanggal BETWEEN ? AND ?
         GROUP BY tanggal`,
        [awal, hari]
      ).then((r) => r[0]),

      // Jumlah menu terjual dan jenis menu yang laku hari ini
      db.query(
        `SELECT COALESCE(SUM(d.qty), 0) AS jumlah,
                COUNT(DISTINCT d.kode_menu) AS jenis
         FROM detail_transaksi d
         JOIN transaksi t ON t.id_transaksi = d.id_transaksi
         WHERE t.status = 'selesai' AND t.tanggal = ?`,
        [hari]
      ),

      // 5 transaksi terakhir
      db.query(
        `SELECT t.id_transaksi AS no,
                DATE_FORMAT(t.tanggal, '%Y-%m-%d') AS tanggal,
                c.nama_channel AS channel,
                p.nama_pembeli AS pelanggan,
                t.total_harga AS total
         FROM transaksi t
         JOIN channel c ON c.id_channel = t.id_channel
         JOIN pembeli p ON p.id_pembeli = t.id_pembeli
         WHERE t.status = 'selesai'
         ORDER BY CAST(SUBSTRING(t.id_transaksi, 3) AS UNSIGNED) DESC
         LIMIT 5`
      ).then((r) => r[0]),

      // 5 menu paling banyak terjual
      db.query(
        `SELECT m.nama_menu AS nama, SUM(d.qty) AS terjual
         FROM detail_transaksi d
         JOIN transaksi t ON t.id_transaksi = d.id_transaksi
         JOIN menu m ON m.kode_menu = d.kode_menu
         WHERE t.status = 'selesai'
         GROUP BY m.kode_menu, m.nama_menu
         ORDER BY terjual DESC
         LIMIT 5`
      ).then((r) => r[0]),

      // Penjualan per channel
      db.query(
        `SELECT c.nama_channel AS channel, SUM(t.total_harga) AS total
         FROM transaksi t
         JOIN channel c ON c.id_channel = t.id_channel
         WHERE t.status = 'selesai'
         GROUP BY c.id_channel, c.nama_channel
         ORDER BY total DESC`
      ).then((r) => r[0])
    ]);

    // Susun 7 hari penuh (hari tanpa transaksi diisi 0)
    const grafik = [];
    for (let i = -6; i <= 0; i++) {
      const tgl = tanggalLokal(i);
      const baris = perHari.find((x) => x.tanggal === tgl);
      grafik.push({ tanggal: tgl, total: baris ? Number(baris.penjualan) : 0 });
    }

    const ambil = (tgl) => {
      const b = perHari.find((x) => x.tanggal === tgl);
      return {
        penjualan: b ? Number(b.penjualan) : 0,
        transaksi: b ? Number(b.transaksi) : 0,
        hpp: b ? Number(b.hpp) : 0
      };
    };
    const h = ambil(hari);
    const k = ambil(kemarin);

    res.json({
      hari: hari,
      hariIni: {
        penjualan: h.penjualan,
        transaksi: h.transaksi,
        laba: h.penjualan - h.hpp,
        menuTerjual: Number(jual[0].jumlah),
        jenisMenu: Number(jual[0].jenis)
      },
      kemarin: { penjualan: k.penjualan, transaksi: k.transaksi },
      grafik: grafik,
      terbaru: terbaru,
      terlaris: terlaris.map((x) => ({ nama: x.nama, terjual: Number(x.terjual) })),
      channel: perChannel.map((x) => ({ channel: x.channel, total: Number(x.total) }))
    });
  } catch (err) {
    console.log("Gagal ambil ringkasan:", err.message);
    res.status(500).json({ error: "Gagal mengambil ringkasan dashboard" });
  }
});

module.exports = router