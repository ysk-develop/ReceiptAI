import {
  getApiKey, setApiKey, getModel, setModel,
  getModels, setModels, getGasUrl, setGasUrl, getBookId, setBookId,
  getPaymentMethods, setPaymentMethods, ensurePaymentMethodInList
} from './storage.js';
import { CATEGORIES, normalizeCategory } from './categories.js';
import {
  fetchModels, analyzeReceipt, sendToGas, pingGas,
  listReceipts, getReceipt, fetchReceiptImage, deleteReceipt, findDuplicateReceipts,
  listBooks, addBook, renameBook, deleteBook
} from './gemini-api.js';
import { resizeImageFile } from './image-util.js';
import {
  getTaxSettings, saveTaxSettings, calcInclusive, normalizeRateType,
  calcExclusiveFromIncl, suggestPriceBasis
} from './tax.js';
import { APP_VERSION } from './version.js';

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

  initBookControls();
  if (gasUrl) {
    refreshBooksSelect({ silent: true }).catch(() => {});
  }
}

function initBookControls() {
  const sel = $('bookSelect');
  if (!sel) return;
  sel.addEventListener('change', () => {
    const id = sel.value;
    setBookId(id);
    updateBookHint();
  });
  $('refreshBooksBtn')?.addEventListener('click', () => refreshBooksSelect({ silent: false }));
  $('addBookBtn')?.addEventListener('click', handleAddBook);
  $('renameBookBtn')?.addEventListener('click', handleRenameBook);
  $('deleteBookBtn')?.addEventListener('click', handleDeleteBook);
}

function populateBookSelect(books, preferredId) {
  const sel = $('bookSelect');
  if (!sel) return;
  const want = preferredId || getBookId() || '';
  sel.innerHTML = '';
  if (!books.length) {
    const opt = document.createElement('option');
    opt.value = '';
    opt.textContent = '（帳簿がありません。追加してください）';
    sel.appendChild(opt);
    setBookId('');
    updateBookHint();
    return;
  }
  let matched = false;
  books.forEach((b) => {
    const opt = document.createElement('option');
    opt.value = b.id;
    opt.textContent = b.name || b.id;
    if (b.id === want) {
      opt.selected = true;
      matched = true;
    }
    sel.appendChild(opt);
  });
  if (!matched) {
    sel.selectedIndex = 0;
  }
  setBookId(sel.value);
  updateBookHint();
}

function updateBookHint() {
  const sel = $('bookSelect');
  const out = $('gasTestResult');
  if (!sel || !out) return;
  const name = sel.options[sel.selectedIndex]?.textContent || '';
  if (sel.value && name) {
    // keep existing test result if present; append soft hint via title only
    sel.title = `選択中: ${name}`;
  }
}

async function refreshBooksSelect({ silent = false } = {}) {
  const gasUrl = $('gasUrlInput')?.value.trim() || getGasUrl();
  if (!gasUrl) {
    if (!silent) showMessage('先に GAS URL を保存してください');
    return [];
  }
  try {
    const books = await listBooks(gasUrl);
    populateBookSelect(books, getBookId());
    if (!silent) {
      const out = $('gasTestResult');
      if (out) out.textContent = `帳簿一覧を更新しました（${books.length} 件）`;
      showMessage(`帳簿 ${books.length} 件を取得しました`, 'success');
    }
    return books;
  } catch (err) {
    if (!silent) {
      showMessage(err.message || String(err));
      const out = $('gasTestResult');
      if (out) out.textContent = String(err.message || err);
    }
    throw err;
  }
}

async function handleAddBook() {
  const gasUrl = requireGasUrl();
  if (!gasUrl) return;
  const name = window.prompt('新しい帳簿名', '');
  if (name == null) return;
  const trimmed = name.trim();
  if (!trimmed) {
    showMessage('帳簿名を入力してください');
    return;
  }
  try {
    const data = await addBook(gasUrl, trimmed);
    populateBookSelect(data.books || [], data.book?.id || getBookId());
    showMessage(`帳簿「${trimmed}」を追加しました`, 'success');
  } catch (err) {
    showMessage(err.message || String(err));
  }
}

