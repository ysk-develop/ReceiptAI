/**
 * ReceiptAI — Google Apps Script
 * 正本: 帳簿ごとのスプレッドシート / 画像: 各帳簿フォルダ/images
 * API: doPost + doGet(JSONP可)
 *
 * 【セットアップ】
 * 1. このコードを貼付け（同じフォルダに appsscript.json も配置）
 * 2. 初回はエディタで setupReceiptAI() を実行（帳簿・シート・フォルダ作成＋権限許可）
 * 3. デプロイ → ウェブアプリ（実行:自分 / アクセス:全員）
 * 4. /exec URL をスマホ・PCアプリに設定
 * 5. コード変更後は必ず「新バージョン」で再デプロイ
 *
 * 任意: FOLDER_ID をルート固定したい場合のみ下に記入
 * （旧 SPREADSHEET_ID 単一運用は setup 時に「テスト用」へ移行）
 */
var FOLDER_ID = '';
var LEGACY_SPREADSHEET_ID = ''; // 旧単一シート移行用（通常は空でOK）
var SHEET_NAME = 'receipts';
var BOOKS_PROP = 'BOOKS_V1';
var DEFAULT_BOOK_NAMES = ['テスト用', 'あーちゃん用'];
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
  'image_view_url',
  'payment_method'
];

