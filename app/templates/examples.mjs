// @ts-check
// Non-job templates. They are not offered for new workspaces; they keep the
// core honest by exercising the template contract with other domains.
const field = (id, label, question, required = true) => ({id, label, question, required});
export const exampleTemplates = [
  {
    id: 'housing',
    example: true,
    recordOperations: {
      prepare: {label: 'Mesajı hazırla'},
      execute: {
        label: 'Mesaj gönder',
        reviewLabel: 'Onayla ve mesaj gönder',
        successCriteria:
          'The website shows this exact message sent to this listing or a new thread containing it.',
      },
    },
    table: {
      title: 'Ev arama akışı',
      columns: [
        {key: 'source', label: 'Kaynak', type: 'text'},
        {key: 'title', label: 'İlan', type: 'text'},
        {key: 'location', label: 'Konum', type: 'text'},
        {key: 'rent', label: 'Kira (€)', type: 'money'},
        {key: 'rooms', label: 'Oda', type: 'number'},
        {key: 'score', label: 'Puan', type: 'number'},
      ],
    },
    version: 1,
    title: 'Ev arama',
    icon: '⌂',
    description: 'İlanları takip et, kriterlerine uyan evleri bul ve ev sahiplerine yaz.',
    kind: 'web',
    records: {identity: 'url'},
    defaultMode: 'prepare',
    fields: [
      field('location', 'Konum', 'Hangi şehir ve semtlerde ev arıyorsun?'),
      field('budget', 'Toplam kira sınırı', 'Aidat ve ek giderler dahil kira sınırın nedir?'),
      field(
        'requirements',
        'Ev kriterleri',
        'Oda sayısı, taşınma tarihi ve kesin şartların neler?',
      ),
      field(
        'introduction',
        'Tanıtım ve mesaj',
        'Ev sahibine hangi bilgilerini iletebiliriz? Nasıl bir mesaj istersin?',
        false,
      ),
    ],
    steps: [
      'Seçilen sitelerde yeni ilanları bul',
      'Kesin şartları ve tercihleri değerlendir',
      'Uygun ilan için kişisel mesaj hazırla',
      'Yetki varsa gönder ve sonucu doğrula',
    ],
    guidance:
      'Record each listing with its exact URL, total rent, location, availability, matching reasons and unknowns. Never invent income, employment, documents or personal facts. Prepare an individual message using only provided facts. Contact a listing at most once. Follow responses only through the configured website.',
  },
  {
    id: 'appointment',
    example: true,
    recordOperations: {
      prepare: {label: 'Randevuyu hazırla'},
      execute: {
        label: 'Rezervasyon yap',
        reviewLabel: 'Onayla ve rezervasyon yap',
        successCriteria:
          'The portal confirms the exact date, time, center and applicant, ideally with a booking reference. Availability alone is insufficient.',
      },
    },
    table: {
      title: 'Randevu akışı',
      columns: [
        {key: 'source', label: 'Kaynak', type: 'text'},
        {key: 'title', label: 'İlan', type: 'text'},
        {key: 'location', label: 'Merkez', type: 'text'},
        {key: 'date', label: 'Randevu tarihi', type: 'date'},
        {key: 'score', label: 'Puan', type: 'number'},
      ],
    },
    version: 1,
    title: 'Randevu takibi',
    icon: '◷',
    description:
      'Seçtiğin portalda uygun tarihleri takip et; bildir, hazırla veya yetkin kapsamında randevu al.',
    kind: 'web',
    defaultMode: 'observe',
    fields: [
      field(
        'service',
        'Randevu türü',
        'Hangi hizmet, ülke veya başvuru türü için randevu gerekiyor?',
      ),
      field('location', 'Başvuru merkezi', 'Hangi şehir ve merkezler uygun?'),
      field('dates', 'Tarih aralığı', 'Hangi tarihler ve saatler uygun?'),
      field(
        'applicants',
        'Başvuran bilgileri',
        'Kaç kişi için randevu gerekiyor? Portalın istediği bilgileri veya eksikleri belirt.',
        false,
      ),
    ],
    steps: [
      'Seçilen portalda oturumu kontrol et',
      'Uygun tarihleri incele',
      'Bulunan seçenekleri kaydet',
      'Yetki ve güncel uygunluk varsa rezervasyon yap ve doğrula',
    ],
    guidance:
      'Use only the configured appointment portal and user criteria. Availability is not a reservation. Record the observed date, center and time in the result. Before booking, recheck availability and exact applicant details. Never cancel an existing appointment, make a payment or change application details without separate explicit user instructions. Ask for manual browser takeover for login, MFA and access barriers. Do not bypass site protections. A trial validates observation only, never claim it has tested booking.',
  },
  {
    id: 'custom',
    example: true,
    table: {
      title: 'Takip akışı',
      columns: [
        {key: 'source', label: 'Kaynak', type: 'text'},
        {key: 'title', label: 'Kayıt', type: 'text'},
        {key: 'score', label: 'Puan', type: 'number'},
      ],
    },
    version: 1,
    title: 'Özel otomasyon',
    icon: '✳',
    description: 'Ne yapmak istediğini anlat; asistan sorularla işleyişi ve kuralları hazırlasın.',
    kind: 'web',
    defaultMode: 'observe',
    fields: [
      field('outcome', 'Beklenen sonuç', 'Bu otomasyonun hangi sonucu üretmesini istiyorsun?'),
      field(
        'rules',
        'Seçim kuralları',
        'Hangi durumlarda işlem yapmalı, neleri dışarıda bırakmalı?',
      ),
      field('completion', 'Bitiş koşulu', 'Hangi durumda tamamlanmış sayılmalı veya durmalı?'),
    ],
    steps: [
      'Kaynakları incele',
      'Kurallara göre değerlendir',
      'Sonucu veya işlem taslağını kaydet',
      'Yetki kapsamında uygula ve doğrula',
    ],
    guidance:
      'Clarify the intended outcome, selection rules and stopping condition. Use the fixed browser capabilities supplied by this app. Do not install code, create background loops or promise unsupported integrations. The user can start tracking after setup review. Each source automatically gets a read-only trial on its first scheduled turn; later turns run its workflow.',
  },
];
