import http from 'node:http';
import { createHash, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, normalize, extname } from 'node:path';
import db, { setup, perf } from './src/db.js'; // PERF TEST: perf を取り込む
import { NUTRIENTS, NUTRIENT_KEYS } from './src/nutrients.js';
import {
  daily, series, foodFrequency, frequentFoods, isoDate, addDays,
  loadFoodsMap, loadSupplementsMap, getMealsInRange, getSupplementLogsInRange,
  invalidateFoods, invalidateSupplements,
} from './src/nutrition.js';
import { estimateFood } from './src/llm.js';
import { buildExport, applyImport } from './src/dataio.js';
import { parseFoodsText } from './src/parse.js';
// 判定ロジックはブラウザと共用（public/ 配下に置いてあるのはブラウザから import させるため）。
import { nutrientJudge } from './public/shared/judge.js';

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
// JSON ボディの取得。Vercel Functions は req.body に解析済みの値を載せる場合があるため両対応。
async function readBody(req) {
  if (req.body !== undefined && req.body !== null) {
    if (typeof req.body === 'object' && !Buffer.isBuffer(req.body)) return req.body;
    const s = Buffer.isBuffer(req.body) ? req.body.toString('utf8') : String(req.body);
    if (!s) return {};
    try { return JSON.parse(s); } catch { throw new Error('不正なJSONです'); }
  }
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
  if (req.body !== undefined && req.body !== null) {
    if (Buffer.isBuffer(req.body)) return req.body;
    if (typeof req.body === 'string') return Buffer.from(req.body, 'binary');
  }
  const chunks = [];
  for await (const c of req) chunks.push(c);
  return Buffer.concat(chunks);
}
const now = () => new Date().toISOString();

// ---------- 認証 ----------
// 環境変数 API_TOKEN が設定されているときだけ /api/* にトークンを要求する。
// 未設定なら従来どおり素通し（ローカル開発をそのまま動かすため）。
// トークンは x-api-token ヘッダ、または ?token=（<img>/ダウンロード遷移などヘッダを
// 付けられない経路のため）で渡す。
function tokenOk(req, url) {
  const expected = process.env.API_TOKEN;
  if (!expected) return true; // 認証無効
  const got = req.headers['x-api-token'] || url.searchParams.get('token') || '';
  return timingSafeEqualStr(String(got), expected);
}
// 文字列比較のタイミング差から桁を推測されないよう、長さに依存しない比較にする。
function timingSafeEqualStr(a, b) {
  const ab = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  // 長さが違うと timingSafeEqual が例外を投げるので、固定長のハッシュに揃えてから比較する。
  const ah = createHash('sha256').update(ab).digest();
  const bh = createHash('sha256').update(bb).digest();
  return timingSafeEqual(ah, bh);
}