function doPost(e) {
  try {
    var data = parseIncoming_(e);
    var action = data.action || 'save';
    if (action === 'save') {
      return respond_(e, saveReceipt_(data));
    }
    if (action === 'delete') {
      return respond_(e, deleteReceipt_(data.book || data.book_id || '', data.id || data.receipt_id, data.delete_image !== false));
    }
    if (action === 'book_add') {
      return respond_(e, addBook_(data.name || ''));
    }
    if (action === 'book_rename') {
      return respond_(e, renameBook_(data.id || data.book || data.book_id || '', data.name || ''));
    }
    if (action === 'book_delete') {
      return respond_(e, deleteBook_(data.id || data.book || data.book_id || '', data.delete_data !== false));
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
    var bookId = p.book || p.book_id || '';
    var result;
    if (action === 'ping') {
      result = ping_(bookId);
    } else if (action === 'books') {
      result = listBooks_();
    } else if (action === 'book_add') {
      result = addBook_(p.name || '');
    } else if (action === 'book_rename') {
      result = renameBook_(p.id || bookId, p.name || '');
    } else if (action === 'book_delete') {
      result = deleteBook_(p.id || bookId, p.delete_data !== '0');
    } else if (action === 'list') {
      result = listReceipts_(bookId, p.month || '', Number(p.limit || 50));
    } else if (action === 'receipt') {
      result = getReceipt_(bookId, p.id || '');
    } else if (action === 'image') {
      result = getImageMeta_(p.id || '', p.data === '1' || p.data === 'true');
    } else if (action === 'delete') {
      result = deleteReceipt_(bookId, p.id || '', p.delete_image !== '0');
    } else if (action === 'duplicates') {
      result = findDuplicates_(
        bookId,
        p.shop || p.shop_name || '',
        p.date || '',
        Number(p.total || p.total_amount || 0),
        p.items != null && p.items !== '' ? Number(p.items) : null
      );
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
  var root = getRootFolder_();
  var books = ensureBooksInitialized_();
  Logger.log('root=' + root.getUrl());
  for (var i = 0; i < books.length; i++) {
    var b = books[i];
    var sheet = getSheetForBook_(b);
    Logger.log(
      'book=' + b.name + ' id=' + b.id +
      ' folder=' + DriveApp.getFolderById(b.folderId).getUrl() +
      ' sheet=' + SpreadsheetApp.openById(b.spreadsheetId).getUrl() +
      ' rows=' + sheet.getLastRow()
    );
  }
}

function testWrite() {
  var books = ensureBooksInitialized_();
  var book = books[0];
  var result = saveReceipt_({
    book: book.id,
    shop_name: 'テスト店',
    date: Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy-MM-dd'),
    total_amount: 100,
    items: [{ name: 'テスト品', price: 100, category: 'その他' }]
  });
  Logger.log(JSON.stringify(result));
}

function ping_(bookId) {
  var books = ensureBooksInitialized_();
  var out = {
    status: 'ok',
    app: 'ReceiptAI',
    mode: 'spreadsheet_books',
    folderUrl: getRootFolder_().getUrl(),
    books: booksPublic_(books)
  };
  if (bookId) {
    var book = resolveBook_(bookId);
    out.book = bookPublic_(book);
    out.spreadsheetUrl = SpreadsheetApp.openById(book.spreadsheetId).getUrl();
    out.spreadsheetId = book.spreadsheetId;
    out.imagesFolderUrl = getImagesFolderForBook_(book).getUrl();
    out.sheetName = SHEET_NAME;
  } else if (books.length === 1) {
    out.book = bookPublic_(books[0]);
    out.spreadsheetUrl = SpreadsheetApp.openById(books[0].spreadsheetId).getUrl();
  }
  return out;
}

function listBooks_() {
  return {
    status: 'ok',
    books: booksPublic_(ensureBooksInitialized_())
  };
}

function addBook_(name) {
  name = String(name || '').trim();
  if (!name) throw new Error('帳簿名が空です');
  if (name.length > 40) throw new Error('帳簿名は40文字以内にしてください');
  var books = ensureBooksInitialized_();
  for (var i = 0; i < books.length; i++) {
    if (books[i].name === name) throw new Error('同名の帳簿が既にあります: ' + name);
  }
  var book = createBookFolderAndSheet_(name, null);
  books.push(book);
  saveBooks_(books);
  return { status: 'ok', book: bookPublic_(book), books: booksPublic_(books) };
}

function renameBook_(bookId, name) {
  name = String(name || '').trim();
  if (!name) throw new Error('帳簿名が空です');
  if (name.length > 40) throw new Error('帳簿名は40文字以内にしてください');
  var books = ensureBooksInitialized_();
  var book = null;
  var idx = -1;
  for (var i = 0; i < books.length; i++) {
    if (books[i].id === String(bookId)) {
      book = books[i];
      idx = i;
      break;
    }
  }
  if (!book) throw new Error('帳簿が見つかりません');
  for (var j = 0; j < books.length; j++) {
    if (j !== idx && books[j].name === name) {
      throw new Error('同名の帳簿が既にあります: ' + name);
    }
  }
  book.name = name;
  try {
    DriveApp.getFolderById(book.folderId).setName(name);
  } catch (_) {}
  try {
    SpreadsheetApp.openById(book.spreadsheetId).rename('ReceiptAI - ' + name);
  } catch (_) {}
  books[idx] = book;
  saveBooks_(books);
  return { status: 'ok', book: bookPublic_(book), books: booksPublic_(books) };
}

function deleteBook_(bookId, deleteData) {
  var books = ensureBooksInitialized_();
  if (books.length <= 1) {
    throw new Error('帳簿は少なくとも1つ必要です。削除する前に別の帳簿を追加してください。');
  }
  var kept = [];
  var target = null;
  for (var i = 0; i < books.length; i++) {
    if (books[i].id === String(bookId)) target = books[i];
    else kept.push(books[i]);
  }
  if (!target) throw new Error('帳簿が見つかりません');
  if (deleteData !== false) {
    try {
      DriveApp.getFolderById(target.folderId).setTrashed(true);
    } catch (_) {}
    try {
      DriveApp.getFileById(target.spreadsheetId).setTrashed(true);
    } catch (_) {}
  }
  saveBooks_(kept);
  return { status: 'ok', deleted: bookPublic_(target), books: booksPublic_(kept) };
}

function saveReceipt_(data) {
  var book = resolveBook_(data.book || data.book_id || '');
  var items = data.items || [];
  if (!items.length) throw new Error('明細が空です');
  var dateStr = normalizeDateCell_(data.date);
  if (!dateStr) throw new Error('日付がありません');

  var shop = String(data.shop_name || '不明');
  var total = Number(data.total_amount);
  if (!total) {
    total = 0;
    for (var i = 0; i < items.length; i++) total += Number(items[i].price || 0);
  }

  var receiptId = String(data.receipt_id || Utilities.getUuid());
  var createdAt = formatNowTokyo_();
  var imageInfo = saveImageIfPresent_(book, data, receiptId, shop);
  var payment = String(data.payment_method || data.paymentMethod || '現金').trim() || '現金';

  var sheet = getSheetForBook_(book);
  var startRow = sheet.getLastRow() + 1;
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
      imageInfo.viewUrl || '',
      payment
    ]);
  }
  sheet.getRange(startRow, 1, rows.length, HEADERS.length).setValues(rows);
  sheet.getRange(startRow, 1, rows.length, 1).setNumberFormat('@');
  sheet.getRange(startRow, 3, rows.length, 1).setNumberFormat('@');

  return {
    status: 'success',
    book_id: book.id,
    book_name: book.name,
    receipt_id: receiptId,
    rows: rows.length,
    created_at: createdAt,
    date: dateStr,
    payment_method: payment,
    image_file_id: imageInfo.fileId || '',
    image_view_url: imageInfo.viewUrl || '',
    spreadsheetUrl: SpreadsheetApp.openById(book.spreadsheetId).getUrl()
  };
}

