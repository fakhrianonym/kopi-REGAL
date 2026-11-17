const express = require("express");
const cors = require("cors");
const session = require("express-session");
const adminRoutes = require("./routes/admin");
const menuAdminRoutes = require("./routes/menuAdmin");
const laporanAdminRoutes = require("./routes/laporanAdmin");
const path = require("path");
const crypto = require("crypto");
const db = require("./db_config");
const { wajibAdmin, wajibKasir, wajibLogin } = require("./middleware/auth");

const app = express();

app.use(cors());
app.use(express.json());

app.use(
  session({
    secret:
      process.env.SESSION_SECRET || "regal-coffee-session-secret-ganti-nanti",
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      secure: false,
      sameSite: "lax",
      maxAge: 1000 * 60 * 60 * 2,
    },
  }),
);

app.use("/api/admin", adminRoutes);
app.use("/api/admin/menu", menuAdminRoutes);
app.use("/api/admin/laporan", laporanAdminRoutes);

// ===== Halaman kasir (hanya bisa dibuka kalau sudah login) =====
// Tiap alamat menyajikan FILE-nya sendiri. bolehAdmin = true berarti admin juga boleh membukanya
// (dipakai untuk struk, supaya "Cetak Ulang" dari riwayat admin bisa jalan).
function halamanKasir(namaFile, bolehAdmin) {
  return (req, res) => {
    const boleh = req.session.kasir || (bolehAdmin && req.session.admin);
    if (!boleh) {
      return res.redirect("/login.html");
    }
    res.sendFile(path.join(__dirname, "public", namaFile));
  };
}

app.get("/kasir.html", halamanKasir("kasir.html"));
app.get("/kasir", halamanKasir("kasir.html"));
app.get("/pembayaran.html", halamanKasir("pembayaran.html"));
app.get("/struk.html", halamanKasir("struk.html", true));

app.use(express.static(path.join(__dirname, "public")));

app.get("/", (req, res) => {
  res.redirect("/login.html");
});

// ===== Cek server dan database hidup =====
app.get("/api/ping", async (req, res) => {
  try {
    const [rows] = await db.query("SELECT 1 AS ok");
    res.json({ status: "ok", db: rows[0].ok });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ===== Daftar menu =====
app.get("/api/menu", wajibKasir, async (req, res) => {
  try {
    const [rows] = await db.query(
      `SELECT m.kode_menu AS kode, m.nama_menu AS nama,
              k.nama_kategori AS kategori, m.harga
       FROM menu m
       JOIN kategori k ON k.id_kategori = m.id_kategori
       WHERE m.aktif = 1
       ORDER BY m.kode_menu`,
    );
    res.json(rows);
  } catch (err) {
    console.log("Gagal ambil menu:", err.message);
    res.status(500).json({ error: "Gagal mengambil menu" });
  }
});

// ===== Pesanan aktif (keranjang yang sedang menunggu dibayar) =====
// Disimpan di MEMORI server (bukan localStorage). Kalau server dimatikan, isinya hilang.
const pesananAktif = new Map();
const BATAS_WAKTU = 2 * 60 * 60 * 1000; // pesanan yang tidak dibayar dibuang setelah 2 jam

function bersihkanPesananLama() {
  const sekarang = Date.now();
  for (const [id, p] of pesananAktif) {
    if (sekarang - p.dibuat > BATAS_WAKTU) {
      pesananAktif.delete(id);
    }
  }
}

// Kasir menekan "Bayar": simpan keranjang di server, balas dengan id pesanan
app.post("/api/pesanan", wajibKasir, async (req, res) => {
  try {
    const { channel, pelanggan, items } = req.body || {};

    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: "Pesanan kosong" });
    }

    const [ch] = await db.query(
      "SELECT id_channel FROM channel WHERE nama_channel = ?",
      [channel],
    );
    if (ch.length === 0) {
      return res
        .status(400)
        .json({ error: "Channel tidak dikenal: " + channel });
    }

    // Nama dan harga diambil dari database, bukan dari browser
    const [menuRows] = await db.query(
      "SELECT kode_menu, nama_menu, harga FROM menu WHERE kode_menu IN (?) AND aktif = 1",
      [items.map((i) => i.kode)],
    );

    const daftar = [];
    for (const it of items) {
      const m = menuRows.find((x) => x.kode_menu === it.kode);
      const jumlah = Number(it.jumlah);
      if (!m || !Number.isInteger(jumlah) || jumlah < 1) {
        return res.status(400).json({ error: "Menu tidak valid: " + it.kode });
      }
      daftar.push({
        kode: m.kode_menu,
        nama: m.nama_menu,
        harga: m.harga,
        jumlah: jumlah,
      });
    }

    bersihkanPesananLama();
    const id = crypto.randomUUID();
    pesananAktif.set(id, {
      channel: channel,
      pelanggan: String(pelanggan || "").trim() || "Umum",
      tanggal: new Date().toLocaleDateString("sv-SE"), // tanggal ditentukan server
      items: daftar,
      dibuat: Date.now(),
    });

    res.json({ id: id });
  } catch (err) {
    console.log("Gagal membuat pesanan:", err.message);
    res.status(500).json({ error: "Gagal membuat pesanan" });
  }
});

