
const bcrypt = require("bcryptjs");
const readline = require("readline");

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

rl.question("Masukkan password admin: ", async (password) => {
  if (password.length < 8) {
    console.log("Password minimal 8 karakter.");
  } else {
    const hash = await bcrypt.hash(password, 10);
    console.log("\nPassword hash:");
    console.log(hash);
  }

  rl.close();
});