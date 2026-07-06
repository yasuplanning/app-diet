# デプロイ手順（Railway）

このアプリは `node:sqlite` でローカルのDBファイルに書き込み、常駐サーバー
（`http.createServer().listen()`）として動きます。そのため **永続ディスクと
常駐プロセスが必要**で、Vercel等のサーバーレスでは動きません。Railway など
「永続ボリューム＋常駐Node」に対応したホストを使います。

## 前提

- Node 24 で動作（`node:sqlite` が安定版。`.nvmrc` / `package.json` の `engines` で固定済み）
- 依存パッケージなし（`npm install` 不要）

## 手順

1. **リポジトリを用意**
   このプロジェクトをGitHubにプッシュしておく（Railwayと連携するため）。

2. **Railwayでプロジェクト作成**
   [railway.app](https://railway.app) → New Project → *Deploy from GitHub repo* →
   このリポジトリを選択。`railway.json` を読んで自動的に `npm start` で起動します。

3. **永続ボリュームを追加（最重要）**
   サービスの *Settings → Volumes* → *Add Volume*。
   - Mount path: `/data`

   これを付けないと、再デプロイ・再起動のたびにDBが消えます。

4. **環境変数を設定**
   サービスの *Variables* に以下を追加：

   | 変数 | 値 | 必須? | 説明 |
   |------|-----|-------|------|
   | `DATA_DIR` | `/data` | **必須** | 手順3のボリュームのマウントパス。DBと自動バックアップの保存先 |
   | `ANTHROPIC_API_KEY` | `sk-ant-...` | 任意 | 食材の栄養素をLLMで自動推定する機能を使う場合のみ |
   | `ANTHROPIC_MODEL` | 例: `claude-haiku-4-5-20251001` | 任意 | 推定に使うモデル（未設定なら Haiku） |

   ※ `PORT` はRailwayが自動注入するので設定不要（`server.js` が `process.env.PORT` を参照）。

5. **公開URLを発行**
   *Settings → Networking → Generate Domain* でHTTPSのURLが払い出されます。

## 動作確認

- `https://<発行されたドメイン>/api/meta` がJSONを返せばサーバーは正常。
- 食事を記録 → 再デプロイ → データが残っていれば、ボリュームが正しく効いています。

## 他ホストでも同じ

`DATA_DIR` を永続ディスクのパスに向け、`npm start` を常駐で動かせれば、
Render（要 Persistent Disk）・Fly.io・VPS などでも同じ要領で動きます。