async function handleRenameBook() {
  const gasUrl = requireGasUrl();
  if (!gasUrl) return;
  const bookId = requireBookId();
  if (!bookId) return;
  const sel = $('bookSelect');
  const current = sel?.options[sel.selectedIndex]?.textContent || '';
  const name = window.prompt('新しい帳簿名', current);
  if (name == null) return;
  const trimmed = name.trim();
  if (!trimmed) {
    showMessage('帳簿名を入力してください');
    return;
  }
  try {
    const data = await renameBook(gasUrl, bookId, trimmed);
    populateBookSelect(data.books || [], bookId);
    showMessage(`「${trimmed}」に変更しました`, 'success');
  } catch (err) {
    showMessage(err.message || String(err));
  }
}

async function handleDeleteBook() {
  const gasUrl = requireGasUrl();
  if (!gasUrl) return;
  const bookId = requireBookId();
  if (!bookId) return;
  const sel = $('bookSelect');
  const current = sel?.options[sel.selectedIndex]?.textContent || '';
  if (!window.confirm(
    `帳簿「${current}」を削除しますか？\nDrive 上のフォルダ・シート・画像もゴミ箱へ移します。\n（少なくとも1つは残す必要があります）`
  )) return;
  try {
    const data = await deleteBook(gasUrl, bookId, { deleteData: true });
    populateBookSelect(data.books || [], getBookId());
    showMessage(`帳簿「${current}」を削除しました`, 'success');
  } catch (err) {
    showMessage(err.message || String(err));
  }
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

function requireBookId() {
  const bookId = $('bookSelect')?.value || getBookId();
  if (!bookId) {
    showMessage('設定タブで帳簿を選択（または追加）してください');
    $('gasSettings').open = true;
    return null;
  }
  return bookId;
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
  btn.title = v || '店舗名を入力';
}

function formatDateLabel(isoDay) {
  const s = String(isoDay || '').trim();
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[1]}/${m[2]}/${m[3]}`;
  return s || '—';
}

function syncDateDisplay() {
  const btn = $('receiptDateDisplay');
  const input = $('receiptDate');
  if (!btn || !input) return;
  const v = (input.value || '').trim() || todayStr();
  if (!input.value) input.value = v;
  btn.textContent = formatDateLabel(v);
  btn.dataset.empty = '0';
  btn.title = formatDateLabel(v);
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

async function editReceiptDate() {
  const next = await openFieldModal({
    title: '日付の編集',
    label: 'レシート日付',
    mode: 'date',
    value: $('receiptDate').value || todayStr()
  });
  if (next === null) return;
  const day = toDateInputValue(next) || todayStr();
  $('receiptDate').value = day;
  syncDateDisplay();
}

function openFieldModal({ title, label, mode, value, options = [] }) {
  return new Promise((resolve) => {
    const modal = $('fieldModal');
    const textEl = $('fieldModalText');
    const numEl = $('fieldModalNumber');
    const dateEl = $('fieldModalDate');
    const selectEl = $('fieldModalSelect');
    $('fieldModalTitle').textContent = title;
    $('fieldModalLabel').textContent = label || '';

    hide(textEl);
    hide(numEl);
    if (dateEl) hide(dateEl);
    if (selectEl) hide(selectEl);
    let active;
    if (mode === 'text') {
      show(textEl);
      textEl.value = value ?? '';
      active = textEl;
    } else if (mode === 'date') {
      show(dateEl);
      dateEl.value = toDateInputValue(value) || todayStr();
      active = dateEl;
    } else if (mode === 'select') {
      show(selectEl);
      const opts = options.length ? options : [String(value || '')];
      selectEl.innerHTML = opts.map((o) => {
        const v = String(o);
        const sel = v === String(value) ? ' selected' : '';
        return `<option value="${escapeHtml(v)}"${sel}>${escapeHtml(v)}</option>`;
      }).join('');
      if (value && ![...selectEl.options].some((o) => o.value === String(value))) {
        const opt = document.createElement('option');
        opt.value = String(value);
        opt.textContent = String(value);
        opt.selected = true;
        selectEl.appendChild(opt);
      }
      active = selectEl;
    } else {
      show(numEl);
      numEl.value = value === '' || value == null ? '' : String(value);
      active = numEl;
    }

    show(modal);
    setTimeout(() => {
      active.focus();
      if (mode === 'text') textEl.setSelectionRange(textEl.value.length, textEl.value.length);
      else if (mode === 'number') numEl.select();
    }, 50);

    const finish = (result) => {
      $('fieldModalOk').onclick = null;
      $('fieldModalCancel').onclick = null;
      $('fieldModalBackdrop').onclick = null;
      textEl.onkeydown = null;
      numEl.onkeydown = null;
      if (dateEl) dateEl.onkeydown = null;
      if (selectEl) selectEl.onkeydown = null;
      hide(modal);
      resolve(result);
    };

    const confirm = () => {
      if (mode === 'text') finish(textEl.value);
      else if (mode === 'date') finish(dateEl.value || '');
      else if (mode === 'select') finish(selectEl.value || '');
      else finish(numEl.value === '' ? '' : Number(numEl.value));
    };
    const onKey = (e) => {
      if (e.key === 'Enter' && (mode === 'number' || mode === 'date' || mode === 'select' || !e.shiftKey)) {
        e.preventDefault();
        confirm();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        finish(null);
      }
    };
    textEl.onkeydown = onKey;
    numEl.onkeydown = onKey;
    if (dateEl) dateEl.onkeydown = onKey;
    if (selectEl) selectEl.onkeydown = onKey;

    $('fieldModalOk').onclick = confirm;
    $('fieldModalCancel').onclick = () => finish(null);
    $('fieldModalBackdrop').onclick = () => finish(null);
  });
}

function syncPaymentDisplay() {
  const btn = $('paymentDisplay');
  const input = $('paymentMethod');
  if (!btn || !input) return;
  const v = (input.value || '').trim() || '現金';
  input.value = v;
  btn.textContent = v;
  btn.dataset.empty = '0';
  btn.title = v;
}

async function editPaymentMethod() {
  ensurePaymentMethodInList($('paymentMethod').value || '現金');
  const options = getPaymentMethods();
  const next = await openFieldModal({
    title: '支払い方法',
    label: '支払い方法を選択',
    mode: 'select',
    value: $('paymentMethod').value || '現金',
    options
  });
  if (next === null) return;
  const name = String(next).trim() || '現金';
  ensurePaymentMethodInList(name);
  $('paymentMethod').value = name;
  syncPaymentDisplay();
  refreshPaymentMethodSelect();
}

function refreshPaymentMethodSelect() {
  const sel = $('paymentMethodSelect');
  if (!sel) return;
  const list = getPaymentMethods();
  const current = sel.value;
  sel.innerHTML = '';
  list.forEach((name) => {
    const opt = document.createElement('option');
    opt.value = name;
    opt.textContent = name;
    if (name === current) opt.selected = true;
    sel.appendChild(opt);
  });
  if (!sel.value && list.length) sel.selectedIndex = 0;
}

function initPaymentMethodSettings() {
  refreshPaymentMethodSelect();
  $('addPaymentMethodBtn')?.addEventListener('click', () => {
    const name = window.prompt('追加する支払い方法', '');
    if (name == null) return;
    const trimmed = name.trim();
    if (!trimmed) {
      showMessage('名前を入力してください');
      return;
    }
    const list = getPaymentMethods();
    if (list.includes(trimmed)) {
      showMessage('すでに登録されています');
      return;
    }
    setPaymentMethods([...list, trimmed]);
    refreshPaymentMethodSelect();
    $('paymentMethodSelect').value = trimmed;
    showMessage(`「${trimmed}」を追加しました`, 'success');
  });
  $('renamePaymentMethodBtn')?.addEventListener('click', () => {
    const sel = $('paymentMethodSelect');
    const current = sel?.value || '';
    if (!current) return;
    const name = window.prompt('新しい名前', current);
    if (name == null) return;
    const trimmed = name.trim();
    if (!trimmed) {
      showMessage('名前を入力してください');
      return;
    }
    const list = getPaymentMethods().map((x) => (x === current ? trimmed : x));
    setPaymentMethods(list);
    if (($('paymentMethod').value || '') === current) {
      $('paymentMethod').value = trimmed;
      syncPaymentDisplay();
    }
    refreshPaymentMethodSelect();
    $('paymentMethodSelect').value = trimmed;
    showMessage(`「${trimmed}」に変更しました`, 'success');
  });
  $('deletePaymentMethodBtn')?.addEventListener('click', () => {
    const sel = $('paymentMethodSelect');
    const current = sel?.value || '';
    if (!current) return;
    const list = getPaymentMethods();
    if (list.length <= 1) {
      showMessage('支払い方法は少なくとも1つ必要です');
      return;
    }
    if (!window.confirm(`「${current}」を削除しますか？`)) return;
    const next = list.filter((x) => x !== current);
    setPaymentMethods(next);
    if (($('paymentMethod').value || '') === current) {
      $('paymentMethod').value = next[0];
      syncPaymentDisplay();
    }
    refreshPaymentMethodSelect();
    showMessage(`「${current}」を削除しました`, 'success');
  });
}

function refreshRowIncl(row) {
  row?._syncMetaDisplay?.();
}

function currentPriceBasis() {
  const r = analyzedReceipts[currentReceiptIndex];
  return r?.price_basis === 'inclusive' ? 'inclusive' : 'exclusive';
}

function syncPriceBasisUi() {
  const sel = $('priceBasisSelect');
  const hint = $('priceBasisHint');
  const r = analyzedReceipts[currentReceiptIndex];
  if (sel) sel.value = currentPriceBasis();
  if (hint) {
    hint.textContent = (r?.price_basis_hint && currentPriceBasis() === 'inclusive')
      ? r.price_basis_hint
      : '';
  }
  const label = $('totalBoxLabel');
  if (label) {
    label.textContent = currentPriceBasis() === 'inclusive'
      ? '税込合計（印字額）'
      : '税込合計（換算）';
  }
}

function onPriceBasisChange() {
  if (!analyzedReceipts.length) return;
  const sel = $('priceBasisSelect');
  const basis = sel?.value === 'inclusive' ? 'inclusive' : 'exclusive';
  analyzedReceipts[currentReceiptIndex] = {
    ...analyzedReceipts[currentReceiptIndex],
    price_basis: basis,
    // clear auto hint once user overrides to exclusive; keep if staying inclusive
    price_basis_hint: basis === 'inclusive'
      ? (analyzedReceipts[currentReceiptIndex].price_basis_hint || '')
      : ''
  };
  syncPriceBasisUi();
  calcTotal();
  // refresh summary line without re-rendering items
  const r = analyzedReceipts[currentReceiptIndex];
  const shop = r.shop_name || $('shopName').value || '';
  const dateVal = toDateInputValue(r.date || $('receiptDate').value);
  const payment = (r.payment_method || $('paymentMethod').value || '現金').trim() || '現金';
  const items = r.items || [];
  const { exclSum, inclSum } = calcTotal();
  const printedTotal = Number(r.total_amount) || 0;
  const diff = printedTotal > 0 ? printedTotal - inclSum : 0;
  const basisLine = basis === 'inclusive'
    ? `<b>印字額合計（税込扱い）:</b> ${inclSum.toLocaleString()} 円`
    : `<b>税抜合計:</b> ${exclSum.toLocaleString()} 円 → <b>税込換算:</b> ${inclSum.toLocaleString()} 円`;
  $('detectedSummary').innerHTML =
    `<b>検出:</b> ${escapeHtml(shop || '不明')} / ${escapeHtml(dateVal)} / ${escapeHtml(payment)}（${items.length}件）<br>` +
    basisLine +
    (r.price_basis_hint && basis === 'inclusive'
      ? `<br><span class="hint">${escapeHtml(r.price_basis_hint)}</span>`
      : '') +
    (printedTotal > 0
      ? `<br><b>レシート記載合計（参考）:</b> ${printedTotal.toLocaleString()} 円` +
        (Math.abs(diff) > 0
          ? `（差 ${diff > 0 ? '+' : ''}${diff.toLocaleString()} 円）`
          : '（一致）')
      : '') +
    `<br><span class="hint">品名・税抜・税込をタップすると拡大編集できます。差額は「記載合計に合わせる」が便利です。</span>`;
}

function rowInclValue(row) {
  if (row.dataset.inclOverride !== undefined && row.dataset.inclOverride !== '') {
    return Number(row.dataset.inclOverride) || 0;
  }
  const printed = Number(row.querySelector('.i-price')?.value) || 0;
  if (currentPriceBasis() === 'inclusive') return printed;
  const rateType = normalizeRateType(row.querySelector('.i-tax')?.value);
  return calcInclusive(printed, rateType).incl;
}

function calcTotal() {
  let exclSum = 0;
  let inclSum = 0;
  document.querySelectorAll('#itemList .item-row').forEach((row) => {
    exclSum += Number(row.querySelector('.i-price')?.value) || 0;
    inclSum += rowInclValue(row);
    row._syncMetaDisplay?.();
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

function openItemEditModal(row) {
  return new Promise((resolve) => {
    const modal = $('itemEditModal');
    const nameEl = $('itemEditName');
    const exclEl = $('itemEditExcl');
    const inclEl = $('itemEditIncl');
    const taxEl = $('itemEditTax');
    const catEl = $('itemEditCat');

    const rateType = normalizeRateType(row.querySelector('.i-tax').value);
    const category = row.querySelector('.i-cat').value;
    taxEl.innerHTML = taxRateOptionsHtml(rateType);
    catEl.innerHTML = categoryOptionsHtml(category);
    nameEl.value = row.querySelector('.i-name').value;
    exclEl.value = row.querySelector('.i-price').value;
    inclEl.value = String(rowInclValue(row));

    let inclTouched = row.dataset.inclOverride !== undefined && row.dataset.inclOverride !== '';
    const basis = currentPriceBasis();

    const syncInclFromExcl = () => {
      if (inclTouched) return;
      const printed = Math.max(0, Math.round(Number(exclEl.value) || 0));
      if (basis === 'inclusive') {
        inclEl.value = String(printed);
      } else {
        const { incl } = calcInclusive(printed, normalizeRateType(taxEl.value));
        inclEl.value = String(incl);
      }
    };

    exclEl.oninput = () => {
      inclTouched = false;
      syncInclFromExcl();
    };
    taxEl.onchange = () => {
      inclTouched = false;
      syncInclFromExcl();
    };
    inclEl.oninput = () => {
      inclTouched = true;
    };

    show(modal);
    setTimeout(() => nameEl.focus(), 50);

    const finish = (ok) => {
      $('itemEditOk').onclick = null;
      $('itemEditCancel').onclick = null;
      $('itemEditBackdrop').onclick = null;
      exclEl.oninput = null;
      taxEl.onchange = null;
      inclEl.oninput = null;
      hide(modal);
      resolve(ok);
    };

    $('itemEditOk').onclick = () => {
      const name = nameEl.value.trim();
      const printed = Math.max(0, Math.round(Number(exclEl.value) || 0));
      const incl = Math.max(0, Math.round(Number(inclEl.value) || 0));
      const tax = normalizeRateType(taxEl.value);
      const cat = catEl.value;
      row.querySelector('.i-name').value = name;
      row.querySelector('.i-tax').value = tax;
      row.querySelector('.i-cat').value = cat;
      if (basis === 'inclusive') {
        row.querySelector('.i-price').value = String(printed);
        if (inclTouched && incl !== printed) {
          row.dataset.inclOverride = String(incl);
        } else {
          delete row.dataset.inclOverride;
        }
      } else {
        const auto = calcInclusive(printed, tax).incl;
        row.querySelector('.i-price').value = String(printed);
        if (inclTouched || incl !== auto) {
          row.dataset.inclOverride = String(incl);
          const back = calcExclusiveFromIncl(incl, tax);
          row.querySelector('.i-price').value = String(back.excl);
        } else {
          delete row.dataset.inclOverride;
        }
      }
      row._syncNameDisplay?.();
      row._syncMetaDisplay?.();
      calcTotal();
      finish(true);
    };
    $('itemEditCancel').onclick = () => finish(false);
    $('itemEditBackdrop').onclick = () => finish(false);
  });
}

function addItemRow(name = '', price = '', category = '食費', taxRateType = '', inclOverride = null) {
  const tax = getTaxSettings();
  const rateType = normalizeRateType(taxRateType || tax.default_rate_type, tax);
  const row = document.createElement('div');
  row.className = 'item-row item-line';
  const exclVal = price === '' || price == null ? '' : Number(price);
  if (inclOverride != null && inclOverride !== '') {
    row.dataset.inclOverride = String(inclOverride);
  }
  row.innerHTML = `
    <div class="item-line-main">
      <button type="button" class="item-line-name i-name-display" aria-label="品目を修正"></button>
      <button type="button" class="btn btn-secondary btn-sm item-line-edit i-edit">修正</button>
      <button type="button" class="btn-icon" aria-label="行を削除">✕</button>
    </div>
    <div class="item-line-meta" aria-hidden="false">
      <span class="item-line-amount i-amount-display">0 円</span>
      <span class="item-line-category i-cat-display"></span>
    </div>
    <input class="i-name hidden" type="hidden" value="${escapeHtml(name)}">
    <input class="i-price hidden" type="hidden" value="${exclVal}">
    <select class="i-tax hidden">${taxRateOptionsHtml(rateType)}</select>
    <select class="i-cat hidden">${categoryOptionsHtml(category)}</select>
  `;

  const syncNameDisplay = () => {
    const v = row.querySelector('.i-name').value;
    const el = row.querySelector('.i-name-display');
    el.textContent = v || '品名を入力';
    el.dataset.empty = v ? '0' : '1';
    el.title = v || '品名を入力';
  };
  const syncMetaDisplay = () => {
    const amountEl = row.querySelector('.i-amount-display');
    const catEl = row.querySelector('.i-cat-display');
    const incl = rowInclValue(row);
    const cat = row.querySelector('.i-cat')?.value || 'その他';
    if (amountEl) amountEl.textContent = `${incl.toLocaleString()} 円`;
    if (catEl) {
      catEl.textContent = cat;
      catEl.title = cat;
    }
  };
  row._syncNameDisplay = syncNameDisplay;
  row._syncMetaDisplay = syncMetaDisplay;
  syncNameDisplay();
  syncMetaDisplay();

  const openEdit = () => openItemEditModal(row);
  row.querySelector('.i-edit').addEventListener('click', openEdit);
  row.querySelector('.i-name-display').addEventListener('click', openEdit);
  row.querySelector('.item-line-meta')?.addEventListener('click', openEdit);
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
function itemsForSaveFromRaw(rawItems, basis = 'exclusive') {
  const tax = getTaxSettings();
  const mode = basis === 'inclusive' ? 'inclusive' : 'exclusive';
  return (rawItems || []).map((it) => {
    const rateType = normalizeRateType(it.tax_rate_type, tax);
    const printed = Number(it.price_excl ?? it.price) || 0;
    if (mode === 'inclusive') {
      const price = it.incl_override != null ? Number(it.incl_override) : printed;
      const back = calcExclusiveFromIncl(price, rateType, tax);
      return {
        name: it.name || '（未入力）',
        price,
        price_excl: back.excl,
        tax_rate: back.rate,
        tax_rate_type: rateType,
        category: it.category || 'その他'
      };
    }
    const { incl, rate } = calcInclusive(printed, rateType, tax);
    const price = it.incl_override != null ? Number(it.incl_override) : incl;
    return {
      name: it.name || '（未入力）',
      price,
      price_excl: printed,
      tax_rate: rate,
      tax_rate_type: rateType,
      category: it.category || 'その他'
    };
  }).filter((it) => it.name || it.price > 0);
}

function collectItemsForSave() {
  return itemsForSaveFromRaw(collectItemsRaw(), currentPriceBasis());
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
      row._syncMetaDisplay?.();
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
      payment_method: '現金',
      price_basis: 'exclusive',
      items: []
    }];
  }
  analyzedReceipts = analyzedReceipts.map((r) => {
    const pm = (r.payment_method || '現金').trim() || '現金';
    ensurePaymentMethodInList(pm);
    let basis = r.price_basis;
    let hint = r.price_basis_hint || '';
    if (basis !== 'inclusive' && basis !== 'exclusive') {
      const sug = suggestPriceBasis(r);
      basis = sug.basis;
      hint = sug.reason;
    }
    return { ...r, payment_method: pm, price_basis: basis, price_basis_hint: hint };
  });
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
  const payment = (r.payment_method || '現金').trim() || '現金';
  const items = r.items || [];
  const basis = r.price_basis === 'inclusive' ? 'inclusive' : 'exclusive';

  $('shopName').value = shop;
  syncShopNameDisplay();
  $('receiptDate').value = dateVal;
  syncDateDisplay();
  $('paymentMethod').value = payment;
  ensurePaymentMethodInList(payment);
  syncPaymentDisplay();
  syncPriceBasisUi();
  renderItems(items);

  const { exclSum, inclSum } = calcTotal();
  const printedTotal = Number(r.total_amount) || 0;
  const diff = printedTotal > 0 ? printedTotal - inclSum : 0;
  const basisLine = basis === 'inclusive'
    ? `<b>印字額合計（税込扱い）:</b> ${inclSum.toLocaleString()} 円`
    : `<b>税抜合計:</b> ${exclSum.toLocaleString()} 円 → <b>税込換算:</b> ${inclSum.toLocaleString()} 円`;

  $('detectedSummary').innerHTML =
    `<b>検出:</b> ${escapeHtml(shop || '不明')} / ${escapeHtml(dateVal)} / ${escapeHtml(payment)}（${items.length}件）<br>` +
    basisLine +
    (r.price_basis_hint && basis === 'inclusive'
      ? `<br><span class="hint">${escapeHtml(r.price_basis_hint)}</span>`
      : '') +
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
    payment_method: ($('paymentMethod').value || '現金').trim() || '現金',
    price_basis: currentPriceBasis(),
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
  syncDateDisplay();
  $('paymentMethod').value = '現金';
  syncPaymentDisplay();
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
    if (result.model_used && result.model_used !== model) {
      setModel(result.model_used);
      if ($('modelSelect')) {
        const opt = [...$('modelSelect').options].find((o) => o.value === result.model_used);
        if (opt) $('modelSelect').value = result.model_used;
        else {
          const o = document.createElement('option');
          o.value = result.model_used;
          o.textContent = result.model_used;
          $('modelSelect').appendChild(o);
          $('modelSelect').value = result.model_used;
        }
      }
    }
    const n = result.receipts?.length || 0;
    const usedHint = result.model_fallback
      ? `（混雑のため ${result.model_used} で解析）`
      : '';
    showMessage(
      n > 1
        ? `解析完了。${n} 枚のレシートを検出しました。切り替えながら確認してください。${usedHint}`
        : `解析完了。税込金額を確認・修正してください。${usedHint}`,
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
  const book = payload.book || payload.book_id || getBookId();
  if (!book) throw new Error('帳簿を選択してください');
  const body = { ...payload, book };
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
      bookId: payload.book || getBookId(),
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
  const bookId = requireBookId();
  if (!bookId) return;

  stashCurrentReceiptEdits();
  const itemsSave = collectItemsForSave();
  if (itemsSave.length === 0) {
    showMessage('明細が1件以上必要です');
    return;
  }

  const totalAmount = itemsSave.reduce((sum, i) => sum + i.price, 0);
  const payload = {
    timestamp: new Date().toISOString(),
    book: bookId,
    shop_name: $('shopName').value.trim() || '不明',
    date: receiptDateForSave(),
    payment_method: ($('paymentMethod').value || '現金').trim() || '現金',
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
  const bookId = requireBookId();
  if (!bookId) return;
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
      const basis = r.price_basis === 'inclusive' ? 'inclusive' : 'exclusive';
      const itemsSave = itemsForSaveFromRaw(rawItems, basis);

      if (!itemsSave.length) continue;

      const payload = {
        timestamp: new Date().toISOString(),
        book: bookId,
        shop_name: r.shop_name || '不明',
        date: r.date || todayStr(),
        payment_method: (r.payment_method || '現金').trim() || '現金',
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
  const bookId = requireBookId();
  if (!bookId) return;
  const month = $('historyMonth').value || '';
  $('historyStatus').textContent = '読み込み中…';
  $('historyList').innerHTML = '';
  try {
    const receipts = await listReceipts(gasUrl, { bookId, month, limit: 50 });
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
        <div class="history-meta">保存 ${escapeHtml(formatDateTimeDisplay(r.created_at || r.date))} ／ レシート ${escapeHtml(/\d{1,2}:\d{2}/.test(String(r.date || '')) ? formatDateTimeDisplay(r.date) : formatDateDisplay(r.date))} ／ ${escapeHtml(r.payment_method || '現金')} ／ ${Number(r.total_amount || 0).toLocaleString()} 円 ／ ${r.item_count || 0}品目</div>
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
          const full = await getReceipt(gasUrl, r.receipt_id, { bookId });
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
          const result = await deleteReceipt(gasUrl, r.receipt_id, { bookId, deleteImage: true });
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
    const bookId = $('bookSelect')?.value || getBookId() || '';
    const result = await pingGas(gasUrl, { bookId });
    if (result.ok && result.data?.books) {
      populateBookSelect(result.data.books, bookId || getBookId());
    }
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
  if (!('serviceWorker' in navigator)) return;
  navigator.serviceWorker.register('./service-worker.js')
    .then((reg) => {
      const check = () => reg.update().catch(() => {});
      check();
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') check();
      });
    })
    .catch(() => {});
}

/** Clear SW caches and hard-reload so PWA picks up the latest GitHub Pages deploy. */
async function forceAppUpdate() {
  const status = $('forceUpdateStatus');
  const btn = $('forceUpdateBtn');
  if (btn) {
    btn.disabled = true;
    btn.textContent = '更新中…';
  }
  if (status) status.textContent = 'キャッシュと Service Worker をクリアしています…';

  try {
    if ('caches' in window) {
      const keys = await caches.keys();
      await Promise.all(keys.map((k) => caches.delete(k)));
    }
    if ('serviceWorker' in navigator) {
      const regs = await navigator.serviceWorker.getRegistrations();
      await Promise.all(regs.map((r) => r.unregister()));
    }
    if (status) status.textContent = '最新版を読み込みます…';
    const url = new URL(location.href);
    url.searchParams.set('_reload', String(Date.now()));
    location.replace(url.toString());
  } catch (err) {
    if (status) status.textContent = `更新に失敗しました: ${err.message || err}`;
    if (btn) {
      btn.disabled = false;
      btn.textContent = '最新版を読み込み';
    }
    showMessage(`更新エラー: ${err.message || err}`);
  }
}

function cleanReloadQueryParam() {
  try {
    const url = new URL(location.href);
    if (!url.searchParams.has('_reload')) return;
    url.searchParams.delete('_reload');
    history.replaceState(null, '', url.pathname + url.search + url.hash);
  } catch {
    /* ignore */
  }
}

function applyAppVersion() {
  const label = `v${APP_VERSION}`;
  const header = $('appVersion');
  if (header) header.textContent = label;
  const about = $('aboutVersion');
  if (about) about.textContent = label;
}

function init() {
  cleanReloadQueryParam();
  applyAppVersion();
  $('receiptDate').value = todayStr();
  syncShopNameDisplay();
  syncDateDisplay();
  $('paymentMethod').value = '現金';
  syncPaymentDisplay();
  initTabs();
  initSettings();
  initPaymentMethodSettings();
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
  $('editShopBtn')?.addEventListener('click', editShopName);
  $('receiptDateDisplay')?.addEventListener('click', editReceiptDate);
  $('editDateBtn')?.addEventListener('click', editReceiptDate);
  $('paymentDisplay')?.addEventListener('click', editPaymentMethod);
  $('editPaymentBtn')?.addEventListener('click', editPaymentMethod);
  $('priceBasisSelect')?.addEventListener('change', onPriceBasisChange);
  $('forceUpdateBtn')?.addEventListener('click', forceAppUpdate);
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
