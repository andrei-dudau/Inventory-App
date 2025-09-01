import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import pkg from 'pg';

const { Pool } = pkg;
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const app = express();
app.use(cors());
app.use(express.json());

// Helper to ensure on-hand row exists for an item
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
  soldorder: '"SoldOrder#"',   // query param: soldorder
  // You can add numeric fields later (price, qty, etc.)
};

app.get('/items/distinct', async (req, res) => {
  try {
    const fieldParam = String(req.query.field || '').toLowerCase();
    const col = FIELD_MAP[fieldParam];
    if (!col) return res.status(400).json({ error: 'INVALID_FIELD' });

    const { rows } = await pool.query(
      `
      SELECT ${col} AS value, COUNT(*)::int AS count
      FROM items
      WHERE ${col} IS NOT NULL AND btrim(${col}) <> ''
      GROUP BY ${col}
      ORDER BY lower(${col})
      `
    );
    res.json(rows);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'SERVER_ERROR' });
  }
});

app.get('/items/search', async (req, res) => {
  try {
    const qRaw = (req.query.q ?? '').toString().trim();
    const qPattern = qRaw ? `%${qRaw.replace(/[%_]/g, '\\$&')}%` : null;

    // Parse multi-select filters: &brand=Stanley,Thermos&color=Blue
    function parseList(k) {
      const v = req.query[k];
      if (!v) return [];
      const str = Array.isArray(v) ? v.join(',') : String(v);
      return str.split(',').map(s => s.trim()).filter(Boolean);
    }

    const filters = {
      brand:         parseList('brand'),
      model:         parseList('model'),
      size:          parseList('size'),
      color:         parseList('color'),
      purchasedfrom: parseList('purchasedfrom'),
      scannedcode:   parseList('scannedcode'),
      notes:         parseList('notes'),
      soldorder:     parseList('soldorder'),
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

    // AND across categories; OR within the same category
    for (const [key, values] of Object.entries(filters)) {
      if (!values.length) continue;
      const col = FIELD_MAP[key];
      // Case-insensitive match on exact values
      where.push(`LOWER(${col}) = ANY($${i})`);
      params.push(values.map(v => v.toLowerCase()));
      i++;
    }

    const whereSQL = where.length ? `WHERE ${where.join(' AND ')}` : '';
    // If no q and no filters, return a page of everything
    const limit = 200;

    const { rows } = await pool.query(
      `
      SELECT
        i.id,
        i."InventoryDate",
        i."ScannedCode",
        i."Brand",
        i."Model",
        i."Size",
        i."Color",
        i."Notes",
        i."SoldOrder#",
        i."PurchasedFrom",
        i."PaintThickness",
        i."Price",
        i."Qty",
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
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'SERVER_ERROR' });
  }
});

// Get item by barcode
app.get('/items/:barcode', async (req, res) => {
  const { barcode } = req.params;
  try {
    const { rows } = await pool.query('SELECT * FROM items WHERE "ScannedCode" = $1', [barcode]);
    if (rows.length === 0) return res.status(404).json({ error: 'ITEM_NOT_FOUND' });
    res.json(rows[0]);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'SERVER_ERROR' });
  }
});

// Create or update item (also ensure on-hand row exists with 0)
app.post('/items', async (req, res) => {
  const {
    InventoryDate,
    ScannedCode,
    Brand,
    Model,
    Size,
    Color,
    Notes,
    // note the bracket access for '#'
    ['SoldOrder#']: SoldOrderNum,
    PurchasedFrom,
    PaintThickness,
    Price,
    Qty
  } = req.body || {};

  if (!ScannedCode || !Model) {
    return res.status(400).json({ error: 'MISSING_FIELDS', required: ['ScannedCode', 'Model'] });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const { rows } = await client.query(
      `INSERT INTO items (
         "InventoryDate","ScannedCode","Brand","Model","Size","Color",
         "Notes","SoldOrder#","PurchasedFrom","PaintThickness","Price","Qty"
       )
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
       ON CONFLICT ("ScannedCode") DO UPDATE SET
         "InventoryDate" = COALESCE(EXCLUDED."InventoryDate", items."InventoryDate"),
         "Brand"         = EXCLUDED."Brand",
         "Model"         = EXCLUDED."Model",
         "Size"          = EXCLUDED."Size",
         "Color"         = EXCLUDED."Color",
         "Notes"         = EXCLUDED."Notes",
         "SoldOrder#"    = EXCLUDED."SoldOrder#",
         "PurchasedFrom" = EXCLUDED."PurchasedFrom",
         "PaintThickness"= EXCLUDED."PaintThickness",
         "Price"         = EXCLUDED."Price",
         "Qty"           = EXCLUDED."Qty"
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

    // keep on-hand row present (qty here is metadata; we don't auto-sync stock)
    await client.query(
      `INSERT INTO inventory_onhand (item_id, on_hand)
       VALUES ($1, 0)
       ON CONFLICT (item_id) DO NOTHING`,
      [item.id]
    );

    await client.query('COMMIT');
    res.status(201).json(item);
  } catch (e) {
    await client.query('ROLLBACK');
    console.error(e);
    res.status(500).json({ error: 'SERVER_ERROR' });
  } finally {
    client.release();
  }
});

// ADD one unit
app.post('/inventory/add', async (req, res) => {
  const { barcode } = req.body;
  if (!barcode) return res.status(400).json({ error: 'MISSING_BARCODE' });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const itemRes = await client.query('SELECT id, "Brand", "Model" FROM items WHERE "ScannedCode" = $1', [barcode]);
    if (itemRes.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'ITEM_NOT_FOUND' });
    }
    const item = itemRes.rows[0];
    await ensureOnHandRow(client, item.id);
    await client.query('UPDATE inventory_onhand SET on_hand = on_hand + 1 WHERE item_id = $1', [item.id]);
    const ev = await client.query(
      `INSERT INTO inventory_events (item_id, action, qty)
       VALUES ($1, 'add', 1) RETURNING *`,
      [item.id]
    );
    await client.query('COMMIT');
    res.status(201).json({ event: ev.rows[0], item });
  } catch (e) {
    await client.query('ROLLBACK');
    console.error(e);
    res.status(500).json({ error: 'SERVER_ERROR' });
  } finally {
    client.release();
  }
});

