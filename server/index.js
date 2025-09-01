import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import pkg from 'pg';
import path, { dirname } from 'path';
import { fileURLToPath } from 'url';

const { Pool } = pkg;
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false } // Neon requires SSL
});

const app = express();
// CORS only in dev (prod serves UI + API on same origin)
if (process.env.NODE_ENV !== 'production') {
  app.use(cors({ origin: API }));
}
app.use(express.json());

// ---------- helpers ----------
async function ensureOnHandRow(client, itemId) {
  await client.query(
    `INSERT INTO inventory_onhand (item_id, on_hand)
     VALUES ($1, 0)
     ON CONFLICT (item_id) DO NOTHING`,
    [itemId]
  );
}
const FIELD_MAP = {
  brand: '"Brand"',
  model: '"Model"',
  size: '"Size"',
  color: '"Color"',
  purchasedfrom: '"PurchasedFrom"',
  scannedcode: '"ScannedCode"',
  notes: '"Notes"',
  soldorder: '"SoldOrder#"'
};

// ---------- search (place these BEFORE /items/:code) ----------
app.get('/items/distinct', async (req, res) => {
  try {
    const fieldParam = String(req.query.field || '').toLowerCase();
    const col = FIELD_MAP[fieldParam];
    if (!col) return res.status(400).json({ error: 'INVALID_FIELD' });

    const { rows } = await pool.query(
      `SELECT ${col} AS value, COUNT(*)::int AS count
       FROM items
       WHERE ${col} IS NOT NULL AND btrim(${col}) <> ''
       GROUP BY ${col}
       ORDER BY lower(${col})`
    );
    res.json(rows);
  } catch (e) { console.error(e); res.status(500).json({ error: 'SERVER_ERROR' }); }
});

app.get('/items/search', async (req, res) => {
  try {
    const qRaw = (req.query.q ?? '').toString().trim();
    const qPattern = qRaw ? `%${qRaw.replace(/[%_]/g, '\\$&')}%` : null;

    const parseList = k => {
      const v = req.query[k]; if (!v) return [];
      const s = Array.isArray(v) ? v.join(',') : String(v);
      return s.split(',').map(x => x.trim()).filter(Boolean);
    };

    const filters = {
      brand:         parseList('brand'),
      model:         parseList('model'),
      size:          parseList('size'),
      color:         parseList('color'),
      purchasedfrom: parseList('purchasedfrom'),
      scannedcode:   parseList('scannedcode'),
      notes:         parseList('notes'),
      soldorder:     parseList('soldorder')
    };

    const where = [];
    const params = [];
    let i = 1;

    if (qPattern) {
      where.push(`(
        i."ScannedCode"    ILIKE $${i} OR
        i."Brand"          ILIKE $${i} OR
        i."Model"          ILIKE $${i} OR
        i."Size"           ILIKE $${i} OR
        i."Color"          ILIKE $${i} OR
        i."Notes"          ILIKE $${i} OR
        i."SoldOrder#"     ILIKE $${i} OR
        i."PurchasedFrom"  ILIKE $${i} OR
        CAST(i."PaintThickness" AS TEXT) ILIKE $${i} OR
        CAST(i."Price"          AS TEXT) ILIKE $${i} OR
        CAST(i."Qty"            AS TEXT) ILIKE $${i} OR
        CAST(i."InventoryDate"  AS TEXT) ILIKE $${i}
      )`);
      params.push(qPattern); i++;
    }

    for (const [key, values] of Object.entries(filters)) {
      if (!values.length) continue;
      const col = FIELD_MAP[key];
      where.push(`LOWER(${col}) = ANY($${i})`);
      params.push(values.map(v => v.toLowerCase()));
      i++;
    }

    const whereSQL = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const limit = 200;

    const { rows } = await pool.query(
      `
      SELECT
        i.id, i."InventoryDate", i."ScannedCode", i."Brand", i."Model",
        i."Size", i."Color", i."Notes", i."SoldOrder#", i."PurchasedFrom",
        i."PaintThickness", i."Price", i."Qty",
        COALESCE(oh.on_hand, 0) AS "onHand"
      FROM items i
      LEFT JOIN inventory_onhand oh ON oh.item_id = i.id
      ${whereSQL}
      ORDER BY i."Brand" NULLS LAST, i."Model" NULLS LAST, i."ScannedCode"
      LIMIT ${limit}
      `,
      params
    );

    res.json(rows);
  } catch (e) { console.error(e); res.status(500).json({ error: 'SERVER_ERROR' }); }
});

// ---------- items ----------
app.get('/items/:code', async (req, res) => {
  const { code } = req.params;
  try {
    const { rows } = await pool.query('SELECT * FROM items WHERE "ScannedCode" = $1', [code]);
    if (!rows.length) return res.status(404).json({ error: 'ITEM_NOT_FOUND' });
    res.json(rows[0]);
  } catch (e) { console.error(e); res.status(500).json({ error: 'SERVER_ERROR' }); }
});

