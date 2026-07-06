import { NUTRIENTS, NUTRIENT_KEYS } from './nutrients.js';

const API_URL = 'https://api.anthropic.com/v1/messages';
// 推定は軽量な用途なので既定は Haiku。環境変数で上書き可能。
const MODEL = process.env.ANTHROPIC_MODEL || 'claude-haiku-4-5-20251001';

// 未登録食材について 100gあたり栄養素の推定値ドラフトを返す。
// 返り値は { estimated:true, source, draft:{name, category, ...nutrients} }
export async function estimateFood(name, hint = '') {
  const apiKey = process.env.ANTHROPIC_API_KEY;

  // APIキーが無い場合: 空ドラフト（全て null）を返し、手動入力を促す。
  if (!apiKey) {
    const draft = { name, category: '', note: 'LLM未接続のため自動推定できません。手動で入力してください。' };
    for (const k of NUTRIENT_KEYS) draft[k] = null;
    return {
      estimated: true,
      available: false,
      source: 'LLM未接続（ANTHROPIC_API_KEY 未設定）',
      draft,
    };
  }

  const spec = NUTRIENTS.map((n) => `  "${n.key}": 数値または null  // ${n.label} (${n.unit}/100g)`).join('\n');
  const prompt = `あなたは栄養士です。次の食材について、一般的な100gあたりの栄養素を推定してください。
食材名: ${name}
${hint ? `補足: ${hint}\n` : ''}
以下のJSONオブジェクトだけを出力してください（前後の説明文やコードフェンスは不要）。
値は100gあたりの数値。単位は指定どおり。不明な項目は null にしてください。
{
  "category": "主食/主菜/副菜/汁物/果物/乳製品/ナッツ・種実/菓子/調味料/海藻/その他 のいずれか",
${spec}
}`;

  const res = await fetch(API_URL, {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 1024,
      messages: [{ role: 'user', content: prompt }],
    }),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Anthropic API error ${res.status}: ${text.slice(0, 300)}`);
  }

  const data = await res.json();
  const textOut = (data.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('');
  const parsed = extractJson(textOut);

  const draft = { name, category: typeof parsed.category === 'string' ? parsed.category : '', note: `LLM推定（${MODEL}）` };
  for (const k of NUTRIENT_KEYS) {
    const v = parsed[k];
    draft[k] = typeof v === 'number' && isFinite(v) ? v : null;
  }

  return { estimated: true, available: true, source: `LLM推定（${MODEL}）`, draft };
}

function extractJson(text) {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end === -1) throw new Error('LLM応答からJSONを抽出できませんでした');
  return JSON.parse(text.slice(start, end + 1));
}
