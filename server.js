import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, normalize, extname } from 'node:path';
import db from './src/db.js';
import { NUTRIENTS, NUTRIENT_KEYS, MEAL_TYPES, CATEGORIES } from './src/nutrients.js';
import {
  daily, series, foodFrequency, frequentFoods, isoDate, addDays,
} from './src/nutrition.js';
import { estimateFood } from './src/llm.js';
import { buildExport, applyImport } from './src/dataio.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PUBLIC = join(__dirname, 'public');
const PORT = process.env.PORT || 3000;

// ---------- helpers ----------
function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(body);
}
function sendError(res, status, message) {
  sendJson(res, status, { error: message });
}
async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new Error('不正なJSONです');
  }
}
async function readRawBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  return Buffer.concat(chunks);
}
const now = () => new Date().toISOString();

// 食材名から食材マスタを解決（正式名 → 別名）
function resolveFood(name) {
  if (!name) return null;
  const exact = db.prepare('SELECT * FROM foods WHERE name = ?').get(name);
  if (exact) return exact;
  // 別名（カンマ区切り）に含まれるものを探す
  const rows = db.prepare('SELECT * FROM foods WHERE aliases LIKE ?').all(`%${name}%`);
  for (const r of rows) {
    const aliases = (r.aliases || '').split(',').map((s) => s.trim());
    if (aliases.includes(name)) return r;
  }
  return null;
}

function foodValues(body) {
  const vals = {};
  for (const k of NUTRIENT_KEYS) {
    const v = body[k];
    vals[k] = (v === '' || v === undefined || v === null) ? null : Number(v);
    if (vals[k] !== null && !isFinite(vals[k])) vals[k] = null;
  }
  return vals;
}

// ---------- content types ----------
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

async function serveStatic(req, res, pathname) {
  let rel = pathname === '/' ? '/index.html' : pathname;
  const filePath = normalize(join(PUBLIC, rel));
  if (!filePath.startsWith(PUBLIC)) return sendError(res, 403, 'forbidden');
  try {
    const data = await readFile(filePath);
    res.writeHead(200, { 'Content-Type': MIME[extname(filePath)] || 'application/octet-stream' });
    res.end(data);
  } catch {
    // SPA フォールバック
    try {
      const data = await readFile(join(PUBLIC, 'index.html'));
      res.writeHead(200, { 'Content-Type': MIME['.html'] });
      res.end(data);
    } catch {
      sendError(res, 404, 'not found');
    }
  }
}

