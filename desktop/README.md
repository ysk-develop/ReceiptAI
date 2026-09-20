# ReceiptAI デスクトップ（PyQt6）

スプレッドシート（GAS）を正本とし、ローカル SQLite にキャッシュして一覧・編集・グラフ・CSV を行います。

## セットアップ

```powershell
cd desktop
python -m pip install -r requirements.txt
python main.py
```

## 使い方

1. **設定**にスマホと同じ GAS `/exec` URL を保存 → 接続テスト
2. **一覧 → シートから同期**
3. **画像**ボタンで Drive 上の原画像を表示（都度オープン）
4. （任意）AI解析タブで PC 画像を解析し、シートへ画像付き保存

## テスト

```powershell
$env:QT_QPA_PLATFORM = "offscreen"
python test_app.py -v
```