// REMOVE flow — step 1: initiate (decide if confirmation is needed or ensure 0-row)
app.post('/inventory/remove/initiate', async (req, res) => {
  const { barcode } = req.body;
  if (!barcode) return res.status(400).json({ error: 'MISSING_BARCODE' });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const itemRes = await client.query('SELECT id, "ScannedCode", "Brand", "Model", "Color", "Size" FROM items WHERE "ScannedCode" = $1', [barcode]);
    if (itemRes.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'ITEM_NOT_FOUND' });
    }
    const item = itemRes.rows[0];
    await ensureOnHandRow(client, item.id);
    const onhandRes = await client.query('SELECT on_hand FROM inventory_onhand WHERE item_id = $1', [item.id]);
    const onHand = onhandRes.rows[0].on_hand;
    await client.query('COMMIT');

    if (onHand > 0) {
      return res.json({ status: 'CONFIRM_REQUIRED', item, onHand });
    } else {
      return res.json({ status: 'REGISTERED_ZERO_STOCK', item, onHand: 0 });
    }
  } catch (e) {
    await client.query('ROLLBACK');
    console.error(e);
    res.status(500).json({ error: 'SERVER_ERROR' });
  } finally {
    client.release();
  }
});

// REMOVE flow — step 2: confirm actual removal of one unit
app.post('/inventory/remove/confirm', async (req, res) => {
  const {barcode, ["Order Id"]: orderId, ["Where bought from"]: whereBoughtFrom,
    ["Date Subtracted"]: dateSubtracted
} = req.body;
  if (!barcode) return res.status(400).json({ error: 'MISSING_BARCODE' });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const itemRes = await client.query('SELECT id, name FROM items WHERE barcode = $1', [barcode]);
    if (itemRes.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'ITEM_NOT_FOUND' });
    }
    const item = itemRes.rows[0];
    const onhandRes = await client.query('SELECT on_hand FROM inventory_onhand WHERE item_id = $1 FOR UPDATE', [item.id]);
    if (onhandRes.rows.length === 0) {
      // Create a zero row if somehow missing
      await ensureOnHandRow(client, item.id);
      await client.query('COMMIT');
      return res.status(409).json({ error: 'OUT_OF_STOCK', onHand: 0 });
    }
    const onHand = onhandRes.rows[0].on_hand;
    if (onHand <= 0) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'OUT_OF_STOCK', onHand: 0 });
    }
    await client.query('UPDATE inventory_onhand SET on_hand = on_hand - 1 WHERE item_id = $1', [item.id]);
    const ev = await client.query(
    `INSERT INTO inventory_events (item_id, action, qty, "Order Id", "Where bought from", "Date Subtracted")
     VALUES ($1, 'remove', 1, $2, $3, COALESCE($4::timestamptz, now()))
    RETURNING *`, [item.id, orderId ?? null, whereBoughtFrom ?? null, dateSubtracted ?? null]
    );
    await client.query('COMMIT');
    res.json({ status: 'REMOVED', item, onHand: onHand - 1, event: ev.rows[0] });
  } catch (e) {
    await client.query('ROLLBACK');
    console.error(e);
    res.status(500).json({ error: 'SERVER_ERROR' });
  } finally {
    client.release();
  }
});

app.get('/stock', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT i."ScannedCode", i."Brand", i."Model", COALESCE(oh.on_hand,0) AS on_hand
       FROM items i
       LEFT JOIN inventory_onhand oh ON oh.item_id = i.id
       ORDER BY i.name`
    );
    res.json(rows);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'SERVER_ERROR' });
  }
});



app.get('/health', (_, res) => res.json({ ok: true }));

const port = Number(process.env.PORT || 4000);
app.listen(port, () => console.log(`API listening on http://localhost:${port}`));