function listReceipts_(bookId, month, limit) {
  var book = resolveBook_(bookId);
  limit = Math.min(Math.max(limit || 50, 1), 200);
  var sheet = getSheetForBook_(book);
  var last = sheet.getLastRow();
  if (last < 2) return { status: 'ok', book_id: book.id, receipts: [] };

  var values = sheet.getRange(2, 1, last - 1, HEADERS.length).getValues();
  var map = {};
  for (var i = 0; i < values.length; i++) {
    var row = values[i];
    var rid = String(row[1] || '');
    if (!rid) continue;
    var dateStr = normalizeDateCell_(row[2]);
    var createdAt = normalizeDateTimeCell_(row[0]);
    if (month) {
      var key = monthKey_(dateStr) || monthKey_(createdAt);
      if (key !== String(month)) continue;
    }
    if (!map[rid]) {
      map[rid] = {
        receipt_id: rid,
        created_at: createdAt,
        date: dateStr,
        shop_name: String(row[3] || ''),
        total_amount: Number(row[4] || 0),
        image_file_id: String(row[8] || ''),
        image_view_url: String(row[9] || ''),
        payment_method: String(row[10] || '現金').trim() || '現金',
        item_count: 0
      };
    }
    map[rid].item_count += 1;
    if (!map[rid].image_file_id && row[8]) {
      map[rid].image_file_id = String(row[8]);
      map[rid].image_view_url = String(row[9] || '');
    }
    if ((!map[rid].payment_method || map[rid].payment_method === '現金') && row[10]) {
      map[rid].payment_method = String(row[10]).trim() || map[rid].payment_method;
    }
  }

  var list = [];
  for (var k in map) list.push(map[k]);
  list.sort(function (a, b) {
    if (a.date === b.date) return a.created_at < b.created_at ? 1 : -1;
    return a.date < b.date ? 1 : -1;
  });
  return { status: 'ok', book_id: book.id, receipts: list.slice(0, limit) };
}

function findDuplicates_(bookId, shop, dateStr, total, itemCount) {
  var book = resolveBook_(bookId);
  var shopKey = normalizeShopKey_(shop);
  var day = dayKey_(dateStr);
  var totalN = Math.round(Number(total) || 0);
  var wantItems = itemCount != null && !isNaN(Number(itemCount)) ? Number(itemCount) : null;

  if (!shopKey || !day) {
    return {
      status: 'ok',
      book_id: book.id,
      duplicates: [],
      match: { shop: shop, date: day, total: totalN, item_count: wantItems }
    };
  }

  var sheet = getSheetForBook_(book);
  var last = sheet.getLastRow();
  if (last < 2) {
    return {
      status: 'ok',
      book_id: book.id,
      duplicates: [],
      match: { shop: shop, date: day, total: totalN, item_count: wantItems }
    };
  }

  var values = sheet.getRange(2, 1, last - 1, HEADERS.length).getValues();
  var map = {};
  for (var i = 0; i < values.length; i++) {
    var row = values[i];
    var rid = String(row[1] || '');
    if (!rid) continue;
    if (!map[rid]) {
      map[rid] = {
        receipt_id: rid,
        created_at: normalizeDateTimeCell_(row[0]),
        date: normalizeDateCell_(row[2]),
        shop_name: String(row[3] || ''),
        total_amount: Number(row[4] || 0),
        item_count: 0
      };
    }
    map[rid].item_count += 1;
  }

  var dupes = [];
  for (var k in map) {
    if (!map.hasOwnProperty(k)) continue;
    var r = map[k];
    if (normalizeShopKey_(r.shop_name) !== shopKey) continue;
    if (dayKey_(r.date) !== day) continue;
    if (Math.round(Number(r.total_amount) || 0) !== totalN) continue;
    if (wantItems != null && Number(r.item_count) !== wantItems) continue;
    dupes.push(r);
  }

  dupes.sort(function (a, b) {
    return a.created_at < b.created_at ? 1 : -1;
  });

  return {
    status: 'ok',
    book_id: book.id,
    duplicates: dupes.slice(0, 10),
    match: { shop: shop, date: day, total: totalN, item_count: wantItems }
  };
}