// 食材名から食材マスタを解決（正式名 → 別名）
async function resolveFood(name) {
  if (!name) return null;
  const exact = await db.prepare('SELECT * FROM foods WHERE name = ?').get(name);
  if (exact) return exact;
  // 別名（カンマ区切り）に含まれるものを探す
  const rows = await db.prepare('SELECT * FROM foods WHERE aliases LIKE ?').all(`%${name}%`);
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
export async function handleApi(req, res, url) {
  const p = url.pathname;
  const q = url.searchParams;
  const method = req.method;

  // API_TOKEN 設定時は全 /api/* にトークンを要求する（/api/setup も含む）。
  if (!tokenOk(req, url)) return sendError(res, 401, 'アクセストークンが必要です');

  // メタ情報
  if (p === '/api/meta' && method === 'GET') {
    return sendJson(res, 200, { nutrients: NUTRIENTS, today: isoDate(new Date()) });
  }

  // PERF TEST: DB単体のレイテンシ計測用の一時エンドポイント。
  // neon() は 1クエリ=1 HTTP往復なので、query1Ms/query2Ms がほぼ純粋な往復時間になる。
  // 計測が終わったら（切り分け完了後）このブロックごと削除してよい。
  if (p === '/api/db-speed' && method === 'GET') {
    const r1 = (n) => Math.round(n * 10) / 10;
    const t0 = performance.now();
    const nowRow = await db.prepare('SELECT NOW() AS now').get();      // 1往復目
    const t1 = performance.now();
    const dbRow = await db.prepare('SELECT current_database() AS db').get(); // 2往復目
    const t2 = performance.now();
    return sendJson(res, 200, {
      dbMs: r1(t2 - t0),          // 2クエリ合計のDB時間
      query1Ms: r1(t1 - t0),      // SELECT NOW()           の1往復
      query2Ms: r1(t2 - t1),      // SELECT current_database() の1往復
      totalMs: r1(performance.now() - t0),
      vercelRegion: process.env.VERCEL_REGION || null, // Vercel関数のリージョン
      now: nowRow.now,
      database: dbRow.db,
      timestamp: new Date().toISOString(),
    });
  }

  // 初回セットアップ（テーブル作成 + seed。冪等）
  if (p === '/api/setup' && (method === 'POST' || method === 'GET')) {
    const result = await setup();
    return sendJson(res, 200, result);
  }

  // --- foods ---
  if (p === '/api/foods' && method === 'GET') {
    const search = q.get('search');
    let rows;
    if (search) {
      rows = await db.prepare('SELECT * FROM foods WHERE name LIKE ? OR aliases LIKE ? ORDER BY name LIMIT 30')
        .all(`%${search}%`, `%${search}%`);
    } else {
      rows = await db.prepare('SELECT * FROM foods ORDER BY name').all();
    }
    return sendJson(res, 200, rows.map((r) => ({ ...r, isEstimated: !!r.isEstimated })));
  }

  if (p === '/api/foods/frequency' && method === 'GET') {
    const end = q.get('end') || isoDate(new Date());
    const start = q.get('start') || addDays(end, -29);
    return sendJson(res, 200, await foodFrequency(start, end, Number(q.get('limit')) || 20));
  }

  if (p === '/api/foods/frequent' && method === 'GET') {
    return sendJson(res, 200, await frequentFoods(Number(q.get('limit')) || 12));
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

  // 貼り付けテキストからの一括登録（AI生成データ等をコピペ一発で登録）
  if (p === '/api/foods/bulk' && method === 'POST') {
    const body = await readBody(req);
    // name 指定時: 未登録食材の行から「食材名を書かず栄養データだけ」貼り付けて
    // その名前で1食材として登録する動線（スマホで分量のみ記録→後でPCでマスタ更新）。
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    const parsed = parseFoodsText(body.text || '', name ? { defaultName: name } : {});
    if (!parsed.length) {
      return sendError(res, 400, name
        ? '栄養データを認識できませんでした（栄養素名と数値の行を貼り付けてください）'
        : '「食材名：○○」の形式で始まるデータを認識できませんでした');
    }
    const cols = ['name', 'aliases', ...NUTRIENT_KEYS, 'dataSource', 'note', 'isEstimated', 'createdAt', 'updatedAt'];
    const results = [];
    let added = 0, updated = 0, relinkedTotal = 0;
    for (const f of parsed) {
      const existing = await db.prepare('SELECT * FROM foods WHERE name = ?').get(f.name);
      if (existing) {
        const sets = [...NUTRIENT_KEYS.map((k) => `${k} = ?`), 'updatedAt = ?'];
        const params = [...NUTRIENT_KEYS.map((k) => f.values[k]), now(), existing.id];
        await db.prepare(`UPDATE foods SET ${sets.join(', ')} WHERE id = ?`).run(...params);
        updated++;
        results.push({ name: f.name, action: 'updated', matched: f.matched });
      } else {
        const params = [
          f.name, '',
          ...NUTRIENT_KEYS.map((k) => f.values[k]),
          '貼り付け登録', '', 0, now(), now(),
        ];
        const info = await db.prepare(`INSERT INTO foods (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')}) RETURNING id`).run(...params);
        // 同名の未登録食事を新しい食材にひも付け直す
        const relinked = await db.prepare('UPDATE meals SET foodId = ?, isUnregistered = 0, updatedAt = ? WHERE foodName = ? AND isUnregistered = 1 RETURNING id')
          .run(info.lastInsertRowid, now(), f.name);
        relinkedTotal += relinked.changes;
        added++;
        results.push({ name: f.name, action: 'added', matched: f.matched, relinked: relinked.changes });
      }
    }
    invalidateFoods(); // マスタ更新: キャッシュ破棄
    return sendJson(res, 201, { added, updated, relinked: relinkedTotal, results });
  }

  if (p === '/api/foods' && method === 'POST') {
    const body = await readBody(req);
    if (!body.name) return sendError(res, 400, 'name は必須です');
    const vals = foodValues(body);
    const cols = ['name', 'aliases', ...NUTRIENT_KEYS, 'dataSource', 'note', 'isEstimated', 'createdAt', 'updatedAt'];
    const params = [
      body.name, body.aliases || '',
      ...NUTRIENT_KEYS.map((k) => vals[k]),
      body.dataSource || '', body.note || '', body.isEstimated ? 1 : 0, now(), now(),
    ];
    const info = await db.prepare(`INSERT INTO foods (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')}) RETURNING id`).run(...params);
    const newId = info.lastInsertRowid;
    // 同名の未登録食事を新しい食材にひも付け直す
    const relinked = await db.prepare('UPDATE meals SET foodId = ?, isUnregistered = 0, updatedAt = ? WHERE foodName = ? AND isUnregistered = 1 RETURNING id')
      .run(newId, now(), body.name);
    invalidateFoods(); // マスタ更新: キャッシュ破棄
    const row = await db.prepare('SELECT * FROM foods WHERE id = ?').get(newId);
    return sendJson(res, 201, { ...row, isEstimated: !!row.isEstimated, relinked: relinked.changes });
  }

  let m;
  if ((m = p.match(/^\/api\/foods\/(\d+)$/))) {
    const id = Number(m[1]);
    const existing = await db.prepare('SELECT * FROM foods WHERE id = ?').get(id);
    if (!existing) return sendError(res, 404, '食材が見つかりません');

    if (method === 'PUT') {
      const body = await readBody(req);
      const vals = foodValues(body);
      const sets = ['name = ?', 'aliases = ?',
        ...NUTRIENT_KEYS.map((k) => `${k} = ?`),
        'dataSource = ?', 'note = ?', 'isEstimated = ?', 'updatedAt = ?'];
      const params = [
        body.name ?? existing.name, body.aliases ?? existing.aliases,
        ...NUTRIENT_KEYS.map((k) => (k in body ? vals[k] : existing[k])),
        body.dataSource ?? existing.dataSource, body.note ?? existing.note,
        body.isEstimated ? 1 : 0, now(), id,
      ];
      await db.prepare(`UPDATE foods SET ${sets.join(', ')} WHERE id = ?`).run(...params);
      invalidateFoods(); // マスタ更新: キャッシュ破棄
      const row = await db.prepare('SELECT * FROM foods WHERE id = ?').get(id);
      return sendJson(res, 200, { ...row, isEstimated: !!row.isEstimated });
    }
    if (method === 'DELETE') {
      await db.prepare('DELETE FROM foods WHERE id = ?').run(id);
      invalidateFoods(); // マスタ更新: キャッシュ破棄
      return sendJson(res, 200, { ok: true });
    }
  }

  // --- supplements（サプリマスタ：食材マスタと同構成だが別管理。栄養値は1個あたり）---
  if (p === '/api/supplements' && method === 'GET') {
    const search = q.get('search');
    let rows;
    if (search) {
      rows = await db.prepare('SELECT * FROM supplements WHERE name LIKE ? OR aliases LIKE ? OR brand LIKE ? ORDER BY name LIMIT 30')
        .all(`%${search}%`, `%${search}%`, `%${search}%`);
    } else {
      rows = await db.prepare('SELECT * FROM supplements ORDER BY name').all();
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
    const info = await db.prepare(`INSERT INTO supplements (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')}) RETURNING id`).run(...params);
    invalidateSupplements(); // マスタ更新: キャッシュ破棄
    const row = await db.prepare('SELECT * FROM supplements WHERE id = ?').get(info.lastInsertRowid);
    return sendJson(res, 201, { ...row, isEstimated: !!row.isEstimated });
  }

  if ((m = p.match(/^\/api\/supplements\/(\d+)$/))) {
    const id = Number(m[1]);
    const existing = await db.prepare('SELECT * FROM supplements WHERE id = ?').get(id);
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
      await db.prepare(`UPDATE supplements SET ${sets.join(', ')} WHERE id = ?`).run(...params);
      invalidateSupplements(); // マスタ更新: キャッシュ破棄
      const row = await db.prepare('SELECT * FROM supplements WHERE id = ?').get(id);
      return sendJson(res, 200, { ...row, isEstimated: !!row.isEstimated });
    }
    if (method === 'DELETE') {
      await db.prepare('DELETE FROM supplements WHERE id = ?').run(id);
      invalidateSupplements(); // マスタ更新: キャッシュ破棄
      return sendJson(res, 200, { ok: true });
    }
  }

  // --- supplement logs（サプリ摂取記録：個数ベース）---
  if (p === '/api/supplement-logs' && method === 'GET') {
    const date = q.get('date');
    const start = q.get('start');
    const end = q.get('end');
    let rows;
    if (date) rows = await db.prepare('SELECT * FROM supplement_logs WHERE date = ? ORDER BY time, id').all(date);
    else if (start && end) rows = await db.prepare('SELECT * FROM supplement_logs WHERE date >= ? AND date <= ? ORDER BY date, time, id').all(start, end);
    else rows = await db.prepare('SELECT * FROM supplement_logs ORDER BY date DESC, time DESC, id DESC LIMIT 200').all();
    return sendJson(res, 200, rows);
  }

  if (p === '/api/supplement-logs' && method === 'POST') {
    const body = await readBody(req);
    if (!body.date || body.units === undefined || body.units === '') {
      return sendError(res, 400, 'date と units は必須です');
    }
    let suppId = body.supplementId ? Number(body.supplementId) : null;
    let supp = suppId ? await db.prepare('SELECT * FROM supplements WHERE id = ?').get(suppId) : null;
    if (!supp && body.supplementName) {
      supp = await db.prepare('SELECT * FROM supplements WHERE name = ?').get(body.supplementName);
      suppId = supp ? supp.id : null;
    }
    if (!supp) return sendError(res, 400, 'サプリが見つかりません（先にサプリマスタへ登録してください）');
    const info = await db.prepare(`INSERT INTO supplement_logs (date, time, supplementId, supplementName, units, memo, createdAt, updatedAt)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`).run(
      body.date, body.time || '', suppId, supp.name, Number(body.units), body.memo || '', now(), now(),
    );
    const row = await db.prepare('SELECT * FROM supplement_logs WHERE id = ?').get(info.lastInsertRowid);
    return sendJson(res, 201, row);
  }

  if ((m = p.match(/^\/api\/supplement-logs\/(\d+)$/))) {
    const id = Number(m[1]);
    const existing = await db.prepare('SELECT * FROM supplement_logs WHERE id = ?').get(id);
    if (!existing) return sendError(res, 404, 'サプリ記録が見つかりません');

    if (method === 'PUT') {
      const body = await readBody(req);
      let suppId = existing.supplementId;
      let name = existing.supplementName;
      // サプリを変更する場合のみマスタを引き直す。
      if ('supplementId' in body || 'supplementName' in body) {
        let supp = body.supplementId ? await db.prepare('SELECT * FROM supplements WHERE id = ?').get(Number(body.supplementId)) : null;
        if (!supp && body.supplementName) supp = await db.prepare('SELECT * FROM supplements WHERE name = ?').get(body.supplementName);
        if (!supp) return sendError(res, 400, 'サプリが見つかりません（先にサプリマスタへ登録してください）');
        suppId = supp.id; name = supp.name;
      }
      await db.prepare(`UPDATE supplement_logs SET date=?, time=?, supplementId=?, supplementName=?, units=?, memo=?, updatedAt=? WHERE id=?`).run(
        body.date ?? existing.date, body.time ?? existing.time, suppId, name,
        (body.units !== undefined && body.units !== '') ? Number(body.units) : existing.units,
        body.memo ?? existing.memo, now(), id,
      );
      const row = await db.prepare('SELECT * FROM supplement_logs WHERE id = ?').get(id);
      return sendJson(res, 200, row);
    }
    if (method === 'DELETE') {
      await db.prepare('DELETE FROM supplement_logs WHERE id = ?').run(id);
      return sendJson(res, 200, { ok: true });
    }
  }

  // --- meals ---
  // 一覧・集計では大きい photo 本体は返さず、有無だけ hasPhoto で返す（画像は専用エンドポイントで取得）。
  const MEAL_COLS = 'id, date, time, foodId, foodName, grams, memo, nutrients, isUnregistered, createdAt, updatedAt, (photo IS NOT NULL) AS hasPhoto';
  if (p === '/api/meals' && method === 'GET') {
    const date = q.get('date');
    const start = q.get('start');
    const end = q.get('end');
    let rows;
    if (date) rows = await db.prepare(`SELECT ${MEAL_COLS} FROM meals WHERE date = ? ORDER BY time, id`).all(date);
    else if (start && end) rows = await db.prepare(`SELECT ${MEAL_COLS} FROM meals WHERE date >= ? AND date <= ? ORDER BY date, time, id`).all(start, end);
    else rows = await db.prepare(`SELECT ${MEAL_COLS} FROM meals ORDER BY date DESC, time DESC, id DESC LIMIT 200`).all();
    return sendJson(res, 200, rows.map((r) => ({ ...r, isUnregistered: !!r.isUnregistered, hasPhoto: !!r.hasPhoto })));
  }

  if (p === '/api/meals' && method === 'POST') {
    const body = await readBody(req);
    const photo = (typeof body.photo === 'string' && body.photo.startsWith('data:')) ? body.photo : null;
    // 写真がある場合は食材名を任意にし、未入力なら「名称未設定」で登録する（あとで編集で命名）。
    const foodName = (body.foodName && String(body.foodName).trim()) || (photo ? '名称未設定' : '');
    if (!foodName || !body.date || body.grams === undefined || body.grams === '') {
      return sendError(res, 400, 'date と grams は必須です（写真がない場合は foodName も必須）');
    }
    let foodId = body.foodId ? Number(body.foodId) : null;
    let food = foodId ? await db.prepare('SELECT * FROM foods WHERE id = ?').get(foodId) : null;
    if (!food) {
      food = await resolveFood(foodName);
      foodId = food ? food.id : null;
    }
    const isUnregistered = food ? 0 : 1;
    const info = await db.prepare(`INSERT INTO meals (date, time, foodId, foodName, grams, memo, photo, isUnregistered, createdAt, updatedAt)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`).run(
      body.date, body.time || '', foodId, foodName,
      Number(body.grams), body.memo || '', photo, isUnregistered, now(), now(),
    );
    const row = await db.prepare(`SELECT ${MEAL_COLS} FROM meals WHERE id = ?`).get(info.lastInsertRowid);
    return sendJson(res, 201, { ...row, isUnregistered: !!row.isUnregistered, hasPhoto: !!row.hasPhoto, unregistered: !!isUnregistered });
  }

  // 方法3: 1食まるごと記録（マスタ不要）。栄養素は貼り付けテキストから解析し meals に直接保存、量=1。
  if (p === '/api/meals/entry' && method === 'POST') {
    const body = await readBody(req);
    const name = (body.foodName || '').trim();
    if (!name || !body.date) return sendError(res, 400, '食事名称と日付は必須です');
    const parsed = parseFoodsText(body.nutrientsText || '', { defaultName: name });
    const block = parsed[0];
    if (!block || block.matched === 0) {
      return sendError(res, 400, '栄養素データを認識できませんでした（カロリー・タンパク質などの栄養素名と数値の行を貼り付けてください）');
    }
    const nutrientsJson = JSON.stringify(block.values);
    const info = await db.prepare(`INSERT INTO meals (date, time, foodId, foodName, grams, memo, nutrients, isUnregistered, createdAt, updatedAt)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`).run(
      body.date, body.time || '', null, name, 1, body.memo || '', nutrientsJson, 0, now(), now(),
    );
    const row = await db.prepare(`SELECT ${MEAL_COLS} FROM meals WHERE id = ?`).get(info.lastInsertRowid);
    return sendJson(res, 201, { ...row, isUnregistered: !!row.isUnregistered, hasPhoto: !!row.hasPhoto, matched: block.matched });
  }

  // 前日と同じ食事をコピー: { from: 'YYYY-MM-DD', to: 'YYYY-MM-DD' }
  if (p === '/api/meals/copy' && method === 'POST') {
    const body = await readBody(req);
    if (!body.from || !body.to) return sendError(res, 400, 'from と to は必須です');
    const src = await db.prepare('SELECT * FROM meals WHERE date = ? ORDER BY time, id').all(body.from);
    const stmt = db.prepare(`INSERT INTO meals (date, time, foodId, foodName, grams, memo, photo, nutrients, isUnregistered, createdAt, updatedAt)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    let count = 0;
    for (const s of src) {
      await stmt.run(body.to, s.time, s.foodId, s.foodName, s.grams, s.memo, s.photo, s.nutrients, s.isUnregistered, now(), now());
      count++;
    }
    return sendJson(res, 201, { copied: count });
  }

  // 食事写真のバイナリ配信（<img src> 用。data URL をデコードして画像として返す）。
  if ((m = p.match(/^\/api\/meals\/(\d+)\/photo$/)) && method === 'GET') {
    const row = await db.prepare('SELECT photo FROM meals WHERE id = ?').get(Number(m[1]));
    const dataUrl = row && row.photo;
    const parsed = typeof dataUrl === 'string' ? /^data:([^;,]+)?(;base64)?,([\s\S]*)$/.exec(dataUrl) : null;
    if (!parsed) return sendError(res, 404, '写真がありません');
    const mime = parsed[1] || 'application/octet-stream';
    const buf = parsed[2] ? Buffer.from(parsed[3], 'base64') : Buffer.from(decodeURIComponent(parsed[3]), 'utf8');
    res.writeHead(200, { 'Content-Type': mime, 'Cache-Control': 'private, max-age=3600' });
    return res.end(buf);
  }

  if ((m = p.match(/^\/api\/meals\/(\d+)$/))) {
    const id = Number(m[1]);
    const existing = await db.prepare('SELECT * FROM meals WHERE id = ?').get(id);
    if (!existing) return sendError(res, 404, '食事記録が見つかりません');

    if (method === 'PUT') {
      const body = await readBody(req);
      const foodName = body.foodName ?? existing.foodName;

      // 方法3（自己完結レコード）の判定と栄養素の更新。nutrientsText を渡すと貼り付けから再解析して差し替え。
      const hadOwn = existing.nutrients != null && existing.nutrients !== '';
      const replacing = typeof body.nutrientsText === 'string' && body.nutrientsText.trim() !== '';
      let nutrients = existing.nutrients;
      if (replacing) {
        const parsed = parseFoodsText(body.nutrientsText, { defaultName: (foodName || '食事').trim() });
        if (!parsed[0] || parsed[0].matched === 0) return sendError(res, 400, '栄養素データを認識できませんでした');
        nutrients = JSON.stringify(parsed[0].values);
      }
      const selfContained = hadOwn || replacing;

      // 写真: removePhoto または photo:null で削除、data URL 文字列で差し替え、未指定なら据え置き。
      let photo = existing.photo;
      if (body.removePhoto || body.photo === null) photo = null;
      else if (typeof body.photo === 'string' && body.photo.startsWith('data:')) photo = body.photo;

      let foodId, isUnreg;
      if (selfContained) {
        // マスタに紐付けない自己完結レコード（方法3）。名前・メモ・栄養素・日時のみ編集対象。
        foodId = null; isUnreg = 0;
      } else {
        foodId = ('foodId' in body) ? (body.foodId ? Number(body.foodId) : null) : existing.foodId;
        let food = foodId ? await db.prepare('SELECT * FROM foods WHERE id = ?').get(foodId) : null;
        if (!food && ('foodName' in body || 'foodId' in body)) {
          food = await resolveFood(foodName);
          foodId = food ? food.id : null;
        }
        isUnreg = food ? 0 : (foodId ? 0 : 1);
      }
      await db.prepare(`UPDATE meals SET date=?, time=?, foodId=?, foodName=?, grams=?, memo=?, photo=?, nutrients=?, isUnregistered=?, updatedAt=? WHERE id=?`).run(
        body.date ?? existing.date, body.time ?? existing.time,
        foodId, foodName, body.grams !== undefined ? Number(body.grams) : existing.grams,
        body.memo ?? existing.memo, photo, nutrients, isUnreg, now(), id,
      );
      const row = await db.prepare(`SELECT ${MEAL_COLS} FROM meals WHERE id = ?`).get(id);
      return sendJson(res, 200, { ...row, isUnregistered: !!row.isUnregistered, hasPhoto: !!row.hasPhoto });
    }
    if (method === 'DELETE') {
      await db.prepare('DELETE FROM meals WHERE id = ?').run(id);
      return sendJson(res, 200, { ok: true });
    }
  }

  // 未登録食材一覧（食材マスタに無い meal の食材名）
  if (p === '/api/meals/unregistered' && method === 'GET') {
    const rows = await db.prepare(`SELECT foodName, COUNT(*)::int AS count, MAX(date) AS lastDate
      FROM meals WHERE isUnregistered = 1 GROUP BY foodName ORDER BY count DESC`).all();
    return sendJson(res, 200, rows);
  }

  // --- nutrition ---
  if (p === '/api/nutrition/daily' && method === 'GET') {
    const date = q.get('date') || isoDate(new Date());
    return sendJson(res, 200, await daily(date));
  }
  if (p === '/api/nutrition/weekly' && method === 'GET') {
    const start = q.get('start') || addDays(isoDate(new Date()), -6);
    return sendJson(res, 200, await series(start, addDays(start, 6)));
  }
  if (p === '/api/nutrition/monthly' && method === 'GET') {
    const month = q.get('month') || isoDate(new Date()).slice(0, 7); // YYYY-MM
    const start = `${month}-01`;
    const [y, mo] = month.split('-').map(Number);
    const end = isoDate(new Date(y, mo, 0)); // 月末
    return sendJson(res, 200, await series(start, end));
  }

  // --- widget（スマホウィジェット用の軽量エンドポイント）---
  // ダッシュボードと違い当日1日分しか集計しないため、ウィジェットの定期取得でも軽い。
  // 端末のローカル日付とサーバー(UTC)の日付がずれるので、date は端末側から渡す想定。
  if (p === '/api/widget/today' && method === 'GET') {
    const date = q.get('date') || isoDate(new Date());
    const [day, goals, unreg] = await Promise.all([
      daily(date),
      db.prepare('SELECT * FROM goals WHERE id = 1').get(),
      db.prepare('SELECT COUNT(DISTINCT foodName)::int AS n FROM meals WHERE isUnregistered = 1').get(),
    ]);
    const calMeta = NUTRIENTS.find((n) => n.key === 'calories');
    const cal = day.total.calories;
    const j = nutrientJudge(calMeta, cal, goals || {});
    return sendJson(res, 200, {
      date,
      calories: cal ? cal.value : 0,
      ref: j ? j.ref : null,
      status: j ? j.status : null,
      percent: j ? Math.round(j.ratio * 100) : null,
      partial: cal ? !!cal.partial : false,
      unregisteredCount: unreg ? unreg.n : 0,
    });
  }

  // ウィジェットからのワンタップ記録用。既存の /api/meals と同じ登録処理だが、
  // GET + クエリだけで完結するので Tasker 等の HTTP Request から呼びやすい。
  // 例: /api/widget/log?food=ごはん&grams=150&date=2026-07-19
  if (p === '/api/widget/log' && method === 'GET') {
    const foodName = (q.get('food') || '').trim();
    const grams = Number(q.get('grams'));
    const date = q.get('date') || isoDate(new Date());
    if (!foodName || !isFinite(grams) || grams <= 0) {
      return sendError(res, 400, 'food と grams（正の数）は必須です');
    }
    const food = await resolveFood(foodName);
    await db.prepare(`INSERT INTO meals (date, time, foodId, foodName, grams, memo, photo, isUnregistered, createdAt, updatedAt)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      date, q.get('time') || '', food ? food.id : null, foodName, grams, '', null, food ? 0 : 1, now(), now(),
    );
    const day = await daily(date);
    return sendJson(res, 200, {
      ok: true, foodName, grams, date,
      registered: !!food, // false = 食材マスタに無い（あとで「未登録」画面から栄養データを補完）
      calories: day.total.calories ? day.total.calories.value : 0,
    });
  }

  // --- dashboard ---
  if (p === '/api/dashboard' && method === 'GET') {
    const date = q.get('date') || isoDate(new Date());
    const monthStart = addDays(date, -29);
    // マスタ・レコードを1回ずつ「並列」で取得し、日/週/月で使い回す。
    // 週・当日の範囲は月範囲(monthStart..date)の部分集合なので meals/suppLogs は1回の取得で足りる。
    // 旧: daily+series×2 が各自ロード → 直列16往復。新: 独立クエリ8本を並列（壁時計 ≈ 1往復）。
    const [foodsById, suppById, meals, suppLogs, goals, freq, energy, latestBody] = await Promise.all([
      loadFoodsMap(),
      loadSupplementsMap(),
      getMealsInRange(monthStart, date),
      getSupplementLogsInRange(monthStart, date),
      db.prepare('SELECT * FROM goals WHERE id = 1').get(),
      foodFrequency(monthStart, date, 10),
      db.prepare('SELECT * FROM daily_energy WHERE date = ?').get(date),
      db.prepare('SELECT * FROM body_records ORDER BY date DESC LIMIT 1').get(),
    ]);
    // ctx を渡すと daily/series は追加のDBアクセスをせず、上のデータをJSでフィルタするだけ。
    const ctx = { foodsById, suppById, meals, suppLogs };
    const today = await daily(date, ctx);
    const week = await series(addDays(date, -6), date, ctx);
    const month = await series(monthStart, date, ctx);
    return sendJson(res, 200, {
      date, today, week, month, goals,
      foodFrequency: freq, energy: energy || null, latestBody: latestBody || null,
    });
  }

  // --- goals ---
  if (p === '/api/goals' && method === 'GET') {
    return sendJson(res, 200, await db.prepare('SELECT * FROM goals WHERE id = 1').get());
  }
  if (p === '/api/goals' && method === 'PUT') {
    const body = await readBody(req);
    const num = (v) => (v === '' || v === undefined || v === null ? null : Number(v));
    await db.prepare(`UPDATE goals SET targetCalories=?, targetProtein=?, targetFiber=?, saltLimit=?, weightGoal=?, bodyFatGoal=?, updatedAt=? WHERE id=1`).run(
      num(body.targetCalories), num(body.targetProtein), num(body.targetFiber),
      num(body.saltLimit), num(body.weightGoal), num(body.bodyFatGoal), now(),
    );
    return sendJson(res, 200, await db.prepare('SELECT * FROM goals WHERE id = 1').get());
  }

  // --- body records（体重・体脂肪率・内臓脂肪。日付ごとに1セット、翌朝登録想定） ---
  if (p === '/api/body' && method === 'GET') {
    const date = q.get('date');
    if (date) return sendJson(res, 200, await db.prepare('SELECT * FROM body_records WHERE date = ?').get(date) || null);
    return sendJson(res, 200, await db.prepare('SELECT * FROM body_records ORDER BY date DESC LIMIT 200').all());
  }
  if (p === '/api/body' && (method === 'POST' || method === 'PUT')) {
    const body = await readBody(req);
    if (!body.date) return sendError(res, 400, 'date は必須です');
    const num = (v) => (v === '' || v === undefined || v === null ? null : Number(v));
    const existing = await db.prepare('SELECT * FROM body_records WHERE date = ?').get(body.date);
    if (existing) {
      await db.prepare('UPDATE body_records SET weight=?, bodyFat=?, visceralFat=?, memo=? WHERE date=?')
        .run(num(body.weight), num(body.bodyFat), num(body.visceralFat), body.memo || '', body.date);
    } else {
      await db.prepare('INSERT INTO body_records (date, weight, bodyFat, visceralFat, memo, createdAt) VALUES (?, ?, ?, ?, ?, ?)')
        .run(body.date, num(body.weight), num(body.bodyFat), num(body.visceralFat), body.memo || '', now());
    }
    return sendJson(res, existing ? 200 : 201, await db.prepare('SELECT * FROM body_records WHERE date = ?').get(body.date));
  }
  if ((m = p.match(/^\/api\/body\/(\d+)$/)) && method === 'DELETE') {
    await db.prepare('DELETE FROM body_records WHERE id = ?').run(Number(m[1]));
    return sendJson(res, 200, { ok: true });
  }

  // --- daily energy（当日の消費カロリー。日付ごとに1値、手入力） ---
  if (p === '/api/energy' && method === 'GET') {
    const date = q.get('date');
    if (date) return sendJson(res, 200, await db.prepare('SELECT * FROM daily_energy WHERE date = ?').get(date) || null);
    return sendJson(res, 200, await db.prepare('SELECT * FROM daily_energy ORDER BY date DESC LIMIT 200').all());
  }
  if (p === '/api/energy' && (method === 'POST' || method === 'PUT')) {
    const body = await readBody(req);
    if (!body.date) return sendError(res, 400, 'date は必須です');
    const val = (body.burnedCalories === '' || body.burnedCalories === undefined || body.burnedCalories === null) ? null : Number(body.burnedCalories);
    await db.prepare(`INSERT INTO daily_energy (date, burnedCalories, updatedAt) VALUES (?, ?, ?)
      ON CONFLICT(date) DO UPDATE SET burnedCalories = excluded.burnedCalories, updatedAt = excluded.updatedAt`)
      .run(body.date, val, now());
    return sendJson(res, 200, await db.prepare('SELECT * FROM daily_energy WHERE date = ?').get(body.date));
  }
  if ((m = p.match(/^\/api\/energy\/(\d{4}-\d{2}-\d{2})$/)) && method === 'DELETE') {
    await db.prepare('DELETE FROM daily_energy WHERE date = ?').run(m[1]);
    return sendJson(res, 200, { ok: true });
  }

  // --- export / import ---
  if (p === '/api/export' && method === 'GET') {
    const scope = ['masters', 'records', 'all'].includes(q.get('scope')) ? q.get('scope') : 'all';
    const start = q.get('start') || '';
    const end = q.get('end') || '';
    const { buffer, manifest } = await buildExport(start, end, scope);
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
      const result = await applyImport(buf, { mode: q.get('mode'), importGoals: q.get('goals') === '1' });
      invalidateFoods(); invalidateSupplements(); // インポートでマスタが変わりうる: キャッシュ破棄
      return sendJson(res, 200, result);
    } catch (e) {
      return sendError(res, 400, `インポートに失敗しました: ${e.message}`);
    }
  }

  return sendError(res, 404, 'APIが見つかりません');
}

// ---------- server ----------
// 全リクエストを捌くハンドラ。静的配信も /api/* もこの1関数が処理する。
async function requestListener(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const perfT0 = performance.now(); // PERF TEST
  if (perf.enabled) perf.reset();   // PERF TEST: リクエストごとにSQL計測をリセット
  try {
    if (url.pathname.startsWith('/api/')) {
      await handleApi(req, res, url);
    } else {
      await serveStatic(req, res, url.pathname);
    }
  } catch (e) {
    console.error(e);
    if (!res.headersSent) sendError(res, 500, e.message || 'サーバーエラー');
  } finally {
    // PERF TEST: 1リクエストで発行したSQL回数・DB合計時間・全体時間をまとめて出力。
    if (perf.enabled && url.pathname.startsWith('/api/')) {
      const r = perf.report();
      const totalMs = performance.now() - perfT0;
      console.log(`[PERF] === ${req.method} ${url.pathname} — SQL ${r.count}回 / DB ${r.totalMs.toFixed(1)}ms / 全体 ${totalMs.toFixed(1)}ms ===`);
    }
  }
}

// Vercel は root エントリポイント（server.js）の default export を、
// 全リクエストを受けるハンドラ関数として呼び出す（Fluid / @vercel/node 方式）。
export default requestListener;

// ローカル開発時のみ自前で listen する。Vercel 上ではラッパーが requestListener を
// 直接呼ぶため listen は不要（自前 listen はラッパーと競合し FUNCTION_INVOCATION_FAILED を招く）。
if (!process.env.VERCEL) {
  http.createServer(requestListener).listen(PORT, () => {
    console.log(`\n  栄養管理アプリ起動: http://localhost:${PORT}\n`);
  });
}
