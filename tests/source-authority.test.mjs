import test from 'node:test';
import assert from 'node:assert/strict';
import {sourceMode} from '../app/automation-sources.mjs';
import {recordSource} from '../app/record-operations.mjs';

test('unknown source URLs never inherit automatic workspace authority',()=>{
 for(const source of ['https://example.test/jobs/','https://example.test/?query=engineer','https://other.test/catalog?type=home']){
  const a={mode:'auto',sources:[source],sourceSettings:{[source]:{mode:'observe'}}};
  for(const url of [source.replace(/\/$/,''),source+'/',source+'#old','https://removed.test/list'])assert.equal(sourceMode(a,url),'observe');
 }
});
test('known source permissions respect the workspace ceiling and disabled sources',()=>{
 const source='https://example.test/jobs';
 for(const workspace of ['observe','prepare','auto'])for(const mode of ['observe','prepare','auto']){
  const a={mode:workspace,sources:[source],sourceSettings:{[source]:{mode}}};
  const modes=['observe','prepare','auto'];assert.equal(sourceMode(a,source),modes[Math.min(modes.indexOf(workspace),modes.indexOf(mode))]);
  a.sourceSettings[source].enabled=false;assert.equal(sourceMode(a,source),'observe');
 }
});
test('records without source provenance do not select an arbitrary same-origin source',()=>{
 const a={mode:'auto',sources:['https://example.test/read','https://example.test/act'],sourceSettings:{'https://example.test/read':{mode:'observe'},'https://example.test/act':{mode:'auto'}}};
 const item={url:'https://example.test/details/123'};
 assert.equal(recordSource(a,item),null);
 assert.equal(recordSource(a,{...item,sourceUrl:a.sources[1]}),a.sources[1]);
 assert.equal(recordSource({...a,sources:[a.sources[0]]},item),a.sources[0]);
});