function normalizeShopKey_(s) {
  return String(s || '')
    .replace(/[ 　\t\r\n]+/g, '')
    .toLowerCase();
}

function dayKey_(dateStr) {
  var n = normalizeDateCell_(dateStr);
  var m = String(n).match(/(\d{4})[\/\-](\d{1,2})[\/\-](\d{1,2})/);
  if (!m) return '';
  return m[1] + '-' + pad2_(m[2]) + '-' + pad2_(m[3]);
}

function deleteReceipt_(bookId, receiptId, deleteImage) {
  var book = resolveBook_(bookId);
  receiptId = String(receiptId || '').trim();
  if (!receiptId) throw new Error('id が空です');

  var sheet = getSheetForBook_(book);
  var last = sheet.getLastRow();
  if (last < 2) return { status: 'error', message: 'not found' };

  var values = sheet.getRange(2, 1, last - 1, HEADERS.length).getValues();
  var rowNums = [];
  var imageIds = {};
  for (var i = 0; i < values.length; i++) {
    if (String(values[i][1]) !== receiptId) continue;
    rowNums.push(i + 2);
    var imgId = String(values[i][8] || '').trim();
    if (imgId) imageIds[imgId] = true;
  }
  if (!rowNums.length) return { status: 'error', message: 'not found' };

  rowNums.sort(function (a, b) { return b - a; });
  for (var j = 0; j < rowNums.length; j++) {
    sheet.deleteRow(rowNums[j]);
  }

  var deletedImages = [];
  if (deleteImage !== false) {
    last = sheet.getLastRow();
    var stillUsed = {};
    if (last >= 2) {
      values = sheet.getRange(2, 1, last - 1, HEADERS.length).getValues();
      for (var k = 0; k < values.length; k++) {
        var fid = String(values[k][8] || '').trim();
        if (fid) stillUsed[fid] = true;
      }
    }
    for (var key in imageIds) {
      if (!imageIds.hasOwnProperty(key)) continue;
      if (stillUsed[key]) continue;
      try {
        DriveApp.getFileById(key).setTrashed(true);
        deletedImages.push(key);
      } catch (_) {}
    }
  }

  return {
    status: 'ok',
    book_id: book.id,
    receipt_id: receiptId,
    deleted_rows: rowNums.length,
    deleted_images: deletedImages
  };
}

function getReceipt_(bookId, receiptId) {
  var book = resolveBook_(bookId);
  if (!receiptId) throw new Error('id が空です');
  var sheet = getSheetForBook_(book);
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
        created_at: normalizeDateTimeCell_(row[0]),
        date: normalizeDateCell_(row[2]),
        shop_name: String(row[3] || ''),
        total_amount: Number(row[4] || 0),
        image_file_id: String(row[8] || ''),
        image_view_url: String(row[9] || ''),
        payment_method: String(row[10] || '現金').trim() || '現金'
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
  meta.book_id = book.id;
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
    view_url: 'https://drive.google.com/uc?export=view&id=' + fileId
  };
  if (includeData) {
    var bytes = blob.getBytes();
    if (bytes.length > 4 * 1024 * 1024) {
      throw new Error('画像が大きすぎます（4MB超）。再撮影または再保存してください。');
    }
    result.data_base64 = Utilities.base64Encode(bytes);
  }
  return result;
}