// Halaman pembayaran mengambil isi pesanan berdasarkan id
app.get("/api/pesanan/:id", wajibKasir, (req, res) => {
  const pesanan = pesananAktif.get(req.params.id);
  if (!pesanan) {
    return res
      .status(404)
      .json({ error: "Pesanan tidak ditemukan atau sudah kedaluwarsa" });
  }
  res.json(pesanan);
});

// ===== Simpan transaksi (dipanggil saat tombol Bayar di halaman pembayaran) =====
app.post("/api/transaksi", wajibKasir, async (req, res) => {
  const { pesananId, metode, diterima } = req.body || {};

  const pesanan = pesananAktif.get(pesananId);
  if (!pesanan) {
    return res.status(400).json({
      error:
        "Pesanan tidak ditemukan atau sudah kedaluwarsa. Silakan buat pesanan lagi.",
    });
  }

  let conn;
  try {
    conn = await db.getConnection();
    await conn.beginTransaction();

    // 1. Ubah nama channel dan metode jadi id
    const [ch] = await conn.query(
      "SELECT id_channel FROM channel WHERE nama_channel = ?",
      [pesanan.channel],
    );
    const [mt] = await conn.query(
      "SELECT id_metode FROM metode_pembayaran WHERE nama_metode = ?",
      [metode],
    );
    if (ch.length === 0) {
      throw new Error("Channel tidak dikenal: " + pesanan.channel);
    }
    if (mt.length === 0) {
      throw new Error("Metode tidak dikenal: " + metode);
    }

    // 2. Cari pembeli; kalau belum ada, buat baru
    let idPembeli;
    const [pb] = await conn.query(
      "SELECT id_pembeli FROM pembeli WHERE nama_pembeli = ?",
      [pesanan.pelanggan],
    );
    if (pb.length > 0) {
      idPembeli = pb[0].id_pembeli;
    } else {
      const [baru] = await conn.query(
        "INSERT INTO pembeli (nama_pembeli) VALUES (?)",
        [pesanan.pelanggan],
      );
      idPembeli = baru.insertId;
    }

    // 3. Harga dan HPP diambil dari database
    const kodeList = pesanan.items.map((i) => i.kode);
    const [menuRows] = await conn.query(
      "SELECT kode_menu, harga, hpp FROM menu WHERE kode_menu IN (?)",
      [kodeList],
    );

    let totalHarga = 0;
    let totalHpp = 0;
    const baris = [];
    for (const it of pesanan.items) {
      const m = menuRows.find((x) => x.kode_menu === it.kode);
      if (!m) {
        throw new Error("Menu tidak valid: " + it.kode);
      }
      totalHarga += m.harga * it.jumlah;
      totalHpp += m.hpp * it.jumlah;
      baris.push([m.kode_menu, it.jumlah, m.harga, m.hpp]);
    }

    // 4. Tunai: pakai uang dari kasir. QRIS/Debit: dianggap pas sebesar total.
    const uangMasuk = metode === "Tunai" ? Number(diterima) : totalHarga;
    if (!(uangMasuk >= totalHarga)) {
      throw new Error("Uang diterima kurang dari total");
    }

    // 5. Nomor berikutnya: TS001, TS002, ... (angka terbesar + 1)
    const [mx] = await conn.query(
      "SELECT MAX(CAST(SUBSTRING(id_transaksi, 3) AS UNSIGNED)) AS maks FROM transaksi FOR UPDATE",
    );
    const nomor = "TS" + String((mx[0].maks || 0) + 1).padStart(3, "0");

    // 6. Simpan ke dua tabel
    await conn.query(
      `INSERT INTO transaksi
        (id_transaksi, tanggal, id_channel, id_pembeli, total_harga, total_hpp, id_metode, uang_diterima)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        nomor,
        pesanan.tanggal,
        ch[0].id_channel,
        idPembeli,
        totalHarga,
        totalHpp,
        mt[0].id_metode,
        uangMasuk,
      ],
    );
    await conn.query(
      "INSERT INTO detail_transaksi (id_transaksi, kode_menu, qty, harga_satuan, hpp_satuan) VALUES ?",
      [baris.map((b) => [nomor, ...b])],
    );

    await conn.commit();
    pesananAktif.delete(pesananId); // pesanan sudah selesai, buang dari memori
    res.json({ no: nomor, total: totalHarga });
  } catch (err) {
    if (conn) {
      await conn.rollback();
    }
    console.log("Gagal simpan transaksi:", err.message);
    res.status(400).json({ error: err.message });
  } finally {
    if (conn) {
      conn.release();
    }
  }
});

// ===== Ambil transaksi (untuk struk dan riwayat) =====
async function ambilTransaksi({ no, hanyaSelesai, tanggal } = {}) {
  const syarat = [];
  const nilai = [];
  if (no) {
    syarat.push("t.id_transaksi = ?");
    nilai.push(no);
  }
  if (hanyaSelesai) {
    syarat.push("t.status = 'selesai'");
  }
  if (tanggal) {
    syarat.push("t.tanggal = ?");
    nilai.push(tanggal);
  }
  const where = syarat.length > 0 ? "WHERE " + syarat.join(" AND ") : "";

  const [trx] = await db.query(
    `SELECT t.id_transaksi AS no,
            DATE_FORMAT(t.tanggal, '%Y-%m-%d') AS tanggal,
            c.nama_channel AS channel,
            p.nama_pembeli AS pelanggan,
            mp.nama_metode AS metode,
            t.total_harga AS total,
            t.total_hpp AS hpp,
            t.uang_diterima AS diterima,
            t.status
     FROM transaksi t
     JOIN channel c ON c.id_channel = t.id_channel
     JOIN pembeli p ON p.id_pembeli = t.id_pembeli
     JOIN metode_pembayaran mp ON mp.id_metode = t.id_metode
     ${where}
     ORDER BY CAST(SUBSTRING(t.id_transaksi, 3) AS UNSIGNED)`,
    nilai,
  );
  if (trx.length === 0) {
    return [];
  }

  const [items] = await db.query(
    `SELECT d.id_transaksi AS no, d.kode_menu AS kode, m.nama_menu AS nama,
            d.harga_satuan AS harga, d.hpp_satuan AS hpp, d.qty AS jumlah
     FROM detail_transaksi d
     JOIN menu m ON m.kode_menu = d.kode_menu
     WHERE d.id_transaksi IN (?)
     ORDER BY d.id_detail`,
    [trx.map((t) => t.no)],
  );
  trx.forEach((t) => {
    t.items = items.filter((i) => i.no === t.no);
  });
  return trx;
}

app.get("/api/transaksi/:no", wajibLogin, async (req, res) => {
  try {
    const hasil = await ambilTransaksi({ no: req.params.no });
    if (hasil.length === 0) {
      return res.status(404).json({ error: "Tidak ditemukan" });
    }
    res.json(hasil[0]);
  } catch (err) {
    console.log("Gagal ambil transaksi:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ===== Riwayat hari ini untuk kasir (hanya lihat dan cetak ulang) =====
app.get("/api/kasir/riwayat", wajibKasir, async (req, res) => {
  try {
    const hariIni = new Date().toLocaleDateString("sv-SE");
    const transaksi = await ambilTransaksi({ hanyaSelesai: true, tanggal: hariIni });
    res.json({ tanggal: hariIni, transaksi: transaksi });
  } catch (err) {
    console.log("Gagal ambil riwayat kasir:", err.message);
    res.status(500).json({ error: "Gagal mengambil riwayat" });
  }
});

// ===== Riwayat, batal, reset =====

// Daftar riwayat (transaksi yang dibatalkan tidak ditampilkan)
app.get("/api/transaksi", wajibAdmin, async (req, res) => {
  try {
    res.json(await ambilTransaksi({ hanyaSelesai: true }));
  } catch (err) {
    console.log("Gagal ambil riwayat:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// Batalkan = ubah status jadi 'batal', datanya tetap ada sebagai arsip
app.patch("/api/transaksi/:no/batal", wajibAdmin, async (req, res) => {
  try {
    const [hasil] = await db.query(
      "UPDATE transaksi SET status = 'batal' WHERE id_transaksi = ? AND status = 'selesai'",
      [req.params.no],
    );
    if (hasil.affectedRows === 0) {
      return res.status(404).json({ error: "Tidak ditemukan" });
    }
    res.json({ ok: true });
  } catch (err) {
    console.log("Gagal membatalkan transaksi:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// Reset: HAPUS PERMANEN semua transaksi (termasuk TS001 contoh)
app.delete("/api/transaksi", wajibAdmin, async (req, res) => {
  let conn;
  try {
    conn = await db.getConnection();
    await conn.beginTransaction();
    await conn.query("DELETE FROM detail_transaksi");
    await conn.query("DELETE FROM transaksi");
    await conn.commit();
    res.json({ ok: true });
  } catch (err) {
    if (conn) {
      await conn.rollback();
    }
    console.log("Gagal reset:", err.message);
    res.status(500).json({ error: err.message });
  } finally {
    if (conn) {
      conn.release();
    }
  }
});

// ===== Halaman admin (hanya bisa dibuka kalau sudah login) =====
// File-nya ada di folder admin/ (di luar public/), jadi tidak bisa dibuka langsung lewat alamat file.
function halamanAdmin(namaFile) {
  return (req, res) => {
    if (!req.session.admin) {
      return res.redirect("/login.html");
    }
    res.sendFile(path.join(__dirname, "admin", namaFile));
  };
}

app.get("/admin", halamanAdmin("dashboard.html"));
app.get("/admin/riwayat", halamanAdmin("riwayat.html"));
app.get("/admin/menu", halamanAdmin("menu.html"));
app.get("/admin/laporan", halamanAdmin("laporan.html"));

app.listen(3001, async (err) => {
  if (err) {
    console.log("Server GAGAL start:", err.code, err.message);
    process.exit(1);
  }
  console.log("Server berjalan di http://localhost:3001");
  try {
    await db.query("SELECT 1");
    console.log("Database coffee_shop terhubung");
  } catch (err) {
    console.log("Koneksi database GAGAL:", err.code, err.message);
  }
});