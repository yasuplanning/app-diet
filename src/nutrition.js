import db from './db.js';
import { NUTRIENT_KEYS } from './nutrients.js';

// 摂取栄養素 = 食材100gあたり栄養素 × 摂取グラム数 / 100
// 各栄養素について { value, partial } を返す。
// partial=true は「寄与した食材のいずれかで数値が未登録(null)だった」= 一部データ未登録。
export function emptyTotals() {
  const t = {};
  for (const k of NUTRIENT_KEYS) t[k] = { value: 0, partial: false };
  return t;
}

// 1食分（meal + food行）の栄養素を計算
export function computeMeal(meal, food) {
  const factor = meal.grams / 100;
  const out = {};
  for (const k of NUTRIENT_KEYS) {
    const per100 = food ? food[k] : null; // 未登録食材(foodなし)は全て null 扱い
    if (per100 === null || per100 === undefined) {
      out[k] = { value: 0, partial: true };
    } else {
      out[k] = { value: per100 * factor, partial: false };
    }
  }
  return out;
}

// 複数のmealを合算
export function aggregate(meals, foodsById) {
  const totals = emptyTotals();
  for (const meal of meals) {
    const food = meal.foodId ? foodsById[meal.foodId] : null;
    const factor = meal.grams / 100;
    for (const k of NUTRIENT_KEYS) {
      const per100 = food ? food[k] : null;
      if (per100 === null || per100 === undefined) {
        totals[k].partial = true;
      } else {
        totals[k].value += per100 * factor;
      }
    }
  }
  // 丸め
  for (const k of NUTRIENT_KEYS) totals[k].value = round(totals[k].value);
  return totals;
}

function round(n) {
  return Math.round(n * 100) / 100;
}

// 食材をidで引けるマップを作る
export function loadFoodsMap() {
  const rows = db.prepare('SELECT * FROM foods').all();
  const map = {};
  for (const r of rows) map[r.id] = r;
  return map;
}

// サプリをidで引けるマップを作る
export function loadSupplementsMap() {
  const rows = db.prepare('SELECT * FROM supplements').all();
  const map = {};
  for (const r of rows) map[r.id] = r;
  return map;
}

// サプリ摂取記録の取得
export function getSupplementLogsByDate(date) {
  return db.prepare('SELECT * FROM supplement_logs WHERE date = ? ORDER BY time, id').all(date);
}
export function getSupplementLogsInRange(start, end) {
  return db.prepare('SELECT * FROM supplement_logs WHERE date >= ? AND date <= ? ORDER BY date, time, id').all(start, end);
}

// サプリ1件（log + supplement行）の栄養素を計算。
// 摂取栄養素 = サプリ1個あたりの含有量 × units（グラム換算はしない）。
export function computeSupplementLog(log, supp) {
  const out = {};
  for (const k of NUTRIENT_KEYS) {
    const perUnit = supp ? supp[k] : null; // マスタから外れた/未登録は null 扱い
    if (perUnit === null || perUnit === undefined) {
      out[k] = { value: 0, partial: true };
    } else {
      out[k] = { value: perUnit * log.units, partial: false };
    }
  }
  return out;
}

// サプリ摂取記録を既存の合計(totals)に加算する（totalsを破壊的に更新）。丸めは呼び出し側で行う。
export function addSupplementTotals(totals, logs, suppById) {
  for (const log of logs) {
    const supp = log.supplementId ? suppById[log.supplementId] : null;
    for (const k of NUTRIENT_KEYS) {
      const perUnit = supp ? supp[k] : null;
      if (perUnit === null || perUnit === undefined) {
        totals[k].partial = true;
      } else {
        totals[k].value += perUnit * log.units;
      }
    }
  }
  return totals;
}

// 指定日のmealを取得
export function getMealsByDate(date) {
  return db.prepare('SELECT * FROM meals WHERE date = ? ORDER BY time, id').all(date);
}

// 日付範囲のmealを取得（両端含む）
export function getMealsInRange(start, end) {
  return db.prepare('SELECT * FROM meals WHERE date >= ? AND date <= ? ORDER BY date, time, id').all(start, end);
}

