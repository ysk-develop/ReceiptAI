/**
 * Gemini API client for receipt analysis
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
  const models = (data.models || [])
    .filter((m) => m.name && m.supportedGenerationMethods?.includes('generateContent'))
    .map((m) => ({
      id: m.name.replace('models/', ''),
      name: m.displayName || m.name.replace('models/', ''),
      description: m.description || ''
    }))
    .filter((m) => /gemini/i.test(m.id));
  return models;
}

const RECEIPT_SCHEMA = {
  type: 'object',
  properties: {
    shop_name: { type: 'string', description: '店舗名。不明なら「不明」' },
    date: { type: 'string', description: '日付 YYYY-MM-DD。不明なら今日' },
    items: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string', description: '品目名' },
          price: { type: 'number', description: '金額（円）' },
          category: { type: 'string', description: 'カテゴリ' }
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
提供されたレシート画像またはテキストメモから、以下の情報を抽出してください。

- shop_name: 店舗名（不明な場合は「不明」）
- date: 日付（YYYY-MM-DD形式。不明なら ${today}）
- items: 品目リスト（name=品目名, price=金額の数値, category=カテゴリ）

カテゴリは必ず次のいずれかから選んでください:
[${categoryList}]

複数のレシートが写っている場合は、すべての品目を items に含めてください。
税込金額が分かる場合は税込で記載してください。
JSONのみを出力してください。`;

  if (memo) {
    text += `\n\n【入力メモ】\n${memo}`;
  }
  return text;
}

export async function analyzeReceipt(apiKey, model, { base64Data, mimeType, memo }) {
  const url = `${API_BASE}/models/${model}:generateContent?key=${encodeURIComponent(apiKey)}`;
  const today = new Date().toISOString().slice(0, 10);

  const parts = [];
  if (base64Data) {
    parts.push({
      inlineData: {
        mimeType: mimeType || 'image/jpeg',
        data: base64Data
      }
    });
  }
  parts.push({ text: buildPrompt(today, memo) });

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

  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`JSON解析失敗: ${text.slice(0, 200)}`);
  }
}

function normalizeGasUrl(url) {
  const u = String(url || '').trim();
  if (!u) throw new Error('GAS URLが空です');
  if (!/script\.google\.com\/macros\/s\//.test(u)) {
    throw new Error('GASのウェブアプリURL（script.google.com/macros/s/.../exec）を指定してください');
  }
  // /dev は自分のログイン時のみ。スマホから使うなら /exec が必須
  if (u.includes('/dev')) {
    throw new Error('URLが /dev です。デプロイ後の /exec のURLを使ってください');
  }
  return u.replace(/\/$/, '');
}

/**
 * Ping GAS (doGet?ping=1). Opens in a way that works despite CORS:
 * returns { ok, message, raw? } — may ask user to open URL manually.
 */
export async function pingGas(gasUrl) {
  const url = `${normalizeGasUrl(gasUrl)}?ping=1`;
  try {
    const res = await fetch(url, { method: 'GET', redirect: 'follow' });
    const text = await res.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      throw new Error(`応答がJSONではありません: ${text.slice(0, 120)}`);
    }
    if (data.status === 'ok') {
      return {
        ok: true,
        message: `接続OK / 保存先: ${data.folderName || 'ReceiptAI'}`,
        data,
        checkUrl: url
      };
    }
    return { ok: false, message: data.message || 'ping失敗', data, checkUrl: url };
  } catch (err) {
    // CORSで読めない場合でもスクリプト自体は生きていることがある
    return {
      ok: false,
      corsBlocked: true,
      message: `ブラウザから応答を読めませんでした（CORS）。次のURLをSafariで開いて {"status":"ok"} と出るか確認してください。\n${url}`,
      checkUrl: url,
      error: String(err.message || err)
    };
  }
}

/**
 * Send receipt JSON to GAS.
 * Prefer cors+readable response; fall back to form-encoded POST.
 * Returns { verified: boolean, result?: object, warning?: string }
 */
export async function sendToGas(gasUrl, payload) {
  const url = normalizeGasUrl(gasUrl);
  const bodyText = JSON.stringify(payload);

  // 1) text/plain POST（プリフライト無し）。成功時は JSON が読めることもある
  try {
    const res = await fetch(url, {
      method: 'POST',
      redirect: 'follow',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: bodyText
    });
    const text = await res.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      throw new Error(`応答不正: ${text.slice(0, 150)}`);
    }
    if (data.status === 'error') {
      throw new Error(data.message || 'GAS側でエラー');
    }
    return { verified: true, result: data };
  } catch (err) {
    // 2) CORSで読めない場合: form POST（no-cors）。サーバー側は動くことが多いが検証不可
    const form = new URLSearchParams();
    form.set('data', bodyText);
    await fetch(url, {
      method: 'POST',
      mode: 'no-cors',
      body: form
    });
    return {
      verified: false,
      warning: String(err.message || err),
      hint: '送信リクエストは送りました。My Drive の「ReceiptAI」フォルダを確認してください。無い場合は GAS を新バージョンで再デプロイし、アクセスを「全員」にしてください。'
    };
  }
}
