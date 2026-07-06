import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdirSync, existsSync, copyFileSync, readdirSync, rmSync } from 'node:fs';
import { NUTRIENT_KEYS } from './nutrients.js';
import { SEED_FOODS } from './seed.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const dataDir = join(__dirname, '..', 'data');
mkdirSync(dataDir, { recursive: true });

export const db = new DatabaseSync(join(dataDir, 'diet.db'));
db.exec('PRAGMA journal_mode = WAL;');
db.exec('PRAGMA foreign_keys = ON;');

// 栄養素カラム定義（すべて NULL 許容 = データ未登録を表現できる）
const nutrientCols = NUTRIENT_KEYS.map((k) => `${k} REAL`).join(',\n    ');

db.exec(`
  CREATE TABLE IF NOT EXISTS foods (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    aliases TEXT,
    category TEXT,
    ${nutrientCols},
    dataSource TEXT,
    note TEXT,
    isEstimated INTEGER NOT NULL DEFAULT 0,
    createdAt TEXT NOT NULL,
    updatedAt TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS meals (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    date TEXT NOT NULL,
    time TEXT,
    mealType TEXT NOT NULL,
    foodId INTEGER,
    foodName TEXT NOT NULL,
    grams REAL NOT NULL,
    memo TEXT,
    isUnregistered INTEGER NOT NULL DEFAULT 0,
    createdAt TEXT NOT NULL,
    updatedAt TEXT NOT NULL,
    FOREIGN KEY (foodId) REFERENCES foods(id) ON DELETE SET NULL
  );

  CREATE INDEX IF NOT EXISTS idx_meals_date ON meals(date);

  CREATE TABLE IF NOT EXISTS goals (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    targetCalories REAL,
    targetProtein REAL,
    targetFiber REAL,
    saltLimit REAL,
    weightGoal REAL,
    bodyFatGoal REAL,
    updatedAt TEXT
  );

  CREATE TABLE IF NOT EXISTS body_records (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    date TEXT NOT NULL UNIQUE,
    weight REAL,
    bodyFat REAL,
    visceralFat REAL,
    memo TEXT,
    createdAt TEXT NOT NULL
  );

  -- 当日の消費カロリー（スマートウォッチ等の手入力）。日付ごとに1値。
  CREATE TABLE IF NOT EXISTS daily_energy (
    date TEXT PRIMARY KEY,
    burnedCalories REAL,
    updatedAt TEXT
  );

  -- サプリマスタ（食材マスタと同じ構成だが別管理）。
  -- 栄養素の値は「1粒/1個あたり」の含有量（食材の100gあたりとは異なる）。
  CREATE TABLE IF NOT EXISTS supplements (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    aliases TEXT,
    brand TEXT,
    ${nutrientCols},
    dataSource TEXT,
    note TEXT,
    isEstimated INTEGER NOT NULL DEFAULT 0,
    createdAt TEXT NOT NULL,
    updatedAt TEXT NOT NULL
  );

  -- サプリの摂取記録。グラムではなく「個数(units)」で記録し、
  -- 摂取栄養素 = サプリ1個あたりの含有量 × units として集計に加える。
  CREATE TABLE IF NOT EXISTS supplement_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    date TEXT NOT NULL,
    time TEXT,
    supplementId INTEGER,
    supplementName TEXT NOT NULL,
    units REAL NOT NULL,
    memo TEXT,
    createdAt TEXT NOT NULL,
    updatedAt TEXT NOT NULL,
    FOREIGN KEY (supplementId) REFERENCES supplements(id) ON DELETE SET NULL
  );

  CREATE INDEX IF NOT EXISTS idx_supplement_logs_date ON supplement_logs(date);
`);

// --- migrations（既存DB向け）---
const bodyCols = db.prepare('PRAGMA table_info(body_records)').all().map((c) => c.name);
if (!bodyCols.includes('visceralFat')) {
  db.exec('ALTER TABLE body_records ADD COLUMN visceralFat REAL');
  console.log('[db] migrated: body_records.visceralFat added');
}

// goals は必ず1行存在させる
const goalCount = db.prepare('SELECT COUNT(*) AS c FROM goals').get();
if (goalCount.c === 0) {
  db.prepare(`INSERT INTO goals (id, targetCalories, targetProtein, targetFiber, saltLimit, weightGoal, bodyFatGoal, updatedAt)
              VALUES (1, 2000, 60, 20, 7.5, NULL, NULL, ?)`).run(new Date().toISOString());
}

// 食材マスタが空のときだけ seed
const foodCount = db.prepare('SELECT COUNT(*) AS c FROM foods').get();
if (foodCount.c === 0) {
  const cols = ['name', 'aliases', 'category', ...NUTRIENT_KEYS, 'dataSource', 'note', 'isEstimated', 'createdAt', 'updatedAt'];
  const placeholders = cols.map(() => '?').join(', ');
  const stmt = db.prepare(`INSERT INTO foods (${cols.join(', ')}) VALUES (${placeholders})`);
  const now = new Date().toISOString();
  for (const f of SEED_FOODS) {
    const values = cols.map((c) => {
      if (c === 'createdAt' || c === 'updatedAt') return now;
      const v = f[c];
      return v === undefined ? null : v;
    });
    stmt.run(...values);
  }
  console.log(`[db] seeded ${SEED_FOODS.length} foods`);
}

// --- 起動時の自動バックアップ ---
// 誤削除・破損に備え、起動のたびに diet.db を data/backups/ に日時つきでコピー。
// WAL の内容を本体へ反映してからコピーし、直近20世代のみ保持。
try {
  db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  const backupsDir = join(dataDir, 'backups');
  mkdirSync(backupsDir, { recursive: true });
  const dbPath = join(dataDir, 'diet.db');
  if (existsSync(dbPath)) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    copyFileSync(dbPath, join(backupsDir, `diet-${stamp}.db`));
    const backups = readdirSync(backupsDir).filter((f) => f.startsWith('diet-') && f.endsWith('.db')).sort();
    for (const old of backups.slice(0, -20)) {
      rmSync(join(backupsDir, old), { force: true });
    }
    console.log(`[db] backup created (${backups.length > 20 ? 20 : backups.length + 1} kept)`);
  }
} catch (e) {
  console.warn('[db] backup skipped:', e.message);
}

export default db;
