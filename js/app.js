import {
  getApiKey, setApiKey, getModel, setModel,
  getModels, setModels, getGasUrl, setGasUrl
} from './storage.js';
import { CATEGORIES, normalizeCategory } from './categories.js';
import {
  fetchModels, analyzeReceipt, sendToGas, pingGas,
  listReceipts, getReceipt, fetchReceiptImage, deleteReceipt, findDuplicateReceipts
} from './gemini-api.js';
import { resizeImageFile } from './image-util.js';
import {
  getTaxSettings, saveTaxSettings, calcInclusive, normalizeRateType,
  calcExclusiveFromIncl
} from './tax.js';

let imageData = null;
let imageMime = 'image/jpeg';
/** Resized JPEG for Drive upload (may equal imageData) */
let uploadImageBase64 = null;
/** Shared Drive image after first upload in a multi-receipt batch */
let sharedUploadImage = null;
/** @type {Array<{shop_name:string,date:string,total_amount:number,items:Array}>} */
let analyzedReceipts = [];
let currentReceiptIndex = 0;

function $(id) {
  return document.getElementById(id);
}

function show(el) { el.classList.remove('hidden'); }
function hide(el) { el.classList.add('hidden'); }

function showMessage(msg, type = 'error') {
  const el = $('errorArea');
  el.textContent = msg;
  el.classList.remove('error-box', 'success-box');
  el.classList.add(type === 'success' ? 'success-box' : 'error-box');
  show(el);
}

function clearMessage() {
  hide($('errorArea'));
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function pad2(n) {
  return String(n).padStart(2, '0');
}

/** 端末ローカル（日本想定）の今日 yyyy-MM-dd（input[type=date] 用） */
function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/** 保存用のレシート日時（編集で日付だけ変えた場合は日付のみ） */
function receiptDateForSave() {
  const input = $('receiptDate').value || todayStr();
  const stashed = analyzedReceipts[currentReceiptIndex]?.date;
  if (stashed) {
    const stashedDay = toDateInputValue(stashed);
    if (stashedDay === input && /\d{1,2}:\d{2}/.test(String(stashed))) {
      return formatDateTimeDisplay(stashed);
    }
  }
  const m = input.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  return m ? `${m[1]}/${m[2]}/${m[3]}` : input;
}

/** 履歴表示用 yyyy/mm/dd hh:mm:ss */
function formatDateTimeDisplay(value) {
  const d = parseToDate(value);
  if (!d) return value ? String(value) : '';
  return (
    `${d.getFullYear()}/${pad2(d.getMonth() + 1)}/${pad2(d.getDate())} ` +
    `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`
  );
}

/** 日付のみ表示 yyyy/mm/dd */
function formatDateDisplay(value) {
  const d = parseToDate(value);
  if (!d) return value ? String(value) : '';
  return `${d.getFullYear()}/${pad2(d.getMonth() + 1)}/${pad2(d.getDate())}`;
}

/** input[type=date] 用 yyyy-MM-dd */
function toDateInputValue(value) {
  const d = parseToDate(value);
  if (!d) {
    const s = String(value || '').trim();
    const m = s.match(/(\d{4})[\/\-](\d{1,2})[\/\-](\d{1,2})/);
    if (m) return `${m[1]}-${pad2(m[2])}-${pad2(m[3])}`;
    return todayStr();
  }
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

function parseToDate(value) {
  if (value == null || value === '') return null;
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value;
  const s = String(value).trim();
  if (!s) return null;

  let m = s.match(
    /^(\d{4})[\/\-年.](\d{1,2})[\/\-月.](\d{1,2})(?:[ T日]\s*(\d{1,2}):(\d{1,2})(?::(\d{1,2}))?)?/
  );
  if (m) {
    return new Date(
      Number(m[1]),
      Number(m[2]) - 1,
      Number(m[3]),
      Number(m[4] || 0),
      Number(m[5] || 0),
      Number(m[6] || 0)
    );
  }

  // ISO / "Sat Sep 19 2026 00:00:00 GMT+0900"
  const d = new Date(s);
  if (!Number.isNaN(d.getTime())) return d;
  return null;
}

function initTabs() {
  document.querySelectorAll('.tab').forEach((tab) => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.tab').forEach((t) => {
        t.classList.remove('active');
        t.setAttribute('aria-selected', 'false');
      });
      document.querySelectorAll('.tab-panel').forEach((p) => p.classList.remove('active'));
      tab.classList.add('active');
      tab.setAttribute('aria-selected', 'true');
      $(`tab-${tab.dataset.tab}`).classList.add('active');
      if (tab.dataset.tab === 'history') {
        // optional auto-load when gas configured
      }
    });
  });
}

function populateModelSelect() {
  const select = $('modelSelect');
  const models = getModels();
  const current = getModel();
  select.innerHTML = '';
  if (models.length === 0) {
    const opt = document.createElement('option');
    opt.value = current;
    opt.textContent = current;
    select.appendChild(opt);
    return;
  }
  for (const m of models) {
    const opt = document.createElement('option');
    opt.value = m.id;
    opt.textContent = m.name;
    select.appendChild(opt);
  }
  select.value = current;
}

