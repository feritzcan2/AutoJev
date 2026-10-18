import test from 'node:test';
import assert from 'node:assert/strict';
import {decode, htmlText} from '../app/site-extensions/listing.mjs';

test('listing text decodes named entities of non-English listings, once', () => {
  assert.equal(decode('Dr&oslash;mmer du om &aring;rets &AElig;ble?'), 'Drømmer du om årets Æble?');
  assert.equal(
    decode('Fran&ccedil;ais &ndash; &laquo;CDI&raquo; &hellip; &euro;&nbsp;42k'),
    'Français – «CDI» … € 42k',
  );
  assert.equal(decode('Ma&ntilde;ana &rsquo;s &uuml;ber &szlig;'), 'Mañana ’s über ß');
  assert.equal(
    decode('&amp;oslash; stays text'),
    '&oslash; stays text',
    'an escaped entity is decoded once',
  );
  assert.equal(decode('&unknown; &#248; &#xE6;'), '&unknown; ø æ');
  assert.equal(
    htmlText('<p>K&oslash;benhavn</p><ul><li>R&eacute;sum&eacute;</li></ul>'),
    'København\n• Résumé',
  );
});
