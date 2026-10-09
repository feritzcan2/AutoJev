// Starting sources for the job-search template. Workspace copies remain editable.
// Sources without countries join every workspace; country sources are added
// in setup for users searching in those countries (ISO 3166 alpha-2).
const indeed = (host) => ({
  entry: {kind: 'url_template', template: `https://${host}/jobs?q={query}&l={location}`},
  pagination: 'url_param',
  loginRequired: false,
  notes:
    'Result links are rc/clk and pagead/clk redirects; a detail opens as viewjob?jk=<id>. Pages via start=10,20,… No date order observed.',
});
const indeedInstructions =
  'Güncel çalışma alanı kriterlerini ve kaynak sorgusunu kullan. Sonuç sayfalarını sırayla işle. Hız sınırı veya doğrulama sayfası çıkarsa bildir, aşmaya çalışma. Bu talimat işlem yetkisi vermez.';
export const jobSearchSources = [
  {
    url: 'https://www.linkedin.com/jobs/',
    name: 'LinkedIn',
    intervalMinutes: 15,
    enabled: true,
    instructions:
      'Güncel çalışma alanı kriterlerini ve kaynak sorgusunu kullan. Girişsiz jobs-guest sonuç adresi yalnızca ilan kartlarını verir; giriş duvarına gitme. Her sorgunun sayfalamasını ve kalan detaylarını tarama kuyruğunda tut. Boş sonuç ile erişim engelini ayır; giriş veya doğrulama engelini bildir, aşmaya çalışma. Bu talimat işlem yetkisi vermez; başvurular kayıt görevlerinden yürütülür.',
    recipe: {
      entry: {
        kind: 'url_template',
        template:
          'https://www.linkedin.com/jobs-guest/jobs/api/seeMoreJobPostings/search?keywords={query}&location={location}&sortBy=DD',
      },
      pagination: 'url_param',
      ordering: 'newest_first',
      loginRequired: false,
      notes:
        'Girişsiz jobs-guest uç noktası: sayfa iskeleti ve giriş duvarı yok, yalnızca ilan kartları. sortBy=DD en yeni önce. Sayfa başına 10 ilan, start=10,20,… ile sayfalanır.',
    },
  },
  {
    url: 'https://html.duckduckgo.com/html/',
    name: 'Şirket kariyer sayfaları',
    intervalMinutes: 60,
    enabled: true,
    instructions:
      'Hedef rol ve konumla web araması yaparak şirketlerin kendi kariyer sayfalarındaki tekil ilanları bul. Toplayıcı ve iş ilanı sitelerinin sonuçlarını atla; onlar ayrı kaynaklardır. Bu talimat işlem yetkisi vermez.',
  },
  {
    url: 'https://freehire.me/',
    name: 'FreeHire',
    intervalMinutes: 30,
    enabled: true,
    instructions:
      'Güncel çalışma alanı kriterlerini ve kaynak sorgusunu kullan. Çok ülkeli, teknoloji odaklı bir toplayıcıdır; ülke, şehir, kıdem ve beceri filtreleri vardır. Sonuç sayfalarını sırayla işle; tarih, uzaktan çalışma ve maaş bilgilerini kaynaktaki kapsamıyla koru. Bu talimat işlem yetkisi vermez.',
  },
  {
    url: 'https://weworkremotely.com/',
    name: 'We Work Remotely',
    intervalMinutes: 60,
    enabled: true,
    instructions:
      'Dünya geneli uzaktan çalışma ilanları. Kategori sayfaları tek sayfadır. Bazı ilanlar tam metin için kayıt ister; kayıt formunu doldurma, görünen ilan metniyle değerlendir. Bu talimat işlem yetkisi vermez.',
    recipe: {
      entry: {
        kind: 'url_template',
        template: 'https://weworkremotely.com/categories/remote-{query}-jobs',
      },
      pagination: 'none',
      maxPages: 1,
      loginRequired: false,
      notes:
        '{query} is a category slug, not free text: /categories/remote-<slug>-jobs (back-end-programming was read; the home page lists the other categories). Each category is one page without pagination. Listings are /remote-jobs/<company>-<title> links; company, sign-up and plan links are not listings.',
    },
  },
  {
    url: 'https://himalayas.app/',
    name: 'Himalayas',
    countries: ['DE'],
    intervalMinutes: 60,
    enabled: true,
    instructions:
      "Himalayas extension'ı CLI ile resmî API'den Almanya'dan çalışılabilen ilanları ve tam açıklamalarını alır. Önce Jev profille karşılaştırıp eler, ardından agent kalanları puanlayıp kaydeder. collect_source_page ile bir sayfa al; Jev grubunu inceleyip onayladıktan sonra sonraki sayfaya geç. Ülke ve sorgu URL reçetesinden gelir. API önbelleklidir. Bu talimat işlem yetkisi vermez.",
    recipe: {
      entry: {
        kind: 'url_template',
        template: 'https://himalayas.app/jobs/api/search?country=DE&q={query}&sort=recent',
      },
      pagination: 'url_param',
      loginRequired: false,
      notes:
        'Himalayas site extension: CLI supplies full JSON descriptions to the common Jev review queue. The agent scores and saves retained listings before advancing each page. Search pages use page=N and offset/limit/totalCount; a short page is not the end. Browser page caps and date cutoffs do not apply.',
    },
  },
  {
    url: 'https://www.indeed.com/',
    name: 'Indeed (ABD)',
    countries: ['US'],
    intervalMinutes: 30,
    enabled: true,
    instructions: indeedInstructions,
    recipe: indeed('www.indeed.com'),
  },
  {
    url: 'https://de.indeed.com/',
    name: 'Indeed (Almanya)',
    countries: ['DE'],
    intervalMinutes: 30,
    enabled: true,
    instructions: indeedInstructions,
    recipe: indeed('de.indeed.com'),
  },
  {
    url: 'https://www.stepstone.de/',
    name: 'StepStone',
    countries: ['DE'],
    intervalMinutes: 30,
    enabled: true,
    instructions:
      'Almanya. Sonuç adresi /jobs/<arama-slug>/in-<şehir>?radius=30 biçimindedir; sort=2&action=sort_publish tarihe göre sıralar, fdl=en yalnızca İngilizce yazılmış ilanları gösterir (yalnızca kriterler İngilizce ilan istiyorsa kullan). İlanlar /stellenangebote--…-inline.html bağlantılarıdır; "Popular jobs" ve konum bağlantıları başka aramalardır. Bu talimat işlem yetkisi vermez.',
    recipe: {
      entry: {
        kind: 'url_template',
        template: 'https://www.stepstone.de/jobs/{query}?sort=2&action=sort_publish',
      },
      pagination: 'url_param',
      maxPages: 5,
      loginRequired: false,
      notes:
        '{query} is a hyphenated search slug (senior-backend-engineer). This searches all of Germany; for one city use /jobs/{query}/in-<city>?radius=30. sort=2&action=sort_publish orders by date, so the first pages hold the newest listings. Pages via &page=N.',
    },
  },
  {
    url: 'https://www.jobindex.dk/',
    name: 'Jobindex',
    countries: ['DK'],
    intervalMinutes: 30,
    enabled: true,
    instructions:
      'Danimarka. Güncel kriterleri ve kaynak sorgusunu kullan; /jobsoegning arama sayfasında tarihe göre sıralı sonuçları sayfa sayfa işle ve toplam sonuç sayısını gözet. Danimarka için uygun arama terimleri kullan. Erişim engelini sıfır sonuç olarak yorumlama. Bu talimat işlem yetkisi vermez.',
    recipe: {
      entry: {
        kind: 'url_template',
        template: 'https://www.jobindex.dk/jobsoegning?q={query}',
      },
      pagination: 'url_param',
      loginRequired: false,
      notes: 'page=2 ile sayfalanır; sonuçlar tarihe göre sıralı gelir.',
    },
  },
  {
    url: 'https://jobnet.dk/',
    name: 'Jobnet',
    countries: ['DK'],
    intervalMinutes: 30,
    enabled: true,
    instructions:
      'Danimarka. Güncel kriterleri ve kaynak sorgusunu kullan; arama sayfasında meslek, bölge ve çalışma süresi filtreleri vardır. Yayın tarihine göre sırala, her sonuç sayfasını işle. Dış ilanlarda yalnızca özet varsa eksik gereksinimleri gerçek ilandan oku. Bu talimat işlem yetkisi vermez.',
    recipe: {
      entry: {
        kind: 'search_form',
        url: 'https://job.jobnet.dk/CV/FindWork',
        fields: [
          {
            key: 'query',
            label: 'Søg på stilling, fag, firma',
          },
        ],
      },
      pagination: 'auto',
      loginRequired: false,
    },
  },
  {
    url: 'https://jobdanmark.dk/',
    name: 'Jobdanmark',
    countries: ['DK'],
    intervalMinutes: 30,
    enabled: true,
    instructions:
      'Danimarka. Güncel kriterleri ve kaynak sorgusunu kullan; metin, belediye ve kategori filtreleriyle ara, sayfalamayı sonuna kadar izle. Aynı sayfanın kalan kayıtlarını atlama. Bu talimat işlem yetkisi vermez.',
  },
  {
    url: 'https://jobbank.dk/',
    name: 'Akademikernes Jobbank',
    countries: ['DK'],
    intervalMinutes: 30,
    enabled: true,
    instructions:
      'Danimarka akademik ve yüksek eğitimli aday ilanları. Güncel kriterleri ve kaynak sorgusunu kullan; tür, konum, çalışma alanı ve eğitim filtreleri vardır. /job/ sonuç sayfalarını sonuna kadar işle. Erişim hatasını boş sonuç gibi kaydetme. Bu talimat işlem yetkisi vermez.',
  },
].map((source) => ({
  ...source,
  query: 'Kayıtlı hedef rollere, ülke ve çalışma tercihlerine uygun güncel ilanlar',
}));
