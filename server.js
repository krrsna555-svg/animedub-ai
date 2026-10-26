const express = require("express");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const helmet = require("helmet");
const cookieParser = require("cookie-parser");
const rateLimit = require("express-rate-limit");
const multer = require("multer");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const Database = require("better-sqlite3");

const app = express();
const PORT = Number(process.env.PORT || 3000);
const ROOT = __dirname;
const DATA_DIR = path.join(ROOT, "data");
const UPLOAD_DIR = path.join(ROOT, "uploads");
const OUTPUT_DIR = path.join(ROOT, "outputs");
for (const dir of [DATA_DIR, UPLOAD_DIR, OUTPUT_DIR]) fs.mkdirSync(dir, { recursive: true });

const secret = process.env.JWT_SECRET;
if (!secret || secret.length < 32) {
  console.warn("WARNING: Set JWT_SECRET to a random value of at least 32 characters before public deployment.");
}
const JWT_SECRET = secret || crypto.randomBytes(48).toString("hex");
const db = new Database(path.join(DATA_DIR, "animedub.sqlite"));
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'user' CHECK(role IN ('user','admin')),
  plan TEXT NOT NULL DEFAULT 'free' CHECK(plan IN ('free','pro')),
  subscription_status TEXT NOT NULL DEFAULT 'inactive',
  subscription_expires_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  original_name TEXT NOT NULL,
  stored_name TEXT NOT NULL,
  language TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued',
  message TEXT NOT NULL DEFAULT 'Waiting for an AI dubbing provider.',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  completed_at TEXT
);
CREATE TABLE IF NOT EXISTS payments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  amount_paise INTEGER NOT NULL,
  currency TEXT NOT NULL DEFAULT 'INR',
  plan_period TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  provider_reference TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_jobs_user_created ON jobs(user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_payments_user ON payments(user_id);
`);

app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'"],
      imgSrc: ["'self'", "data:", "https://s4.anilist.co"],
      connectSrc: ["'self'", "https://graphql.anilist.co"],
      mediaSrc: ["'self'", "blob:"],
      objectSrc: ["'none'"],
      upgradeInsecureRequests: null
    }
  }
}));
app.use(express.json({ limit: "1mb" }));
app.use(cookieParser());
app.use(express.static(path.join(ROOT, "public"), { extensions: ["html"] }));

const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 15, standardHeaders: true, legacyHeaders: false });
const uploadLimiter = rateLimit({ windowMs: 60 * 60 * 1000, limit: 8, standardHeaders: true, legacyHeaders: false });

const LANGUAGES = new Set(["Hindi", "English", "Japanese", "Spanish", "French", "Korean", "Tamil", "Telugu"]);
const FREE_DAILY_LIMIT = 3;
const MAX_UPLOAD_BYTES = Math.max(10, Math.min(500, Number(process.env.MAX_UPLOAD_MB || 100))) * 1024 * 1024;
const ALLOWED_EXTENSIONS = new Set([".mp4", ".webm", ".mov", ".mkv"]);

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, UPLOAD_DIR),
  filename: (_req, file, cb) => cb(null, crypto.randomUUID() + path.extname(file.originalname).toLowerCase())
});
const upload = multer({
  storage,
  limits: { fileSize: MAX_UPLOAD_BYTES, files: 1 },
  fileFilter: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (!ALLOWED_EXTENSIONS.has(ext)) return cb(new Error("Use an MP4, WebM, MOV, or MKV video."));
    cb(null, true);
  }
});

function safeUser(row) {
  return row && {
    id: row.id, email: row.email, role: row.role, plan: effectivePlan(row),
    subscriptionStatus: row.subscription_status,
    subscriptionExpiresAt: row.subscription_expires_at,
    createdAt: row.created_at
  };
}
function effectivePlan(user) {
  if (!user) return "free";
  if (user.plan === "pro" && user.subscription_status === "active" &&
      user.subscription_expires_at && Date.parse(user.subscription_expires_at) > Date.now()) return "pro";
  return "free";
}
function tokenFor(user) {
  return jwt.sign({ sub: user.id }, JWT_SECRET, { expiresIn: "7d" });
}
function setSession(res, user) {
  res.cookie("ad_session", tokenFor(user), {
    httpOnly: true, secure: process.env.NODE_ENV === "production",
    sameSite: "lax", maxAge: 7 * 24 * 60 * 60 * 1000, path: "/"
  });
}
function auth(req, res, next) {
  try {
    const token = req.cookies.ad_session;
    if (!token) return res.status(401).json({ error: "Please sign in first." });
    const payload = jwt.verify(token, JWT_SECRET);
    const user = db.prepare("SELECT * FROM users WHERE id = ?").get(Number(payload.sub));
    if (!user) return res.status(401).json({ error: "Session is no longer valid." });
    req.user = user;
    next();
  } catch {
    return res.status(401).json({ error: "Please sign in again." });
  }
}
function adminOnly(req, res, next) {
  if (!req.user || req.user.role !== "admin") return res.status(403).json({ error: "Admin access required." });
  next();
}
function todayUtc() {
  return new Date().toISOString().slice(0, 10);
}
function dailySuccessfulCount(userId) {
  return db.prepare(`
    SELECT COUNT(*) AS n FROM jobs
    WHERE user_id = ? AND status = 'completed' AND substr(completed_at, 1, 10) = ?
  `).get(userId, todayUtc()).n;
}
function cleanupFile(filePath) {
  if (filePath) fs.unlink(filePath, () => {});
}
function cleanExpiredSubscriptions() {
  db.prepare(`
    UPDATE users SET subscription_status = 'expired', plan = 'free'
    WHERE plan = 'pro' AND subscription_status = 'active'
      AND (subscription_expires_at IS NULL OR subscription_expires_at <= ?)
  `).run(new Date().toISOString());
}
cleanExpiredSubscriptions();
setInterval(cleanExpiredSubscriptions, 60 * 60 * 1000).unref();

// Bootstrap the admin by setting ADMIN_EMAIL before the first account with that email registers.
// Never expose admin registration in the public UI.
app.post("/api/auth/register", authLimiter, async (req, res) => {
  const email = String(req.body.email || "").trim().toLowerCase();
  const password = String(req.body.password || "");
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: "Enter a valid email address." });
  if (password.length < 10) return res.status(400).json({ error: "Password must be at least 10 characters." });
  if (password.length > 200) return res.status(400).json({ error: "Password is too long." });
  const exists = db.prepare("SELECT id FROM users WHERE email = ?").get(email);
  if (exists) return res.status(409).json({ error: "An account with this email already exists." });
  const role = process.env.ADMIN_EMAIL && email === process.env.ADMIN_EMAIL.trim().toLowerCase() &&
    db.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'admin'").get().n === 0 ? "admin" : "user";
  const hash = await bcrypt.hash(password, 12);
  const result = db.prepare("INSERT INTO users (email, password_hash, role) VALUES (?, ?, ?)").run(email, hash, role);
  const user = db.prepare("SELECT * FROM users WHERE id = ?").get(result.lastInsertRowid);
  setSession(res, user);
  res.status(201).json({ user: safeUser(user) });
});

app.post("/api/auth/login", authLimiter, async (req, res) => {
  const email = String(req.body.email || "").trim().toLowerCase();
  const password = String(req.body.password || "");
  const user = db.prepare("SELECT * FROM users WHERE email = ?").get(email);
  if (!user || !(await bcrypt.compare(password, user.password_hash))) {
    return res.status(401).json({ error: "Email or password is incorrect." });
  }
  setSession(res, user);
  res.json({ user: safeUser(user) });
});
app.post("/api/auth/logout", (_req, res) => {
  res.clearCookie("ad_session", { path: "/" });
  res.json({ ok: true });
});
app.get("/api/me", auth, (req, res) => res.json({ user: safeUser(req.user) }));

app.get("/api/library/search", async (req, res) => {
  const search = String(req.query.q || "").trim().slice(0, 100);
  if (!search) return res.json({ results: [] });
  try {
    const response = await fetch("https://graphql.anilist.co", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Accept": "application/json" },
      body: JSON.stringify({
        query: `query ($search: String) {
          Page(page: 1, perPage: 12) {
            media(search: $search, type: ANIME, sort: SEARCH_MATCH) {
              id title { romaji english native }
              coverImage { large } description(asHtml: false)
              episodes seasonYear format
              genres
            }
          }
        }`,
        variables: { search }
      }),
      signal: AbortSignal.timeout(10000)
    });
    if (!response.ok) throw new Error("Anime metadata provider is unavailable.");
    const data = await response.json();
    const results = (data.data?.Page?.media || []).map(a => ({
      id: a.id, title: a.title.english || a.title.romaji || a.title.native,
      nativeTitle: a.title.native, cover: a.coverImage.large,
      description: (a.description || "").replace(/<[^>]*>/g, "").slice(0, 700),
      episodes: a.episodes, year: a.seasonYear, format: a.format, genres: a.genres
    }));
    res.json({ results });
  } catch {
    res.status(502).json({ error: "Anime search is temporarily unavailable. Try again later." });
  }
});

app.get("/api/jobs", auth, (req, res) => {
  const jobs = db.prepare(`
    SELECT id, original_name AS originalName, language, status, message, created_at AS createdAt, completed_at AS completedAt
    FROM jobs WHERE user_id = ? ORDER BY created_at DESC LIMIT 100
  `).all(req.user.id);
  res.json({ jobs, dailyUsed: dailySuccessfulCount(req.user.id), dailyLimit: effectivePlan(req.user) === "pro" ? null : FREE_DAILY_LIMIT });
});

app.post("/api/dub", auth, uploadLimiter, (req, res) => {
  upload.single("video")(req, res, err => {
    if (err) return res.status(400).json({ error: err.code === "LIMIT_FILE_SIZE" ? "Video exceeds the upload size limit." : err.message || "Upload failed." });
    if (!req.file) return res.status(400).json({ error: "Choose a video file." });
    const language = String(req.body.language || "");
    const rightsConfirmed = req.body.rightsConfirmed === "true";
    if (!rightsConfirmed) {
      cleanupFile(req.file.path);
      return res.status(400).json({ error: "Confirm you own this video or have permission to process it." });
    }
    if (!LANGUAGES.has(language)) {
      cleanupFile(req.file.path);
      return res.status(400).json({ error: "Choose a supported language." });
    }
    cleanExpiredSubscriptions();
    const plan = effectivePlan(req.user);
    if (plan !== "pro" && dailySuccessfulCount(req.user.id) >= FREE_DAILY_LIMIT) {
      cleanupFile(req.file.path);
      return res.status(429).json({ error: "You have reached your 3 successful episodes per UTC day on the Free plan." });
    }
    const id = crypto.randomUUID();
    db.prepare(`INSERT INTO jobs (id, user_id, original_name, stored_name, language, status, message)
      VALUES (?, ?, ?, ?, ?, 'awaiting_provider', 'Upload received. Connect an AI dubbing provider to process this video.')`)
      .run(id, req.user.id, path.basename(req.file.originalname).slice(0, 180), path.basename(req.file.filename), language);
    res.status(202).json({
      job: { id, status: "awaiting_provider", language },
      message: "Video received. Real AI dubbing is not configured yet; no dubbed output has been created."
    });
  });
});

app.get("/api/jobs/:id", auth, (req, res) => {
  const job = db.prepare(`SELECT id, original_name AS originalName, language, status, message, created_at AS createdAt, completed_at AS completedAt
    FROM jobs WHERE id = ? AND user_id = ?`).get(req.params.id, req.user.id);
  if (!job) return res.status(404).json({ error: "Job not found." });
  res.json({ job });
});

// Pricing is displayed, but paid subscriptions remain disabled until a real gateway and verified webhook are configured.
app.get("/api/plans", (_req, res) => res.json({
  currency: "INR",
  plans: [
    { id: "free", name: "Free", priceMonthly: 0, priceYearly: 0, successfulEpisodesPerUtcDay: 3, features: ["Anime metadata search", "Projects dashboard", "Authorized video uploads"] },
    { id: "pro", name: "Pro", priceMonthly: 299, priceYearly: 2499, successfulEpisodesPerUtcDay: null, features: ["Higher processing quota subject to capacity", "Priority processing when configured", "Higher export quality when supported"] }
  ],
  paymentsEnabled: false,
  message: "Pro payment activation is disabled until a payment gateway and server-verified webhook are configured."
}));
app.get("/api/billing", auth, (req, res) => {
  const payments = db.prepare(`SELECT id, amount_paise AS amountPaise, currency, plan_period AS planPeriod, status, created_at AS createdAt
    FROM payments WHERE user_id = ? ORDER BY id DESC LIMIT 50`).all(req.user.id);
  res.json({ plan: effectivePlan(req.user), status: req.user.subscription_status, expiresAt: req.user.subscription_expires_at, payments, paymentsEnabled: false });
});

app.get("/api/admin/overview", auth, adminOnly, (_req, res) => {
  const users = db.prepare("SELECT COUNT(*) AS n FROM users").get().n;
  const jobs = db.prepare("SELECT COUNT(*) AS n FROM jobs").get().n;
  const pending = db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE status IN ('queued','processing','awaiting_provider')").get().n;
  const activePro = db.prepare("SELECT COUNT(*) AS n FROM users WHERE plan='pro' AND subscription_status='active' AND subscription_expires_at > ?").get(new Date().toISOString()).n;
  const failures = db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE status='failed'").get().n;
  res.json({ users, jobs, pending, activePro, failures });
});
app.get("/api/admin/jobs", auth, adminOnly, (_req, res) => {
  res.json({ jobs: db.prepare(`SELECT id, user_id AS userId, original_name AS originalName, language, status, message, created_at AS createdAt
    FROM jobs ORDER BY created_at DESC LIMIT 100`).all() });
});

// No payment webhook is implemented here intentionally: do not grant Pro based on a browser request or screenshot.
app.get("/api/health", (_req, res) => res.json({ status: "ok", dubbingConfigured: false, paymentsConfigured: false }));

app.use((err, _req, res, _next) => {
  console.error(err);
  if (res.headersSent) return;
  res.status(500).json({ error: "Unexpected server error." });
});

app.listen(PORT, "0.0.0.0", () => console.log(`AnimeDub AI running on port ${PORT}`));
