/**
 * Gemini API + GAS spreadsheet client
 */

import { CATEGORIES } from './categories.js';

const API_BASE = 'https://generativelanguage.googleapis.com/v1beta';

export async function fetchModels(apiKey) {
  const url = `${API_BASE}/models?key=${encodeURIComponent(apiKey)}`;
  const res = await fetch(url);
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`モデル一覧取得失敗 (${res.status}): ${err}`);
  }
  const data = await res.json();
  return (data.models || [])
    .filter((m) => m.name && m.supportedGenerationMethods?.includes('generateContent'))
    .map((m) => ({
      id: m.name.replace('models/', ''),
      name: m.displayName || m.name.replace('models/', ''),
      description: m.description || ''
    }))
    .filter((m) => /gemini/i.test(m.id));
}

/**
 * Flat line schema: models extract ALL items reliably this way,
 * then we group by receipt_index into separate receipts.
 */
const LINE_SCHEMA = {
  type: 'object',
  properties: {
    receipt_index: {
      type: 'integer',
      description: '画像内のレシート番号（左から1,2,3...）。同じ紙は同じ番号'
    },
    shop_name: { type: 'string', description: 'そのレシートの店舗名' },
    date: {
      type: 'string',
      description:
        'レシート印字の日時。時刻があれば YYYY-MM-DD HH:mm:ss、日付のみなら YYYY-MM-DD'
    },
    total_amount: {
      type: 'number',
      description: 'そのレシート印字の税込合計（参考値）'
    },
    name: { type: 'string', description: '品目名（小計・税・合計行は出さない）' },
    price: {
      type: 'number',
      description: 'レシート印字の個別金額（税抜が多い。換算せず印字どおり）'
    },
    tax_rate_type: {
      type: 'string',
      description: 'standard=標準10%対象, reduced=軽減8%対象（*や軽などの印があれば reduced）'
    },
    category: { type: 'string' }
  },
  required: [
    'receipt_index',
    'shop_name',
    'date',
    'total_amount',
    'name',
    'price',
    'tax_rate_type',
    'category'
  ]
};

const RECEIPT_SCHEMA = {
  type: 'object',
  properties: {
    receipt_count: {
      type: 'integer',
      description: '画像に写っている紙のレシート枚数'
    },
    lines: {
      type: 'array',
      description: '全レシートの全品目（漏れなく）。receipt_index で所属レシートを示す',
      items: LINE_SCHEMA
    }
  },
  required: ['receipt_count', 'lines']
};

function buildPrompt(today, memo) {
  const categoryList = CATEGORIES.join(', ');
  let text = `あなたは優秀な家計簿アシスタントです。
日本の家計簿では「実際に支払った税込金額」を記録します。

【最重要・複数レシート】
- まず画像に「紙のレシート」が何枚あるか数え、receipt_count にその枚数を入れてください。
- 左右（または上下）に並ぶレシートはすべて別番号です（1,2,3...）。
- 同じ店舗名・同じ日でも、紙が別なら別の receipt_index にしてください。
- lines には全レシートの全品目を漏れなく出してください。1枚分だけ出力するのは誤りです（写真に1枚しかない場合を除く）。
- 各行に shop_name / date / total_amount をそのレシートのもので繰り返してください。

【金額】
- price はレシートに印字されている個別金額をそのまま（多くの店では税抜）。アプリ側で税込換算するため、勝手に税込へ直さない。
- total_amount だけはレシート下部の「合計／お会計」の税込額（参考）。
- tax_rate_type は軽減対象（*・軽・8%など）なら "reduced"、それ以外は "standard"。
- 小計・消費税・内税・外税・合計の行は lines に入れない。

カテゴリは次から選択: [${categoryList}]
不明な日付のみ ${today} を使う。時刻が印字されていれば date に含める。店舗名が読めないときのみ「不明」。
JSONのみ出力。`;
  if (memo) text += `\n\n【入力メモ】\n${memo}`;
  return text;
}