function renderCategoryList() {
  const ul = $('categoryList');
  ul.innerHTML = '';
  CATEGORIES.forEach((c) => {
    const li = document.createElement('li');
    li.textContent = c;
    ul.appendChild(li);
  });
}

function initSettings() {
  const apiKey = getApiKey();
  if (apiKey) $('apiKeyInput').value = apiKey;
  const gasUrl = getGasUrl();
  if (gasUrl) $('gasUrlInput').value = gasUrl;
  if (!apiKey) $('apiSettings').open = true;
  if (!gasUrl) $('gasSettings').open = true;
  populateModelSelect();
  $('modelSelect').addEventListener('change', (e) => setModel(e.target.value));
  renderCategoryList();

  const tax = getTaxSettings();
  $('taxStandard').value = tax.standard_rate;
  $('taxReduced').value = tax.reduced_rate;
  $('taxDefaultType').value = tax.default_rate_type;
  $('taxRounding').value = tax.rounding;
  $('saveTaxBtn').onclick = () => {
    saveTaxSettings({
      standard_rate: Number($('taxStandard').value),
      reduced_rate: Number($('taxReduced').value),
      default_rate_type: $('taxDefaultType').value,
      rounding: $('taxRounding').value
    });
    calcTotal();
    showMessage('消費税設定を保存しました', 'success');
  };
}

function initImageInput() {
  $('imageInput').addEventListener('change', async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    clearMessage();
    $('imageStatus').textContent = '画像をリサイズ中…';
    try {
      const resized = await resizeImageFile(file, 1280, 0.82);
      imageData = resized.base64;
      imageMime = resized.mime;
      uploadImageBase64 = resized.base64;
      sharedUploadImage = null;
      $('previewImg').src = resized.dataUrl;
      show($('imagePreview'));
      $('imageStatus').textContent =
        `画像を読み込みました（${resized.width}×${resized.height}, JPEG縮小済み）`;
    } catch (err) {
      showMessage(`画像の読み込みに失敗: ${err.message}`);
      imageData = null;
      uploadImageBase64 = null;
      sharedUploadImage = null;
    }
  });
}

function categoryOptionsHtml(selected) {
  const cat = normalizeCategory(selected);
  return CATEGORIES.map(
    (c) => `<option value="${escapeHtml(c)}" ${c === cat ? 'selected' : ''}>${escapeHtml(c)}</option>`
  ).join('');
}

function taxRateOptionsHtml(selected) {
  const type = normalizeRateType(selected);
  const tax = getTaxSettings();
  return `
    <option value="standard" ${type === 'standard' ? 'selected' : ''}>${tax.standard_rate}%</option>
    <option value="reduced" ${type === 'reduced' ? 'selected' : ''}>${tax.reduced_rate}%</option>
  `;
}

function syncShopNameDisplay() {
  const btn = $('shopNameDisplay');
  const input = $('shopName');
  if (!btn || !input) return;
  const v = (input.value || '').trim();
  btn.textContent = v || '店舗名を入力';
  btn.dataset.empty = v ? '0' : '1';
}

async function editShopName() {
  const next = await openFieldModal({
    title: '店舗名の編集',
    label: '店舗名',
    mode: 'text',
    value: $('shopName').value
  });
  if (next === null) return;
  $('shopName').value = next.trim();
  syncShopNameDisplay();
}

function openFieldModal({ title, label, mode, value }) {
  return new Promise((resolve) => {
    const modal = $('fieldModal');
    const textEl = $('fieldModalText');
    const numEl = $('fieldModalNumber');
    $('fieldModalTitle').textContent = title;
    $('fieldModalLabel').textContent = label || '';

    hide(textEl);
    hide(numEl);
    let active;
    if (mode === 'text') {
      show(textEl);
      textEl.value = value ?? '';
      active = textEl;
    } else {
      show(numEl);
      numEl.value = value === '' || value == null ? '' : String(value);
      active = numEl;
    }

    show(modal);
    setTimeout(() => {
      active.focus();
      if (mode === 'text') textEl.setSelectionRange(textEl.value.length, textEl.value.length);
      else numEl.select();
    }, 50);

    const finish = (result) => {
      $('fieldModalOk').onclick = null;
      $('fieldModalCancel').onclick = null;
      $('fieldModalBackdrop').onclick = null;
      textEl.onkeydown = null;
      numEl.onkeydown = null;
      hide(modal);
      resolve(result);
    };

    const confirm = () => {
      if (mode === 'text') finish(textEl.value);
      else finish(numEl.value === '' ? '' : Number(numEl.value));
    };
    const onKey = (e) => {
      if (e.key === 'Enter' && (mode === 'number' || !e.shiftKey)) {
        e.preventDefault();
        confirm();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        finish(null);
      }
    };
    textEl.onkeydown = onKey;
    numEl.onkeydown = onKey;

    $('fieldModalOk').onclick = confirm;
    $('fieldModalCancel').onclick = () => finish(null);
    $('fieldModalBackdrop').onclick = () => finish(null);
  });
}

