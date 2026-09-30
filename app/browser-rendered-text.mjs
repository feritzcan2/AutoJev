// Jev wraps rendered text and control metadata in JSON; Playwright returns
// accessible text directly. Evidence must use page prose, not hidden metadata.
export function browserRenderedText(page){
 const raw=String(page?.text??'').replace(/^Page URL: [^\n]+\n/,'');
 try{
  const value=JSON.parse(raw);
  return typeof value?.text==='string'?value.text:'';
 }catch{
  // A truncated structured observation is not usable evidence.
  return raw.trimStart().startsWith('{')?'':raw;
 }
}
