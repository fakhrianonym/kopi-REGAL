function wajibAdmin(req, res, next) {
  if (!req.session || !req.session.admin) {
    return res.status(401).json({
      error: "Silakan login sebagai admin terlebih dahulu.",
    });
  }

  next();
}

function wajibKasir(req, res, next) {
  if (!req.session || !req.session.kasir) {
    return res.status(401).json({
      error: "Silakan login sebagai kasir terlebih dahulu.",
    });
  }

  next();
}

function wajibLogin(req, res, next) {
  if (!req.session || (!req.session.admin && !req.session.kasir)) {
    return res.status(401).json({
      error: "Silakan login terlebih dahulu.",
    });
  }

  next();
}

module.exports = {
  wajibAdmin,
  wajibKasir,
  wajibLogin,
};