function refreshRowIncl(row) {
  const el = row.querySelector('.item-incl');
  if (!el) return;
  if (row.dataset.inclOverride !== undefined && row.dataset.inclOverride !== '') {
    const incl = Number(row.dataset.inclOverride) || 0;
    el.textContent = `${incl.toLocaleString()}`;
    el.classList.add('is-override');
    return;
  }
  const excl = Number(row.querySelector('.i-price')?.value) || 0;
  const rateType = normalizeRateType(row.querySelector('.i-tax')?.value);
  const { incl } = calcInclusive(excl, rateType);
  el.textContent = `${incl.toLocaleString()}`;
  el.classList.remove('is-override');
}

function rowInclValue(row) {
  if (row.dataset.inclOverride !== undefined && row.dataset.inclOverride !== '') {
    return Number(row.dataset.inclOverride) || 0;
  }
  const excl = Number(row.querySelector('.i-price')?.value) || 0;
  const rateType = normalizeRateType(row.querySelector('.i-tax')?.value);
  return calcInclusive(excl, rateType).incl;
}

function calcTotal() {
  let exclSum = 0;
  let inclSum = 0;
  document.querySelectorAll('#itemList .item-row').forEach((row) => {
    refreshRowIncl(row);
    exclSum += Number(row.querySelector('.i-price')?.value) || 0;
    inclSum += rowInclValue(row);
  });
  $('totalPrice').textContent = `${inclSum.toLocaleString()} 円`;
  updateAdjustButton(inclSum);
  return { exclSum, inclSum };
}

function updateAdjustButton(inclSum) {
  const btn = $('adjustTotalBtn');
  if (!btn || !analyzedReceipts.length) {
    if (btn) hide(btn);
    return;
  }
  const printed = Number(analyzedReceipts[currentReceiptIndex]?.total_amount) || 0;
  if (printed > 0 && printed !== inclSum) {
    show(btn);
    btn.textContent = `記載合計 ${printed.toLocaleString()} 円に合わせる（差 ${printed - inclSum} 円）`;
  } else {
    hide(btn);
  }
}

function addItemRow(name = '', price = '', category = '食費', taxRateType = '', inclOverride = null) {
  const tax = getTaxSettings();
  const rateType = normalizeRateType(taxRateType || tax.default_rate_type, tax);
  const row = document.createElement('div');
  row.className = 'item-row';
  const exclVal = price === '' || price == null ? '' : Number(price);
  if (inclOverride != null && inclOverride !== '') {
    row.dataset.inclOverride = String(inclOverride);
  }
  row.innerHTML = `
    <button type="button" class="field-tap i-name-display" aria-label="品名を編集"></button>
    <input class="i-name hidden" type="hidden" value="${escapeHtml(name)}">
    <button type="button" class="field-tap i-price-display" aria-label="税抜を編集"></button>
    <input class="i-price hidden" type="hidden" value="${exclVal}">
    <select class="i-tax">${taxRateOptionsHtml(rateType)}</select>
    <button type="button" class="field-tap item-incl" aria-label="税込を編集">0</button>
    <select class="i-cat">${categoryOptionsHtml(category)}</select>
    <button type="button" class="btn-icon" aria-label="行を削除">✕</button>
  `;

  const syncNameDisplay = () => {
    const v = row.querySelector('.i-name').value;
    const btn = row.querySelector('.i-name-display');
    btn.textContent = v || '品名を入力';
    btn.dataset.empty = v ? '0' : '1';
  };
  const syncPriceDisplay = () => {
    const v = row.querySelector('.i-price').value;
    const btn = row.querySelector('.i-price-display');
    btn.textContent = v === '' ? '税抜' : Number(v).toLocaleString();
    btn.dataset.empty = v === '' ? '1' : '0';
  };
  syncNameDisplay();
  syncPriceDisplay();

  row.querySelector('.i-name-display').addEventListener('click', async () => {
    const next = await openFieldModal({
      title: '品名の編集',
      label: '品名',
      mode: 'text',
      value: row.querySelector('.i-name').value
    });
    if (next === null) return;
    row.querySelector('.i-name').value = next;
    syncNameDisplay();
  });

  row.querySelector('.i-price-display').addEventListener('click', async () => {
    const next = await openFieldModal({
      title: '税抜金額の編集',
      label: '税抜（円）',
      mode: 'number',
      value: row.querySelector('.i-price').value
    });
    if (next === null) return;
    delete row.dataset.inclOverride;
    row.querySelector('.i-price').value = next === '' ? '' : String(Math.max(0, Math.round(Number(next) || 0)));
    syncPriceDisplay();
    calcTotal();
  });

  row.querySelector('.item-incl').addEventListener('click', async () => {
    const current = rowInclValue(row);
    const next = await openFieldModal({
      title: '税込金額の編集',
      label: '税込（円）※ここを直すと保存金額になります',
      mode: 'number',
      value: current
    });
    if (next === null) return;
    const incl = Math.max(0, Math.round(Number(next) || 0));
    const rateType = normalizeRateType(row.querySelector('.i-tax').value);
    const { excl } = calcExclusiveFromIncl(incl, rateType);
    row.querySelector('.i-price').value = String(excl);
    row.dataset.inclOverride = String(incl);
    syncPriceDisplay();
    calcTotal();
  });

  row.querySelector('.i-tax').addEventListener('change', () => {
    delete row.dataset.inclOverride;
    calcTotal();
  });
  row.querySelector('.btn-icon').addEventListener('click', () => {
    row.remove();
    calcTotal();
  });
  $('itemList').appendChild(row);
  calcTotal();
}