app.post('/items', async (req, res) => {
  const {
    InventoryDate, ScannedCode, Brand, Model, Size, Color, Notes,
    ['SoldOrder#']: SoldOrderNum, PurchasedFrom, PaintThickness, Price, Qty
  } = req.body || {};
  if (!ScannedCode || !Model) return res.status(400).json({ error: 'MISSING_FIELDS', required: ['ScannedCode','Model'] });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `INSERT INTO items (
         "InventoryDate","ScannedCode","Brand","Model","Size","Color",
         "Notes","SoldOrder#","PurchasedFrom","PaintThickness","Price","Qty"
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
       ON CONFLICT ("ScannedCode") DO UPDATE SET
         "InventoryDate"   = COALESCE(EXCLUDED."InventoryDate", items."InventoryDate"),
         "Brand"           = EXCLUDED."Brand",
         "Model"           = EXCLUDED."Model",
         "Size"            = EXCLUDED."Size",
         "Color"           = EXCLUDED."Color",
         "Notes"           = EXCLUDED."Notes",
         "SoldOrder#"      = EXCLUDED."SoldOrder#",
         "PurchasedFrom"   = EXCLUDED."PurchasedFrom",
         "PaintThickness"  = EXCLUDED."PaintThickness",
         "Price"           = EXCLUDED."Price",
         "Qty"             = EXCLUDED."Qty"
       RETURNING *`,
      [
        InventoryDate ?? new Date().toISOString(),
        ScannedCode,
        Brand ?? null,
        Model,
        Size ?? null,
        Color ?? null,
        Notes ?? null,
        SoldOrderNum ?? null,
        PurchasedFrom ?? null,
        (PaintThickness === '' || PaintThickness == null) ? null : Number(PaintThickness),
        (Price === '' || Price == null) ? null : Number(Price),
        (Qty === '' || Qty == null) ? null : Number(Qty)
      ]
    );
    const item = rows[0];

    await ensureOnHandRow(client, item.id);
    await client.query('COMMIT');
    res.status(201).json(item);
  } catch (e) { await client.query('ROLLBACK'); console.error(e); res.status(500).json({ error: 'SERVER_ERROR' }); }
  finally { client.release(); }
});

// ---------- inventory add/remove ----------
app.post('/inventory/add', async (req, res) => {
  const { barcode } = req.body; // barcode = ScannedCode
  if (!barcode) return res.status(400).json({ error: 'MISSING_BARCODE' });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const it = await client.query('SELECT id, "Model" FROM items WHERE "ScannedCode" = $1', [barcode]);
    if (!it.rows.length) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'ITEM_NOT_FOUND' }); }
    const item = it.rows[0];
    await ensureOnHandRow(client, item.id);
    await client.query('UPDATE inventory_onhand SET on_hand = on_hand + 1 WHERE item_id = $1', [item.id]);
    const ev = await client.query(
      `INSERT INTO inventory_events (item_id, action, qty) VALUES ($1,'add',1) RETURNING *`,
      [item.id]
    );
    await client.query('COMMIT');
    res.status(201).json({ event: ev.rows[0], item });
  } catch (e) { await client.query('ROLLBACK'); console.error(e); res.status(500).json({ error: 'SERVER_ERROR' }); }
  finally { client.release(); }
});

app.post('/inventory/remove/initiate', async (req, res) => {
  const { barcode } = req.body;
  if (!barcode) return res.status(400).json({ error: 'MISSING_BARCODE' });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const it = await client.query(
      'SELECT id, "ScannedCode","Brand","Model","Color","Size" FROM items WHERE "ScannedCode" = $1',
      [barcode]
    );
    if (!it.rows.length) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'ITEM_NOT_FOUND' }); }
    const item = it.rows[0];
    await ensureOnHandRow(client, item.id);
    const oh = await client.query('SELECT on_hand FROM inventory_onhand WHERE item_id = $1', [item.id]);
    const onHand = oh.rows[0].on_hand;
    await client.query('COMMIT');
    if (onHand > 0) return res.json({ status: 'CONFIRM_REQUIRED', item, onHand });
    return res.json({ status: 'REGISTERED_ZERO_STOCK', item, onHand: 0 });
  } catch (e) { await client.query('ROLLBACK'); console.error(e); res.status(500).json({ error: 'SERVER_ERROR' }); }
  finally { client.release(); }
});

app.post('/inventory/remove/confirm', async (req, res) => {
  const {
    barcode,
    ['Order Id']: orderId,
    ['Where bought from']: whereBoughtFrom,
    ['Date Subtracted']: dateSubtracted
  } = req.body || {};
  if (!barcode) return res.status(400).json({ error: 'MISSING_BARCODE' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const it = await client.query('SELECT id FROM items WHERE "ScannedCode" = $1', [barcode]);
    if (!it.rows.length) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'ITEM_NOT_FOUND' }); }
    const item = it.rows[0];

    const oh = await client.query('SELECT on_hand FROM inventory_onhand WHERE item_id = $1 FOR UPDATE', [item.id]);
    if (!oh.rows.length || oh.rows[0].on_hand <= 0) {
      await client.query('ROLLBACK'); return res.status(409).json({ error: 'OUT_OF_STOCK', onHand: 0 });
    }

    await client.query('UPDATE inventory_onhand SET on_hand = on_hand - 1 WHERE item_id = $1', [item.id]);
    const ev = await client.query(
      `INSERT INTO inventory_events (item_id, action, qty, "Order Id", "Where bought from", "Date Subtracted")
       VALUES ($1,'remove',1,$2,$3,COALESCE($4::timestamptz, now()))
       RETURNING *`,
      [item.id, orderId ?? null, whereBoughtFrom ?? null, dateSubtracted ?? null]
    );

    const newOnHand = oh.rows[0].on_hand - 1;
    await client.query('COMMIT');
    res.json({ status: 'REMOVED', onHand: newOnHand, event: ev.rows[0] });
  } catch (e) { await client.query('ROLLBACK'); console.error(e); res.status(500).json({ error: 'SERVER_ERROR' }); }
  finally { client.release(); }
});

app.get('/health', (_, res) => res.json({ ok: true }));

// ---------- static hosting (AFTER routes) ----------
const __dirname = dirname(fileURLToPath(import.meta.url));
const clientDist = path.resolve(__dirname, '../web/dist');
app.use(express.static(clientDist));
app.get('*', (req, res) => res.sendFile(path.join(clientDist, 'index.html')));

const port = Number(process.env.PORT || 4000);
app.listen(port, () => console.log(`Server ready on http://localhost:${port}`));
