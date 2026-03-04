import express from "express";
import pg from "pg";

const { Pool } = pg;

const app = express();
app.use(express.json());

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
}

function formatDate(date: Date): string {
  const pad = (n: number) => n.toString().padStart(2, "0");
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
  );
}

// POST /coupons/v1/coupon/create
app.post("/coupons/v1/coupon/create", async (req, res) => {
  try {
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
      res.json({ success: false, error: "internal error" });
      return;
    }

    const coupon = couponResult.rows[0];

    // Check if coupon is within valid date range
    const now = new Date();
    const since = new Date(coupon.valid_since);
    const until = new Date(coupon.valid_until);
    if (now < since || now > until) {
      res.json({ success: false, error: "internal error" });
      return;
    }

    // Check if already activated by this user in this org
    const activationResult = await pool.query(
      `SELECT 1 FROM activations WHERE user_id = $1 AND org_id = $2 AND title = $3`,
      [userId, orgId, data.title]
    );

    if (activationResult.rows.length > 0) {
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

const PORT = process.env.PORT || 3000;

initDb().then(() => {
  app.listen(PORT, () => {
    console.log(`Coupon API running on port ${PORT}`);
  });
});