function renderItems(items = []) {
  const container = $('itemList');
  container.innerHTML = '';
  if (!items.length) addItemRow();
  else {
    items.forEach((item) => addItemRow(
      item.name,
      item.price_excl ?? item.price,
      item.category,
      item.tax_rate_type,
      item.incl_override
    ));
  }
}

/** Collect for UI stash (税抜 + 税率). */
function collectItemsRaw() {
  const items = [];
  document.querySelectorAll('#itemList .item-row').forEach((row) => {
    const name = row.querySelector('.i-name').value.trim();
    const price_excl = Number(row.querySelector('.i-price').value) || 0;
    const tax_rate_type = normalizeRateType(row.querySelector('.i-tax').value);
    const category = row.querySelector('.i-cat').value;
    const incl_override = row.dataset.inclOverride !== undefined && row.dataset.inclOverride !== ''
      ? Number(row.dataset.inclOverride)
      : null;
    if (name || price_excl > 0 || (incl_override != null && incl_override !== 0)) {
      items.push({
        name: name || '（未入力）',
        price: price_excl,
        price_excl,
        tax_rate_type,
        category,
        incl_override
      });
    }
  });
  return items;
}

/** Collect for save: price = 税込（家計簿の正） */
function collectItemsForSave() {
  const tax = getTaxSettings();
  return collectItemsRaw().map((it) => {
    const rateType = normalizeRateType(it.tax_rate_type, tax);
    const { incl, rate } = calcInclusive(it.price_excl, rateType, tax);
    const price = it.incl_override != null ? Number(it.incl_override) : incl;
    return {
      name: it.name,
      price,
      price_excl: it.price_excl,
      tax_rate: rate,
      tax_rate_type: rateType,
      category: it.category
    };
  });
}

function collectItems() {
  return collectItemsRaw();
}

function adjustToPrintedTotal() {
  if (!analyzedReceipts.length) return;
  const printed = Number(analyzedReceipts[currentReceiptIndex]?.total_amount) || 0;
  if (!printed) {
    showMessage('このレシートに記載合計がありません');
    return;
  }
  const { inclSum } = calcTotal();
  const diff = printed - inclSum;
  if (diff === 0) {
    showMessage('すでに記載合計と一致しています', 'success');
    return;
  }

  // Reuse existing 端数調整 row if present
  let adjusted = false;
  document.querySelectorAll('#itemList .item-row').forEach((row) => {
    if (row.querySelector('.i-name')?.value === '端数調整') {
      const cur = rowInclValue(row);
      const next = cur + diff;
      row.dataset.inclOverride = String(next);
      row.querySelector('.i-price').value = '0';
      row.querySelector('.i-price-display').textContent = '0';
      adjusted = true;
    }
  });
  if (!adjusted) {
    addItemRow('端数調整', 0, 'その他', 'standard', diff);
  } else {
    calcTotal();
  }
  showMessage(`端数調整 ${diff > 0 ? '+' : ''}${diff} 円を反映しました`, 'success');
}

function openEditor(parsed) {
  // Accept either a single receipt object or { receipts }
  if (parsed && Array.isArray(parsed.receipts)) {
    analyzedReceipts = parsed.receipts;
  } else if (parsed) {
    analyzedReceipts = [parsed];
  } else {
    analyzedReceipts = [{
      shop_name: '',
      date: todayStr(),
      total_amount: 0,
      items: []
    }];
  }
  currentReceiptIndex = 0;
  showReceiptAt(0);
  show($('resultArea'));
}

function showReceiptAt(index) {
  if (!analyzedReceipts.length) return;
  currentReceiptIndex = Math.max(0, Math.min(index, analyzedReceipts.length - 1));
  const r = analyzedReceipts[currentReceiptIndex];
  const shop = r.shop_name || '';
  const dateVal = toDateInputValue(r.date);
  const items = r.items || [];

  $('shopName').value = shop;
  syncShopNameDisplay();
  $('receiptDate').value = dateVal;
  renderItems(items);

  const { exclSum, inclSum } = calcTotal();
  const printedTotal = Number(r.total_amount) || 0;
  const diff = printedTotal > 0 ? printedTotal - inclSum : 0;

  $('detectedSummary').innerHTML =
    `<b>検出:</b> ${escapeHtml(shop || '不明')} / ${escapeHtml(dateVal)}（${items.length}件）<br>` +
    `<b>税抜合計:</b> ${exclSum.toLocaleString()} 円 → <b>税込換算:</b> ${inclSum.toLocaleString()} 円` +
    (printedTotal > 0
      ? `<br><b>レシート記載合計（参考）:</b> ${printedTotal.toLocaleString()} 円` +
        (Math.abs(diff) > 0
          ? `（差 ${diff > 0 ? '+' : ''}${diff.toLocaleString()} 円）`
          : '（一致）')
      : '') +
    `<br><span class="hint">品名・税抜・税込をタップすると拡大編集できます。差額は「記載合計に合わせる」が便利です。</span>`;

  const hint = $('receiptTotalHint');
  if (hint) {
    hint.textContent = printedTotal > 0 && Math.abs(diff) > 0
      ? `記載合計 ${printedTotal.toLocaleString()} 円 / 税込換算 ${inclSum.toLocaleString()} 円（差 ${diff.toLocaleString()} 円）`
      : '';
  }

  const multi = analyzedReceipts.length > 1;
  if (multi) {
    show($('receiptNav'));
    show($('receiptNavLabel'));
    show($('sendAllBtn'));
    $('receiptNavLabel').textContent =
      `レシート ${currentReceiptIndex + 1} / ${analyzedReceipts.length}`;
    $('prevReceiptBtn').disabled = currentReceiptIndex <= 0;
    $('nextReceiptBtn').disabled = currentReceiptIndex >= analyzedReceipts.length - 1;
  } else {
    hide($('receiptNav'));
    hide($('receiptNavLabel'));
    hide($('sendAllBtn'));
  }
  calcTotal();
}

