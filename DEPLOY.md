# デプロイ手順（Vercel + Neon Postgres）

このアプリは Vercel のサーバーレス構成で動きます。
- 静的ファイル（`public/`）… Vercel が CDN から配信
- API（`/api/*`）… Vercel Functions（`api/[...path].js` が `server.js` の `handleApi` に委譲）
- DB … Neon Postgres（`@neondatabase/serverless` で HTTP 接続。`process.env.DATABASE_URL`）

`node:sqlite` / ローカルDBファイルは廃止済みです。

## 環境変数

Vercel のプロジェクト → Settings → Environment Variables に設定します。

| 変数 | 必須? | 説明 |
|------|-------|------|
| `DATABASE_URL` | **必須** | Neon の接続文字列。Neon連携済みなら自動で入っています |
| `ANTHROPIC_API_KEY` | 任意 | 食材の栄養素をLLMで自動推定する機能を使う場合のみ |
| `ANTHROPIC_MODEL` | 任意 | 推定に使うモデル（未設定なら `claude-haiku-4-5`） |

## デプロイ

1. このリポジトリを GitHub にプッシュ（Vercelが連携ブランチを自動デプロイ）。
2. Vercel が `npm install`（`@neondatabase/serverless` を導入）して関数をビルド。

## 初回だけ: テーブル作成 + 初期データ投入

DBは空の状態でデプロイされるので、**一度だけ初期化**します（冪等なので複数回叩いても安全）。

- 方法A（推奨）: デプロイ後に次のURLをブラウザで開く
  ```
  https://<あなたのドメイン>/api/setup
  ```
  `{"ok":true,"seededFoods":22}` のようなJSONが返れば成功。テーブル作成＋食材22件のseedが入ります。

- 方法B: ローカルから流し込む
  ```bash
  # プロジェクト直下に .env を作成し DATABASE_URL=... を記載
  npm install
  npm run setup
  ```

初期化後、`https://<ドメイン>/` を開けばアプリが使えます。

## 動作確認

- `https://<ドメイン>/api/meta` がJSONを返す → 関数OK
- `https://<ドメイン>/api/foods` が食材配列を返す → DB接続＋seed OK
- 画面から食事を記録 → リロードしても残っていれば永続化OK

## ローカル開発

Neon をそのまま開発DBとして使えます。

```bash
# .env に DATABASE_URL=<Neonの接続文字列> を記載
npm install
npm run setup        # 初回のみ
npm start            # http://localhost:3000
```

`server.js` はローカル時のみ `listen()` します（Vercel上では `VERCEL` 環境変数を検知して常駐しません）。

## 補足・注意

- **旧データの移行**: 以前ローカルで使っていた `data/diet.db`（SQLite）のデータは、この新構成には自動では移りません。引き継ぐ場合は旧版でエクスポートしたZIPを、新版の画面「インポート」から取り込んでください。
- **インポート機能**: ZIP(`application/zip`)を受け取ります。Vercelのボディ処理に合わせて実装済みですが、うまく取り込めない場合は連絡ください（受信方法を調整します）。
- **技術メモ**: SQLite→Postgres移植では、Postgresが未クォート識別子を小文字化する性質を利用し、既存SQL（camelCaseカラム）をほぼ無修正で流用。DBから返る行のキーだけ `src/db.js` で camelCase に復元しています。集計の件数は `::int`/`::float` でキャストして数値型を維持。
