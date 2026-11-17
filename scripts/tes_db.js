const db = require("./db_config");
db.query("SELECT COUNT(*) AS jumlah FROM menu")
  .then(([rows]) => { console.log("Database OK, jumlah menu:", rows[0].jumlah); process.exit(); })
  .catch(err => { console.log("Gagal:", err.code, err.message); process.exit(); });