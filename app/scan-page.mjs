import {observedPagePosition} from './jev-results.mjs';

const normalize=value=>String(value??'').replace(/\s+/gu,' ').trim();
const pageNumber=value=>Number.isSafeInteger(value)&&value>0;

export function observedScanPage(snapshot,at){
 let page;try{page=JSON.parse(snapshot.text.replace(/^Page URL: [^\n]+\n/,''));}catch{return null;}
 const position=observedPagePosition(page);
 return position?scanPageReport(snapshot,position,at):null;
}

// A page position is an agent report backed by an actual snapshot, not a
// percentage of completed work. Never derive totals from result counts/URLs.
export function scanPageReport(snapshot,{currentPage,totalPages=null,evidence},at){
 if(!pageNumber(currentPage)||totalPages!==null&&(!pageNumber(totalPages)||totalPages<currentPage))throw Error('Geçerli sayfa numarası gerekli; toplam bilinmiyorsa totalPages alanını gönderme.');
 if(typeof evidence!=='string'||evidence.trim().length<1||evidence.length>500)throw Error('Sayfa konumu için kısa bir açıklama gerekli.');
 const quote=normalize(evidence);
 return {currentPage,totalPages,url:snapshot.url,evidence:quote,at};
}

export function scanPageLabel(progress){
 if(!pageNumber(progress?.currentPage))return '';
 return pageNumber(progress.totalPages)&&progress.totalPages>=progress.currentPage?`Sayfa ${progress.currentPage} / ${progress.totalPages}`:`${progress.currentPage}. sayfa`;
}