// ---------- API ----------
async function handleApi(req, res, url) {
  const p = url.pathname;
  const q = url.searchParams;
  const method = req.method;

  // メタ情報
  if (p === '/api/meta' && method === 'GET') {
    return sendJson(res, 200, { nutrients: NUTRIENTS, mealTypes: MEAL_TYPES, categories: CATEGORIES, today: isoDate(new Date()) });
  }

  // --- foods ---
  if (p === '/api/foods' && method === 'GET') {
    const search = q.get('search');
    let rows;
    if (search) {
      rows = db.prepare('SELECT * FROM foods WHERE name LIKE ? OR aliases LIKE ? ORDER BY name LIMIT 30')
        .all(`%${search}%`, `%${search}%`);
    } else {
      rows = db.prepare('SELECT * FROM foods ORDER BY category, name').all();
    }
    return sendJson(res, 200, rows.map((r) => ({ ...r, isEstimated: !!r.isEstimated })));
  }

  if (p === '/api/foods/frequency' && method === 'GET') {
    const end = q.get('end') || isoDate(new Date());
    const start = q.get('start') || addDays(end, -29);
    return sendJson(res, 200, foodFrequency(start, end, Number(q.get('limit')) || 20));
  }

  if (p === '/api/foods/frequent' && method === 'GET') {
    return sendJson(res, 200, frequentFoods(Number(q.get('limit')) || 12));
  }

  if (p === '/api/foods/estimate' && method === 'POST') {
    const body = await readBody(req);
    if (!body.name) return sendError(res, 400, 'name は必須です');
    try {
      const result = await estimateFood(body.name, body.hint || '');
      return sendJson(res, 200, result);
    } catch (e) {
      return sendError(res, 502, `推定に失敗しました: ${e.message}`);
    }
  }

  if (p === '/api/foods' && method === 'POST') {
    const body = await readBody(req);
    if (!body.name) return sendError(res, 400, 'name は必須です');
    const vals = foodValues(body);
    const cols = ['name', 'aliases', 'category', ...NUTRIENT_KEYS, 'dataSource', 'note', 'isEstimated', 'createdAt', 'updatedAt'];
    const params = [
      body.name, body.aliases || '', body.category || '',
      ...NUTRIENT_KEYS.map((k) => vals[k]),
      body.dataSource || '', body.note || '', body.isEstimated ? 1 : 0, now(), now(),
    ];
    const info = db.prepare(`INSERT INTO foods (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`).run(...params);
    const newId = info.lastInsertRowid;
    // 同名の未登録食事を新しい食材にひも付け直す
    const relinked = db.prepare('UPDATE meals SET foodId = ?, isUnregistered = 0, updatedAt = ? WHERE foodName = ? AND isUnregistered = 1')
      .run(newId, now(), body.name);
    const row = db.prepare('SELECT * FROM foods WHERE id = ?').get(newId);
    return sendJson(res, 201, { ...row, isEstimated: !!row.isEstimated, relinked: relinked.changes });
  }

  let m;
  if ((m = p.match(/^\/api\/foods\/(\d+)$/))) {
    const id = Number(m[1]);
    const existing = db.prepare('SELECT * FROM foods WHERE id = ?').get(id);
    if (!existing) return sendError(res, 404, '食材が見つかりません');

    if (method === 'PUT') {
      const body = await readBody(req);
      const vals = foodValues(body);
      const sets = ['name = ?', 'aliases = ?', 'category = ?',
        ...NUTRIENT_KEYS.map((k) => `${k} = ?`),
        'dataSource = ?', 'note = ?', 'isEstimated = ?', 'updatedAt = ?'];
      const params = [
        body.name ?? existing.name, body.aliases ?? existing.aliases, body.category ?? existing.category,
        ...NUTRIENT_KEYS.map((k) => (k in body ? vals[k] : existing[k])),
        body.dataSource ?? existing.dataSource, body.note ?? existing.note,
        body.isEstimated ? 1 : 0, now(), id,
      ];
      db.prepare(`UPDATE foods SET ${sets.join(', ')} WHERE id = ?`).run(...params);
      const row = db.prepare('SELECT * FROM foods WHERE id = ?').get(id);
      return sendJson(res, 200, { ...row, isEstimated: !!row.isEstimated });
    }
    if (method === 'DELETE') {
      db.prepare('DELETE FROM foods WHERE id = ?').run(id);
      return sendJson(res, 200, { ok: true });
    }
  }

  // --- supplements（サプリマスタ：食材マスタと同構成だが別管理。栄養値は1個あたり）---
  if (p === '/api/supplements' && method === 'GET') {
    const search = q.get('search');
    let rows;
    if (search) {
      rows = db.prepare('SELECT * FROM supplements WHERE name LIKE ? OR aliases LIKE ? OR brand LIKE ? ORDER BY name LIMIT 30')
        .all(`%${search}%`, `%${search}%`, `%${search}%`);
    } else {
      rows = db.prepare('SELECT * FROM supplements ORDER BY name').all();
    }
    return sendJson(res, 200, rows.map((r) => ({ ...r, isEstimated: !!r.isEstimated })));
  }

  if (p === '/api/supplements' && method === 'POST') {
    const body = await readBody(req);
    if (!body.name) return sendError(res, 400, 'name は必須です');
    const vals = foodValues(body);
    const cols = ['name', 'aliases', 'brand', ...NUTRIENT_KEYS, 'dataSource', 'note', 'isEstimated', 'createdAt', 'updatedAt'];
    const params = [
      body.name, body.aliases || '', body.brand || '',
      ...NUTRIENT_KEYS.map((k) => vals[k]),
      body.dataSource || '', body.note || '', body.isEstimated ? 1 : 0, now(), now(),
    ];
    const info = db.prepare(`INSERT INTO supplements (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`).run(...params);
    const row = db.prepare('SELECT * FROM supplements WHERE id = ?').get(info.lastInsertRowid);
    return sendJson(res, 201, { ...row, isEstimated: !!row.isEstimated });
  }

  if ((m = p.match(/^\/api\/supplements\/(\d+)$/))) {
    const id = Number(m[1]);
    const existing = db.prepare('SELECT * FROM supplements WHERE id = ?').get(id);
    if (!existing) return sendError(res, 404, 'サプリが見つかりません');

    if (method === 'PUT') {
      const body = await readBody(req);
      const vals = foodValues(body);
      const sets = ['name = ?', 'aliases = ?', 'brand = ?',
        ...NUTRIENT_KEYS.map((k) => `${k} = ?`),
        'dataSource = ?', 'note = ?', 'isEstimated = ?', 'updatedAt = ?'];
      const params = [
        body.name ?? existing.name, body.aliases ?? existing.aliases, body.brand ?? existing.brand,
        ...NUTRIENT_KEYS.map((k) => (k in body ? vals[k] : existing[k])),
        body.dataSource ?? existing.dataSource, body.note ?? existing.note,
        body.isEstimated ? 1 : 0, now(), id,
      ];
      db.prepare(`UPDATE supplements SET ${sets.join(', ')} WHERE id = ?`).run(...params);
      const row = db.prepare('SELECT * FROM supplements WHERE id = ?').get(id);
      return sendJson(res, 200, { ...row, isEstimated: !!row.isEstimated });
    }
    if (method === 'DELETE') {
      db.prepare('DELETE FROM supplements WHERE id = ?').run(id);
      return sendJson(res, 200, { ok: true });
    }
  }

  // --- supplement logs（サプリ摂取記録：個数ベース）---
  if (p === '/api/supplement-logs' && method === 'GET') {
    const date = q.get('date');
    const start = q.get('start');
    const end = q.get('end');
    let rows;
    if (date) rows = db.prepare('SELECT * FROM supplement_logs WHERE date = ? ORDER BY time, id').all(date);
    else if (start && end) rows = db.prepare('SELECT * FROM supplement_logs WHERE date >= ? AND date <= ? ORDER BY date, time, id').all(start, end);
    else rows = db.prepare('SELECT * FROM supplement_logs ORDER BY date DESC, time DESC, id DESC LIMIT 200').all();
    return sendJson(res, 200, rows);
  }

  if (p === '/api/supplement-logs' && method === 'POST') {
    const body = await readBody(req);
    if (!body.date || body.units === undefined || body.units === '') {
      return sendError(res, 400, 'date と units は必須です');
    }
    let suppId = body.supplementId ? Number(body.supplementId) : null;
    let supp = suppId ? db.prepare('SELECT * FROM supplements WHERE id = ?').get(suppId) : null;
    if (!supp && body.supplementName) {
      supp = db.prepare('SELECT * FROM supplements WHERE name = ?').get(body.supplementName);
      suppId = supp ? supp.id : null;
    }
    if (!supp) return sendError(res, 400, 'サプリが見つかりません（先にサプリマスタへ登録してください）');
    const info = db.prepare(`INSERT INTO supplement_logs (date, time, supplementId, supplementName, units, memo, createdAt, updatedAt)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
      body.date, body.time || '', suppId, supp.name, Number(body.units), body.memo || '', now(), now(),
    );
    const row = db.prepare('SELECT * FROM supplement_logs WHERE id = ?').get(info.lastInsertRowid);
    return sendJson(res, 201, row);
  }

  if ((m = p.match(/^\/api\/supplement-logs\/(\d+)$/)) && method === 'DELETE') {
    db.prepare('DELETE FROM supplement_logs WHERE id = ?').run(Number(m[1]));
    return sendJson(res, 200, { ok: true });
  }

  // --- meals ---
  if (p === '/api/meals' && method === 'GET') {
    const date = q.get('date');
    const start = q.get('start');
    const end = q.get('end');
    let rows;
    if (date) rows = db.prepare('SELECT * FROM meals WHERE date = ? ORDER BY time, id').all(date);
    else if (start && end) rows = db.prepare('SELECT * FROM meals WHERE date >= ? AND date <= ? ORDER BY date, time, id').all(start, end);
    else rows = db.prepare('SELECT * FROM meals ORDER BY date DESC, time DESC, id DESC LIMIT 200').all();
    return sendJson(res, 200, rows.map((r) => ({ ...r, isUnregistered: !!r.isUnregistered })));
  }

  if (p === '/api/meals' && method === 'POST') {
    const body = await readBody(req);
    if (!body.foodName || !body.date || body.grams === undefined || body.grams === '') {
      return sendError(res, 400, 'date, foodName, grams は必須です');
    }
    let foodId = body.foodId ? Number(body.foodId) : null;
    let food = foodId ? db.prepare('SELECT * FROM foods WHERE id = ?').get(foodId) : null;
    if (!food) {
      food = resolveFood(body.foodName);
      foodId = food ? food.id : null;
    }
    const isUnregistered = food ? 0 : 1;
    const info = db.prepare(`INSERT INTO meals (date, time, mealType, foodId, foodName, grams, memo, isUnregistered, createdAt, updatedAt)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      body.date, body.time || '', body.mealType || 'その他', foodId, body.foodName,
      Number(body.grams), body.memo || '', isUnregistered, now(), now(),
    );
    const row = db.prepare('SELECT * FROM meals WHERE id = ?').get(info.lastInsertRowid);
    return sendJson(res, 201, { ...row, isUnregistered: !!row.isUnregistered, unregistered: !!isUnregistered });
  }

  // 前日と同じ食事をコピー: { from: 'YYYY-MM-DD', to: 'YYYY-MM-DD' }
  if (p === '/api/meals/copy' && method === 'POST') {
    const body = await readBody(req);
    if (!body.from || !body.to) return sendError(res, 400, 'from と to は必須です');
    const src = db.prepare('SELECT * FROM meals WHERE date = ? ORDER BY time, id').all(body.from);
    const stmt = db.prepare(`INSERT INTO meals (date, time, mealType, foodId, foodName, grams, memo, isUnregistered, createdAt, updatedAt)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    let count = 0;
    for (const s of src) {
      stmt.run(body.to, s.time, s.mealType, s.foodId, s.foodName, s.grams, s.memo, s.isUnregistered, now(), now());
      count++;
    }
    return sendJson(res, 201, { copied: count });
  }

  if ((m = p.match(/^\/api\/meals\/(\d+)$/))) {
    const id = Number(m[1]);
    const existing = db.prepare('SELECT * FROM meals WHERE id = ?').get(id);
    if (!existing) return sendError(res, 404, '食事記録が見つかりません');

    if (method === 'PUT') {
      const body = await readBody(req);
      let foodId = ('foodId' in body) ? (body.foodId ? Number(body.foodId) : null) : existing.foodId;
      const foodName = body.foodName ?? existing.foodName;
      let food = foodId ? db.prepare('SELECT * FROM foods WHERE id = ?').get(foodId) : null;
      if (!food && ('foodName' in body || 'foodId' in body)) {
        food = resolveFood(foodName);
        foodId = food ? food.id : null;
      }
      db.prepare(`UPDATE meals SET date=?, time=?, mealType=?, foodId=?, foodName=?, grams=?, memo=?, isUnregistered=?, updatedAt=? WHERE id=?`).run(
        body.date ?? existing.date, body.time ?? existing.time, body.mealType ?? existing.mealType,
        foodId, foodName, body.grams !== undefined ? Number(body.grams) : existing.grams,
        body.memo ?? existing.memo, food ? 0 : (foodId ? 0 : 1), now(), id,
      );
      const row = db.prepare('SELECT * FROM meals WHERE id = ?').get(id);
      return sendJson(res, 200, { ...row, isUnregistered: !!row.isUnregistered });
    }
    if (method === 'DELETE') {
      db.prepare('DELETE FROM meals WHERE id = ?').run(id);
      return sendJson(res, 200, { ok: true });
    }
  }

  // 未登録食材一覧（食材マスタに無い meal の食材名）
  if (p === '/api/meals/unregistered' && method === 'GET') {
    const rows = db.prepare(`SELECT foodName, COUNT(*) AS count, MAX(date) AS lastDate
      FROM meals WHERE isUnregistered = 1 GROUP BY foodName ORDER BY count DESC`).all();
    return sendJson(res, 200, rows);
  }

  // --- nutrition ---
  if (p === '/api/nutrition/daily' && method === 'GET') {
    const date = q.get('date') || isoDate(new Date());
    return sendJson(res, 200, daily(date));
  }
  if (p === '/api/nutrition/weekly' && method === 'GET') {
    const start = q.get('start') || addDays(isoDate(new Date()), -6);
    return sendJson(res, 200, series(start, addDays(start, 6)));
  }
  if (p === '/api/nutrition/monthly' && method === 'GET') {
    const month = q.get('month') || isoDate(new Date()).slice(0, 7); // YYYY-MM
    const start = `${month}-01`;
    const [y, mo] = month.split('-').map(Number);
    const end = isoDate(new Date(y, mo, 0)); // 月末
    return sendJson(res, 200, series(start, end));
  }

  // --- dashboard ---
  if (p === '/api/dashboard' && method === 'GET') {
    const date = q.get('date') || isoDate(new Date());
    const today = daily(date);
    const week = series(addDays(date, -6), date);
    const month = series(addDays(date, -29), date);
    const goals = db.prepare('SELECT * FROM goals WHERE id = 1').get();
    const freq = foodFrequency(addDays(date, -29), date, 10);
    const energy = db.prepare('SELECT * FROM daily_energy WHERE date = ?').get(date) || null;
    const latestBody = db.prepare('SELECT * FROM body_records ORDER BY date DESC LIMIT 1').get() || null;
    return sendJson(res, 200, { date, today, week, month, goals, foodFrequency: freq, energy, latestBody });
  }

  // --- goals ---
  if (p === '/api/goals' && method === 'GET') {
    return sendJson(res, 200, db.prepare('SELECT * FROM goals WHERE id = 1').get());
  }
  if (p === '/api/goals' && method === 'PUT') {
    const body = await readBody(req);
    const num = (v) => (v === '' || v === undefined || v === null ? null : Number(v));
    db.prepare(`UPDATE goals SET targetCalories=?, targetProtein=?, targetFiber=?, saltLimit=?, weightGoal=?, bodyFatGoal=?, updatedAt=? WHERE id=1`).run(
      num(body.targetCalories), num(body.targetProtein), num(body.targetFiber),
      num(body.saltLimit), num(body.weightGoal), num(body.bodyFatGoal), now(),
    );
    return sendJson(res, 200, db.prepare('SELECT * FROM goals WHERE id = 1').get());
  }

  // --- body records（体重・体脂肪率・内臓脂肪。日付ごとに1セット、翌朝登録想定） ---
  if (p === '/api/body' && method === 'GET') {
    const date = q.get('date');
    if (date) return sendJson(res, 200, db.prepare('SELECT * FROM body_records WHERE date = ?').get(date) || null);
    return sendJson(res, 200, db.prepare('SELECT * FROM body_records ORDER BY date DESC LIMIT 200').all());
  }
  if (p === '/api/body' && (method === 'POST' || method === 'PUT')) {
    const body = await readBody(req);
    if (!body.date) return sendError(res, 400, 'date は必須です');
    const num = (v) => (v === '' || v === undefined || v === null ? null : Number(v));
    const existing = db.prepare('SELECT * FROM body_records WHERE date = ?').get(body.date);
    if (existing) {
      db.prepare('UPDATE body_records SET weight=?, bodyFat=?, visceralFat=?, memo=? WHERE date=?')
        .run(num(body.weight), num(body.bodyFat), num(body.visceralFat), body.memo || '', body.date);
    } else {
      db.prepare('INSERT INTO body_records (date, weight, bodyFat, visceralFat, memo, createdAt) VALUES (?, ?, ?, ?, ?, ?)')
        .run(body.date, num(body.weight), num(body.bodyFat), num(body.visceralFat), body.memo || '', now());
    }
    return sendJson(res, existing ? 200 : 201, db.prepare('SELECT * FROM body_records WHERE date = ?').get(body.date));
  }
  if ((m = p.match(/^\/api\/body\/(\d+)$/)) && method === 'DELETE') {
    db.prepare('DELETE FROM body_records WHERE id = ?').run(Number(m[1]));
    return sendJson(res, 200, { ok: true });
  }

  // --- daily energy（当日の消費カロリー。日付ごとに1値、手入力） ---
  if (p === '/api/energy' && method === 'GET') {
    const date = q.get('date');
    if (date) return sendJson(res, 200, db.prepare('SELECT * FROM daily_energy WHERE date = ?').get(date) || null);
    return sendJson(res, 200, db.prepare('SELECT * FROM daily_energy ORDER BY date DESC LIMIT 200').all());
  }
  if (p === '/api/energy' && (method === 'POST' || method === 'PUT')) {
    const body = await readBody(req);
    if (!body.date) return sendError(res, 400, 'date は必須です');
    const val = (body.burnedCalories === '' || body.burnedCalories === undefined || body.burnedCalories === null) ? null : Number(body.burnedCalories);
    db.prepare(`INSERT INTO daily_energy (date, burnedCalories, updatedAt) VALUES (?, ?, ?)
      ON CONFLICT(date) DO UPDATE SET burnedCalories = excluded.burnedCalories, updatedAt = excluded.updatedAt`)
      .run(body.date, val, now());
    return sendJson(res, 200, db.prepare('SELECT * FROM daily_energy WHERE date = ?').get(body.date));
  }
  if ((m = p.match(/^\/api\/energy\/(\d{4}-\d{2}-\d{2})$/)) && method === 'DELETE') {
    db.prepare('DELETE FROM daily_energy WHERE date = ?').run(m[1]);
    return sendJson(res, 200, { ok: true });
  }

  // --- export / import ---
  if (p === '/api/export' && method === 'GET') {
    const scope = ['masters', 'records', 'all'].includes(q.get('scope')) ? q.get('scope') : 'all';
    const start = q.get('start') || '';
    const end = q.get('end') || '';
    const { buffer, manifest } = buildExport(start, end, scope);
    let label;
    if (scope === 'masters') {
      label = 'masters';
    } else {
      const r = manifest.range || {};
      const range = `${(r.start || 'all').replace(/-/g, '')}_${(r.end || 'all').replace(/-/g, '')}`;
      label = scope === 'records' ? `records_${range}` : range;
    }
    res.writeHead(200, {
      'Content-Type': 'application/zip',
      'Content-Disposition': `attachment; filename="app-diet_${label}.zip"`,
      'Content-Length': buffer.length,
    });
    return res.end(buffer);
  }
  if (p === '/api/import' && method === 'POST') {
    const buf = await readRawBody(req);
    if (!buf.length) return sendError(res, 400, 'ZIPファイルが空です');
    try {
      const result = applyImport(buf, { mode: q.get('mode'), importGoals: q.get('goals') === '1' });
      return sendJson(res, 200, result);
    } catch (e) {
      return sendError(res, 400, `インポートに失敗しました: ${e.message}`);
    }
  }

  return sendError(res, 404, 'APIが見つかりません');
}

// ---------- server ----------
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  try {
    if (url.pathname.startsWith('/api/')) {
      await handleApi(req, res, url);
    } else {
      await serveStatic(req, res, url.pathname);
    }
  } catch (e) {
    console.error(e);
    if (!res.headersSent) sendError(res, 500, e.message || 'サーバーエラー');
  }
});

server.listen(PORT, () => {
  console.log(`\n  栄養管理アプリ起動: http://localhost:${PORT}\n`);
});
