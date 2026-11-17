const mysql = require("mysql2/promise");

const pool = mysql.createPool({
  host: "127.0.0.1",
  user: "root",
  password: "",              // XAMPP biasanya kosong
  database: "coffee_shop",
  waitForConnections: true,
  connectionLimit: 10,
  decimalNumbers: true       
});

module.exports = pool;