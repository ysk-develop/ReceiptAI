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

const RECEIPT_ITEM_SCHEMA = {
  type: 'object',
  properties: {
    name: { type: 'string', description: '品目名（小計・税・合計行は含めない）' },
    price: { type: 'number', description: '税込金額（円）' },
    category: { type: 'string' }
  },
  required: ['name', 'price', 'category']
};

const SINGLE_RECEIPT_SCHEMA = {
  type: 'object',
  properties: {
    shop_name: { type: 'string', description: 'そのレシートの店舗名' },
    date: { type: 'string', description: 'そのレシートの日付 YYYY-MM-DD' },
    total_amount: { type: 'number', description: 'レシート記載の税込合計金額' },
    items: {
      type: 'array',
      items: RECEIPT_ITEM_SCHEMA
    }
  },
  required: ['shop_name', 'date', 'total_amount', 'items']
};

/** Multi-receipt friendly schema (1 image may contain several receipts). */
const RECEIPT_SCHEMA = {
  type: 'object',
  properties: {
    receipts: {
      type: 'array',
      description: '画像内のレシートごと（店舗・日付が違うものは必ず分ける）',
      items: SINGLE_RECEIPT_SCHEMA
    }
  },
  required: ['receipts']
};

function buildPrompt(today, memo) {
  const categoryList = CATEGORIES.join(', ');
  let text = `あなたは優秀な家計簿アシスタントです。
日本の家計簿では「実際に支払った税込金額」を記録します。

【金額ルール・最重要】
- 各品目の price は必ず税込（円）にしてください。
- レシートに税抜単価と税込合計がある場合、品目は税込に換算し、合計はレシートの「合計／税込合計／お会計」行の金額を total_amount に入れてください。
- 税抜のまま合計しないでください。小計・消費税・内税・外税・合計の行自体は items に入れないでください。
- 値引き行がある場合は負の金額、または対象品目から差し引いた税込額にしてください。

【複数レシート・最重要】
- 1枚の写真に複数のレシートがある場合、receipts 配列の要素をレシート枚数分作ってください。
- 店舗名・日付が異なるレシートを1つにまとめないでください。
- 各レシートごとに shop_name / date / total_amount / items を独立して設定してください。
- 日付が読めないレシートだけ ${today} を使い、読める日付は必ずその日付にしてください。
- 店舗名が読めない場合のみ「不明」。

カテゴリは次から選択: [${categoryList}]
JSONのみ出力してください。`;
  if (memo) text += `\n\n【入力メモ】\n${memo}`;
  return text;
}

/**
 * Normalize model output to { receipts: [...] }.
 * Also accepts legacy single-receipt shape.
 */
export function normalizeAnalysisResult(parsed, today = new Date().toISOString().slice(0, 10)) {
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
      category: String(it.category || 'その他')
    })).filter((it) => it.name || it.price);

    const itemsSum = items.reduce((s, it) => s + it.price, 0);
    let total = Number(r.total_amount);
    if (!Number.isFinite(total) || total <= 0) total = itemsSum;

    let dateStr = String(r.date || '').trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) dateStr = today;

    return {
      shop_name: String(r.shop_name || '不明').trim() || '不明',
      date: dateStr,
      total_amount: total,
      items,
      _index: idx
    };
  }).filter((r) => r.items.length > 0);
}

export async function analyzeReceipt(apiKey, model, { base64Data, mimeType, memo }) {
  const url = `${API_BASE}/models/${model}:generateContent?key=${encodeURIComponent(apiKey)}`;
  const today = new Date().toISOString().slice(0, 10);
  const parts = [];
  if (base64Data) {
    parts.push({ inlineData: { mimeType: mimeType || 'image/jpeg', data: base64Data } });
  }
  parts.push({ text: buildPrompt(today, memo) });
  if (parts.length === 1 && !memo) throw new Error('画像またはメモが必要です');

  const body = {
    contents: [{ parts }],
    generationConfig: {
      responseMimeType: 'application/json',
      responseSchema: RECEIPT_SCHEMA
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
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw new Error('AIからの応答が空です');
  const parsed = JSON.parse(text);
  const receipts = normalizeAnalysisResult(parsed, today);
  if (!receipts.length) throw new Error('レシートを検出できませんでした');
  return { receipts, raw: parsed };
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