/** Persist current form edits back into analyzedReceipts[current] */
function stashCurrentReceiptEdits() {
  if (!analyzedReceipts.length) return;
  const items = collectItemsRaw();
  const inclSum = collectItemsForSave().reduce((s, i) => s + i.price, 0);
  analyzedReceipts[currentReceiptIndex] = {
    ...analyzedReceipts[currentReceiptIndex],
    shop_name: $('shopName').value.trim() || '不明',
    date: receiptDateForSave(),
    items,
    // keep printed total as reference; working total is converted
    total_amount: analyzedReceipts[currentReceiptIndex].total_amount,
    converted_total: inclSum
  };
}

function goPrevReceipt() {
  stashCurrentReceiptEdits();
  showReceiptAt(currentReceiptIndex - 1);
}

function goNextReceipt() {
  stashCurrentReceiptEdits();
  showReceiptAt(currentReceiptIndex + 1);
}

function handleClear() {
  imageData = null;
  uploadImageBase64 = null;
  sharedUploadImage = null;
  imageMime = 'image/jpeg';
  analyzedReceipts = [];
  currentReceiptIndex = 0;
  $('imageInput').value = '';
  $('textMemo').value = '';
  hide($('imagePreview'));
  $('previewImg').src = '';
  hide($('resultArea'));
  hide($('receiptNav'));
  hide($('receiptNavLabel'));
  hide($('sendAllBtn'));
  clearMessage();
  $('imageStatus').textContent = '写真を選ぶか、メモを入力してください';
  $('itemList').innerHTML = '';
  $('shopName').value = '';
  syncShopNameDisplay();
  $('receiptDate').value = todayStr();
  calcTotal();
}

function ensureApiKey() {
  const apiKey = $('apiKeyInput').value.trim() || getApiKey();
  if (!apiKey) {
    showMessage('設定タブでGemini APIキーを入力してください');
    return null;
  }
  if ($('saveApiKey').checked) setApiKey(apiKey);
  return apiKey;
}

function requireGasUrl() {
  const gasUrl = $('gasUrlInput').value.trim() || getGasUrl();
  if (!gasUrl) {
    showMessage('設定タブでGAS Web App URLを保存してください');
    $('gasSettings').open = true;
    return null;
  }
  return gasUrl;
}

async function handleAnalyze() {
  clearMessage();
  const memo = $('textMemo').value.trim();
  if (!imageData && !memo) {
    showMessage('先にレシート写真を選択するか、テキストメモを入力してください');
    return;
  }
  const apiKey = ensureApiKey();
  if (!apiKey) return;
  const model = $('modelSelect').value || getModel();
  if (!model) {
    showMessage('モデルを選択してください');
    return;
  }

  show($('loadingArea'));
  $('analyzeBtn').disabled = true;
  try {
    const result = await analyzeReceipt(apiKey, model, {
      base64Data: imageData,
      mimeType: imageMime,
      memo
    });
    openEditor(result);
    const n = result.receipts?.length || 0;
    showMessage(
      n > 1
        ? `解析完了。${n} 枚のレシートを検出しました。切り替えながら確認してください。`
        : '解析完了。税込金額を確認・修正してください。',
      'success'
    );
  } catch (err) {
    showMessage(err.message);
  } finally {
    hide($('loadingArea'));
    $('analyzeBtn').disabled = false;
  }
}

function handleManualEdit() {
  clearMessage();
  openEditor(null);
  showMessage('手入力モードを開きました', 'success');
}

async function saveOnePayload(gasUrl, payload, { uploadFresh = false, reuseImage = null } = {}) {
  const body = { ...payload };
  if (uploadFresh && uploadImageBase64) {
    body.image_base64 = uploadImageBase64;
    body.image_mime = 'image/jpeg';
  } else if (reuseImage?.fileId) {
    body.image_file_id = reuseImage.fileId;
    body.image_view_url = reuseImage.viewUrl || '';
  }
  return sendToGas(gasUrl, body);
}

function rememberSharedImage(saveResult) {
  const data = saveResult?.result;
  const fileId = data?.image_file_id || '';
  if (!fileId) return;
  sharedUploadImage = {
    fileId,
    viewUrl: data.image_view_url || ''
  };
}

