import db from './db.js';
import { NUTRIENT_KEYS } from './nutrients.js';
import { zipSync, unzipSync } from './zip.js';

const EXPORT_VERSION = 1;
const now = () => new Date().toISOString();

// データを ZIP(Buffer) に書き出す。scope で内容を切り替える。
//  - 'masters' … 食材マスタ・サプリマスタ・目標（期間指定なし・全件）
//  - 'records' … 食事・サプリ摂取記録・消費カロリー・体組成（期間内）
//  - 'all'     … 上記すべて（後方互換）
// 期間(start/end)は日付キーのデータ（records系）にのみ適用。
// インポート時はファイル名を参照して、含まれているものだけを取り込む。
export async function buildExport(start, end, scope = 'all') {
  const s = start || '0000-01-01';
  const e = end || '9999-12-31';
  const wantMasters = scope === 'all' || scope === 'masters';
  const wantRecords = scope === 'all' || scope === 'records';

  const files = [];
  const counts = {};
  const fileLines = [];
  const addFile = (name, obj, note) => {
    files.push({ name, data: JSON.stringify(obj, null, 2) });
    fileLines.push(`  ${(name + '                    ').slice(0, 20)}… ${note}`);
  };

  if (wantMasters) {
    const foods = await db.prepare('SELECT * FROM foods ORDER BY id').all();
    const supplements = await db.prepare('SELECT * FROM supplements ORDER BY id').all();
    const goals = await db.prepare('SELECT * FROM goals WHERE id = 1').get();
    counts.foods = foods.length;
    counts.supplements = supplements.length;
    addFile('foods.json', foods, '食材マスタ（全件）');
    addFile('supplements.json', supplements, 'サプリマスタ（全件）');
    addFile('goals.json', goals, '目標設定');
  }

  if (wantRecords) {
    const meals = await db.prepare('SELECT * FROM meals WHERE date >= ? AND date <= ? ORDER BY date, time, id').all(s, e);
    const energy = await db.prepare('SELECT * FROM daily_energy WHERE date >= ? AND date <= ? ORDER BY date').all(s, e);
    const body = await db.prepare('SELECT * FROM body_records WHERE date >= ? AND date <= ? ORDER BY date').all(s, e);
    const supplementLogs = await db.prepare('SELECT * FROM supplement_logs WHERE date >= ? AND date <= ? ORDER BY date, time, id').all(s, e);
    counts.meals = meals.length;
    counts.daily_energy = energy.length;
    counts.body_records = body.length;
    counts.supplement_logs = supplementLogs.length;
    addFile('meals.json', meals, '食事記録（期間内）');
    addFile('daily_energy.json', energy, '消費カロリー（期間内）');
    addFile('body_records.json', body, '体重・体脂肪率・内臓脂肪（期間内）');
    addFile('supplement_logs.json', supplementLogs, 'サプリ摂取記録（期間内）');
  }

  const scopeLabel = scope === 'masters' ? '食材マスタ・サプリ'
    : scope === 'records' ? '食事・消費カロリー・体組成'
      : '全データ';

  const manifest = {
    app: 'app-diet',
    version: EXPORT_VERSION,
    exportedAt: now(),
    scope,
    range: wantRecords ? { start: s, end: e } : null,
    counts,
  };

  const readme = [
    'app-diet データエクスポート',
    `作成日時: ${manifest.exportedAt}`,
    `種別: ${scopeLabel}`,
    wantRecords ? `対象期間: ${s} 〜 ${e}` : '対象期間: —（マスタは全件）',
    '',
    '含まれるファイル:',
    '  manifest.json       … メタ情報',
    ...fileLines,
    '',
    'このZIPは同アプリの「インポート」で取り込めます（ファイル名を見て自動判別）。',
  ].join('\n');

  files.unshift({ name: 'manifest.json', data: JSON.stringify(manifest, null, 2) });
  files.push({ name: 'README.txt', data: readme });

  return { buffer: zipSync(files), manifest };
}

