// 貼り付けテキスト → 食材データの解析。
//
// AI 等が生成した「食材名：X／栄養素ラベル／含有量」形式の複数行テキストを、
// コピーペースト一発で食材マスタへ登録するためのパーサ。
//
// 対応する形式（1食材＝1ブロック。複数ブロックを続けて貼り付け可）:
//   食材名：ハンバーグ
//   栄養素            ← 見出し行は無視
//   含有量            ← 見出し行は無視
//   カロリー           ← 栄養素ラベル行
//   約230 kcal        ← 直前ラベルの値
//   タンパク質
//   約15.5 g
//   ...
// 「カロリー：230」「カロリー 約230 kcal」のような1行完結形式も許容する。
import { NUTRIENTS, NUTRIENT_KEYS } from './nutrients.js';

// ラベル比較用の正規化: 全角英数→半角、空白・括弧内を除去、小文字化。
function normLabel(s) {
  return String(s)
    .replace(/[Ａ-Ｚａ-ｚ０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/[（(][^）)]*[）)]/g, '')
    .replace(/\s+/g, '')
    .toLowerCase();
}

// 栄養素ラベル（表記ゆれ含む）→ 内部キー の対応表を構築。
const LABEL_TO_KEY = {};
for (const n of NUTRIENTS) LABEL_TO_KEY[normLabel(n.label)] = n.key;
const ALIASES = {
  calories: ['カロリー', 'エネルギー', '熱量', 'kcal'],
  protein: ['タンパク質', 'たんぱく質', '蛋白質', 'タンパク'],
  fat: ['脂質', '脂肪'],
  carbs: ['炭水化物', '糖質'],
  fiber: ['食物繊維', '繊維'],
  salt: ['食塩', '食塩相当量', '塩分'],
  potassium: ['カリウム'],
  calcium: ['カルシウム'],
  magnesium: ['マグネシウム'],
  iron: ['鉄', '鉄分'],
  zinc: ['亜鉛'],
  vitaminB6: ['ビタミンB6', 'vb6'],
  vitaminB12: ['ビタミンB12', 'vb12'],
  folate: ['葉酸'],
  vitaminC: ['ビタミンC', 'vc'],
  vitaminD: ['ビタミンD', 'vd'],
  omega3: ['オメガ3', 'オメガ-3', 'ω3', 'n-3', 'omega3'],
  omega6: ['オメガ6', 'オメガ-6', 'ω6', 'n-6', 'omega6'],
  omega9: ['オメガ9', 'オメガ-9', 'ω9', 'n-9', 'omega9'],
};
for (const [key, list] of Object.entries(ALIASES)) {
  for (const a of list) LABEL_TO_KEY[normLabel(a)] = key;
}

// 食材ブロックの先頭行（食材名：X）。
const NAME_RE = /^\s*(?:食材名|食品名|品名|名前|名称)\s*[：:]\s*(.+?)\s*$/;

// 文字列から最初の数値を取り出す。「約230 kcal」→230、「約1,200 mg」→1200、「約15.5 g」→15.5。
function parseNumber(s) {
  const m = String(s).replace(/,/g, '').match(/-?\d+(?:\.\d+)?/);
  return m ? Number(m[0]) : null;
}

// 1行完結形式「ラベル 値」を解釈。該当キーと数値を返す（無ければ null）。
function parseInline(line) {
  const m = line.match(/^(.+?)\s*[：:]?\s*約?\s*(-?\d[\d,]*(?:\.\d+)?)\s*[^\d]*$/);
  if (!m) return null;
  const key = LABEL_TO_KEY[normLabel(m[1])];
  if (!key) return null;
  return { key, value: parseNumber(m[2]) };
}

// 貼り付けテキストを解析し、[{ name, values, matched }] を返す。
// values は全 NUTRIENT_KEYS を含み、認識できなかった栄養素は null。
//
// opts.defaultName を渡すと、食材名ヘッダより前（＝先頭）の栄養素行を
// その名前の食材として扱う。未登録食材の行から「食材名を書かずに2行目以降だけ」
// 貼り付けて登録する動線で使用。この場合、栄養素が1つも取れなかった空ブロックは除外する。
export function parseFoodsText(text, opts = {}) {
  const lines = String(text || '').split(/\r?\n/);
  const foods = [];
  // defaultName 指定時は先頭を無名ブロックではなくその名前の食材として開始する。
  let cur = opts.defaultName ? { name: opts.defaultName, values: {} } : null;
  let pending = null; // 直前に現れた栄養素ラベルのキー

  const push = () => {
    if (!cur) return;
    const values = {};
    for (const k of NUTRIENT_KEYS) values[k] = k in cur.values ? cur.values[k] : null;
    foods.push({ name: cur.name, values, matched: Object.keys(cur.values).length });
  };

  for (const raw of lines) {
    const line = raw.trim();

    const nm = line.match(NAME_RE);
    if (nm) {
      push();
      cur = { name: nm[1].trim(), values: {} };
      pending = null;
      continue;
    }
    if (!cur) continue; // 食材名ヘッダより前の行は無視
    if (!line) { pending = null; continue; }

    const norm = normLabel(line);

    // 1. 栄養素ラベル行（値は次行）。B6/B12/オメガ3 等の数字を含むラベルもここで判定する
    //    （値行「約230kcal」は正規化してもキーに一致しないため誤判定しない）。
    if (LABEL_TO_KEY[norm] !== undefined) {
      pending = LABEL_TO_KEY[norm];
      continue;
    }
    // 2. 直前ラベルに対する値
    if (pending) {
      const v = parseNumber(line);
      if (v !== null) cur.values[pending] = v;
      pending = null;
      continue;
    }
    // 3. 1行完結形式「ラベル 値」
    const inline = parseInline(line);
    if (inline && inline.value !== null) cur.values[inline.key] = inline.value;
  }
  push();

  let result = foods.filter((f) => f.name);
  // defaultName 指定時: 貼り付け本文に食材名行が混ざっていた場合に生じる
  // 「名前だけで栄養素0」の空ブロックを除外する。
  if (opts.defaultName) result = result.filter((f) => f.matched > 0);
  return result;
}

export default { parseFoodsText };