// --- 日付ユーティリティ (YYYY-MM-DD, ローカル基準) ---
export function isoDate(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}
export function addDays(dateStr, n) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  dt.setDate(dt.getDate() + n);
  return isoDate(dt);
}
export function daysBetween(start, end) {
  const out = [];
  let cur = start;
  while (cur <= end) {
    out.push(cur);
    cur = addDays(cur, 1);
  }
  return out;
}

// 日次集計
export function daily(date) {
  const foodsById = loadFoodsMap();
  const meals = getMealsByDate(date);
  const mealsOut = meals.map((m) => ({
    ...m,
    isUnregistered: !!m.isUnregistered,
    nutrients: computeMeal(m, m.foodId ? foodsById[m.foodId] : null),
  }));

  // 食事区分ごと
  const byMealType = {};
  for (const m of meals) {
    (byMealType[m.mealType] ||= []).push(m);
  }
  const byType = {};
  for (const [type, list] of Object.entries(byMealType)) {
    byType[type] = aggregate(list, foodsById);
  }

  // サプリ（別管理・個数ベース）
  const suppById = loadSupplementsMap();
  const suppLogs = getSupplementLogsByDate(date);
  const supplementsOut = suppLogs.map((l) => ({
    ...l,
    nutrients: computeSupplementLog(l, l.supplementId ? suppById[l.supplementId] : null),
  }));

  // 合計は食事＋サプリ。サプリは個数×1個あたり含有量で加算し、最後に再度丸める。
  const total = aggregate(meals, foodsById);
  addSupplementTotals(total, suppLogs, suppById);
  for (const k of NUTRIENT_KEYS) total[k].value = round(total[k].value);

  return {
    date,
    meals: mealsOut,
    supplements: supplementsOut,
    byMealType: byType,
    total,
  };
}

// 期間の日別系列 + 合計 + 平均
export function series(start, end) {
  const foodsById = loadFoodsMap();
  const meals = getMealsInRange(start, end);
  const byDate = {};
  for (const m of meals) (byDate[m.date] ||= []).push(m);

  // サプリ（別管理・個数ベース）を日付ごとにまとめる
  const suppById = loadSupplementsMap();
  const suppLogs = getSupplementLogsInRange(start, end);
  const suppByDate = {};
  for (const l of suppLogs) (suppByDate[l.date] ||= []).push(l);

  const dates = daysBetween(start, end);
  const days = dates.map((d) => {
    const t = aggregate(byDate[d] || [], foodsById);
    addSupplementTotals(t, suppByDate[d] || [], suppById);
    for (const k of NUTRIENT_KEYS) t[k].value = round(t[k].value);
    return { date: d, total: t };
  });

  // 合計・平均（記録のある日数で平均を取る。サプリのみの日も記録日に数える）
  const total = emptyTotals();
  const recordedDates = new Set([...meals.map((m) => m.date), ...suppLogs.map((l) => l.date)]);
  const nDays = recordedDates.size || 1;
  for (const day of days) {
    for (const k of NUTRIENT_KEYS) {
      total[k].value += day.total[k].value;
      if (day.total[k].partial) total[k].partial = true;
    }
  }
  const average = emptyTotals();
  for (const k of NUTRIENT_KEYS) {
    total[k].value = round(total[k].value);
    average[k].value = round(total[k].value / nDays);
    average[k].partial = total[k].partial;
  }

  return { start, end, days, total, average, recordedDays: recordedDates.size };
}

// 食材別の摂取頻度（回数と合計グラム）
export function foodFrequency(start, end, limit = 20) {
  const rows = db.prepare(`
    SELECT foodName, COUNT(*) AS count, SUM(grams) AS totalGrams
    FROM meals WHERE date >= ? AND date <= ?
    GROUP BY foodName ORDER BY count DESC, totalGrams DESC LIMIT ?
  `).all(start, end, limit);
  return rows;
}

// よく使う食材（クイック入力用）: 直近の使用頻度順
export function frequentFoods(limit = 12) {
  return db.prepare(`
    SELECT m.foodName, m.foodId, m.grams, COUNT(*) AS count, MAX(m.date) AS lastDate
    FROM meals m
    GROUP BY m.foodName
    ORDER BY count DESC, lastDate DESC
    LIMIT ?
  `).all(limit);
}
