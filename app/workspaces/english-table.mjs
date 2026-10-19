// @ts-check
// Workspaces set up before the app became English-only kept Turkish table
// labels. Startup renames the known ones; labels a user wrote stay unchanged.
const legacyLabels = new Map(
  Object.entries({
    Kaynak: 'Source',
    Pozisyon: 'Position',
    Şirket: 'Company',
    Konum: 'Location',
    'Çalışma şekli': 'Work mode',
    'Çalışma modeli': 'Work model',
    'AI odağı': 'AI focus',
    Maaş: 'Salary',
    'Maaş / aralık': 'Salary / range',
    'Maaş aralığı': 'Salary range',
    'Temel koşullar': 'Key requirements',
    'Uygunluk puanı': 'Fit score',
    'Uygunluk notu': 'Fit note',
    'Kısıt / uygunluk notu': 'Restrictions / fit note',
    'Son başvuru': 'Deadline',
    'İş ilanları ve başvurular': 'Job listings and applications',
    'Başvuru akışı': 'Applications',
    Başvurular: 'Applications',
  }),
);

const english = (label) =>
  typeof label === 'string' ? (legacyLabels.get(label.trim()) ?? label) : label;

// Returns the table with known legacy labels in English, or null when none changed.
export function englishTable(table) {
  if (!table) return null;
  const next = {
    ...table,
    title: english(table.title),
    columns: (table.columns ?? []).map((column) => ({...column, label: english(column.label)})),
  };
  return JSON.stringify(next) === JSON.stringify(table) ? null : next;
}
