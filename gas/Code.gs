/**
 * Google Apps Script — レシート JSON 受け口
 *
 * 【重要】コードを変えたら必ず「デプロイ → デプロイを管理 → 編集 → 新バージョン」で再デプロイしてください。
 *
 * 使い方:
 * 1. script.google.com で新規プロジェクトを作成
 * 2. このファイルの内容を貼り付け
 * 3. （任意）FOLDER_ID を保存先フォルダの ID に変更。空のままなら「ReceiptAI」フォルダを自動作成
 * 4. デプロイ → 新しいデプロイ → ウェブアプリ
 *    - 実行ユーザー: 自分
 *    - アクセスできるユーザー: 全員（「Google アカウントを持つユーザー」ではなく「全員」）
 * 5. 発行された URL（末尾 /exec）を ReceiptAI の設定に保存
 *
 * 動作確認: ブラウザでその URL を開くと {"status":"ok","app":"ReceiptAI",...} と出ればOK
 */

/** 空文字のままなら My Drive に「ReceiptAI」フォルダを自動作成／利用します */
var FOLDER_ID = '';

function doPost(e) {
  try {
    var data = parseIncoming_(e);
    var folder = getTargetFolder_();
    var fileName = buildFileName_(data);
    folder.createFile(fileName, JSON.stringify(data, null, 2), MimeType.PLAIN_TEXT);

    return jsonOut_({
      status: 'success',
      fileName: fileName,
      folderName: folder.getName(),
      folderUrl: folder.getUrl()
    });
  } catch (err) {
    try {
      DriveApp.getRootFolder().createFile(
        'receiptai_error_' + Date.now() + '.txt',
        String(err) + '\n\nraw=' + safeRaw_(e),
        MimeType.PLAIN_TEXT
      );
    } catch (_) {}
    return jsonOut_({ status: 'error', message: String(err) });
  }
}

function doGet(e) {
  var ping = e && e.parameter && e.parameter.ping;
  if (ping === '1') {
    try {
      var folder = getTargetFolder_();
      return jsonOut_({
        status: 'ok',
        app: 'ReceiptAI',
        folderName: folder.getName(),
        folderUrl: folder.getUrl(),
        folderId: folder.getId()
      });
    } catch (err) {
      return jsonOut_({ status: 'error', message: String(err) });
    }
  }
  return jsonOut_({ status: 'ok', app: 'ReceiptAI', hint: 'Add ?ping=1 to verify Drive folder access' });
}

/** エディタから直接実行して Drive 書き込みを確認できます */
function testWrite() {
  var folder = getTargetFolder_();
  var name = 'receipt_test_' + Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyyMMdd_HHmmss') + '.json';
  folder.createFile(name, JSON.stringify({ test: true, at: new Date().toISOString() }, null, 2), MimeType.PLAIN_TEXT);
  Logger.log('Wrote ' + name + ' to ' + folder.getUrl());
}

function getTargetFolder_() {
  if (FOLDER_ID && FOLDER_ID.indexOf('ここに') === -1) {
    return DriveApp.getFolderById(FOLDER_ID);
  }
  var it = DriveApp.getFoldersByName('ReceiptAI');
  if (it.hasNext()) return it.next();
  return DriveApp.createFolder('ReceiptAI');
}

function parseIncoming_(e) {
  if (!e) throw new Error('リクエスト本体が空です');

  // text/plain JSON body（アプリからの通常送信）
  if (e.postData && e.postData.contents) {
    var contents = e.postData.contents;
    try {
      return JSON.parse(contents);
    } catch (err1) {
      // application/x-www-form-urlencoded: data=...
      var form = e.parameter || {};
      if (form.data) return JSON.parse(form.data);
      throw new Error('JSONの解析に失敗: ' + String(err1));
    }
  }

  // form / query
  if (e.parameter && e.parameter.data) {
    return JSON.parse(e.parameter.data);
  }

  throw new Error('postData も parameter.data もありません。デプロイ設定（全員アクセス）を確認してください。');
}

function buildFileName_(data) {
  var now = new Date();
  var timeStr = Utilities.formatDate(now, 'Asia/Tokyo', 'yyyyMMdd_HHmmss');
  var shop = String((data && data.shop_name) || 'unknown').replace(/[\\/:*?"<>|]/g, '_');
  return 'receipt_' + timeStr + '_' + shop + '.json';
}

function jsonOut_(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

function safeRaw_(e) {
  try {
    if (e && e.postData && e.postData.contents) return e.postData.contents.slice(0, 2000);
    if (e && e.parameter) return JSON.stringify(e.parameter).slice(0, 2000);
  } catch (_) {}
  return '(none)';
}
