// @ts-check
// A listing's description is saved on disk with its record when a scan or a
// scoring task has read it, so the record can show it after a restart.
import {setTimeout as pause} from 'node:timers/promises';
import {memoryDetail} from './evidence.mjs';
import {readOne} from './listing-reader.mjs';

const MAX_CHARACTERS = 60000,
  READ_TIMEOUT_MS = 60000;

// The description part of a listing a site reader or the page's structured
// data gave (../site-extensions/listing.mjs): the text after its title and
// facts. Rendered pages and agent observations carry site chrome and are not kept.
const descriptionPart = (text) => text.split('\n\n').slice(1).join('\n\n').trim();

function readListingText(db, owner, run, url) {
  if (run.automationId !== owner) return '';
  const read = db.browserEvidence?.latest(run, url);
  if (read?.reader) return read.text;
  const detail = memoryDetail(db, owner, run, url);
  return detail?.listing ? detail.text : '';
}

// Only scans and scoring read the listing itself; application runs on the same
// address may hold a form page, which is not the description.
export function keepListingDescription(db, owner, run, recordId, url) {
  if (run.recordOperation && run.recordOperation !== 'score') return;
  const text = descriptionPart(readListingText(db, owner, run, url));
  if (!text) return;
  db.store.workspaces.records.saveDescription(owner, recordId, {
    url,
    text: text.slice(0, MAX_CHARACTERS),
    readAt: db.now(),
  });
}

export function listingDescription(db, owner, recordId) {
  return db.store.workspaces.records.description(owner, recordId);
}

// Reads the listing again through the site's own reader (API or HTTP), paced
// like a scan and bounded in time. Sites without such a reader are read by a
// scan or a scoring task in the browser.
export async function readListingDescription(db, owner, recordId) {
  const item = db.result(owner, recordId),
    signal = AbortSignal.timeout(READ_TIMEOUT_MS);
  let result;
  try {
    result = await readOne(db, db.get(owner), null, item, {
      signal,
      wait: (ms) => pause(ms, undefined, {signal}),
    });
  } catch (error) {
    if (signal.aborted) throw Error('Reading the listing took too long. Try again later.');
    throw error;
  }
  if (!result)
    throw Error(
      'This site can only be read in the browser. Score the record again to read and save its description.',
    );
  const text = descriptionPart(result.page.text);
  if (!text) throw Error('The site reader returned no description of the listing.');
  db.store.workspaces.records.saveDescription(owner, item.id, {
    url: item.url,
    text: text.slice(0, MAX_CHARACTERS),
    readAt: db.now(),
  });
  return listingDescription(db, owner, item.id);
}
