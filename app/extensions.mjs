export async function loadExtensions(value=process.env.LOOP_EXTENSIONS){
 const ids=value===undefined?['job-search']:value.split(',').map(id=>id.trim()).filter(Boolean);
 if(new Set(ids).size!==ids.length||ids.some(id=>!/^[a-z][a-z0-9_-]*$/.test(id)))throw Error('Geçersiz uzantı listesi');
 return Promise.all(ids.map(id=>import(`./extensions/${id}/index.mjs`)));
}
