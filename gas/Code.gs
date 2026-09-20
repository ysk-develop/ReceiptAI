/**
 * ReceiptAI — Google Apps Script
 * 正本: スプレッドシート / 画像: Drive(images) / API: doPost + doGet(JSONP可)
 *
 * 【セットアップ】
 * 1. このコードを貼付け（同じフォルダに appsscript.json も配置）
 * 2. 初回はエディタで setupReceiptAI() を実行（シート・フォルダ作成＋権限許可）
 * 3. デプロイ → ウェブアプリ（実行:自分 / アクセス:全員）
 * 4. /exec URL をスマホ・PCアプリに設定
 * 5. コード変更後は必ず「新バージョン」で再デプロイ
 * 6. 「openById の権限がありません」が出たら setupReceiptAI を再実行して権限を再許可し、新バージョン再デプロイ
 *
 * 任意: SPREADSHEET_ID / FOLDER_ID を固定したい場合のみ下に記入
 */
var SPREADSHEET_ID = '';
var FOLDER_ID = '';
var SHEET_NAME = 'receipts';
var HEADERS = [
  'created_at',
  'receipt_id',
  'date',
  'shop_name',
  'total_amount',
  'item_name',
  'price',
  'category',
  'image_file_id',
  'image_view_url'
];

function doPost(e) {
  try {
    var data = parseIncoming_(e);
    var action = data.action || 'save';
    if (action === 'save') {
      return respond_(e, saveReceipt_(data));
    }
    return respond_(e, { status: 'error', message: 'unknown action: ' + action });
  } catch (err) {
    try {
      DriveApp.getRootFolder().createFile(
        'receiptai_error_' + Date.now() + '.txt',
        String(err) + '\n\nraw=' + safeRaw_(e),
        MimeType.PLAIN_TEXT
      );
    } catch (_) {}
    return respond_(e, { status: 'error', message: String(err) });
  }
}

function doGet(e) {
  try {
    var p = (e && e.parameter) || {};
    var action = p.action || (p.ping === '1' ? 'ping' : 'ping');
    var result;
    if (action === 'ping') {
      result = ping_();
    } else if (action === 'list') {
      result = listReceipts_(p.month || '', Number(p.limit || 50));
    } else if (action === 'receipt') {
      result = getReceipt_(p.id || '');
    } else if (action === 'image') {
      result = getImageMeta_(p.id || '', p.data === '1' || p.data === 'true');
    } else {
      result = { status: 'error', message: 'unknown action' };
    }
    return respond_(e, result);
  } catch (err) {
    return respond_(e, { status: 'error', message: String(err) });
  }
}

/** 初回セットアップ（エディタから実行） */
function setupReceiptAI() {
  var folder = getRootFolder_();
  var images = getImagesFolder_();
  var ss = getSpreadsheet_();
  var sheet = getSheet_();
  Logger.log('folder=' + folder.getUrl());
  Logger.log('images=' + images.getUrl());
  Logger.log('spreadsheet=' + ss.getUrl());
  Logger.log('sheet=' + sheet.getName() + ' rows=' + sheet.getLastRow());
}

function testWrite() {
  var result = saveReceipt_({
    shop_name: 'テスト店',
    date: Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy-MM-dd'),
    total_amount: 100,
    items: [{ name: 'テスト品', price: 100, category: 'その他' }]
  });
  Logger.log(JSON.stringify(result));
}

function ping_() {
  var folder = getRootFolder_();
  var images = getImagesFolder_();
  var ss = getSpreadsheet_();
  return {
    status: 'ok',
    app: 'ReceiptAI',
    mode: 'spreadsheet',
    folderName: folder.getName(),
    folderUrl: folder.getUrl(),
    imagesFolderUrl: images.getUrl(),
    spreadsheetUrl: ss.getUrl(),
    spreadsheetId: ss.getId(),
    sheetName: SHEET_NAME
  };
}

