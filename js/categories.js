/**
 * Default expense categories for receipt classification
 */
export const CATEGORIES = [
  '食費',
  '日用品',
  '交通費',
  '交際費',
  '衣服・美容',
  '趣味・教養',
  '医療・健康',
  '水道・光熱費',
  'その他'
];

export function normalizeCategory(value) {
  if (!value) return 'その他';
  const found = CATEGORIES.find((c) => c === value || value.includes(c));
  return found || 'その他';
}
