// JSON.parse intentionally accepts duplicate keys. At the raw E03 adapter
// boundary reject them before they can change the request being fingerprinted.
export function parseNoticeJson(text) {
  let i=0;
  const whitespace=()=>{while(/[\x20\t\r\n]/.test(text[i] ?? '') && i<text.length)i++;};
  const bad=()=>{throw Object.assign(new Error('Invalid or duplicate-key JSON'),{code:'INVALID_REQUEST'});};
  function string() {
    const start=i++;
    while(i<text.length) {
      if(text[i]==='\\'){i+=2;continue;}
      if(text[i++]==='"')return JSON.parse(text.slice(start,i));
    }
    bad();
  }
  function value(depth=0) {
    if(depth>100)bad();whitespace();
    if(text[i]==='"')return string();
    if(text[i]==='{') {
      i++;whitespace();const result={};const seen=new Set();
      if(text[i]==='}'){i++;return result;}
      while(i<text.length) {
        whitespace();if(text[i]!=='"')bad();const key=string();
        if(seen.has(key))bad();seen.add(key);whitespace();if(text[i++]!==':')bad();
        Object.defineProperty(result,key,{value:value(depth+1),enumerable:true,writable:true,configurable:true});
        whitespace();const next=text[i++];if(next==='}')return result;if(next!==',')bad();
      }
      bad();
    }
    if(text[i]==='[') {
      i++;whitespace();const result=[];if(text[i]===']'){i++;return result;}
      while(i<text.length){result.push(value(depth+1));whitespace();const next=text[i++];if(next===']')return result;if(next!==',')bad();}
      bad();
    }
    const match=/^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/.exec(text.slice(i));
    if(!match)bad();i+=match[0].length;return JSON.parse(match[0]);
  }
  const result=value();whitespace();if(i!==text.length)bad();return result;
}