function saveReceipt_(data) {
  var items = data.items || [];
  if (!items.length) throw new Error('明細が空です');
  var dateStr = String(data.date || '').trim();
  if (!dateStr) throw new Error('日付がありません');

  var shop = String(data.shop_name || '不明');
  var total = Number(data.total_amount);
  if (!total) {
    total = 0;
    for (var i = 0; i < items.length; i++) total += Number(items[i].price || 0);
  }

  var receiptId = String(data.receipt_id || Utilities.getUuid());
  var createdAt = data.timestamp || new Date().toISOString();
  var imageInfo = saveImageIfPresent_(data, receiptId, shop);

  var sheet = getSheet_();
  var rows = [];
  for (var j = 0; j < items.length; j++) {
    var it = items[j] || {};
    rows.push([
      createdAt,
      receiptId,
      dateStr,
      shop,
      total,
      String(it.name || '（未入力）'),
      Number(it.price || 0),
      String(it.category || 'その他'),
      imageInfo.fileId || '',
      imageInfo.viewUrl || ''
    ]);
  }
  sheet.getRange(sheet.getLastRow() + 1, 1, rows.length, HEADERS.length).setValues(rows);

  return {
    status: 'success',
    receipt_id: receiptId,
    rows: rows.length,
    image_file_id: imageInfo.fileId || '',
    image_view_url: imageInfo.viewUrl || '',
    spreadsheetUrl: getSpreadsheet_().getUrl()
  };
}

function listReceipts_(month, limit) {
  limit = Math.min(Math.max(limit || 50, 1), 200);
  var sheet = getSheet_();
  var last = sheet.getLastRow();
  if (last < 2) return { status: 'ok', receipts: [] };

  var values = sheet.getRange(2, 1, last - 1, HEADERS.length).getValues();
  var map = {};
  for (var i = 0; i < values.length; i++) {
    var row = values[i];
    var rid = String(row[1] || '');
    if (!rid) continue;
    var dateStr = String(row[2] || '');
    if (month && dateStr.indexOf(month) !== 0) continue;
    if (!map[rid]) {
      map[rid] = {
        receipt_id: rid,
        created_at: String(row[0] || ''),
        date: dateStr,
        shop_name: String(row[3] || ''),
        total_amount: Number(row[4] || 0),
        image_file_id: String(row[8] || ''),
        image_view_url: String(row[9] || ''),
        item_count: 0
      };
    }
    map[rid].item_count += 1;
    if (!map[rid].image_file_id && row[8]) {
      map[rid].image_file_id = String(row[8]);
      map[rid].image_view_url = String(row[9] || '');
    }
  }

  var list = [];
  for (var k in map) list.push(map[k]);
  list.sort(function (a, b) {
    if (a.date === b.date) return a.created_at < b.created_at ? 1 : -1;
    return a.date < b.date ? 1 : -1;
  });
  return { status: 'ok', receipts: list.slice(0, limit) };
}

function getReceipt_(receiptId) {
  if (!receiptId) throw new Error('id が空です');
  var sheet = getSheet_();
  var last = sheet.getLastRow();
  if (last < 2) return { status: 'error', message: 'not found' };

  var values = sheet.getRange(2, 1, last - 1, HEADERS.length).getValues();
  var items = [];
  var meta = null;
  for (var i = 0; i < values.length; i++) {
    var row = values[i];
    if (String(row[1]) !== receiptId) continue;
    if (!meta) {
      meta = {
        receipt_id: receiptId,
        created_at: String(row[0] || ''),
        date: String(row[2] || ''),
        shop_name: String(row[3] || ''),
        total_amount: Number(row[4] || 0),
        image_file_id: String(row[8] || ''),
        image_view_url: String(row[9] || '')
      };
    }
    items.push({
      name: String(row[5] || ''),
      price: Number(row[6] || 0),
      category: String(row[7] || 'その他')
    });
  }
  if (!meta) return { status: 'error', message: 'not found' };
  meta.items = items;
  meta.status = 'ok';
  return meta;
}

