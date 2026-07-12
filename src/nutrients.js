// 栄養素の定義（キー・表示名・単位・1日の参照値）
// ref は成人のおおよその推奨量/目安量（日本の食事摂取基準を参考にした概算）。
// salt は上限値（limit:true）として扱う。omega9 は基準が定まっていないため null。
export const NUTRIENTS = [
  { key: 'calories',   label: 'カロリー',      unit: 'kcal', ref: 2000, group: 'macro' },
  { key: 'protein',    label: 'タンパク質',    unit: 'g',    ref: 60,   group: 'macro' },
  { key: 'fat',        label: '脂質',          unit: 'g',    ref: 60,   group: 'macro' },
  { key: 'carbs',      label: '炭水化物',      unit: 'g',    ref: 280,  group: 'macro' },
  { key: 'fiber',      label: '食物繊維',      unit: 'g',    ref: 20,   group: 'macro' },
  { key: 'salt',       label: '食塩相当量',    unit: 'g',    ref: 7.5,  group: 'macro', limit: true },
  { key: 'potassium',  label: 'カリウム',      unit: 'mg',   ref: 2500, group: 'mineral' },
  { key: 'calcium',    label: 'カルシウム',    unit: 'mg',   ref: 700,  group: 'mineral' },
  { key: 'magnesium',  label: 'マグネシウム',  unit: 'mg',   ref: 340,  group: 'mineral' },
  { key: 'iron',       label: '鉄',            unit: 'mg',   ref: 7.5,  group: 'mineral' },
  { key: 'zinc',       label: '亜鉛',          unit: 'mg',   ref: 10,   group: 'mineral' },
  { key: 'vitaminB6',  label: 'ビタミンB6',    unit: 'mg',   ref: 1.4,  group: 'vitamin' },
  { key: 'vitaminB12', label: 'ビタミンB12',   unit: 'µg',   ref: 2.4,  group: 'vitamin' },
  { key: 'folate',     label: '葉酸',          unit: 'µg',   ref: 240,  group: 'vitamin' },
  { key: 'vitaminC',   label: 'ビタミンC',     unit: 'mg',   ref: 100,  group: 'vitamin' },
  { key: 'vitaminD',   label: 'ビタミンD',     unit: 'µg',   ref: 8.5,  group: 'vitamin' },
  { key: 'omega3',     label: 'オメガ3',       unit: 'g',    ref: 2.0,  group: 'fat' },
  { key: 'omega6',     label: 'オメガ6',       unit: 'g',    ref: 10,   group: 'fat' },
  { key: 'omega9',     label: 'オメガ9',       unit: 'g',    ref: null, group: 'fat' },
];

// DBのfoodsテーブルに存在する栄養素カラム
export const NUTRIENT_KEYS = NUTRIENTS.map((n) => n.key);

export const MEAL_TYPES = ['朝食', '昼食', '夕食', '間食', 'その他'];
