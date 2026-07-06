// Neon Postgres への接続とクエリ層。
//
// 設計方針（SQLite からの移植を最小差分にするための工夫）:
//  - Postgres は未クォートの識別子をすべて小文字に畳む。既存 SQL は camelCase の
//    カラム名（foodId, isEstimated, vitaminC ...）を未クォートで書いているため、
//    書き込みも読み出しも一貫して小文字カラムを参照する → SQL 文字列はほぼ無修正で流用可能。
//  - ただし SELECT * の結果キーも小文字になり、フロント/集計は camelCase を期待する。
//    そこで get()/all() の返り値だけ、既知の camelCase 名に復元する（remap）。
//  - SQLite の `?` プレースホルダは Postgres の `$1,$2...` へ自動変換（toPg）。
//  - lastInsertRowid は INSERT ... RETURNING id で代替。
import { neon } from '@neondatabase/serverless';
import { NUTRIENT_KEYS } from './nutrients.js';
import { SEED_FOODS } from './seed.js';

// 接続は遅延生成する。import 時点で throw すると Vercel Functions が初期化段階で
// クラッシュ（FUNCTION_INVOCATION_FAILED）してしまい、原因が分かる 500 JSON を返せないため。
let _sql = null;
function getSql() {
  if (_sql) return _sql;
  if (!process.env.DATABASE_URL) {
    throw new Error('環境変数 DATABASE_URL が設定されていません（Neon Postgres の接続文字列）');
  }
  _sql = neon(process.env.DATABASE_URL);
  return _sql;
}

// `?` → `$1, $2, ...`（SQLite 記法を Postgres 記法へ）
function toPg(text) {
  let i = 0;
  return text.replace(/\?/g, () => `$${++i}`);
}

// 小文字カラム名 → camelCase の復元表。
// nutrients の camelCase キー（vitaminC 等）＋ 各テーブルの camelCase カラム/別名を網羅。
const CAMEL_NAMES = [
  ...NUTRIENT_KEYS,
  'dataSource', 'isEstimated', 'createdAt', 'updatedAt',
  'mealType', 'foodId', 'foodName', 'isUnregistered',
  'targetCalories', 'targetProtein', 'targetFiber', 'saltLimit', 'weightGoal', 'bodyFatGoal',
  'bodyFat', 'visceralFat', 'burnedCalories',
  'supplementId', 'supplementName',
  'totalGrams', 'lastDate',
];
const CAMEL_MAP = {};
for (const k of CAMEL_NAMES) CAMEL_MAP[k.toLowerCase()] = k;

function remap(row) {
  if (!row || typeof row !== 'object') return row;
  const out = {};
  for (const key of Object.keys(row)) out[CAMEL_MAP[key] ?? key] = row[key];
  return out;
}

// SQLite 風の同期 API（db.prepare(sql).get/all/run）を非同期で再現。
export function prepare(text) {
  const q = toPg(text);
  return {
    async get(...params) {
      const rows = await getSql()(q, params);
      return remap(rows[0]);
    },
    async all(...params) {
      const rows = await getSql()(q, params);
      return rows.map(remap);
    },
    async run(...params) {
      const rows = await getSql()(q, params);
      // INSERT ... RETURNING id なら rows[0].id、UPDATE/DELETE ... RETURNING id なら rows.length が件数。
      return { rows: rows.map(remap), changes: rows.length, lastInsertRowid: rows[0]?.id };
    },
  };
}

export async function exec(text) {
  await getSql()(text, []);
}

