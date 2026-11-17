const express = require("express");
const db = require("../db_config");
const { wajibAdmin } = require("../middleware/auth");

const router = express.Router();

// Semua endpoint di file ini khusus admin
router.use(wajibAdmin);

// Periksa isian form menu. Hasilnya { error } atau { data }
function periksa(b) {
  b = b || {};
  const nama = String(b.nama || "").trim();
  const idKategori = Number(b.id_kategori);
  const harga = Number(b.harga);
  const hpp = Number(b.hpp);

  if (nama === "" || nama.length > 100) {
    return { error: "Nama menu wajib diisi (maksimal 100 huruf)." };
  }
  if (!Number.isInteger(idKategori) || idKategori < 1) {
    return { error: "Kategori wajib dipilih." };
  }
  if (!Number.isInteger(harga) || harga < 1 || harga > 10000000) {
    return { error: "Harga jual harus berupa angka bulat lebih dari 0." };
  }
  if (!Number.isInteger(hpp) || hpp < 0 || hpp > 10000000) {
    return { error: "HPP harus berupa angka bulat 0 atau lebih." };
  }
  const aktif = b.aktif === undefined ? 1 : b.aktif ? 1 : 0;
  return { data: { nama, idKategori, harga, hpp, aktif } };
}

// Cek kategori ada dan nama belum dipakai menu lain
async function cekRelasi(data, kodeSendiri) {
  const [kat] = await db.query(
    "SELECT id_kategori FROM kategori WHERE id_kategori = ?",
    [data.idKategori],
  );
  if (kat.length === 0) {
    return "Kategori tidak dikenal.";
  }
  const [dobel] = await db.query(
    "SELECT kode_menu FROM menu WHERE LOWER(nama_menu) = LOWER(?) AND kode_menu <> ?",
    [data.nama, kodeSendiri],
  );
  if (dobel.length > 0) {
    return "Nama menu sudah dipakai oleh " + dobel[0].kode_menu + ".";
  }
  return null;
}

// Daftar semua menu (termasuk yang tidak tersedia) + daftar kategori
router.get("/", async (req, res) => {
  try {
    const [menu] = await db.query(
      `SELECT m.kode_menu AS kode, m.nama_menu AS nama, m.id_kategori,
              k.nama_kategori AS kategori, m.harga, m.hpp, m.aktif
       FROM menu m
       JOIN kategori k ON k.id_kategori = m.id_kategori
       ORDER BY m.kode_menu`,
    );
    const [kategori] = await db.query(
      "SELECT id_kategori AS id, nama_kategori AS nama FROM kategori ORDER BY id_kategori",
    );
    res.json({
      menu: menu.map((m) => ({ ...m, aktif: Boolean(m.aktif) })),
      kategori: kategori,
    });
  } catch (err) {
    console.log("Gagal ambil menu admin:", err.message);
    res.status(500).json({ error: "Gagal mengambil daftar menu" });
  }
});

// Tambah menu baru. Kode dibuat otomatis: M016, M017, ...
router.post("/", async (req, res) => {
  try {
    const cek = periksa(req.body);
    if (cek.error) {
      return res.status(400).json({ error: cek.error });
    }
    const d = cek.data;
    const masalah = await cekRelasi(d, "");
    if (masalah) {
      return res.status(400).json({ error: masalah });
    }

    const [mx] = await db.query(
      "SELECT MAX(CAST(SUBSTRING(kode_menu, 2) AS UNSIGNED)) AS maks FROM menu WHERE kode_menu REGEXP '^M[0-9]+$'",
    );
    const kode = "M" + String((mx[0].maks || 0) + 1).padStart(3, "0");

    await db.query(
      "INSERT INTO menu (kode_menu, nama_menu, id_kategori, harga, hpp, aktif) VALUES (?, ?, ?, ?, ?, ?)",
      [kode, d.nama, d.idKategori, d.harga, d.hpp, d.aktif],
    );
    res.json({ kode: kode });
  } catch (err) {
    console.log("Gagal tambah menu:", err.message);
    res.status(500).json({ error: "Gagal menambah menu" });
  }
});

// Ubah menu
router.put("/:kode", async (req, res) => {
  try {
    const kode = req.params.kode;
    const [ada] = await db.query("SELECT kode_menu FROM menu WHERE kode_menu = ?", [kode]);
    if (ada.length === 0) {
      return res.status(404).json({ error: "Menu tidak ditemukan" });
    }

    const cek = periksa(req.body);
    if (cek.error) {
      return res.status(400).json({ error: cek.error });
    }
    const d = cek.data;
    const masalah = await cekRelasi(d, kode);
    if (masalah) {
      return res.status(400).json({ error: masalah });
    }

    await db.query(
      "UPDATE menu SET nama_menu = ?, id_kategori = ?, harga = ?, hpp = ?, aktif = ? WHERE kode_menu = ?",
      [d.nama, d.idKategori, d.harga, d.hpp, d.aktif, kode],
    );
    res.json({ ok: true });
  } catch (err) {
    console.log("Gagal ubah menu:", err.message);
    res.status(500).json({ error: "Gagal menyimpan perubahan" });
  }
});

// Hapus menu. Hanya boleh kalau belum pernah terjual (transaksi lama harus tetap utuh)
router.delete("/:kode", async (req, res) => {
  try {
    const kode = req.params.kode;
    const [ada] = await db.query("SELECT kode_menu FROM menu WHERE kode_menu = ?", [kode]);
    if (ada.length === 0) {
      return res.status(404).json({ error: "Menu tidak ditemukan" });
    }

    const [pakai] = await db.query(
      "SELECT COUNT(*) AS jumlah FROM detail_transaksi WHERE kode_menu = ?",
      [kode],
    );
    if (pakai[0].jumlah > 0) {
      return res.status(409).json({
        error:
          "Menu ini sudah pernah terjual sehingga tidak bisa dihapus. Matikan \"Tersedia di kasir\" saja.",
      });
    }

    await db.query("DELETE FROM menu WHERE kode_menu = ?", [kode]);
    res.json({ ok: true });
  } catch (err) {
    console.log("Gagal hapus menu:", err.message);
    res.status(500).json({ error: "Gagal menghapus menu" });
  }
});

module.exports = router;