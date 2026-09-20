# レシート自動仕分け家計簿

レシート写真またはテキストメモを Gemini API で解析し、**Google スプレッドシート**を正本として保存する PWA ＋ PyQt デスクトップアプリです。画像は長辺 1280px に縮小して Drive に保管し、必要なときだけ表示します。

UI は [EVCharge-Advisor](https://ysk-develop.github.io/EVCharge-Advisor/) と同系統のティール系デザインです。

## 構成

```
スマホ PWA ──解析・修正──┐
                         ├── GAS ──► スプレッドシート（正本）
PC PyQt  ──同期・集計───┘         └─ Drive/ReceiptAI/images（画像）
```

## スマホ（GitHub Pages）

https://ysk-develop.github.io/ReceiptAI/

### GAS 初回セットアップ

1. [Apps Script](https://script.google.com/) で新規プロジェクト
2. [`gas/Code.gs`](gas/Code.gs) を貼り付け
3. エディタで **`setupReceiptAI`** を実行（シート・フォルダ自動作成）
4. **デプロイ → ウェブアプリ**（実行:自分 / アクセス:**全員**）
5. `/exec` URL をアプリ設定に保存
6. コード変更後は必ず **新バージョン** で再デプロイ

### 使い方

1. 設定で Gemini API キー・GAS URL を保存
2. 写真選択（自動で 1280px JPEG 縮小）またはメモ → AI解析 → 修正
3. **スプレッドシートへ保存**（画像があれば images フォルダへ）
4. **履歴**タブで同期表示／**画像を表示**（リクエスト時のみ）

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
