// Render common inline Markdown without interpreting HTML or creating links.
// Keeping line breaks also preserves the agent's numbered questions and lists.
export function renderMessageText(element,text){
 const value=String(text??'');
 if(element.dataset.messageText===value)return;
 element.dataset.messageText=value;
 const fragment=document.createDocumentFragment(),pattern=/\*\*([^*\n]+)\*\*|`([^`\n]+)`/g;
 let offset=0;
 for(const match of value.matchAll(pattern)){
  fragment.append(document.createTextNode(value.slice(offset,match.index)));
  const span=document.createElement(match[1]!==undefined?'strong':'code');span.textContent=match[1]??match[2];fragment.append(span);
  offset=match.index+match[0].length;
 }
 fragment.append(document.createTextNode(value.slice(offset)));element.replaceChildren(fragment);
}