function buildRetryPrompt(today, expectedCount, gotCount) {
  return `前回の抽出では receipt_count=${expectedCount} なのに lines から再構成したレシートが ${gotCount} 枚しかありませんでした。
画像内の紙レシートを左から右へすべて再抽出し、receipt_count 枚ぶんの品目を lines に出力してください。
金額は税込。小計・税・合計行は lines に入れない。日付不明のみ ${today}。
JSONのみ。`;
}

function localTodayStr() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** Accept YYYY-MM-DD or YYYY-MM-DD HH:mm[:ss] / with slashes; else fallback */
function normalizeReceiptDate(value, fallback) {
  const s = String(value || '').trim();
  const m = s.match(
    /^(\d{4})[\/\-](\d{1,2})[\/\-](\d{1,2})(?:[ T](\d{1,2}):(\d{1,2})(?::(\d{1,2}))?)?/
  );
  if (!m) return fallback;
  const p = (n) => String(n).padStart(2, '0');
  let out = `${m[1]}-${p(m[2])}-${p(m[3])}`;
  if (m[4] != null) {
    out += ` ${p(m[4])}:${p(m[5])}:${p(m[6] || '0')}`;
  }
  return out;
}

/**
 * Group flat lines (or legacy receipts[]) into receipt objects.
 */
export function normalizeAnalysisResult(parsed, today = localTodayStr()) {
  // New flat format
  if (parsed && Array.isArray(parsed.lines) && parsed.lines.length) {
    const groups = new Map();
    for (const line of parsed.lines) {
      const idx = Number(line.receipt_index) || 1;
      if (!groups.has(idx)) {
        groups.set(idx, {
          shop_name: String(line.shop_name || '不明').trim() || '不明',
          date: normalizeReceiptDate(line.date, today),
          total_amount: Number(line.total_amount) || 0,
          items: []
        });
      }
      const g = groups.get(idx);
      const name = String(line.name || '').trim();
      const price = Number(line.price) || 0;
      if (!name && !price) continue;
      // skip tax/total-like rows if model still emits them
      if (/^(小計|合計|税|消費税|内税|外税|お預り|お釣り|お会計)/.test(name)) continue;
      g.items.push({
        name: name || '（未入力）',
        price, // 税抜（印字）
        tax_rate_type: (line.tax_rate_type === 'reduced') ? 'reduced' : 'standard',
        category: String(line.category || 'その他')
      });
      if (Number(line.total_amount) > 0) g.total_amount = Number(line.total_amount);
      if (line.shop_name) g.shop_name = String(line.shop_name).trim() || g.shop_name;
      if (line.date && /^\d{4}-\d{2}-\d{2}$/.test(String(line.date).trim())) {
        g.date = String(line.date).trim();
      }
    }

    const list = [...groups.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([, r], i) => {
        const itemsSum = r.items.reduce((s, it) => s + it.price, 0);
        let total = Number(r.total_amount);
        if (!Number.isFinite(total) || total <= 0) total = itemsSum;
        return { ...r, total_amount: total, _index: i };
      })
      .filter((r) => r.items.length > 0);

    return list;
  }

  // Legacy receipts[] format
  let list = [];
  if (parsed && Array.isArray(parsed.receipts) && parsed.receipts.length) {
    list = parsed.receipts;
  } else if (parsed && (parsed.items || parsed.shop_name)) {
    list = [parsed];
  }

  return list.map((r, idx) => {
    const items = (r.items || []).map((it) => ({
      name: String(it.name || '（未入力）'),
      price: Number(it.price) || 0,
      tax_rate_type: it.tax_rate_type === 'reduced' ? 'reduced' : 'standard',
      category: String(it.category || 'その他')
    })).filter((it) => it.name || it.price);

    const itemsSum = items.reduce((s, it) => s + it.price, 0);
    let total = Number(r.total_amount);
    if (!Number.isFinite(total) || total <= 0) total = itemsSum;

    let dateStr = normalizeReceiptDate(r.date, today);

    return {
      shop_name: String(r.shop_name || '不明').trim() || '不明',
      date: dateStr,
      total_amount: total,
      items,
      _index: idx
    };
  }).filter((r) => r.items.length > 0);
}

