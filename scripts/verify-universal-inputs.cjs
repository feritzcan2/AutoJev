const {readFile}=require('node:fs/promises');
const {createHash}=require('node:crypto');
const path=require('node:path');
module.exports=async({appOutDir,packager})=>{
 if(!appOutDir.endsWith('-arm64-temp'))return;
 const product=packager.appInfo.productFilename;
 const archive=directory=>path.join(directory,`${product}.app`,'Contents/Resources/app.asar');
 const x64=archive(appOutDir.replace(/-arm64-temp$/,'-x64-temp')),arm64=archive(appOutDir);
 const digest=async file=>createHash('sha256').update(await readFile(file)).digest('hex');
 if(await digest(x64)!==await digest(arm64))throw Error('Universal app sources changed between architecture builds. Build from an immutable checkout; the ESM application must use one identical app.asar.');
};
