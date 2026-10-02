import test from 'node:test';
import assert from 'node:assert/strict';
import {navigationLink,observedPagePosition,resultLinkContext,observedNextPage,paginationScrollTarget} from '../app/jev-results.mjs';

const source='https://example.test/jobs/compliance?age=7';
test('generic site chrome is navigation; filters and unusual listing routes stay candidates for Jev',()=>{
 assert.equal(navigationLink({url:'https://example.test/de',text:'site-logo'},source),true);
 assert.equal(navigationLink({url:'https://example.test/',text:'Home'},source),true);
 assert.equal(navigationLink({url:'https://example.test/privacy',text:'Privacy policy'},source),true);
 assert.equal(navigationLink({url:'https://example.test/de',text:'Logo Designer'},source),false);
 assert.equal(navigationLink({url:source+'#',text:'Expand'},source),true);
 assert.equal(navigationLink({url:source+'#job/123',text:'A role'},source),false);
 for(const link of [{url:source+'&id=123',text:'Compliance role'},{url:'https://other.test/de',text:'Logo designer'},{url:'https://example.test/jobs/logo',text:'Logo designer'},{url:'https://example.test/jobs/123?action=facet_selected',text:'Listing'},{url:source+'&action=facet_selected%3Bage%3Bage_1',text:'A filter'},{url:'https://www.linkedin.com/jobs/view/123',text:'Bewerberformular'}])assert.equal(navigationLink(link,source),false,link.url);
});
test('only exact pagination controls establish page numbers; result counts are not totals',()=>{
 assert.deepEqual(observedPagePosition({pagination:[{text:'Previous',disabled:true},{text:'1 of 1'},{text:'Next',disabled:true}]}),{currentPage:1,totalPages:1,evidence:'1 of 1'});
 assert.deepEqual(observedPagePosition({pagination:[{text:'Seite 2 von 9'}]}),{currentPage:2,totalPages:9,evidence:'Seite 2 von 9'});
 assert.deepEqual(observedPagePosition({pagination:[{text:'3',current:true},{text:'8'}]}),{currentPage:3,totalPages:null,evidence:'3'});
 assert.equal(observedPagePosition({title:'25 jobs',text:'Showing 1–25 of 80',pagination:[{text:'Next'}]}),null);
 assert.equal(observedPagePosition({pagination:[{text:'4 of 2'}]}),null);
});
test('link classification receives bounded exact rendered card text, with adjacent text only as fallback',()=>{
 const text='Intro\nOriginal title\nBerlin\n2 days ago\nFooter';
 assert.equal(resultLinkContext({text},{contextRange:{offset:6,length:32}}),text.slice(6,38));
 const link={url:source+'/one',text:'A role'},page={text:`Link: A role — ${source}/one\nBerlin\n2 days ago\nLink: Other — ${source}/two\nOther city`};
 assert.equal(resultLinkContext(page,link),'Berlin\n2 days ago');
 assert.equal(resultLinkContext({text:'Unrelated'},{...link,contextRange:{offset:500,length:10}}),'');
 assert.equal(resultLinkContext({text:'x'.repeat(2000)},{contextRange:{offset:0,length:2000}}).length,900);
});

test('destination counters never override the marked current page',()=>{
 const pagination=Array.from({length:12},(_,n)=>({text:`${n+1} of 12`,url:`https://example.test/?page=${n+1}`,current:n===5}));
 assert.deepEqual(observedPagePosition({pagination}),{currentPage:6,totalPages:12,evidence:'6 of 12'});
 assert.equal(observedPagePosition({pagination:pagination.map(p=>({...p,current:false}))}),null);
 assert.equal(observedPagePosition({pagination:pagination.map(p=>({...p,current:true}))}),null);
 assert.deepEqual(observedPagePosition({pagination:[{text:'1 of 12'},{text:'2 of 12'},{text:'6',current:true}]}),{currentPage:6,totalPages:12,evidence:'6'});
});

test('unmarked counters match the current observed URL and accept out-of wording',()=>{
 const root='https://example.test/jobs?radius=30',pagination=[{text:'Previous',url:root+'&page=3'},...[1,2,3,4,5,12].map(n=>({text:`${n} ${n===4?'out of':'of'} 12`,url:root+'&page='+n,current:false})),{text:'Next',url:root+'&page=5'}];
 assert.deepEqual(observedPagePosition({url:root+'&page=4',pagination}),{currentPage:4,totalPages:12,evidence:'4 out of 12'});
 assert.deepEqual(observedPagePosition({url:root,pagination:[{text:'Previous',disabled:true},...pagination.slice(1)]}),{currentPage:1,totalPages:12,evidence:'1 of 12'});
 assert.equal(observedPagePosition({url:root,pagination:[{text:'2 of 12',url:root+'&page=2'}]}),null,'a single destination link is not a current-page counter');
});


test('tracking addresses do not hide the rendered card requirements',()=>{
 const longUrl='https://example.test/jobs/view/123?utm_source='+'x'.repeat(1500);
 const card=`Link: Compliance Manager — ${longUrl}\nBerlin\nRequired: 4 years of audit experience`;
 const page={text:card+'\nAnother listing: London'};
 const context=resultLinkContext(page,{url:longUrl,contextRange:{offset:0,length:card.length}});
 assert.match(context,/Required: 4 years/);assert.ok(!context.includes('London'));assert.ok(!context.includes('utm_source='));
});

test('named next controls require an observed page position and unambiguous destination',()=>{
 const next={text:'Sonraki sayfayı görüntüle',targetId:'next'},position={currentPage:1,totalPages:40};
 assert.equal(observedNextPage({pagination:[next]},position),next);
 assert.equal(observedNextPage({pagination:[next]},null),null);
 assert.equal(observedNextPage({pagination:[next]},{currentPage:40,totalPages:40}),null);
 assert.equal(observedNextPage({pagination:[next,{...next,targetId:'other'}]},position),null);
 assert.equal(observedNextPage({pagination:[{text:'Next',disabled:true},{text:'2',url:source+'?page=2'}]},position),null,'conflicting end controls require review, not automatic navigation');
 const page={pagination:[{text:'Next',scrollControlId:'list'}],scrollTargets:[{controlId:'other',atBottom:false},{controlId:'list',atBottom:false}]};
 assert.equal(paginationScrollTarget(page,position).controlId,'list');
 page.scrollTargets[1].atBottom=true;assert.equal(paginationScrollTarget(page,position),null);
 page.pagination[0].scrollControlId=undefined;assert.equal(paginationScrollTarget(page,position),null);
});
