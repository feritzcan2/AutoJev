import {BrowserSnapshot} from './browser-snapshot.mjs';

// Recovery is read-only. Never install historical text as the current action
// snapshot: current controls and submission proofs must still be observed.
export function readBrowserEvidence({db,run,snapshots,method,args}){
 if(snapshots.current?.id===args.snapshotId)return snapshots[method](args);
 let page=db.browserEvidence.get(run,args.snapshotId),rebound=false;
 if(!page&&!db.browserEvidence.known(args.snapshotId)&&run.recordId&&!run.recordIds){
  page=db.browserEvidence.latest(run,db.result(run.automationId,run.recordId).url);rebound=Boolean(page);
 }
 if(!page)return snapshots[method](args); // Preserve the precise stale-ID error.
 const reader=new BrowserSnapshot();reader.current=page;
 return {...reader[method]({...args,snapshotId:page.id,...(rebound?{offset:0}:{})}),
  historical:true,recovery:{requestedSnapshotId:args.snapshotId,snapshotId:page.id,observedAt:page.at,offsetReset:rebound},
  notice:'Kayıtlı metin aynı görev ve aramadan geri yüklendi. Dönen snapshotId ve offset ile devam et. Bu metin güncel tarayıcı kontrolü veya gönderim kanıtı değildir.'};
}
