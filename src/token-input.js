export const formatTokens=value=>value.toLocaleString('tr-TR',{maximumFractionDigits:0});
export function parseTokenInput(text){
 if(!/^(?:\d+|\d{1,3}(?:\.\d{3})+)$/.test(text))return NaN;
 const value=Number(text.replaceAll('.',''));
 return Number.isSafeInteger(value)&&value>=0?value:NaN;
}

export function setupTokenInput(field){
 field.addEventListener('input',()=>{
  const text=field.value,caret=field.selectionStart??text.length;
  const digits=text.slice(0,caret).replace(/\D/g,'').length;
  // Dots are grouping separators, including while editing a formatted value.
  const value=/^[\d.]+$/.test(text)?parseTokenInput(text.replaceAll('.','')):NaN;
  field.setCustomValidity(Number.isNaN(value)?'0 (kapalı) veya pozitif bir tam token sayısı gir. Örnek: 120.000.':'');
  if(Number.isNaN(value))return;
  field.value=formatTokens(value);
  let position=0,count=0;
  while(position<field.value.length&&count<digits){if(/\d/.test(field.value[position]))count++;position++;}
  field.setSelectionRange(position,position);
 });
 field.addEventListener('keydown',event=>{
  const start=field.selectionStart,end=field.selectionEnd;
  if(start!==end||event.ctrlKey||event.metaKey||event.altKey)return;
  // Deleting beside a separator removes the adjacent digit too.
  if(event.key==='Backspace'&&start>=2&&field.value[start-1]==='.'){
   event.preventDefault();field.setRangeText('',start-2,start,'end');
  }else if(event.key==='Delete'&&start+1<field.value.length&&field.value[start]==='.'){
   event.preventDefault();field.setRangeText('',start,start+2,'start');
  }else return;
  field.dispatchEvent(new Event('input',{bubbles:true}));
 });
}
