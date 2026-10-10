// @ts-check
// Starting sources for the job-search template. Workspace copies remain editable.
// Sources without countries join every workspace; country sources are added
// in setup for users searching in those countries (ISO 3166 alpha-2).
import {indeedSources} from './indeed.mjs';
import {arbeitnowSources} from './arbeitnow.mjs';
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
    intervalMinutes: 60,
    enabled: true,
    instructions:
      "Himalayas extension'ı CLI ile resmî API'den dünya genelindeki uzaktan ilanları ve tam açıklamalarını alır. Önce Jev profille karşılaştırıp eler, ardından agent kalanları puanlayıp kaydeder. collect_source_page ile bir sayfa al; Jev grubunu inceleyip onayladıktan sonra sonraki sayfaya geç. Ülke ve sorgu URL reçetesinden gelir: ülke kodu boşsa dünya geneli aranır. API önbelleklidir. Bu talimat işlem yetkisi vermez.",
    recipe: {
      entry: {
        kind: 'url_template',
        template: 'https://himalayas.app/jobs/api/search?country={country}&q={query}&sort=recent',
      },
      pagination: 'url_param',
      loginRequired: false,
      notes:
        'Himalayas site extension: CLI supplies full JSON descriptions to the common Jev review queue. {country} is the workspace country code (criteria.country); an empty one searches worldwide. The agent scores and saves retained listings before advancing each page. Search pages use page=N and offset/limit/totalCount; a short page is not the end. Browser page caps and date cutoffs do not apply.',
    },
  },
  ...indeedSources,
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
    url: 'https://www.xing.com/jobs/',
    name: 'Xing',
    countries: ['DE', 'AT', 'CH'],
    intervalMinutes: 30,
    enabled: true,
    instructions:
      "Almanya, Avusturya ve İsviçre. Xing extension'ı girişsiz arama sayfalarını ve ilanları HTTP ile okur; giriş duvarına gitme. Sonuçlar anlamsal alaka sırasındadır, tarihe göre değildir; sayfaları sırayla işle. Bu talimat işlem yetkisi vermez.",
    recipe: {
      entry: {
        kind: 'url_template',
        template: 'https://www.xing.com/jobs/search?keywords={query}&location={location}',
      },
      pagination: 'url_param',
      loginRequired: false,
      notes:
        'Logged-out search read by the Xing extension: 20 results per page via &page=N, the page states its total. Semantic relevance order, no date sort. Postings are /jobs/<slug>-<id>.',
    },
  },
  {
    url: 'https://berlinstartupjobs.com/engineering/',
    name: 'Berlin Startup Jobs',
    countries: ['DE'],
    intervalMinutes: 120,
    enabled: true,
    instructions:
      'Berlin startup ilanları, kategori sayfaları halinde (engineering, product-management, marketing, sales, finance, operations, hr-recruiting, internships, other). Kriterlere uyan kategoriyi {query} olarak kullan; extension sayfaları ve ilanları HTTP ile okur. Site araması (?s=) yalnızca tarayıcıda çalışır, kullanma. Bu talimat işlem yetkisi vermez.',
    recipe: {
      entry: {kind: 'url_template', template: 'https://berlinstartupjobs.com/{query}/'},
      pagination: 'url_param',
      ordering: 'newest_first',
      loginRequired: false,
      notes:
        '{query} is a category slug, not free text (engineering was read; product-management, marketing, sales, finance, operations, hr-recruiting, internships, other exist). 25 listings per page, pages via /{query}/page/N/, newest first by posting date. Listings are /<category>/<slug>/ links; /companies/ links are not listings.',
    },
  },
  ...arbeitnowSources,
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