function getImageMeta_(fileId, includeData) {
  if (!fileId) throw new Error('image id が空です');
  var file = DriveApp.getFileById(fileId);
  var blob = file.getBlob();
  var mime = blob.getContentType() || file.getMimeType() || 'image/jpeg';
  var result = {
    status: 'ok',
    file_id: fileId,
    name: file.getName(),
    mime: mime,
    // Drive直リンクはブラウザの <img> で失敗しやすい。表示は data=1 で本体取得を推奨
    view_url: 'https://drive.google.com/uc?export=view&id=' + fileId
  };
  if (includeData) {
    // 1280px JPEG 想定。極端に大きい場合は拒否してタイムアウト防止
    var bytes = blob.getBytes();
    if (bytes.length > 4 * 1024 * 1024) {
      throw new Error('画像が大きすぎます（4MB超）。再撮影または再保存してください。');
    }
    result.data_base64 = Utilities.base64Encode(bytes);
  }
  return result;
}

function saveImageIfPresent_(data, receiptId, shop) {
  // 同一写真の複数レシート用: 既に上げた画像IDを再利用
  var existingId = String(data.image_file_id || data.imageFileId || '').trim();
  var existingUrl = String(data.image_view_url || data.imageViewUrl || '').trim();
  if (existingId) {
    if (!existingUrl) {
      existingUrl = 'https://drive.google.com/uc?export=view&id=' + existingId;
    }
    return { fileId: existingId, viewUrl: existingUrl };
  }

  var b64 = data.image_base64 || data.imageBase64 || '';
  if (!b64) return { fileId: '', viewUrl: '' };

  // data URL 形式なら除去
  var mime = data.image_mime || data.imageMime || 'image/jpeg';
  var m = String(b64).match(/^data:([^;]+);base64,(.+)$/);
  if (m) {
    mime = m[1];
    b64 = m[2];
  }

  var bytes = Utilities.base64Decode(b64);
  var blob = Utilities.newBlob(bytes, mime, buildImageName_(receiptId, shop));
  var file = getImagesFolder_().createFile(blob);
  // 可能ならリンク共有も付けるが、表示は GAS action=image&data=1 が本線
  try {
    file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
  } catch (_) {}
  var viewUrl = 'https://drive.google.com/uc?export=view&id=' + file.getId();
  return { fileId: file.getId(), viewUrl: viewUrl };
}

