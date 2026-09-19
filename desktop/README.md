# ReceiptAI デスクトップアプリ

スマホ（PWA）で Google ドライブに保存したレシート JSON を取り込み、SQLite に蓄積して一覧・編集・グラフ・CSV 出力する Windows 向けアプリです。

## 必要環境

- Python 3.10+
- Google Drive for Desktop（スマホ保存先フォルダが PC に同期されていること）

## セットアップ

```powershell
cd desktop
python -m pip install -r requirements.txt
python main.py
```

## 使い方

1. **設定**タブで、Drive 上の `ReceiptAI` フォルダのローカルパスを指定  
   例: `G:\マイドライブ\ReceiptAI`
2. **一覧** → **Driveから取込** で JSON を SQLite へ取り込み  
   - 取込済みファイルは内容ハッシュでスキップ  
   - オプションで `_imported` フォルダへ移動
3. **グラフ**でカテゴリ別パイチャート・月別棒グラフを表示
4. 必要なら **AI解析**タブで PC 上の画像／メモを Gemini 解析 → 編集 → 保存
5. **CSV出力**で Excel 用に書き出し

## データ保存場所

| 内容 | 場所 |
|------|------|
| SQLite DB | `%USERPROFILE%\.receiptai\receipts.db` |
| 設定 | `%USERPROFILE%\.receiptai\config.json` |

## スマホとの役割分担

| | スマホ PWA | PC アプリ |
|--|-----------|----------|
| 撮影・その場修正 | ○ | △（任意） |
| Drive へ JSON 送信 | ○ | — |
| 蓄積・集計・グラフ | — | ○ |
