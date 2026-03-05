import express from "express";
import pg from "pg";
import swaggerUi from "swagger-ui-express";
import swaggerDoc from "./swagger.json";

const { Pool } = pg;

const app = express();

// CORS
app.use((_req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.header("Access-Control-Allow-Headers", "Content-Type, x-vercel-protection-bypass");
  if (_req.method === "OPTIONS") {
    res.sendStatus(204);
    return;
  }
  next();
});

app.use(express.json());
app.use("/api-docs", swaggerUi.serve, swaggerUi.setup(swaggerDoc));

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS coupons (
      id SERIAL PRIMARY KEY,
      org_id VARCHAR(255) NOT NULL,
      title VARCHAR(6) NOT NULL,
      amount INTEGER NOT NULL,
      currency VARCHAR(10) NOT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT NOW(),
      valid_since TIMESTAMP NOT NULL,
      valid_until TIMESTAMP NOT NULL
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS activations (
      id SERIAL PRIMARY KEY,
      user_id VARCHAR(255) NOT NULL,
      ip VARCHAR(45) NOT NULL,
      org_id VARCHAR(255) NOT NULL,
      title VARCHAR(6) NOT NULL,
      UNIQUE(user_id, org_id, title)
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS checks (
      id SERIAL PRIMARY KEY,
      org_id VARCHAR(255) NOT NULL,
      endpoint VARCHAR(50) NOT NULL,
      check_name VARCHAR(100) NOT NULL,
      detected_at TIMESTAMP NOT NULL DEFAULT NOW(),
      UNIQUE(org_id, endpoint, check_name)
    )
  `);
}

function formatDate(date: Date): string {
  const pad = (n: number) => n.toString().padStart(2, "0");
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
  );
}

// --- Check detection helpers ---

async function recordCheck(orgId: string, endpoint: string, checkName: string) {
  await pool.query(
    `INSERT INTO checks (org_id, endpoint, check_name)
     VALUES ($1, $2, $3)
     ON CONFLICT (org_id, endpoint, check_name) DO NOTHING`,
    [orgId, endpoint, checkName]
  );
}

const VALID_CURRENCIES = new Set([
  "USD", "EUR", "GBP", "JPY", "CNY", "RUB", "KZT", "UAH", "BYN",
  "CHF", "CAD", "AUD", "NZD", "SEK", "NOK", "DKK", "PLN", "CZK",
  "TRY", "BRL", "INR", "KRW", "SGD", "HKD", "MXN", "ZAR", "THB",
]);

const HAS_CYRILLIC = /[а-яёА-ЯЁ]/;
const HAS_LATIN = /[a-zA-Z]/;
const HAS_SPECIAL = /[^a-zA-Zа-яёА-ЯЁ0-9]/;
const DATE_FORMAT = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}$/;

function detectCreateChecks(body: any): { orgId: string | null; checks: string[] } {
  const detected: string[] = [];
  const { orgId, title, amount, currency, validSince, validUntil } = body ?? {};

  // 1. Required fields — any field missing
  const fields = { title, amount, currency, validSince, validUntil };
  for (const [key, val] of Object.entries(fields)) {
    if (val === undefined || val === null || val === "") {
      detected.push("create:required_fields");
      break;
    }
  }

  // 2. Title checks
  if (title !== undefined && title !== null) {
    const t = String(title);
    // Boundary: empty, exactly 6, 7+
    if (t.length === 0 || t.length === 6 || t.length === 7 || t.length > 7) {
      detected.push("create:title_boundary");
    }
    if (HAS_CYRILLIC.test(t)) detected.push("create:title_cyrillic");
    if (HAS_LATIN.test(t)) detected.push("create:title_latin");
    if (HAS_SPECIAL.test(t)) detected.push("create:title_special_chars");
  }

  // 3. Amount checks
  if (amount !== undefined && amount !== null) {
    if (typeof amount !== "number") {
      detected.push("create:amount_wrong_type");
    } else {
      if (amount === 0 || amount === 9999 || amount === 10000 || amount < 0 || amount > 9999) {
        detected.push("create:amount_boundary");
      }
      if (!Number.isInteger(amount)) {
        detected.push("create:amount_float");
      } else {
        detected.push("create:amount_integer");
      }
    }
  }

  // 4. Currency checks
  if (currency !== undefined && currency !== null) {
    const c = String(currency).toUpperCase();
    if (!VALID_CURRENCIES.has(c)) {
      detected.push("create:currency_invalid");
    } else {
      detected.push("create:currency_valid");
    }
    if (c.length > 3) detected.push("create:currency_full_name");
    if (c.length > 0 && c.length < 3) detected.push("create:currency_partial");
  }

  // 5. Date checks
  if (validSince !== undefined || validUntil !== undefined) {
    const sStr = validSince != null ? String(validSince) : "";
    const uStr = validUntil != null ? String(validUntil) : "";

    if ((sStr && !DATE_FORMAT.test(sStr)) || (uStr && !DATE_FORMAT.test(uStr))) {
      detected.push("create:date_wrong_format");
    }

    const since = new Date(sStr);
    const until = new Date(uStr);
    const now = new Date();

    if (!isNaN(since.getTime()) && !isNaN(until.getTime())) {
      if (since >= until) detected.push("create:date_start_after_end");
      if (since < now && until < now) detected.push("create:date_both_past");
      if (since > now && until > now) detected.push("create:date_both_future");
    }
  }

  return { orgId: orgId ?? null, checks: detected };
}

function detectActivateChecks(
  body: any,
  result: "success" | "not_found" | "expired" | "not_started" | "already_activated"
): string[] {
  const detected: string[] = [];

  switch (result) {
    case "already_activated":
      detected.push("activate:duplicate");
      break;
    case "not_found":
      detected.push("activate:nonexistent");
      break;
    case "expired":
      detected.push("activate:expired");
      break;
    case "not_started":
      detected.push("activate:not_started");
      break;
  }

  return detected;
}

// Init tables on first request
let dbReady = false;
app.use(async (_req, _res, next) => {
  if (!dbReady) {
    await initDb();
    dbReady = true;
  }
  next();
});

// POST /coupons/v1/coupon/create
app.post("/coupons/v1/coupon/create", async (req, res) => {
  try {
    // Detect checks before validation
    const { orgId: detectedOrg, checks } = detectCreateChecks(req.body);
    if (detectedOrg) {
      for (const c of checks) {
        await recordCheck(detectedOrg, "create", c);
      }
    }

    const { orgId, title, amount, currency, validSince, validUntil } = req.body;

    // Required fields
    if (!orgId || !title || amount == null || !currency || !validSince || !validUntil) {
      res.json({ success: false, reason: "internal error" });
      return;
    }

    // title: max 6 characters
    if (typeof title !== "string" || title.length > 6) {
      res.json({ success: false, reason: "internal error" });
      return;
    }

    // amount: max 4 digits
    if (typeof amount !== "number" || amount < 0 || amount > 9999) {
      res.json({ success: false, reason: "internal error" });
      return;
    }

    // currency: must be a non-empty string
    if (typeof currency !== "string" || currency.length === 0) {
      res.json({ success: false, reason: "internal error" });
      return;
    }

    // validSince must be before validUntil
    const since = new Date(validSince);
    const until = new Date(validUntil);
    if (isNaN(since.getTime()) || isNaN(until.getTime())) {
      res.json({ success: false, reason: "internal error" });
      return;
    }
    if (since >= until) {
      res.json({ success: false, reason: "internal error" });
      return;
    }

    const result = await pool.query(
      `INSERT INTO coupons (org_id, title, amount, currency, valid_since, valid_until)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id, org_id, title, amount, currency, created_at, valid_since, valid_until`,
      [orgId, title, amount, currency, validSince, validUntil]
    );

    const row = result.rows[0];

    res.json({
      success: true,
      id: row.id,
      orgId: row.org_id,
      title: row.title,
      amount: row.amount,
      currency: row.currency,
      createdAt: formatDate(new Date(row.created_at)),
      validSince: formatDate(new Date(row.valid_since)),
      validUntil: formatDate(new Date(row.valid_until)),
    });
  } catch {
    res.json({ success: false, reason: "internal error" });
  }
});

// POST /coupons/v1/coupon/activate
app.post("/coupons/v1/coupon/activate", async (req, res) => {
  try {
    const { orgId, userId, ip, data } = req.body;

    // Required fields
    if (!orgId || !userId || !ip || !data?.title) {
      res.json({ success: false, error: "internal error" });
      return;
    }

    // Find coupon by title and orgId
    const couponResult = await pool.query(
      `SELECT title, valid_since, valid_until FROM coupons WHERE title = $1 AND org_id = $2`,
      [data.title, orgId]
    );

    if (couponResult.rows.length === 0) {
      const checks = detectActivateChecks(req.body, "not_found");
      for (const c of checks) await recordCheck(orgId, "activate", c);
      res.json({ success: false, error: "internal error" });
      return;
    }

    const coupon = couponResult.rows[0];

    // Check if coupon is within valid date range
    const now = new Date();
    const since = new Date(coupon.valid_since);
    const until = new Date(coupon.valid_until);
    if (now < since) {
      const checks = detectActivateChecks(req.body, "not_started");
      for (const c of checks) await recordCheck(orgId, "activate", c);
      res.json({ success: false, error: "internal error" });
      return;
    }
    if (now > until) {
      const checks = detectActivateChecks(req.body, "expired");
      for (const c of checks) await recordCheck(orgId, "activate", c);
      res.json({ success: false, error: "internal error" });
      return;
    }

    // Check if already activated by this user in this org
    const activationResult = await pool.query(
      `SELECT 1 FROM activations WHERE user_id = $1 AND org_id = $2 AND title = $3`,
      [userId, orgId, data.title]
    );

    if (activationResult.rows.length > 0) {
      const checks = detectActivateChecks(req.body, "already_activated");
      for (const c of checks) await recordCheck(orgId, "activate", c);
      res.json({ success: false, error: "alreadyActivated" });
      return;
    }

    await pool.query(
      `INSERT INTO activations (user_id, ip, org_id, title) VALUES ($1, $2, $3, $4)`,
      [userId, ip, orgId, data.title]
    );

    res.json({ success: true });
  } catch {
    res.json({ success: false, error: "internal error" });
  }
});

// All possible checks
const ALL_CHECKS = {
  create: [
    "create:required_fields",
    "create:title_boundary",
    "create:title_cyrillic",
    "create:title_latin",
    "create:title_special_chars",
    "create:amount_boundary",
    "create:amount_integer",
    "create:amount_float",
    "create:amount_wrong_type",
    "create:currency_valid",
    "create:currency_invalid",
    "create:currency_full_name",
    "create:currency_partial",
    "create:date_wrong_format",
    "create:date_start_after_end",
    "create:date_both_past",
    "create:date_both_future",
  ],
  activate: [
    "activate:duplicate",
    "activate:nonexistent",
    "activate:expired",
    "activate:not_started",
  ],
};

// GET /coupons/v1/checks/:orgId
app.get("/coupons/v1/checks/:orgId", async (req, res) => {
  try {
    const { orgId } = req.params;

    const result = await pool.query(
      `SELECT endpoint, check_name, detected_at FROM checks WHERE org_id = $1 ORDER BY detected_at`,
      [orgId]
    );

    const passed = result.rows.map((r) => r.check_name);
    const allChecks = [...ALL_CHECKS.create, ...ALL_CHECKS.activate];
    const missing = allChecks.filter((c) => !passed.includes(c));

    res.json({
      orgId,
      total: allChecks.length,
      passed: passed.length,
      missing: missing.length,
      checks: {
        create: ALL_CHECKS.create.map((c) => ({
          name: c,
          passed: passed.includes(c),
        })),
        activate: ALL_CHECKS.activate.map((c) => ({
          name: c,
          passed: passed.includes(c),
        })),
      },
    });
  } catch {
    res.json({ success: false, error: "internal error" });
  }
});

app.get('/healthz', (req, res) => {
  res.status(200).json({ status: 'ok', timestamp: new Date().toISOString() })
})

// Local dev
if (process.env.NODE_ENV !== "production") {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => {
    console.log(`Coupon API running on port ${PORT}`);
  });
}

export default app;
