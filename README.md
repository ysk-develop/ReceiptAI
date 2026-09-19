# レシート自動仕分け家計簿

レシート写真またはテキストメモを Gemini API で解析し、品目・金額・カテゴリを抽出して Google ドライブへ保存する PWA です。

UI・構成は [EVCharge-Advisor](https://ysk-develop.github.io/EVCharge-Advisor/) と同じスタイルです。

## 機能

- レシート写真を Gemini API で解析（複数枚が写っていても対応）
- テキストメモ（例:「ドラッグストア、ティッシュ 235円」）からも同じ形式で抽出
- 解析結果の一覧表示・インライン修正・明細行の追加
- 手入力のみでの明細追加
- 確定データを Google Apps Script（GAS）経由で Google ドライブへ JSON 保存
- モデル一覧を API から取得（プルダウン選択）
- APIキー・GAS URL は各端末の localStorage に保存

## GitHub Pages デプロイ手順

1. このリポジトリを GitHub にプッシュ
2. Settings → Pages → Source: `main` ブランチ、`/ (root)` を選択
3. 数分後 `https://<username>.github.io/<repo>/` でアクセス
4. iPhone: Safari で開く → 共有 → ホーム画面に追加

## 初回設定

1. **設定**タブで Gemini API キーを入力（「この端末に保存」にチェック）
2. **モデル一覧を取得**をタップし、モデルを選択
3. Google Apps Script をデプロイし、**GAS Web App URL** を保存（`gas/Code.gs` 参照）

## 使い方

1. **解析**タブでレシート写真を選択、またはテキストメモを入力
2. **AIで解析** → 内容を確認・修正
3. **Googleドライブへ保存** で JSON を送信

## Google Apps Script の準備

1. [Google Apps Script](https://script.google.com/) で新規プロジェクトを作成
2. `gas/Code.gs` の内容を貼り付け（`FOLDER_ID` は空のままでOK → My Drive に「ReceiptAI」フォルダを自動作成）
3. **デプロイ** → **新しいデプロイ** → 種類: ウェブアプリ
4. 実行ユーザー: 自分 / アクセスできるユーザー: **全員**（「Googleアカウントを持つユーザー」ではない）
5. 発行された URL（末尾 `/exec`）をアプリの設定に保存
6. コード変更後は必ず **デプロイを管理 → 編集 → 新バージョン** で再デプロイ

動作確認:
- ブラウザで `https://script.google.com/macros/s/.../exec?ping=1` を開く
- `{"status":"ok","folderName":"ReceiptAI",...}` と出ればOK
- エディタで `testWrite` を実行するとテストファイルが1つ作られます

## 注意

- 解析結果は参考です。保存前に金額・カテゴリを確認してください
- APIキーは localStorage に保存されます（端末・ブラウザごとに独立）
- ローカルファイル（`file://`）では動作しません。GitHub Pages 等の Web サーバー経由で開いてください
- 古い実装では CORS のため「成功したように見えても Drive に保存されない」ことがありました。最新の `Code.gs` へ更新＆再デプロイしてください

## デスクトップアプリ（PC）

スマホで Drive に溜めた JSON を取り込み、SQLite で蓄積・グラフ表示する Python アプリです。

```powershell
cd desktop
python -m pip install -r requirements.txt
python main.py
```

詳細は [desktop/README.md](desktop/README.md) を参照。

## ファイル構成

```
├── index.html              # スマホ PWA
├── manifest.json
├── service-worker.js
├── css/styles.css
├── js/
├── gas/Code.gs
├── desktop/                # PC アプリ
│   ├── main.py
│   ├── requirements.txt
│   └── receiptai/
└── icons/
```
