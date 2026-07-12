# 栄養管理アプリ (app-diet)

毎日食べた食材と摂取量を入力すると、カロリー・主要栄養素・微量栄養素を自動計算し、
1日・1週間・1か月単位で集計・可視化するWebアプリです。

## 特徴
- **Vercel + Neon Postgres** — サーバーレス構成。DB は `@neondatabase/serverless` で HTTP 接続。
- ビルド不要のシンプルなフロントエンド（バニラJS / レスポンシブ対応）。

## 動作要件
- Node.js **22 以上**（確認: `node --version`）
- Neon Postgres の接続文字列（`DATABASE_URL`）

## 起動（ローカル開発）
```bash
# .env に DATABASE_URL=<Neonの接続文字列> を記載
npm install
npm run setup   # 初回のみ: テーブル作成 + 食材マスタ22件を投入
npm start       # または npm run dev
```
起動後、ブラウザで http://localhost:3000 を開きます。

ポートを変える場合: `PORT=8080 npm start`

デプロイ手順は [DEPLOY.md](./DEPLOY.md) を参照してください。

## LLM推定（未登録食材の栄養推定）
未登録食材を「🤖 推定して追加」すると、Anthropic API で100gあたり栄養素の**推定値**を下書き作成します。
推定値は必ず「推定値」と明示され、確定データと区別されます。

有効化するには環境変数を設定してください（未設定でもアプリは動作し、その場合は空の下書き＝手動入力になります）:
```bash
# PowerShell
$env:ANTHROPIC_API_KEY = "sk-ant-..."
npm start
```
使用モデルは既定で `claude-haiku-4-5-20251001`。`ANTHROPIC_MODEL` で変更可能。

## 画面
ホーム/ダッシュボード・食事入力・履歴・食材マスタ・未登録食材確認・週次/月次レポート・目標設定。

入力の手間を減らす工夫:
- 食材名のサジェスト
- よく食べる食材のクイック入力（タップでグラム数だけ変更して再入力）
- 前日の食事をコピー

## データの扱い（重要）
栄養素が不明な項目は `null`（データ未登録）として保存します。
計算時に `null` は **0扱いにせず**、合計欄に「一部未登録」と表示します。

## API
| Method | Path | 説明 |
|---|---|---|
| GET | `/api/foods` `?search=` | 食材一覧 / 検索・サジェスト |
| POST | `/api/foods` | 食材追加（同名の未登録記録を自動で紐付け直し） |
| PUT/DELETE | `/api/foods/:id` | 食材更新 / 削除 |
| POST | `/api/foods/estimate` | 未登録食材のLLM栄養推定 |
| GET | `/api/meals` `?date=` / `?start=&end=` | 食事一覧 |
| POST | `/api/meals` | 食事記録（未登録食材を自動判定） |
| PUT/DELETE | `/api/meals/:id` | 食事更新 / 削除 |
| POST | `/api/meals/copy` | 日付間コピー `{from,to}` |
| GET | `/api/nutrition/daily` `?date=` | 日次集計 |
| GET | `/api/nutrition/weekly` `?start=` | 週次集計（7日） |
| GET | `/api/nutrition/monthly` `?month=YYYY-MM` | 月次集計 |
| GET | `/api/dashboard` `?date=` | ダッシュボード用まとめ |
| GET/PUT | `/api/goals` | 目標設定 |
| GET/POST/DELETE | `/api/body` | 体重・体脂肪率・内臓脂肪の記録（日付ごと1セット） |
| GET/POST/DELETE | `/api/energy` | 当日の消費カロリー（日付ごと1値） |
| GET | `/api/export` `?start=&end=` | 期間指定でデータをZIPエクスポート |
| POST | `/api/import` `?mode=skip\|overwrite&goals=0\|1` | ZIPをインポート（本文=ZIPバイナリ） |

## データのバックアップ・移行（エクスポート／インポート）
「目標設定」画面に **エクスポート／インポート** があります。
- **エクスポート**: 開始日・終了日を指定して ZIP を書き出し（食事・消費カロリー・体組成が期間対象。食材マスタと目標は常に全件同梱）。標準的なZIP形式で、Windowsの「すべて展開」でも開けます。
- **インポート**: エクスポートしたZIPを取り込み。食材は「名前」で突き合わせ、食事は完全一致する重複を自動スキップ。日付が重複する消費カロリー・体組成は「スキップ／上書き」を選択可能。目標設定はチェックした場合のみ取り込み。

## バックアップ・移行
データの永続化は Neon Postgres が担います。手動のバックアップは「目標設定」画面の
**エクスポート**（ZIP）で行い、必要に応じて **インポート** で復元・移行できます。

## 構成
```
server.js          HTTPサーバー + ルーティング + APIハンドラ（ローカル/Vercel共通のエントリ）
src/nutrients.js   栄養素定義（19項目）・食事区分
src/seed.js        初期食材データ（100gあたり）
src/parse.js       貼り付けテキスト→食材データの解析（一括登録用）
src/db.js          Neon Postgres 接続 + スキーマ + シード
src/nutrition.js   栄養計算・集計（null=未登録の扱いを含む）
src/llm.js         LLM推定（Anthropic Messages API）
src/zip.js         依存なしのZIP読み書き（node:zlib のみ）
src/dataio.js      エクスポート/インポート処理
public/            index.html / styles.css / app.js（SPA）
```
