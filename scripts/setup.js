// テーブル作成 + 初期データ投入を CLI から実行する。
//   npm run setup            （.env があれば読み込む。DATABASE_URL が必要）
// Vercel 上では代わりに /api/setup を1回叩けばよい。
import { setup } from '../src/db.js';

setup()
  .then((r) => {
    console.log('[setup] 完了:', r);
    process.exit(0);
  })
  .catch((e) => {
    console.error('[setup] 失敗:', e);
    process.exit(1);
  });