function formatDuplicateConfirm(dupes, shop, dateStr, total) {
  const lines = dupes.slice(0, 3).map((d) => {
    const when = formatDateTimeDisplay(d.created_at || d.date);
    return `・${d.shop_name} / ${when} / ${Number(d.total_amount || 0).toLocaleString()} 円（${d.item_count || '?'}品目）`;
  });
  return (
    `同じようなレシートがすでに保存されています。\n` +
    `（店名＋日付＋合計が一致）\n\n` +
    `今回: ${shop} / ${dateStr} / ${Number(total).toLocaleString()} 円\n\n` +
    `既存:\n${lines.join('\n')}` +
    (dupes.length > 3 ? `\n…ほか ${dupes.length - 3} 件` : '') +
    `\n\nそれでも新規として保存しますか？\n（キャンセルで保存しません）`
  );
}

/** @returns {Promise<boolean>} true = 保存してよい */
async function confirmNoDuplicateOrProceed(gasUrl, payload) {
  try {
    const dupes = await findDuplicateReceipts(gasUrl, {
      shop_name: payload.shop_name,
      date: payload.date,
      total_amount: payload.total_amount
      // 品目数は条件に入れない（編集・端数調整でずれやすい）
    });
    if (!dupes.length) return true;
    return confirm(
      formatDuplicateConfirm(dupes, payload.shop_name, payload.date, payload.total_amount)
    );
  } catch (err) {
    console.warn('duplicate check failed', err);
    return true;
  }
}

async function handleSend() {
  clearMessage();
  const gasUrl = requireGasUrl();
  if (!gasUrl) return;

  stashCurrentReceiptEdits();
  const itemsSave = collectItemsForSave();
  if (itemsSave.length === 0) {
    showMessage('明細が1件以上必要です');
    return;
  }

  const totalAmount = itemsSave.reduce((sum, i) => sum + i.price, 0);
  const payload = {
    timestamp: new Date().toISOString(),
    shop_name: $('shopName').value.trim() || '不明',
    date: receiptDateForSave(),
    total_amount: totalAmount,
    items: itemsSave
  };

  $('sendBtn').disabled = true;
  $('sendBtn').textContent = '確認中...';
  try {
    const ok = await confirmNoDuplicateOrProceed(gasUrl, payload);
    if (!ok) {
      showMessage('保存をキャンセルしました', 'success');
      return;
    }

    $('sendBtn').textContent = '送信中...';
    // 同一写真の複数レシート: 最初の1回だけアップロードし、以降は同じ画像IDを付与
    const uploadFresh = Boolean(uploadImageBase64) && !sharedUploadImage;
    const result = await saveOnePayload(gasUrl, payload, {
      uploadFresh,
      reuseImage: sharedUploadImage
    });
    setGasUrl(gasUrl);
    if (result.verified) {
      rememberSharedImage(result);
      showMessage('このレシートを保存しました', 'success');
      if (analyzedReceipts.length > 1) {
        analyzedReceipts.splice(currentReceiptIndex, 1);
        if (!analyzedReceipts.length) handleClear();
        else showReceiptAt(Math.min(currentReceiptIndex, analyzedReceipts.length - 1));
      } else {
        handleClear();
      }
    } else {
      showMessage(
        `送信しました（結果未確認）。履歴タブやスプレッドシートを確認してください。\n${result.hint || ''}`,
        'error'
      );
    }
  } catch (err) {
    showMessage(`送信エラー: ${err.message}`);
  } finally {
    $('sendBtn').disabled = false;
    $('sendBtn').textContent = '☁ このレシートをシートへ保存';
  }
}

async function handleSendAll() {
  clearMessage();
  const gasUrl = requireGasUrl();
  if (!gasUrl) return;
  stashCurrentReceiptEdits();
  if (!analyzedReceipts.length) {
    showMessage('保存するレシートがありません');
    return;
  }

  $('sendAllBtn').disabled = true;
  let ok = 0;
  let fail = 0;
  let skipped = 0;
  try {
    for (let i = 0; i < analyzedReceipts.length; i++) {
      const r = analyzedReceipts[i];
      const rawItems = r.items || [];
      if (!rawItems.length) continue;
      const tax = getTaxSettings();
      const itemsSave = rawItems.map((it) => {
        const excl = Number(it.price_excl ?? it.price) || 0;
        const rateType = normalizeRateType(it.tax_rate_type, tax);
        const { incl, rate } = calcInclusive(excl, rateType, tax);
        const price = it.incl_override != null ? Number(it.incl_override) : incl;
        return {
          name: it.name || '（未入力）',
          price,
          price_excl: excl,
          tax_rate: rate,
          tax_rate_type: rateType,
          category: it.category || 'その他'
        };
      }).filter((it) => it.name || it.price > 0);

      if (!itemsSave.length) continue;

      const payload = {
        timestamp: new Date().toISOString(),
        shop_name: r.shop_name || '不明',
        date: r.date || todayStr(),
        total_amount: itemsSave.reduce((s, it) => s + it.price, 0),
        items: itemsSave
      };

      $('sendAllBtn').textContent = `確認中 (${i + 1}/${analyzedReceipts.length})...`;
      const proceed = await confirmNoDuplicateOrProceed(gasUrl, payload);
      if (!proceed) {
        skipped += 1;
        continue;
      }

      $('sendAllBtn').textContent = `送信中 (${i + 1}/${analyzedReceipts.length})...`;
      try {
        const uploadFresh = Boolean(uploadImageBase64) && !sharedUploadImage;
        const result = await saveOnePayload(gasUrl, payload, {
          uploadFresh,
          reuseImage: sharedUploadImage
        });
        if (result.verified) {
          rememberSharedImage(result);
        } else if (uploadFresh) {
          sharedUploadImage = null;
        }
        ok += 1;
      } catch {
        fail += 1;
      }
    }
    setGasUrl(gasUrl);
    showMessage(
      `一括保存: 成功 ${ok} / スキップ ${skipped} / 失敗 ${fail}`,
      fail ? 'error' : 'success'
    );
    if (fail === 0 && skipped === 0 && ok > 0) handleClear();
  } catch (err) {
    showMessage(`一括保存エラー: ${err.message}`);
  } finally {
    $('sendAllBtn').disabled = false;
    $('sendAllBtn').textContent = '☁ 検出した全レシートを保存';
  }
}

