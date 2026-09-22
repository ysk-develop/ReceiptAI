/**
 * localStorage management - per device/browser
 */
const STORAGE_KEYS = {
  API_KEY: 'receiptai_apiKey',
  MODEL: 'receiptai_model',
  MODELS: 'receiptai_models',
  GAS_URL: 'receiptai_gasUrl',
  BOOK_ID: 'receiptai_bookId',
  TAX: 'receiptai_tax',
  PAYMENT_METHODS: 'receiptai_paymentMethods'
};

export const DEFAULT_PAYMENT_METHODS = ['現金', 'WAON', 'PayPay'];

export function getApiKey() {
  return localStorage.getItem(STORAGE_KEYS.API_KEY) || '';
}

export function setApiKey(key) {
  if (key) {
    localStorage.setItem(STORAGE_KEYS.API_KEY, key);
  } else {
    localStorage.removeItem(STORAGE_KEYS.API_KEY);
  }
}

export function getModel() {
  return localStorage.getItem(STORAGE_KEYS.MODEL) || 'gemini-2.0-flash';
}

export function setModel(model) {
  localStorage.setItem(STORAGE_KEYS.MODEL, model);
}

export function getModels() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEYS.MODELS) || '[]');
  } catch {
    return [];
  }
}

export function setModels(models) {
  localStorage.setItem(STORAGE_KEYS.MODELS, JSON.stringify(models));
}

export function getGasUrl() {
  return localStorage.getItem(STORAGE_KEYS.GAS_URL) || '';
}

export function setGasUrl(url) {
  if (url) {
    localStorage.setItem(STORAGE_KEYS.GAS_URL, url);
  } else {
    localStorage.removeItem(STORAGE_KEYS.GAS_URL);
  }
}

export function getBookId() {
  return localStorage.getItem(STORAGE_KEYS.BOOK_ID) || '';
}

export function setBookId(id) {
  if (id) {
    localStorage.setItem(STORAGE_KEYS.BOOK_ID, id);
  } else {
    localStorage.removeItem(STORAGE_KEYS.BOOK_ID);
  }
}

export function getTaxSettings() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEYS.TAX) || '{}');
  } catch {
    return {};
  }
}

export function setTaxSettings(obj) {
  localStorage.setItem(STORAGE_KEYS.TAX, JSON.stringify(obj));
}

export function getPaymentMethods() {
  try {
    const raw = JSON.parse(localStorage.getItem(STORAGE_KEYS.PAYMENT_METHODS) || 'null');
    if (Array.isArray(raw) && raw.length) {
      const cleaned = raw.map((x) => String(x || '').trim()).filter(Boolean);
      if (cleaned.length) return cleaned;
    }
  } catch {
    /* fall through */
  }
  const defaults = DEFAULT_PAYMENT_METHODS.slice();
  setPaymentMethods(defaults);
  return defaults;
}

export function setPaymentMethods(list) {
  const cleaned = (list || []).map((x) => String(x || '').trim()).filter(Boolean);
  const unique = [];
  cleaned.forEach((name) => {
    if (!unique.includes(name)) unique.push(name);
  });
  if (!unique.length) unique.push(...DEFAULT_PAYMENT_METHODS);
  localStorage.setItem(STORAGE_KEYS.PAYMENT_METHODS, JSON.stringify(unique));
  return unique;
}

export function ensurePaymentMethodInList(name) {
  const n = String(name || '').trim();
  if (!n) return getPaymentMethods();
  const list = getPaymentMethods();
  if (!list.includes(n)) {
    list.push(n);
    return setPaymentMethods(list);
  }
  return list;
}
