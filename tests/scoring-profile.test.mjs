import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm,symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {loadScoringCv,scoringSources} from '../app/scoring-profile.mjs';
async function fixture(t){
 const root=await mkdtemp(path.join(tmpdir(),'score-cv-'));t.after(()=>rm(root,{recursive:true,force:true}));await mkdir(path.join(root,'candidates/one'),{recursive:true});
 const a={facts:'Verified profile fact.',referenceData:{profile:{cvPath:path.join(root,'candidates/one/CV.txt')}}};
 const db={get:()=>a,store:{directory:root,workspaces:{get:()=>({id:'one',storagePath:'candidates/one'})}}};return {root,a,db};
}
test('CV extraction uses the workspace storage path, refreshes changed files and isolates candidate sources',async t=>{
 const {a,db}=await fixture(t);await writeFile(a.referenceData.profile.cvPath,'Five years of compliance experience.');
 const first=await loadScoringCv(db,'one');assert.equal(first.path,'CV.txt');assert.match(first.text,/Five years/);assert.equal(await loadScoringCv(db,'one'),first);
 await writeFile(a.referenceData.profile.cvPath,'Seven years of compliance program ownership.');const next=await loadScoringCv(db,'one');assert.notEqual(next.digest,first.digest);
 assert.equal(scoringSources(a,next).facts.text,'Verified profile fact.');assert.equal(scoringSources(a).cv,undefined);
});
test('foreign CV paths and symlink escapes are rejected; missing CV is explicitly unavailable',async t=>{
 const {root,a,db}=await fixture(t),foreign=path.join(root,'other.txt');await writeFile(foreign,'Another candidate private facts.');
 a.referenceData.profile.cvPath=foreign;await assert.rejects(loadScoringCv(db,'one'),/görüntülenemez/);
 const link=path.join(root,'candidates/one/link.txt');await symlink(foreign,link);a.referenceData.profile.cvPath=link;await assert.rejects(loadScoringCv(db,'one'),/görüntülenemez/);
 delete a.referenceData.profile.cvPath;assert.equal((await loadScoringCv(db,'one')).text,'');assert.match((await loadScoringCv(db,'one')).unavailable,/CV yok/);
});
test('PDF CV extraction runs locally and retains exact evidence text',async t=>{
 const {a,db}=await fixture(t);a.referenceData.profile.cvPath=a.referenceData.profile.cvPath.replace('.txt','.pdf');
 const stream='BT /F1 12 Tf 20 80 Td (Five years of compliance experience.) Tj ET';
 const objects=['<< /Type /Catalog /Pages 2 0 R >>','<< /Type /Pages /Kids [3 0 R] /Count 1 >>','<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 100] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>','<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`];
 let pdf='%PDF-1.4\n';const offsets=[0];for(const [i,object] of objects.entries()){offsets.push(pdf.length);pdf+=`${i+1} 0 obj\n${object}\nendobj\n`;}const xref=pdf.length;pdf+='xref\n0 6\n0000000000 65535 f \n'+offsets.slice(1).map(n=>String(n).padStart(10,'0')+' 00000 n \n').join('')+`trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
 await writeFile(a.referenceData.profile.cvPath,pdf);assert.match((await loadScoringCv(db,'one')).text,/Five years of compliance experience\./);
});
