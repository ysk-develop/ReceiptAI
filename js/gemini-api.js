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

const RECEIPT_SCHEMA = {
  type: 'object',
  properties: {
    shop_name: { type: 'string' },
    date: { type: 'string' },
    items: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          price: { type: 'number' },
          category: { type: 'string' }
        },
        required: ['name', 'price', 'category']
      }
    }
  },
  required: ['shop_name', 'date', 'items']
};

function buildPrompt(today, memo) {
  const categoryList = CATEGORIES.join(', ');
  let text = `あなたは優秀な家計簿アシスタントです。
提供されたレシート画像またはテキストメモから情報を抽出してください。
- shop_name: 店舗名（不明なら「不明」）
- date: 日付 YYYY-MM-DD（不明なら ${today}）
- items: 品目リスト（name, price, category）
カテゴリは次から選択: [${categoryList}]
JSONのみ出力してください。`;
  if (memo) text += `\n\n【入力メモ】\n${memo}`;
  return text;
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
  return JSON.parse(text);
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
