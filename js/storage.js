/**
 * localStorage management - per device/browser
 */
const STORAGE_KEYS = {
  API_KEY: 'receiptai_apiKey',
  MODEL: 'receiptai_model',
  MODELS: 'receiptai_models',
  GAS_URL: 'receiptai_gasUrl'
};

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
