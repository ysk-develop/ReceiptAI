/**
 * Google Apps Script — レシート JSON 受け口
 *
 * 使い方:
 * 1. script.google.com で新規プロジェクトを作成
 * 2. このファイルの内容を貼り付け
 * 3. FOLDER_ID を保存先フォルダの ID に変更
 * 4. デプロイ → 新しいデプロイ → ウェブアプリ
 *    - 実行ユーザー: 自分
 *    - アクセスできるユーザー: 全員
 * 5. 発行された URL を ReceiptAI の設定に保存
 */
function doPost(e) {
  try {
    const FOLDER_ID = 'ここにGoogleドライブのフォルダIDを入れる';
    const data = JSON.parse(e.postData.contents);
    const folder = DriveApp.getFolderById(FOLDER_ID);

    const now = new Date();
    const timeStr = Utilities.formatDate(now, 'Asia/Tokyo', 'yyyyMMdd_HHmmss');
    const shop = String(data.shop_name || 'unknown').replace(/[\\/:*?"<>|]/g, '_');
    const fileName = 'receipt_' + timeStr + '_' + shop + '.json';

    folder.createFile(fileName, JSON.stringify(data, null, 2), MimeType.PLAIN_TEXT);

    return ContentService
      .createTextOutput(JSON.stringify({ status: 'success' }))
      .setMimeType(ContentService.MimeType.JSON);
  } catch (err) {
    return ContentService
      .createTextOutput(JSON.stringify({ status: 'error', message: String(err) }))
      .setMimeType(ContentService.MimeType.JSON);
  }
}

function doGet() {
  return ContentService
    .createTextOutput(JSON.stringify({ status: 'ok', app: 'ReceiptAI' }))
    .setMimeType(ContentService.MimeType.JSON);
}
