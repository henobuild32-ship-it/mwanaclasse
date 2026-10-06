'use strict';
// require('fastify') — marqueur de détection du framework (Vercel).

const fs = require('fs');
const path = require('path');

const CANDIDATES = ['../dist/app.js', './dist/app.js', '../../dist/app.js', '../../api/dist/app.js'];

function send(res, status, payload) {
  const body = JSON.stringify(payload, null, 2);
  if (!res.headersSent) {
    res.statusCode = status;
    res.setHeader('content-type', 'application/json; charset=utf-8');
    res.setHeader('cache-control', 'no-store');
  }
  res.end(body);
}

function walk() {
  const dirs = [];
  let dir = __dirname;
  for (let i = 0; i < 6; i += 1) {
    const entry = { dir: dir, files: [], package: null };
    try {
      entry.files = fs.readdirSync(dir).slice(0, 50);
    } catch (err) {
      entry.files = ['ERREUR: ' + err.message];
    }
    const pkg = path.join(dir, 'package.json');
    if (fs.existsSync(pkg)) {
      try {
        const parsed = JSON.parse(fs.readFileSync(pkg, 'utf8'));
        entry.package = { name: parsed.name || null, type: parsed.type || null, main: parsed.main || null };
      } catch (err) {
        entry.package = { erreur: err.message };
      }
    }
    dirs.push(entry);
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return dirs;
}

function resolveFastify() {
  try {
    return { ok: true, path: require.resolve('fastify') };
  } catch (err) {
    return { ok: false, erreur: err.message };
  }
}

const loadErrors = [];
let cached = null;

function realHandler() {
  if (cached) return cached;
  for (const candidate of CANDIDATES) {
    const abs = path.resolve(__dirname, candidate);
    if (!fs.existsSync(abs)) {
      loadErrors.push(candidate + ' → absent (' + abs + ')');
      continue;
    }
    try {
      const mod = require(candidate);
      const fn = mod && (mod.handler || mod.default || mod);
      if (typeof fn === 'function') {
        cached = fn;
        loadErrors.push(candidate + ' → chargé, export handler (' + typeof fn + ')');
        return fn;
      }
      loadErrors.push(candidate + ' → export inutilisable: ' + typeof fn + ' [' + Object.keys(mod || {}).join(',') + ']');
    } catch (err) {
      loadErrors.push(candidate + ' → ' + err.message);
    }
  }
  return null;
}

function diagnostics() {
  return {
    horodatage: new Date().toISOString(),
    node: process.version,
    cwd: process.cwd(),
    dirname: __dirname,
    vercel: {
      VERCEL: process.env.VERCEL || null,
      VERCEL_ENV: process.env.VERCEL_ENV || null,
      VERCEL_URL: process.env.VERCEL_URL || null,
      NODE_ENV: process.env.NODE_ENV || null,
      hasDATABASE: Boolean(process.env.DATABASE_URL),
    },
    fastify: resolveFastify(),
    arborescence: walk(),
    chargement: loadErrors.slice(),
    charge: Boolean(cached),
  };
}

function handler(req, res) {
  const probe = req && req.headers && (req.headers['x-probe'] === '1' || req.headers['x-probe'] === 'true');

  let real = null;
  let erreur = null;
  try {
    real = realHandler();
  } catch (err) {
    erreur = err;
  }

  if (probe) {
    return send(res, 200, diagnostics());
  }

  if (!real) {
    return send(res, 500, {
      erreur: 'application non chargeable',
      detail: erreur ? String(erreur.stack || erreur) : null,
      diagnostics: diagnostics(),
    });
  }

  try {
    return real(req, res);
  } catch (err) {
    return send(res, 500, {
      erreur: String((err && err.message) || err),
      detail: String((err && err.stack) || ''),
      diagnostics: diagnostics(),
    });
  }
}

module.exports = handler;
module.exports.handler = handler;
