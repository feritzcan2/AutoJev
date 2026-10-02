export const SOURCE_TOOL_IDS=['freehire-search','linkedin-search','jobindex-search','jobnet-search','jobdanmark-search','jobbank-search'];
export function sourceToolId(value=''){
 if(typeof value!=='string'||value.length>80||value&&!/^[a-z][a-z0-9-]*$/.test(value))throw Error('Geçersiz kaynak aracı');
 return value;
}
