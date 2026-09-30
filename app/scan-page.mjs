const normalize=value=>String(value??'').replace(/\s+/gu,' ').trim();
const pageNumber=value=>Number.isSafeInteger(value)&&value>0;

// A page position is an agent report backed by an actual snapshot, not a
// percentage of completed work. Never derive totals from result counts/URLs.
export function scanPageReport(snapshot,{currentPage,totalPages=null,evidence},at){
 if(!pageNumber(currentPage)||totalPages!==null&&(!pageNumber(totalPages)||totalPages<currentPage))throw Error('Geçerli sayfa numarası gerekli; toplam bilinmiyorsa totalPages alanını gönderme.');
 if(typeof evidence!=='string'||evidence.trim().length<1||evidence.length>500)throw Error('Sayfalama kontrolünden veya sayfa numarasını gösteren başlıktan kısa, gerçek bir alıntı gerekli.');
 let text=snapshot.text;
 try{const page=JSON.parse(text.replace(/^Page URL: [^\n]+\n/,''));text=[page.title,page.text,...(page.pagination??[]).map(p=>p.text)].filter(Boolean).join('\n');}catch{}
 const quote=normalize(evidence);
 if(!normalize(text).includes(quote))throw Error('Sayfalama kanıtı bu tarayıcı gözleminde bulunamadı.');
 for(const number of [currentPage,totalPages].filter(n=>n!==null))if(!new RegExp(`(^|[^0-9])${number}([^0-9]|$)`).test(quote))throw Error('Bildirilen sayfa numaraları alıntıda görünmeli. İlan sayısı veya aralığı yeterli değil; sayfalama metnini ya da sayfa numarasını gösteren title alanını kullan.');
 return {currentPage,totalPages,url:snapshot.url,evidence:quote,at};
}

export function scanPageLabel(progress){
 if(!pageNumber(progress?.currentPage))return '';
 return pageNumber(progress.totalPages)&&progress.totalPages>=progress.currentPage?`Sayfa ${progress.currentPage} / ${progress.totalPages}`:`${progress.currentPage}. sayfa`;
}
