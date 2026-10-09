// @ts-check
import {isHimalayasUrl, himalayasApiUrl} from './api.mjs';
import {readCollectorCliPage, readCollectorCliDetail} from './cli-client.mjs';

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
      url: job.url,
      title: job.title,
      text: [
        job.title,
        job.company,
        job.location,
        job.employmentType,
        job.publishedAt,
        job.description,
        JSON.stringify({
          salary: job.salary,
          timezoneRestrictions: job.timezoneRestrictions,
          expiresAt: job.expiresAt,
        }),
      ]
        .filter(Boolean)
        .join('\n'),
      cells: {company: job.company, location: job.location},
    }),
  },
};
