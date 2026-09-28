import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,symlink,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {listDocuments,readDocument,documentPath} from '../app/artifacts.mjs';
test('documents appear without registration and technical files stay hidden',async()=>{
 const root=await mkdtemp(join(tmpdir(),'jobloop-files-'));
 try{await mkdir(join(root,'documents'));await mkdir(join(root,'runtime'));await writeFile(join(root,'AGENTS.md'),'instructions');await writeFile(join(root,'runtime','token.txt'),'secret');await writeFile(join(root,'documents','letter.md'),'Dear team');await writeFile(join(root,'CV.pdf'),'test');const docs=await listDocuments(root);assert.deepEqual(docs.map(d=>d.name).sort(),['CV.pdf','letter.md']);assert.equal(await readDocument(root,'documents/letter.md'),'Dear team');await assert.rejects(()=>readDocument(root,'CV.pdf'));await assert.rejects(()=>documentPath(root,'runtime/token.txt'));}finally{await rm(root,{recursive:true,force:true});}
});
test('candidate document access rejects traversal and external symlinks',async()=>{
 const base=await mkdtemp(join(tmpdir(),'jobloop-files-')),root=join(base,'candidate');
 try{await mkdir(root);await writeFile(join(base,'other.txt'),'private');await symlink(base,join(root,'external'),process.platform==='win32'?'junction':'dir');await assert.rejects(()=>documentPath(root,'../other.txt'));await assert.rejects(()=>documentPath(root,'external/other.txt'));assert.deepEqual(await listDocuments(root),[]);}finally{await rm(base,{recursive:true,force:true});}
});
