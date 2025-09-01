import 'dotenv/config';
import pkg from 'pg';
const { Pool } = pkg;
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function main() {
  await pool.query(`
    INSERT INTO items (barcode, name, color, size)
    VALUES
      ('0001112223334', 'Basic Tee', 'Black', 'M'),
      ('0001112223335', 'Basic Tee', 'White', 'L')
    ON CONFLICT (barcode) DO NOTHING;
  `);
  console.log('Seeded sample items.');
  await pool.end();
}
main().catch(e => { console.error(e); process.exit(1); });