async function callGeminiJson(apiKey, model, parts, schema) {
  const url = `${API_BASE}/models/${model}:generateContent?key=${encodeURIComponent(apiKey)}`;
  const body = {
    contents: [{ parts }],
    generationConfig: {
      responseMimeType: 'application/json',
      responseSchema: schema,
      maxOutputTokens: 8192,
      temperature: 0.1
    }
  };
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`レシート解析失敗 (${res.status}): ${err}`);
  }
  const data = await res.json();
  const text = data.candidates?.[0]?.content?.parts?.map((p) => p.text || '').join('') || '';
  if (!text) throw new Error('AIからの応答が空です');
  return JSON.parse(text);
}

export async function analyzeReceipt(apiKey, model, { base64Data, mimeType, memo }) {
  const today = localTodayStr();
  const mediaParts = [];
  if (base64Data) {
    mediaParts.push({ inlineData: { mimeType: mimeType || 'image/jpeg', data: base64Data } });
  }
  if (mediaParts.length === 0 && !memo) throw new Error('画像またはメモが必要です');

  const firstParts = [...mediaParts, { text: buildPrompt(today, memo) }];
  let parsed = await callGeminiJson(apiKey, model, firstParts, RECEIPT_SCHEMA);
  let receipts = normalizeAnalysisResult(parsed, today);
  const declared = Number(parsed.receipt_count) || 0;

  // Retry once if model declared more receipts than it returned
  if (declared > receipts.length && base64Data) {
    const retryParts = [
      ...mediaParts,
      {
        text: buildRetryPrompt(today, declared, receipts.length) +
          (memo ? `\n\n【入力メモ】\n${memo}` : '')
      }
    ];
    parsed = await callGeminiJson(apiKey, model, retryParts, RECEIPT_SCHEMA);
    const retried = normalizeAnalysisResult(parsed, today);
    if (retried.length >= receipts.length) receipts = retried;
  }

  if (!receipts.length) throw new Error('レシートを検出できませんでした');
  return {
    receipts,
    raw: parsed,
    receipt_count_declared: declared || receipts.length
  };
}

export function normalizeGasUrl(url) {
  const u = String(url || '').trim();
  if (!u) throw new Error('GAS URLが空です');
  if (!/script\.google\.com\/macros\/s\//.test(u)) {
    throw new Error('GASのウェブアプリURL（.../exec）を指定してください');
  }
  if (u.includes('/dev')) {
    throw new Error('URLが /dev です。/exec のURLを使ってください');
  }
  return u.replace(/\/$/, '');
}

