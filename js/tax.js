/**
 * Tax settings + 外税 → 税込 conversion (floor of tax amount).
 */

import { getTaxSettings as loadStored, setTaxSettings as saveStored } from './storage.js';

export const DEFAULT_TAX = {
  standard_rate: 10,
  reduced_rate: 8,
  /** 'standard' | 'reduced' — default for new rows / AI without mark */
  default_rate_type: 'standard',
  /** floor: 税額切り捨て（小売で多い） / round: 四捨五入 */
  rounding: 'floor'
};

export function getTaxSettings() {
  return { ...DEFAULT_TAX, ...loadStored() };
}

export function saveTaxSettings(partial) {
  const next = { ...getTaxSettings(), ...partial };
  next.standard_rate = clampRate(next.standard_rate);
  next.reduced_rate = clampRate(next.reduced_rate);
  if (next.default_rate_type !== 'reduced') next.default_rate_type = 'standard';
  if (next.rounding !== 'round') next.rounding = 'floor';
  saveStored(next);
  return next;
}

function clampRate(n) {
  const v = Number(n);
  if (!Number.isFinite(v) || v < 0) return 0;
  if (v > 100) return 100;
  return Math.round(v * 10) / 10;
}

export function ratePercentForType(type, settings = getTaxSettings()) {
  return type === 'reduced' ? settings.reduced_rate : settings.standard_rate;
}

/**
 * @param {number} priceExcl 税抜
 * @param {'standard'|'reduced'} rateType
 * @param {object} [settings]
 * @returns {{ tax: number, incl: number, rate: number }}
 */
export function calcInclusive(priceExcl, rateType = 'standard', settings = getTaxSettings()) {
  const excl = Math.max(0, Math.round(Number(priceExcl) || 0));
  const rate = ratePercentForType(rateType, settings);
  let tax;
  if (settings.rounding === 'round') {
    tax = Math.round((excl * rate) / 100);
  } else {
    tax = Math.floor((excl * rate) / 100 + 1e-9);
  }
  return { tax, incl: excl + tax, rate };
}

/** 税込から税抜を逆算（切り捨てベースで近似） */
export function calcExclusiveFromIncl(priceIncl, rateType = 'standard', settings = getTaxSettings()) {
  const incl = Math.max(0, Math.round(Number(priceIncl) || 0));
  const rate = ratePercentForType(rateType, settings);
  if (rate <= 0) return { excl: incl, tax: 0, rate };
  // excl = floor(incl * 100 / (100+rate)) then adjust so floor tax matches when possible
  let excl = Math.floor((incl * 100) / (100 + rate));
  while (excl < incl && calcInclusive(excl, rateType, settings).incl < incl) {
    excl += 1;
  }
  while (excl > 0 && calcInclusive(excl, rateType, settings).incl > incl) {
    excl -= 1;
  }
  const { tax } = calcInclusive(excl, rateType, settings);
  return { excl, tax, rate };
}

export function normalizeRateType(value, settings = getTaxSettings()) {
  if (value === 'reduced' || value === 8 || value === '8') return 'reduced';
  if (value === 'standard' || value === 10 || value === '10') return 'standard';
  return settings.default_rate_type === 'reduced' ? 'reduced' : 'standard';
}

/**
 * Guess whether printed line prices are tax-inclusive from total vs item sum.
 * @returns {{ basis: 'exclusive'|'inclusive', reason: string }}
 */
export function suggestPriceBasis(receipt, settings = getTaxSettings()) {
  const items = receipt?.items || [];
  const printedSum = items.reduce(
    (s, it) => s + (Number(it.price_excl ?? it.price) || 0),
    0
  );
  const total = Number(receipt?.total_amount) || 0;
  if (printedSum <= 0 || total <= 0) {
    return { basis: 'exclusive', reason: '' };
  }
  const tol = Math.max(2, Math.round(total * 0.02));
  const asPrintedDiff = Math.abs(printedSum - total);

  let converted = 0;
  for (const it of items) {
    const excl = Number(it.price_excl ?? it.price) || 0;
    const rt = normalizeRateType(it.tax_rate_type, settings);
    converted += calcInclusive(excl, rt, settings).incl;
  }
  const asExclDiff = Math.abs(converted - total);

  if (asPrintedDiff <= tol && asPrintedDiff <= asExclDiff) {
    return {
      basis: 'inclusive',
      reason: '合計と品目合計が近いため税込印字と推定'
    };
  }
  return { basis: 'exclusive', reason: '' };
}
