import {
  getApiKey, setApiKey, getModel, setModel,
  getModels, setModels, getGasUrl, setGasUrl
} from './storage.js';
import { CATEGORIES, normalizeCategory } from './categories.js';
import { fetchModels, analyzeReceipt, sendToGas, pingGas } from './gemini-api.js';

let imageData = null;
let imageMime = 'image/jpeg';

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

function readFileAsBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result;
      resolve(result.split(',')[1]);
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

function initImageInput() {
  $('imageInput').addEventListener('change', async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;

    clearMessage();
    imageMime = file.type || 'image/jpeg';

    try {
      imageData = await readFileAsBase64(file);
      $('previewImg').src = URL.createObjectURL(file);
      show($('imagePreview'));
      const mb = (file.size / 1024 / 1024).toFixed(2);
      $('imageStatus').textContent = `画像を読み込みました（${file.name} / ${mb} MB）`;
    } catch (err) {
      showMessage(`画像の読み込みに失敗: ${err.message}`);
      imageData = null;
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
  if (!items.length) {
    addItemRow();
  } else {
    items.forEach((item) => addItemRow(item.name, item.price, item.category));
  }
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

  const count = items.length;
  $('detectedSummary').innerHTML = parsed
    ? `<b>検出結果:</b> ${escapeHtml(shop || '不明')} / ${escapeHtml(date)}（${count}件）`
    : '手入力モードです。明細を追加して保存できます。';

  show($('resultArea'));
}

function handleClear() {
  imageData = null;
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
    showMessage('モデルを選択してください（設定タブでモデル一覧を取得）');
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
  const gasUrl = $('gasUrlInput').value.trim() || getGasUrl();
  if (!gasUrl) {
    showMessage('設定タブでGAS Web App URLを保存してください');
    $('gasSettings').open = true;
    return;
  }

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

  $('sendBtn').disabled = true;
  $('sendBtn').textContent = '送信中...';

  try {
    const result = await sendToGas(gasUrl, payload);
    setGasUrl(gasUrl);

    if (result.verified) {
      const folder = result.result?.folderName || 'ReceiptAI';
      const file = result.result?.fileName || '';
      showMessage(`保存成功: ${folder} / ${file}`, 'success');
      handleClear();
    } else {
      showMessage(
        `送信しましたが、結果を確認できませんでした。\nGoogleドライブの「ReceiptAI」フォルダを見てください。\n無い場合は GAS の Code.gs を更新して新バージョン再デプロイ＆アクセス「全員」にしてください。`,
        'error'
      );
    }
  } catch (err) {
    showMessage(`送信エラー: ${err.message}`);
  } finally {
    $('sendBtn').disabled = false;
    $('sendBtn').textContent = '☁ Googleドライブへ保存';
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
    out.textContent = result.message;
    if (result.ok) {
      setGasUrl(normalizeUrlKeep(gasUrl));
      showMessage(result.message, 'success');
    } else if (result.corsBlocked && result.checkUrl) {
      showMessage('CORSのため自動判定できません。確認用URLを開きます', 'error');
      window.open(result.checkUrl, '_blank', 'noopener');
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

function normalizeUrlKeep(url) {
  return String(url || '').trim().replace(/\/$/, '');
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
      const stillValid = models.some((m) => m.id === current);
      if (!stillValid) {
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

function initApiKeyActions() {
  $('deleteApiKeyBtn').addEventListener('click', () => {
    if (!confirm('APIキーをこの端末から削除しますか？')) return;
    setApiKey('');
    $('apiKeyInput').value = '';
    showMessage('APIキーを削除しました', 'success');
  });
}

function initGasActions() {
  $('saveGasBtn').addEventListener('click', () => {
    const url = $('gasUrlInput').value.trim();
    if (!url) {
      showMessage('GAS URLを入力してください');
      return;
    }
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
  initApiKeyActions();
  initGasActions();
  registerServiceWorker();

  $('analyzeBtn').addEventListener('click', handleAnalyze);
  $('clearBtn').addEventListener('click', handleClear);
  $('addItemBtn').addEventListener('click', () => addItemRow());
  $('sendBtn').addEventListener('click', handleSend);
  $('manualSaveBtn').addEventListener('click', handleManualEdit);
  $('fetchModelsBtn').addEventListener('click', handleFetchModels);
}

document.addEventListener('DOMContentLoaded', init);
