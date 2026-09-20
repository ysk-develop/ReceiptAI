import {
  getApiKey, setApiKey, getModel, setModel,
  getModels, setModels, getGasUrl, setGasUrl
} from './storage.js';
import { CATEGORIES, normalizeCategory } from './categories.js';
import {
  fetchModels, analyzeReceipt, sendToGas, pingGas,
  listReceipts, getReceipt
} from './gemini-api.js';
import { resizeImageFile } from './image-util.js';

let imageData = null;
let imageMime = 'image/jpeg';
/** Resized JPEG for Drive upload (may equal imageData) */
let uploadImageBase64 = null;

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

function todayStr() {
  return new Date().toISOString().slice(0, 10);
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
      $('previewImg').src = resized.dataUrl;
      show($('imagePreview'));
      $('imageStatus').textContent =
        `画像を読み込みました（${resized.width}×${resized.height}, JPEG縮小済み）`;
    } catch (err) {
      showMessage(`画像の読み込みに失敗: ${err.message}`);
      imageData = null;
      uploadImageBase64 = null;
    }
  });
}

function categoryOptionsHtml(selected) {
  const cat = normalizeCategory(selected);
  return CATEGORIES.map(
    (c) => `<option value="${escapeHtml(c)}" ${c === cat ? 'selected' : ''}>${escapeHtml(c)}</option>`
  ).join('');
}

function calcTotal() {
  let total = 0;
  document.querySelectorAll('#itemList .i-price').forEach((el) => {
    total += Number(el.value) || 0;
  });
  $('totalPrice').textContent = `${total.toLocaleString()} 円`;
  return total;
}

function addItemRow(name = '', price = '', category = '食費') {
  const row = document.createElement('div');
  row.className = 'item-row';
  row.innerHTML = `
    <input class="i-name" type="text" value="${escapeHtml(name)}" placeholder="品目名">
    <input class="i-price" type="number" inputmode="numeric" value="${price === '' || price == null ? '' : Number(price)}" placeholder="円">
    <select class="i-cat">${categoryOptionsHtml(category)}</select>
    <button type="button" class="btn-icon" aria-label="行を削除">✕</button>
  `;
  row.querySelector('.i-price').addEventListener('input', calcTotal);
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
  else items.forEach((item) => addItemRow(item.name, item.price, item.category));
}

function collectItems() {
  const items = [];
  document.querySelectorAll('#itemList .item-row').forEach((row) => {
    const name = row.querySelector('.i-name').value.trim();
    const price = Number(row.querySelector('.i-price').value) || 0;
    const category = row.querySelector('.i-cat').value;
    if (name || price > 0) {
      items.push({ name: name || '（未入力）', price, category });
    }
  });
  return items;
}

function openEditor(parsed) {
  const shop = parsed?.shop_name || '';
  const date = parsed?.date && /^\d{4}-\d{2}-\d{2}$/.test(parsed.date)
    ? parsed.date
    : todayStr();
  const items = parsed?.items || [];
  $('shopName').value = shop;
  $('receiptDate').value = date;
  renderItems(items);
  $('detectedSummary').innerHTML = parsed
    ? `<b>検出結果:</b> ${escapeHtml(shop || '不明')} / ${escapeHtml(date)}（${items.length}件）`
    : '手入力モードです。明細を追加して保存できます。';
  show($('resultArea'));
}

function handleClear() {
  imageData = null;
  uploadImageBase64 = null;
  imageMime = 'image/jpeg';
  $('imageInput').value = '';
  $('textMemo').value = '';
  hide($('imagePreview'));
  $('previewImg').src = '';
  hide($('resultArea'));
  clearMessage();
  $('imageStatus').textContent = '写真を選ぶか、メモを入力してください';
  $('itemList').innerHTML = '';
  $('shopName').value = '';
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
    const parsed = await analyzeReceipt(apiKey, model, {
      base64Data: imageData,
      mimeType: imageMime,
      memo
    });
    openEditor(parsed);
    showMessage('解析完了。内容を確認・修正してください。', 'success');
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

async function handleSend() {
  clearMessage();
  const gasUrl = requireGasUrl();
  if (!gasUrl) return;

  const items = collectItems();
  if (items.length === 0) {
    showMessage('明細が1件以上必要です');
    return;
  }

  const totalAmount = items.reduce((sum, i) => sum + i.price, 0);
  const payload = {
    timestamp: new Date().toISOString(),
    shop_name: $('shopName').value.trim() || '不明',
    date: $('receiptDate').value || todayStr(),
    total_amount: totalAmount,
    items
  };
  if (uploadImageBase64) {
    payload.image_base64 = uploadImageBase64;
    payload.image_mime = 'image/jpeg';
  }

  $('sendBtn').disabled = true;
  $('sendBtn').textContent = '送信中...';
  try {
    const result = await sendToGas(gasUrl, payload);
    setGasUrl(gasUrl);
    if (result.verified) {
      const img = result.result?.image_file_id ? ' / 画像あり' : '';
      showMessage(`保存成功（スプレッドシート）${img}`, 'success');
      handleClear();
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
    $('sendBtn').textContent = '☁ スプレッドシートへ保存';
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
        <div class="history-meta">${escapeHtml(r.date)} / ${Number(r.total_amount || 0).toLocaleString()} 円 / ${r.item_count || 0}品目</div>
        <div class="btn-row">
          <button type="button" class="btn btn-secondary btn-detail">明細</button>
          <button type="button" class="btn btn-primary btn-image" ${r.image_file_id || r.image_view_url ? '' : 'disabled'}>画像を表示</button>
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
      frag.appendChild(card);
    }
    $('historyList').appendChild(frag);
  } catch (err) {
    $('historyStatus').textContent = `エラー: ${err.message}`;
  }
}

function openImageModal(viewUrl, fileId) {
  const url = viewUrl || (fileId ? `https://drive.google.com/uc?export=view&id=${fileId}` : '');
  if (!url) {
    alert('画像がありません');
    return;
  }
  $('modalImg').src = url;
  $('modalImgHint').textContent = '表示されない場合は Drive の共有設定、または GAS 再デプロイを確認してください。';
  show($('imageModal'));
}

function closeImageModal() {
  hide($('imageModal'));
  $('modalImg').src = '';
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
  initTabs();
  initSettings();
  initImageInput();
  initGasActions();
  registerServiceWorker();

  $('analyzeBtn').addEventListener('click', handleAnalyze);
  $('clearBtn').addEventListener('click', handleClear);
  $('addItemBtn').addEventListener('click', () => addItemRow());
  $('sendBtn').addEventListener('click', handleSend);
  $('manualSaveBtn').addEventListener('click', handleManualEdit);
  $('fetchModelsBtn').addEventListener('click', handleFetchModels);
  $('refreshHistoryBtn').addEventListener('click', handleRefreshHistory);
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