// ZIP(Buffer) を取り込む。
// opts: { mode: 'skip'|'overwrite', importGoals: boolean }
//  - foods: 食材名で突き合わせ。既存があれば再利用（overwrite時は栄養値も更新）、無ければ追加。
//  - meals: (date,time,foodName,grams) が完全一致する既存はスキップ（重複防止）。foodId は食材名で貼り直す。
//  - daily_energy / body_records: 日付キー。既存日付は skip なら保持、overwrite なら更新。
//  - goals: importGoals=true のときだけ上書き。
// 注: Neon の HTTP ドライバは対話的トランザクションを張らないため逐次実行（各文が即コミット）。
//     重複スキップ設計により、途中失敗しても同じZIPを再インポートすれば安全に続行できる。
export async function applyImport(zipBuffer, opts = {}) {
  const mode = opts.mode === 'overwrite' ? 'overwrite' : 'skip';
  const importGoals = !!opts.importGoals;

  const entries = unzipSync(zipBuffer);
  const readJson = (name) => {
    if (!entries[name]) return null;
    return JSON.parse(entries[name].toString('utf8'));
  };

  const manifest = readJson('manifest.json');
  if (!manifest || manifest.app !== 'app-diet') {
    throw new Error('app-diet のエクスポートZIPではありません（manifest.json 不正）');
  }

  const impFoods = readJson('foods.json') || [];
  const impMeals = readJson('meals.json') || [];
  const impEnergy = readJson('daily_energy.json') || [];
  const impBody = readJson('body_records.json') || [];
  const impSupplements = readJson('supplements.json') || [];
  const impSupplementLogs = readJson('supplement_logs.json') || [];
  const impGoals = readJson('goals.json');

  const summary = {
    foods: { added: 0, updated: 0, skipped: 0 },
    meals: { added: 0, skipped: 0 },
    daily_energy: { added: 0, updated: 0, skipped: 0 },
    body_records: { added: 0, updated: 0, skipped: 0 },
    supplements: { added: 0, updated: 0, skipped: 0 },
    supplement_logs: { added: 0, skipped: 0 },
    goals: importGoals ? 'imported' : 'skipped',
  };

  // --- foods（名前で突き合わせ）---
  const foodCols = ['name', 'aliases', ...NUTRIENT_KEYS, 'dataSource', 'note', 'isEstimated', 'createdAt', 'updatedAt'];
  const insertFood = db.prepare(`INSERT INTO foods (${foodCols.join(',')}) VALUES (${foodCols.map(() => '?').join(',')}) RETURNING id`);
  const nameToId = {};
  for (const f of impFoods) {
    const existing = await db.prepare('SELECT * FROM foods WHERE name = ?').get(f.name);
    if (existing) {
      nameToId[f.name] = existing.id;
      if (mode === 'overwrite') {
        const sets = ['aliases=?', ...NUTRIENT_KEYS.map((k) => `${k}=?`), 'dataSource=?', 'note=?', 'isEstimated=?', 'updatedAt=?'];
        const params = [f.aliases ?? '', ...NUTRIENT_KEYS.map((k) => (f[k] ?? null)), f.dataSource ?? '', f.note ?? '', f.isEstimated ? 1 : 0, now(), existing.id];
        await db.prepare(`UPDATE foods SET ${sets.join(',')} WHERE id=?`).run(...params);
        summary.foods.updated++;
      } else {
        summary.foods.skipped++;
      }
    } else {
      const params = foodCols.map((c) => {
        if (c === 'createdAt' || c === 'updatedAt') return now();
        if (c === 'isEstimated') return f.isEstimated ? 1 : 0;
        return f[c] ?? null;
      });
      const info = await insertFood.run(...params);
      nameToId[f.name] = info.lastInsertRowid;
      summary.foods.added++;
    }
  }

  // --- meals（完全一致で重複スキップ、foodId は名前で貼り直す）---
  const insertMeal = db.prepare(`INSERT INTO meals (date, time, foodId, foodName, grams, memo, isUnregistered, createdAt, updatedAt)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  for (const m of impMeals) {
    const dup = await db.prepare('SELECT id FROM meals WHERE date=? AND time=? AND foodName=? AND grams=?')
      .get(m.date, m.time ?? '', m.foodName, m.grams);
    if (dup) { summary.meals.skipped++; continue; }
    // 食材IDを名前で解決（インポートしたfoodsの対応、無ければ既存マスタ）
    let foodId = nameToId[m.foodName] ?? null;
    if (!foodId) {
      const f = await db.prepare('SELECT id FROM foods WHERE name = ?').get(m.foodName);
      foodId = f ? f.id : null;
    }
    await insertMeal.run(m.date, m.time ?? '', foodId, m.foodName, m.grams, m.memo ?? '', foodId ? 0 : 1, now(), now());
    summary.meals.added++;
  }

  // --- daily_energy（日付キー）---
  for (const en of impEnergy) {
    const existing = await db.prepare('SELECT date FROM daily_energy WHERE date = ?').get(en.date);
    if (existing) {
      if (mode === 'overwrite') {
        await db.prepare('UPDATE daily_energy SET burnedCalories=?, updatedAt=? WHERE date=?').run(en.burnedCalories ?? null, now(), en.date);
        summary.daily_energy.updated++;
      } else summary.daily_energy.skipped++;
    } else {
      await db.prepare('INSERT INTO daily_energy (date, burnedCalories, updatedAt) VALUES (?, ?, ?)').run(en.date, en.burnedCalories ?? null, now());
      summary.daily_energy.added++;
    }
  }

  // --- body_records（日付キー）---
  for (const b of impBody) {
    const existing = await db.prepare('SELECT id FROM body_records WHERE date = ?').get(b.date);
    if (existing) {
      if (mode === 'overwrite') {
        await db.prepare('UPDATE body_records SET weight=?, bodyFat=?, visceralFat=?, memo=? WHERE date=?')
          .run(b.weight ?? null, b.bodyFat ?? null, b.visceralFat ?? null, b.memo ?? '', b.date);
        summary.body_records.updated++;
      } else summary.body_records.skipped++;
    } else {
      await db.prepare('INSERT INTO body_records (date, weight, bodyFat, visceralFat, memo, createdAt) VALUES (?, ?, ?, ?, ?, ?)')
        .run(b.date, b.weight ?? null, b.bodyFat ?? null, b.visceralFat ?? null, b.memo ?? '', now());
      summary.body_records.added++;
    }
  }

  // --- supplements（名前で突き合わせ。栄養値は1個あたり）---
  const suppCols = ['name', 'aliases', 'brand', ...NUTRIENT_KEYS, 'dataSource', 'note', 'isEstimated', 'createdAt', 'updatedAt'];
  const insertSupp = db.prepare(`INSERT INTO supplements (${suppCols.join(',')}) VALUES (${suppCols.map(() => '?').join(',')}) RETURNING id`);
  const suppNameToId = {};
  for (const s of impSupplements) {
    const existing = await db.prepare('SELECT * FROM supplements WHERE name = ?').get(s.name);
    if (existing) {
      suppNameToId[s.name] = existing.id;
      if (mode === 'overwrite') {
        const sets = ['aliases=?', 'brand=?', ...NUTRIENT_KEYS.map((k) => `${k}=?`), 'dataSource=?', 'note=?', 'isEstimated=?', 'updatedAt=?'];
        const params = [s.aliases ?? '', s.brand ?? '', ...NUTRIENT_KEYS.map((k) => (s[k] ?? null)), s.dataSource ?? '', s.note ?? '', s.isEstimated ? 1 : 0, now(), existing.id];
        await db.prepare(`UPDATE supplements SET ${sets.join(',')} WHERE id=?`).run(...params);
        summary.supplements.updated++;
      } else {
        summary.supplements.skipped++;
      }
    } else {
      const params = suppCols.map((c) => {
        if (c === 'createdAt' || c === 'updatedAt') return now();
        if (c === 'isEstimated') return s.isEstimated ? 1 : 0;
        return s[c] ?? null;
      });
      const info = await insertSupp.run(...params);
      suppNameToId[s.name] = info.lastInsertRowid;
      summary.supplements.added++;
    }
  }

  // --- supplement_logs（完全一致で重複スキップ、supplementId は名前で貼り直す）---
  const insertSuppLog = db.prepare(`INSERT INTO supplement_logs (date, time, supplementId, supplementName, units, memo, createdAt, updatedAt)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
  for (const l of impSupplementLogs) {
    const dup = await db.prepare('SELECT id FROM supplement_logs WHERE date=? AND time=? AND supplementName=? AND units=?')
      .get(l.date, l.time ?? '', l.supplementName, l.units);
    if (dup) { summary.supplement_logs.skipped++; continue; }
    let suppId = suppNameToId[l.supplementName] ?? null;
    if (!suppId) {
      const s = await db.prepare('SELECT id FROM supplements WHERE name = ?').get(l.supplementName);
      suppId = s ? s.id : null;
    }
    await insertSuppLog.run(l.date, l.time ?? '', suppId, l.supplementName, l.units, l.memo ?? '', now(), now());
    summary.supplement_logs.added++;
  }

  // --- goals（任意）---
  if (importGoals && impGoals) {
    await db.prepare('UPDATE goals SET targetCalories=?, targetProtein=?, targetFiber=?, saltLimit=?, weightGoal=?, bodyFatGoal=?, updatedAt=? WHERE id=1')
      .run(impGoals.targetCalories ?? null, impGoals.targetProtein ?? null, impGoals.targetFiber ?? null,
        impGoals.saltLimit ?? null, impGoals.weightGoal ?? null, impGoals.bodyFatGoal ?? null, now());
  }

  return { manifest, mode, importGoals, summary };
}
