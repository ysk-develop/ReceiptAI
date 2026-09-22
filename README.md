# レシート自動仕分け家計簿

レシート写真またはテキストメモを Gemini API で解析し、**Google スプレッドシート**を正本として保存する PWA ＋ PyQt デスクトップアプリです。画像は長辺 1280px に縮小して Drive に保管し、必要なときだけ表示します。

UI は [EVCharge-Advisor](https://ysk-develop.github.io/EVCharge-Advisor/) と同系統のティール系デザインです。

## 構成

```
スマホ PWA ──解析・修正──┐
                         ├── GAS ──► 帳簿ごとスプレッドシート（正本）
PC PyQt  ──同期・集計───┘         └─ Drive/ReceiptAI/<帳簿名>/images
```

## スマホ（GitHub Pages）

https://ysk-develop.github.io/ReceiptAI/

### GAS 初回セットアップ

1. [Apps Script](https://script.google.com/) で新規プロジェクト
2. [`gas/Code.gs`](gas/Code.gs) を貼り付け。続けて **プロジェクトの設定** →「「appsscript.json」マニフェスト ファイルをエディタで表示する」をオンにし、[`gas/appsscript.json`](gas/appsscript.json) の内容（特に `oauthScopes`）を反映
3. エディタで **`setupReceiptAI`** を実行（初期帳簿「テスト用」「あーちゃん用」とシート・フォルダを自動作成）。**権限の確認**でスプレッドシート／Drive を許可
4. **デプロイ → ウェブアプリ**（実行:自分 / アクセス:**全員**）
5. `/exec` URL をアプリ設定に保存し、**帳簿**を選択（選択は端末に記憶）
6. コード変更後は必ず **新バージョン** で再デプロイ

履歴読み込みで `SpreadsheetApp.openById` の権限エラーが出る場合:

1. `gas/Code.gs` と `gas/appsscript.json` を最新に更新
2. エディタで **`setupReceiptAI`** を再実行し、追加の権限をすべて許可
3. デプロイ → ウェブアプリ → **新バージョン** で再デプロイ（URLは変わらないことが多い）

### 帳簿（複数家計簿）

- GAS URL は1つ。設定のセレクトで送信先帳簿を切り替えます（追加・名前変更・削除可）
- Drive は `ReceiptAI/<帳簿名>/` 配下にシートと `images` が分かれます
- 選んだ帳簿 ID は API キー・GAS URL と同様に端末へ保存されます

### 使い方

1. 設定で Gemini API キー・GAS URL・帳簿を保存
2. 写真選択（自動で 1280px JPEG 縮小）またはメモ → AI解析 → 修正
3. **スプレッドシートへ保存**（画像があれば当該帳簿の images へ）
4. **履歴**タブで同期表示／**画像を表示**（GAS経由で本体取得。Drive直リンクは使いません）

## 削除

履歴（スマホ）または一覧（PC）の **削除** で、スプレッドシート上の該当行を**物理削除**します。  
同一写真を共有する他レシートが残っている場合、Drive 画像は残します。参照が無くなった画像はゴミ箱へ移します。復元はできません。

## 重複チェック

保存時に **店名＋日付＋合計額** が一致する既存レシートがあると警告します。  
「新規として保存」か「キャンセル」を選べます（自動スキップはしません）。

## デスクトップ（PyQt6）

```powershell
cd desktop
python -m pip install -r requirements.txt
python main.py
```

1. 設定にスマホと同じ GAS URL を保存 → 接続テスト
2. **シートから同期**でローカル SQLite キャッシュを更新
3. グラフ・CSV・必要時の画像表示（ブラウザで開く）

## 注意

- 画像は表示用に「リンクを知っている全員が閲覧可」で保存されます（ID 推測は困難ですが、共有には注意）
- APIキーは端末ローカルのみに保存
- スプレッドシートが正本、PC の SQLite は高速表示用キャッシュです

## ファイル構成

```
├── index.html / css / js/   # スマホ PWA
├── gas/Code.gs              # シート＋画像 API
├── desktop/                 # PyQt6 アプリ
└── icons/
```
