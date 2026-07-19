# スマホウィジェット設定（Android）

ホーム画面に「今日の摂取カロリー」を常時表示し、ワンタップで食材のグラム数を記録するための設定です。
アプリ本体（Webアプリ）はそのまま使えます。ウィジェットは **Tasker + KWGT** から下記のAPIを叩く構成です。

## 0. 前提: アクセストークンの設定

APIにトークン認証を入れたため、まず Vercel に環境変数を設定します。

1. 適当な長い文字列を生成する（例: `openssl rand -hex 24`）
2. Vercel のプロジェクト設定 → Environment Variables に `API_TOKEN` = その文字列 を追加
3. 再デプロイ

これ以降、ブラウザで初めて開くときは一度だけトークンの入力を求められます（`https://<あなたのアプリ>/?token=<トークン>` で開けば自動保存されます）。
保存先は端末の localStorage なので、以後は再入力不要です。

> `API_TOKEN` を設定しない間は従来どおり認証なしで動きます（ローカル開発用）。ただし公開URLでは必ず設定してください。

## 1. 使用するAPI

いずれも `x-api-token` ヘッダ、または `?token=<トークン>` でトークンを渡します。
Tasker からはクエリの方が簡単です。

### 今日のカロリー取得（表示用）

```
GET https://<あなたのアプリ>/api/widget/today?date=2026-07-19&token=<トークン>
```

```json
{
  "date": "2026-07-19",
  "calories": 1420,
  "ref": 2000,
  "status": "適正",
  "percent": 71,
  "partial": false,
  "unregisteredCount": 3
}
```

- `date` は **端末のローカル日付を渡してください**。省略するとサーバー(UTC)基準になり、日本時間の早朝に前日扱いになります
- `status` は履歴の「不足・過剰チェック」と同じ判定（不足 / 適正 / 過剰）
- `percent` は目安に対する割合。KWGT の進捗リングにそのまま使えます
- `partial` が `true` の日は、栄養データ未登録の食材が含まれるため実際の値はこれより多くなります

### ワンタップ記録（入力用）

```
GET https://<あなたのアプリ>/api/widget/log?food=ごはん&grams=150&date=2026-07-19&token=<トークン>
```

POSTではなく **GET + クエリ** で完結するので、Tasker の HTTP Request からそのまま呼べます。
レスポンスに記録後の合計カロリーが入るので、ウィジェットの即時更新に使えます。

```json
{ "ok": true, "foodName": "ごはん", "grams": 150, "date": "2026-07-19", "registered": true, "calories": 1654 }
```

- `registered: false` は食材マスタに無かった場合。記録自体は保存され、あとでアプリの「未登録」画面から栄養データを補完できます

## 2. Tasker 側の設定

### タスク A: カロリー取得（`GetCalories`）

1. **HTTP Request**
   - Method: `GET`
   - URL: `https://<あなたのアプリ>/api/widget/today?date=%DATE_ISO&token=<トークン>`
   - ※ `%DATE_ISO` は下記の変数で作る
2. 直前に **Variable Set** で `%DATE_ISO` を `%YEAR-%MONTH-%DAY` にしておく
3. **Variable Set** `%CAL` を `%http_data` から JSON 抽出（Tasker の `%http_data.calories`）
4. 同様に `%REF` = `%http_data.ref`、`%PCT` = `%http_data.percent`、`%ST` = `%http_data.status`
5. **Variable Set** でグローバル変数 `%CALNOW`, `%CALPCT`, `%CALST` に代入（KWGTから参照するため）

### タスク B: グラム入力して記録（`LogFood`）

1. **Input → Dialog（Text/Number）** で食材名とグラム数を尋ねる
   - よく食べるものが決まっているなら、食材名は固定にしてグラム数だけ聞くのが最速です
2. **HTTP Request**
   - Method: `GET`
   - URL: `https://<あなたのアプリ>/api/widget/log?food=%FOOD&grams=%GRAMS&date=%DATE_ISO&token=<トークン>`
   - ※ 食材名に日本語やスペースが入るので **URLエンコードを有効に**
3. **Flash**（トースト）でレスポンスの `calories` を表示
4. タスクAを呼んでウィジェットを即時更新

### 定期更新

Tasker の **Profile → Time → Every 15 minutes** でタスクAを実行します。
Androidのウィジェットは自前で更新できるためiOSのような厳しい制限はありませんが、
バッテリーを考えると15〜30分間隔が現実的です。「常時最新」ではなくこの間隔で追従する形になります。

## 3. KWGT 側の設定

1. ホーム画面にKWGTウィジェットを配置
2. テキスト要素に `$gv(CALNOW)$ / $gv(CALPCT)$%` のように Tasker のグローバル変数を表示
3. 進捗リング（Progress）の値に `$gv(CALPCT)$` を割り当てる
4. 色を判定で変える場合の例:
   `$if(gv(CALST)="過剰", #FFE5484D, if(gv(CALST)="不足", #FFF5A524, #FF17C964))$`
5. タップ動作（Touch → Tasker Task）に **タスクB（LogFood）** を割り当てる

これでホーム画面に現在のカロリーが出て、タップするとグラム数入力ダイアログが開きます。

## 補足

- 面倒であれば KWGT を使わず、Tasker の **HTTP Request + Flash** だけをショートカットとしてホーム画面に置く形でも「ワンタップ記録」は実現できます（常時表示は諦める形）
- トークンはウィジェットの設定に平文で保存されます。端末を他人と共有している場合は注意してください
- トークンを変えたいときは Vercel の `API_TOKEN` を更新し、ブラウザ側は一度 localStorage をクリア（または `?token=` 付きURLで開き直し）してください