async function handleRefreshHistory() {
  const gasUrl = requireGasUrl();
  if (!gasUrl) return;
  const month = $('historyMonth').value || '';
  $('historyStatus').textContent = '読み込み中…';
  $('historyList').innerHTML = '';
  try {
    const receipts = await listReceipts(gasUrl, { month, limit: 50 });
    if (!receipts.length) {
      $('historyStatus').textContent = 'データがありません';
      return;
    }
    $('historyStatus').textContent = `${receipts.length} 件`;
    const frag = document.createDocumentFragment();
    for (const r of receipts) {
      const card = document.createElement('div');
      card.className = 'history-card';
      card.innerHTML = `
        <h3>${escapeHtml(r.shop_name || '不明')}</h3>
        <div class="history-meta">保存 ${escapeHtml(formatDateTimeDisplay(r.created_at || r.date))} ／ レシート ${escapeHtml(/\d{1,2}:\d{2}/.test(String(r.date || '')) ? formatDateTimeDisplay(r.date) : formatDateDisplay(r.date))} ／ ${Number(r.total_amount || 0).toLocaleString()} 円 ／ ${r.item_count || 0}品目</div>
        <div class="btn-row">
          <button type="button" class="btn btn-secondary btn-detail">明細</button>
          <button type="button" class="btn btn-primary btn-image" ${r.image_file_id ? '' : 'disabled'}>画像を表示</button>
          <button type="button" class="btn btn-danger-outline btn-delete">削除</button>
        </div>
        <div class="history-detail hidden"></div>
      `;
      card.querySelector('.btn-detail').addEventListener('click', async () => {
        const box = card.querySelector('.history-detail');
        if (!box.classList.contains('hidden') && box.innerHTML) {
          box.classList.add('hidden');
          return;
        }
        box.textContent = '取得中…';
        box.classList.remove('hidden');
        try {
          const full = await getReceipt(gasUrl, r.receipt_id);
          box.innerHTML = `<ul>${(full.items || []).map((it) =>
            `<li>${escapeHtml(it.name)} — ${Number(it.price).toLocaleString()} 円（${escapeHtml(it.category)}）</li>`
          ).join('')}</ul>`;
        } catch (err) {
          box.textContent = err.message;
        }
      });
      card.querySelector('.btn-image').addEventListener('click', () => {
        openImageModal(r.image_view_url, r.image_file_id);
      });
      card.querySelector('.btn-delete').addEventListener('click', async () => {
        const label = `${r.shop_name || '不明'} / ${formatDateTimeDisplay(r.created_at || r.date)} / ${Number(r.total_amount || 0).toLocaleString()} 円`;
        if (!confirm(`このレシートを完全に削除しますか？\n（スプレッドシートから物理削除。他レシートが使っていなければ画像も削除）\n\n${label}`)) {
          return;
        }
        const btn = card.querySelector('.btn-delete');
        btn.disabled = true;
        btn.textContent = '削除中…';
        try {
          const result = await deleteReceipt(gasUrl, r.receipt_id, { deleteImage: true });
          card.remove();
          const left = $('historyList').querySelectorAll('.history-card').length;
          $('historyStatus').textContent = left ? `${left} 件` : 'データがありません';
          showMessage(
            `削除しました（行 ${result.deleted_rows || 0}` +
            (result.deleted_images?.length ? ` / 画像 ${result.deleted_images.length}` : '') +
            '）',
            'success'
          );
        } catch (err) {
          btn.disabled = false;
          btn.textContent = '削除';
          showMessage(`削除エラー: ${err.message}`);
        }
      });
      frag.appendChild(card);
    }
    $('historyList').appendChild(frag);
  } catch (err) {
    const msg = String(err.message || err);
    $('historyStatus').textContent = `エラー: ${msg}`;
    if (/権限|openById|spreadsheets/i.test(msg)) {
      showMessage(
        'GASのスプレッドシート権限が不足しています。エディタで setupReceiptAI を実行して権限を許可し、ウェブアプリを「新バージョン」で再デプロイしてください。',
        'error'
      );
    }
  }
}