/** JSONP for GAS doGet (avoids CORS) */
export function gasJsonp(gasUrl, params = {}, timeoutMs = 60000) {
  const base = normalizeGasUrl(gasUrl);
  const cb = `receiptai_cb_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
  const q = new URLSearchParams({ ...params, callback: cb });
  const src = `${base}?${q.toString()}`;

  return new Promise((resolve, reject) => {
    const script = document.createElement('script');
    let timer = setTimeout(() => {
      cleanup();
      reject(new Error('GAS応答タイムアウト'));
    }, timeoutMs);

    function cleanup() {
      clearTimeout(timer);
      delete window[cb];
      script.remove();
    }

    window[cb] = (data) => {
      cleanup();
      resolve(data);
    };
    script.onerror = () => {
      cleanup();
      reject(new Error('GASへの接続に失敗しました'));
    };
    script.src = src;
    document.head.appendChild(script);
  });
}

export async function pingGas(gasUrl) {
  const checkUrl = `${normalizeGasUrl(gasUrl)}?action=ping`;
  try {
    const data = await gasJsonp(gasUrl, { action: 'ping' });
    if (data.status === 'ok') {
      return {
        ok: true,
        message: `接続OK / シート: ${data.spreadsheetUrl || data.sheetName || 'ReceiptAI'}`,
        data,
        checkUrl
      };
    }
    return { ok: false, message: data.message || 'ping失敗', data, checkUrl };
  } catch (err) {
    return {
      ok: false,
      corsBlocked: true,
      message: `自動確認に失敗: ${err.message}\n手動確認: ${checkUrl}`,
      checkUrl,
      error: String(err.message || err)
    };
  }
}

export async function listReceipts(gasUrl, { month = '', limit = 50 } = {}) {
  const data = await gasJsonp(gasUrl, {
    action: 'list',
    month: month || '',
    limit: String(limit)
  });
  if (data.status !== 'ok') throw new Error(data.message || '一覧取得失敗');
  return data.receipts || [];
}

export async function getReceipt(gasUrl, receiptId) {
  const data = await gasJsonp(gasUrl, { action: 'receipt', id: receiptId });
  if (data.status !== 'ok') throw new Error(data.message || '取得失敗');
  return data;
}

/** Physically delete receipt rows (and unused Drive image) via GAS. */
export async function deleteReceipt(gasUrl, receiptId, { deleteImage = true } = {}) {
  if (!receiptId) throw new Error('削除対象のIDがありません');
  const data = await gasJsonp(gasUrl, {
    action: 'delete',
    id: receiptId,
    delete_image: deleteImage ? '1' : '0'
  }, 90000);
  if (data.status !== 'ok') throw new Error(data.message || '削除失敗');
  return data;
}

/** Find likely duplicate receipts (shop + date + total [+ item count]). */
export async function findDuplicateReceipts(
  gasUrl,
  { shop_name, date, total_amount, item_count = null } = {}
) {
  const params = {
    action: 'duplicates',
    shop: shop_name || '',
    date: date || '',
    total: String(Math.round(Number(total_amount) || 0))
  };
  if (item_count != null && item_count !== '') {
    params.items = String(item_count);
  }
  const data = await gasJsonp(gasUrl, params, 60000);
  if (data.status !== 'ok') throw new Error(data.message || '重複チェック失敗');
  return data.duplicates || [];
}

/** Fetch receipt image bytes via GAS (avoids broken Drive hotlink in <img>). */
export async function fetchReceiptImage(gasUrl, fileId) {
  if (!fileId) throw new Error('画像IDがありません');
  const data = await gasJsonp(
    gasUrl,
    { action: 'image', id: fileId, data: '1' },
    120000
  );
  if (data.status !== 'ok') throw new Error(data.message || '画像取得失敗');
  if (!data.data_base64) throw new Error('画像データが空です');
  return {
    mime: data.mime || 'image/jpeg',
    base64: data.data_base64,
    name: data.name || ''
  };
}

/**
 * Save receipt (+ optional resized image) to spreadsheet via GAS.
 */
export async function sendToGas(gasUrl, payload) {
  const url = normalizeGasUrl(gasUrl);
  const body = { action: 'save', ...payload };
  const bodyText = JSON.stringify(body);

  try {
    const res = await fetch(url, {
      method: 'POST',
      redirect: 'follow',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: bodyText
    });
    const text = await res.text();
    const data = JSON.parse(text);
    if (data.status === 'error') throw new Error(data.message || 'GAS側でエラー');
    return { verified: true, result: data };
  } catch (err) {
    const form = new URLSearchParams();
    form.set('data', bodyText);
    await fetch(url, { method: 'POST', mode: 'no-cors', body: form });
    return {
      verified: false,
      warning: String(err.message || err),
      hint: '送信しました。接続テストや履歴タブで反映を確認してください。'
    };
  }
}
