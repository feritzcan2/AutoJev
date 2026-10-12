// @ts-check
import {isHimalayasUrl, himalayasApiUrl} from './api.mjs';
import {readCollectorCliPage, readCollectorCliDetail} from './cli-client.mjs';
import {listingPage} from '../listing.mjs';

const salaryText = (salary) => {
  if (salary?.min == null && salary?.max == null) return '';
  const range = [salary.min, salary.max].filter((v) => v != null).join('–');
  return [range, salary.currency, salary.period && `per ${salary.period}`]
    .filter(Boolean)
    .join(' ');
};

// Like the DOM extensions, this adapter only supplies observed listings.
// The common queue, Jev classifier and agent own every assessment and write.
export default {
  id: 'himalayas',
  matches: isHimalayasUrl,
  collector: {
    templateId: 'job-search',
    searchUrl: himalayasApiUrl,
    // The browse-all endpoint rejects a search query.
    acceptsQuery: (url) => new URL(url).pathname.replace(/\/$/, '') !== '/jobs/api',
    readPage: readCollectorCliPage,
    readDetail: readCollectorCliDetail,
    detail: (job) => ({
      ...listingPage({
        browser: 'Himalayas API',
        url: job.url,
        title: job.title,
        description: job.description,
        fields: {
          company: job.company,
          applicantLocation: job.location,
          employmentType: job.employmentType,
          publishedAt: job.publishedAt,
          expiresAt: job.expiresAt,
          salary: salaryText(job.salary),
          timezoneRestrictions: job.timezoneRestrictions,
        },
        // Himalayas lists only remote roles; its location is a restriction on
        // where applicants may live, not where the employer is.
        notes: job.location
          ? [
              'applicantLocation is the Himalayas restriction on where candidates must be based; Worldwide means no country restriction.',
            ]
          : [],
      }),
      cells: {company: job.company, location: job.location},
    }),
  },
  // The API search address and the filters it accepts (Himalayas API docs).
  search: {
    template: 'https://himalayas.app/jobs/api/search?q={query}&sort=recent',
    ordering: 'newest_first',
    pagination: 'url_param',
    filters: [
      {param: 'country', label: 'Country (ISO code)'},
      {param: 'worldwide', label: 'Worldwide', values: {true: 'Worldwide only'}},
      {param: 'seniority', label: 'Seniority'},
      {param: 'employment_type', label: 'Employment type'},
    ],
    notes: 'sort=recent orders newest first. Pages via &page=N.',
  },
};