// テーブル作成 + 初期データ投入（冪等）。npm run setup / GET|POST /api/setup から呼ぶ。
export async function setup() {
  const nutrientCols = NUTRIENT_KEYS.map((k) => `${k} DOUBLE PRECISION`).join(',\n    ');

  const statements = [
    `CREATE TABLE IF NOT EXISTS foods (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      aliases TEXT,
      category TEXT,
      ${nutrientCols},
      dataSource TEXT,
      note TEXT,
      isEstimated INTEGER NOT NULL DEFAULT 0,
      createdAt TEXT NOT NULL,
      updatedAt TEXT NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS meals (
      id SERIAL PRIMARY KEY,
      date TEXT NOT NULL,
      time TEXT,
      mealType TEXT NOT NULL,
      foodId INTEGER,
      foodName TEXT NOT NULL,
      grams DOUBLE PRECISION NOT NULL,
      memo TEXT,
      isUnregistered INTEGER NOT NULL DEFAULT 0,
      createdAt TEXT NOT NULL,
      updatedAt TEXT NOT NULL,
      FOREIGN KEY (foodId) REFERENCES foods(id) ON DELETE SET NULL
    )`,
    `CREATE INDEX IF NOT EXISTS idx_meals_date ON meals(date)`,
    `CREATE TABLE IF NOT EXISTS goals (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      targetCalories DOUBLE PRECISION,
      targetProtein DOUBLE PRECISION,
      targetFiber DOUBLE PRECISION,
      saltLimit DOUBLE PRECISION,
      weightGoal DOUBLE PRECISION,
      bodyFatGoal DOUBLE PRECISION,
      updatedAt TEXT
    )`,
    `CREATE TABLE IF NOT EXISTS body_records (
      id SERIAL PRIMARY KEY,
      date TEXT NOT NULL UNIQUE,
      weight DOUBLE PRECISION,
      bodyFat DOUBLE PRECISION,
      visceralFat DOUBLE PRECISION,
      memo TEXT,
      createdAt TEXT NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS daily_energy (
      date TEXT PRIMARY KEY,
      burnedCalories DOUBLE PRECISION,
      updatedAt TEXT
    )`,
    `CREATE TABLE IF NOT EXISTS supplements (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      aliases TEXT,
      brand TEXT,
      ${nutrientCols},
      dataSource TEXT,
      note TEXT,
      isEstimated INTEGER NOT NULL DEFAULT 0,
      createdAt TEXT NOT NULL,
      updatedAt TEXT NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS supplement_logs (
      id SERIAL PRIMARY KEY,
      date TEXT NOT NULL,
      time TEXT,
      supplementId INTEGER,
      supplementName TEXT NOT NULL,
      units DOUBLE PRECISION NOT NULL,
      memo TEXT,
      createdAt TEXT NOT NULL,
      updatedAt TEXT NOT NULL,
      FOREIGN KEY (supplementId) REFERENCES supplements(id) ON DELETE SET NULL
    )`,
    `CREATE INDEX IF NOT EXISTS idx_supplement_logs_date ON supplement_logs(date)`,
  ];
  for (const s of statements) await exec(s);

  // goals は必ず1行存在させる
  const goalCount = await prepare('SELECT COUNT(*)::int AS c FROM goals').get();
  if (Number(goalCount.c) === 0) {
    await prepare(`INSERT INTO goals (id, targetCalories, targetProtein, targetFiber, saltLimit, weightGoal, bodyFatGoal, updatedAt)
                   VALUES (1, 2000, 60, 20, 7.5, NULL, NULL, ?)`).run(new Date().toISOString());
  }

  // 食材マスタが空のときだけ seed
  const foodCount = await prepare('SELECT COUNT(*)::int AS c FROM foods').get();
  let seededFoods = 0;
  if (Number(foodCount.c) === 0) {
    const cols = ['name', 'aliases', 'category', ...NUTRIENT_KEYS, 'dataSource', 'note', 'isEstimated', 'createdAt', 'updatedAt'];
    const placeholders = cols.map(() => '?').join(', ');
    const stmt = prepare(`INSERT INTO foods (${cols.join(', ')}) VALUES (${placeholders})`);
    const now = new Date().toISOString();
    for (const f of SEED_FOODS) {
      const values = cols.map((c) => {
        if (c === 'createdAt' || c === 'updatedAt') return now;
        if (c === 'isEstimated') return f.isEstimated ? 1 : 0;
        const v = f[c];
        return v === undefined ? null : v;
      });
      await stmt.run(...values);
    }
    seededFoods = SEED_FOODS.length;
  }

  return { ok: true, seededFoods };
}

export default { prepare, exec, setup };