async function openImageModal(viewUrl, fileId) {
  show($('imageModal'));
  $('modalImg').removeAttribute('src');
  $('modalImgHint').textContent = '画像を読み込み中…';

  const gasUrl = ($('gasUrlInput')?.value || '').trim() || getGasUrl();
  try {
    if (fileId && gasUrl) {
      const img = await fetchReceiptImage(gasUrl, fileId);
      $('modalImg').src = `data:${img.mime};base64,${img.base64}`;
      $('modalImgHint').textContent = '';
      return;
    }
    const url = viewUrl || '';
    if (!url) throw new Error('画像がありません（保存時に写真が付いていない可能性があります）');
    $('modalImg').src = url;
    $('modalImgHint').textContent =
      'Drive直リンク表示です。表示されない場合は GAS を最新に更新し、新バージョンで再デプロイしてください。';
  } catch (err) {
    $('modalImgHint').textContent = `画像を表示できません: ${err.message}`;
  }
}

function closeImageModal() {
  hide($('imageModal'));
  $('modalImg').removeAttribute('src');
  $('modalImgHint').textContent = '';
}

async function handleFetchModels() {
  clearMessage();
  const apiKey = ensureApiKey();
  if (!apiKey) return;
  $('fetchModelsBtn').disabled = true;
  $('fetchModelsBtn').textContent = '取得中...';
  try {
    const models = await fetchModels(apiKey);
    setModels(models);
    populateModelSelect();
    if (models.length > 0) {
      const current = getModel();
      if (!models.some((m) => m.id === current)) {
        const flash = models.find((m) => /flash/i.test(m.id)) || models[0];
        setModel(flash.id);
        $('modelSelect').value = flash.id;
      }
    }
    showMessage(`モデル ${models.length} 件を取得しました`, 'success');
  } catch (err) {
    showMessage(err.message);
  } finally {
    $('fetchModelsBtn').disabled = false;
    $('fetchModelsBtn').textContent = 'モデル一覧を取得';
  }
}

async function handleTestGas() {
  clearMessage();
  const gasUrl = $('gasUrlInput').value.trim() || getGasUrl();
  const out = $('gasTestResult');
  if (!gasUrl) {
    showMessage('先にGAS URLを入力してください');
    return;
  }
  $('testGasBtn').disabled = true;
  $('testGasBtn').textContent = 'テスト中...';
  out.textContent = '接続確認中…';
  try {
    const result = await pingGas(gasUrl);
    out.textContent = result.message + (result.data?.spreadsheetUrl ? `\n${result.data.spreadsheetUrl}` : '');
    if (result.ok) {
      setGasUrl(gasUrl.replace(/\/$/, ''));
      showMessage(result.message, 'success');
    } else if (result.checkUrl) {
      window.open(result.checkUrl, '_blank', 'noopener');
      showMessage(result.message, 'error');
    } else {
      showMessage(result.message, 'error');
    }
  } catch (err) {
    out.textContent = err.message;
    showMessage(err.message);
  } finally {
    $('testGasBtn').disabled = false;
    $('testGasBtn').textContent = '接続テスト';
  }
}

function initGasActions() {
  $('saveGasBtn').addEventListener('click', () => {
    const url = $('gasUrlInput').value.trim();
    if (!url) return showMessage('GAS URLを入力してください');
    setGasUrl(url);
    showMessage('GAS URLを保存しました', 'success');
  });
  $('testGasBtn').addEventListener('click', handleTestGas);
  $('deleteGasBtn').addEventListener('click', () => {
    if (!confirm('GAS URLをこの端末から削除しますか？')) return;
    setGasUrl('');
    $('gasUrlInput').value = '';
    $('gasTestResult').textContent = '';
    showMessage('GAS URLを削除しました', 'success');
  });
}

function registerServiceWorker() {
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./service-worker.js').catch(() => {});
  }
}

function init() {
  $('receiptDate').value = todayStr();
  syncShopNameDisplay();
  initTabs();
  initSettings();
  initImageInput();
  initGasActions();
  registerServiceWorker();

  $('analyzeBtn').addEventListener('click', handleAnalyze);
  $('clearBtn').addEventListener('click', handleClear);
  $('addItemBtn').addEventListener('click', () => addItemRow());
  $('sendBtn').addEventListener('click', handleSend);
  $('sendAllBtn').addEventListener('click', handleSendAll);
  $('prevReceiptBtn').addEventListener('click', goPrevReceipt);
  $('nextReceiptBtn').addEventListener('click', goNextReceipt);
  $('adjustTotalBtn').addEventListener('click', adjustToPrintedTotal);
  $('manualSaveBtn').addEventListener('click', handleManualEdit);
  $('fetchModelsBtn').addEventListener('click', handleFetchModels);
  $('refreshHistoryBtn').addEventListener('click', handleRefreshHistory);
  $('shopNameDisplay').addEventListener('click', editShopName);
  $('deleteApiKeyBtn').addEventListener('click', () => {
    if (!confirm('APIキーをこの端末から削除しますか？')) return;
    setApiKey('');
    $('apiKeyInput').value = '';
    showMessage('APIキーを削除しました', 'success');
  });
  $('imageModalClose').addEventListener('click', closeImageModal);
  $('imageModalCloseBtn').addEventListener('click', closeImageModal);
}

document.addEventListener('DOMContentLoaded', init);