function saveImageIfPresent_(book, data, receiptId, shop) {
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

  var mime = data.image_mime || data.imageMime || 'image/jpeg';
  var m = String(b64).match(/^data:([^;]+);base64,(.+)$/);
  if (m) {
    mime = m[1];
    b64 = m[2];
  }

  var bytes = Utilities.base64Decode(b64);
  var blob = Utilities.newBlob(bytes, mime, buildImageName_(receiptId, shop));
  var file = getImagesFolderForBook_(book).createFile(blob);
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

/* ===== Books / Drive ===== */

function getRootFolder_() {
  if (FOLDER_ID) return DriveApp.getFolderById(FOLDER_ID);
  var it = DriveApp.getFoldersByName('ReceiptAI');
  if (it.hasNext()) return it.next();
  return DriveApp.createFolder('ReceiptAI');
}

function loadBooks_() {
  var props = PropertiesService.getScriptProperties();
  var raw = props.getProperty(BOOKS_PROP) || '';
  if (!raw) return [];
  try {
    var arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr : [];
  } catch (_) {
    return [];
  }
}

function saveBooks_(books) {
  PropertiesService.getScriptProperties().setProperty(BOOKS_PROP, JSON.stringify(books));
}

function booksPublic_(books) {
  var out = [];
  for (var i = 0; i < books.length; i++) out.push(bookPublic_(books[i]));
  return out;
}

function bookPublic_(book) {
  return {
    id: book.id,
    name: book.name,
    folderId: book.folderId,
    spreadsheetId: book.spreadsheetId
  };
}

function ensureBooksInitialized_() {
  var books = loadBooks_();
  if (books.length) return books;

  var root = getRootFolder_();
  var legacySsId = findLegacySpreadsheetId_(root);
  var created = [];

  var first = createBookFolderAndSheet_(DEFAULT_BOOK_NAMES[0], legacySsId);
  created.push(first);

  for (var i = 1; i < DEFAULT_BOOK_NAMES.length; i++) {
    created.push(createBookFolderAndSheet_(DEFAULT_BOOK_NAMES[i], null));
  }

  saveBooks_(created);
  // 旧単一シートキャッシュは帳簿管理へ移行済み
  try {
    PropertiesService.getScriptProperties().deleteProperty('SPREADSHEET_ID');
  } catch (_) {}
  return created;
}

function findLegacySpreadsheetId_(root) {
  var fixed = String(LEGACY_SPREADSHEET_ID || '').trim();
  if (fixed) return fixed;
  var props = PropertiesService.getScriptProperties();
  var cached = props.getProperty('SPREADSHEET_ID') || '';
  if (cached) return cached;
  var files = root.getFilesByName('ReceiptAI');
  while (files.hasNext()) {
    var f = files.next();
    if (f.getMimeType() === MimeType.GOOGLE_SHEETS) return f.getId();
  }
  return '';
}

function createBookFolderAndSheet_(name, reuseSpreadsheetId) {
  var root = getRootFolder_();
  var folder = findOrCreateChildFolder_(root, name);
  var images = findOrCreateChildFolder_(folder, 'images');

  // ルート直下の旧 images を最初の帳簿へ寄せる（再利用時のみ）
  if (reuseSpreadsheetId) {
    try {
      var rootImages = root.getFoldersByName('images');
      if (rootImages.hasNext()) {
        var oldImg = rootImages.next();
        var files = oldImg.getFiles();
        while (files.hasNext()) {
          try {
            var file = files.next();
            file.moveTo(images);
          } catch (_) {}
        }
      }
    } catch (_) {}
  }

  var ssId = String(reuseSpreadsheetId || '').trim();
  var ss;
  if (ssId) {
    try {
      ss = SpreadsheetApp.openById(ssId);
    } catch (err) {
      throw authFriendlyError_(err);
    }
    try {
      var ssFile = DriveApp.getFileById(ssId);
      ssFile.moveTo(folder);
    } catch (_) {}
    try {
      ss.rename('ReceiptAI - ' + name);
    } catch (_) {}
  } else {
    ss = SpreadsheetApp.create('ReceiptAI - ' + name);
    ssId = ss.getId();
    try {
      DriveApp.getFileById(ssId).moveTo(folder);
    } catch (_) {
      try {
        folder.addFile(DriveApp.getFileById(ssId));
        DriveApp.getRootFolder().removeFile(DriveApp.getFileById(ssId));
      } catch (_) {}
    }
  }

  var book = {
    id: Utilities.getUuid().replace(/-/g, '').slice(0, 12),
    name: name,
    folderId: folder.getId(),
    spreadsheetId: ssId
  };
  getSheetForBook_(book);
  return book;
}

function findOrCreateChildFolder_(parent, name) {
  var it = parent.getFoldersByName(name);
  if (it.hasNext()) return it.next();
  return parent.createFolder(name);
}

function resolveBook_(bookId) {
  var books = ensureBooksInitialized_();
  var id = String(bookId || '').trim();
  if (!id) {
    if (books.length === 1) return books[0];
    throw new Error('帳簿を選択してください（設定の帳簿セレクト）');
  }
  for (var i = 0; i < books.length; i++) {
    if (books[i].id === id) return books[i];
  }
  throw new Error('帳簿が見つかりません。設定で帳簿一覧を再取得してください。');
}

function getImagesFolderForBook_(book) {
  var folder = DriveApp.getFolderById(book.folderId);
  return findOrCreateChildFolder_(folder, 'images');
}

function getSheetForBook_(book) {
  var ss;
  try {
    ss = SpreadsheetApp.openById(book.spreadsheetId);
  } catch (err) {
    throw authFriendlyError_(err);
  }
  var sheet = ss.getSheetByName(SHEET_NAME);
  if (!sheet) sheet = ss.insertSheet(SHEET_NAME);
  ensureSheetHeaders_(sheet);
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

/** ヘッダー整備（payment_method など後から増えた列を追加） */
function ensureSheetHeaders_(sheet) {
  if (sheet.getLastRow() === 0) {
    sheet.getRange(1, 1, 1, HEADERS.length).setValues([HEADERS]);
    sheet.setFrozenRows(1);
    return;
  }
  var cols = Math.max(sheet.getLastColumn(), 1);
  var existing = sheet.getRange(1, 1, 1, cols).getValues()[0];
  if (String(existing[0]) !== HEADERS[0]) {
    sheet.insertRowBefore(1);
    sheet.getRange(1, 1, 1, HEADERS.length).setValues([HEADERS]);
    sheet.setFrozenRows(1);
    return;
  }
  var names = {};
  for (var i = 0; i < existing.length; i++) {
    names[String(existing[i] || '')] = true;
  }
  for (var h = 0; h < HEADERS.length; h++) {
    if (names[HEADERS[h]]) continue;
    var col = sheet.getLastColumn() + 1;
    sheet.getRange(1, col).setValue(HEADERS[h]);
    names[HEADERS[h]] = true;
  }
  sheet.setFrozenRows(1);
}

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

function formatNowTokyo_() {
  return Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy/MM/dd HH:mm:ss');
}

function isDateObject_(v) {
  return Object.prototype.toString.call(v) === '[object Date]' && !isNaN(v.getTime());
}

function normalizeDateCell_(value) {
  if (isDateObject_(value)) {
    var hasTime = value.getHours() || value.getMinutes() || value.getSeconds();
    return Utilities.formatDate(
      value,
      'Asia/Tokyo',
      hasTime ? 'yyyy/MM/dd HH:mm:ss' : 'yyyy/MM/dd'
    );
  }
  var s = String(value == null ? '' : value).trim();
  if (!s) return '';
  var m = s.match(
    /(\d{4})[\/\-年.](\d{1,2})[\/\-月.](\d{1,2})(?:[ T日]\s*(\d{1,2}):(\d{1,2})(?::(\d{1,2}))?)?/
  );
  if (m) {
    var out = m[1] + '/' + pad2_(m[2]) + '/' + pad2_(m[3]);
    if (m[4] != null) {
      out += ' ' + pad2_(m[4]) + ':' + pad2_(m[5]) + ':' + pad2_(m[6] || '0');
    }
    return out;
  }
  var d = new Date(s);
  if (!isNaN(d.getTime())) {
    var ht = d.getHours() || d.getMinutes() || d.getSeconds();
    return Utilities.formatDate(
      d,
      'Asia/Tokyo',
      ht ? 'yyyy/MM/dd HH:mm:ss' : 'yyyy/MM/dd'
    );
  }
  return s;
}

function normalizeDateTimeCell_(value) {
  if (isDateObject_(value)) {
    return Utilities.formatDate(value, 'Asia/Tokyo', 'yyyy/MM/dd HH:mm:ss');
  }
  var s = String(value == null ? '' : value).trim();
  if (!s) return '';
  var m = s.match(
    /(\d{4})[\/\-年.](\d{1,2})[\/\-月.](\d{1,2})(?:[ T日](\d{1,2}):(\d{1,2})(?::(\d{1,2}))?)?/
  );
  if (m) {
    var out = m[1] + '/' + pad2_(m[2]) + '/' + pad2_(m[3]);
    if (m[4] != null) {
      out += ' ' + pad2_(m[4]) + ':' + pad2_(m[5]) + ':' + pad2_(m[6] || '0');
    } else {
      out += ' 00:00:00';
    }
    return out;
  }
  var d = new Date(s);
  if (!isNaN(d.getTime())) {
    return Utilities.formatDate(d, 'Asia/Tokyo', 'yyyy/MM/dd HH:mm:ss');
  }
  return s;
}

function monthKey_(dateStr) {
  var s = String(dateStr || '');
  var m = s.match(/(\d{4})[\/\-](\d{1,2})/);
  if (!m) return '';
  return m[1] + '-' + pad2_(m[2]);
}

function pad2_(n) {
  var s = String(n);
  return s.length < 2 ? '0' + s : s;
}