function buildImageName_(receiptId, shop) {
  var safe = String(shop || 'receipt').replace(/[\\/:*?"<>|]/g, '_');
  return 'receipt_' + receiptId.slice(0, 8) + '_' + safe + '.jpg';
}

function getRootFolder_() {
  if (FOLDER_ID) return DriveApp.getFolderById(FOLDER_ID);
  var it = DriveApp.getFoldersByName('ReceiptAI');
  if (it.hasNext()) return it.next();
  return DriveApp.createFolder('ReceiptAI');
}

function getImagesFolder_() {
  var root = getRootFolder_();
  var it = root.getFoldersByName('images');
  if (it.hasNext()) return it.next();
  return root.createFolder('images');
}

function getSpreadsheet_() {
  var props = PropertiesService.getScriptProperties();
  var fixedId = String(SPREADSHEET_ID || '').trim();
  var cachedId = fixedId || props.getProperty('SPREADSHEET_ID') || '';

  if (cachedId) {
    try {
      return SpreadsheetApp.openById(cachedId);
    } catch (err) {
      if (!fixedId) props.deleteProperty('SPREADSHEET_ID');
      throw authFriendlyError_(err);
    }
  }

  var root = getRootFolder_();
  var files = root.getFilesByName('ReceiptAI');
  while (files.hasNext()) {
    var f = files.next();
    if (f.getMimeType() === MimeType.GOOGLE_SHEETS) {
      try {
        var existing = SpreadsheetApp.openById(f.getId());
        props.setProperty('SPREADSHEET_ID', f.getId());
        return existing;
      } catch (err) {
        throw authFriendlyError_(err);
      }
    }
  }

  var ss = SpreadsheetApp.create('ReceiptAI');
  var file = DriveApp.getFileById(ss.getId());
  root.addFile(file);
  try {
    DriveApp.getRootFolder().removeFile(file);
  } catch (_) {}
  props.setProperty('SPREADSHEET_ID', ss.getId());
  return ss;
}

/** openById 権限不足時の案内（再承認・再デプロイが必要） */
function authFriendlyError_(err) {
  var msg = String(err && err.message ? err.message : err);
  if (
    msg.indexOf('権限') >= 0 ||
    msg.indexOf('permission') >= 0 ||
    msg.indexOf('Authorization') >= 0 ||
    msg.indexOf('openById') >= 0
  ) {
    return new Error(
      'スプレッドシートを開く権限がありません。' +
      'GASエディタで setupReceiptAI を実行し、表示された権限をすべて許可したうえで、' +
      'デプロイ→ウェブアプリ→「新バージョン」で再デプロイしてください。' +
      '（必要な権限: spreadsheets / drive）詳細: ' + msg
    );
  }
  return err instanceof Error ? err : new Error(msg);
}

function getSheet_() {
  var ss = getSpreadsheet_();
  var sheet = ss.getSheetByName(SHEET_NAME);
  if (!sheet) sheet = ss.insertSheet(SHEET_NAME);
  if (sheet.getLastRow() === 0) {
    sheet.getRange(1, 1, 1, HEADERS.length).setValues([HEADERS]);
    sheet.setFrozenRows(1);
  } else {
    // ヘッダーが古い場合は先頭行を更新しない（既存データ保護）
    var first = sheet.getRange(1, 1, 1, HEADERS.length).getValues()[0];
    if (String(first[0]) !== HEADERS[0]) {
      sheet.insertRowBefore(1);
      sheet.getRange(1, 1, 1, HEADERS.length).setValues([HEADERS]);
      sheet.setFrozenRows(1);
    }
  }
  // 不要な Sheet1 を残さない
  var sheets = ss.getSheets();
  if (sheets.length > 1) {
    for (var i = 0; i < sheets.length; i++) {
      if (sheets[i].getName() !== SHEET_NAME && sheets[i].getLastRow() <= 1) {
        try { ss.deleteSheet(sheets[i]); } catch (_) {}
      }
    }
  }
  return sheet;
}

function parseIncoming_(e) {
  if (!e) throw new Error('リクエスト本体が空です');
  if (e.postData && e.postData.contents) {
    var contents = e.postData.contents;
    try {
      return JSON.parse(contents);
    } catch (err1) {
      if (e.parameter && e.parameter.data) return JSON.parse(e.parameter.data);
      throw new Error('JSONの解析に失敗: ' + String(err1));
    }
  }
  if (e.parameter && e.parameter.data) return JSON.parse(e.parameter.data);
  throw new Error('postData も parameter.data もありません');
}

function respond_(e, obj) {
  var callback = e && e.parameter && e.parameter.callback;
  var text = JSON.stringify(obj);
  if (callback) {
    return ContentService
      .createTextOutput(String(callback) + '(' + text + ')')
      .setMimeType(ContentService.MimeType.JAVASCRIPT);
  }
  return ContentService.createTextOutput(text).setMimeType(ContentService.MimeType.JSON);
}

function safeRaw_(e) {
  try {
    if (e && e.postData && e.postData.contents) return e.postData.contents.slice(0, 500);
    if (e && e.parameter) return JSON.stringify(e.parameter).slice(0, 500);
  } catch (_) {}
  return '(none)';
}
