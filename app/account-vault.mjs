// Secrets stay outside profile facts, questions, events and agent payloads.
export class AccountVault {
 constructor(db,{encrypt,decrypt}){this.db=db;this.encrypt=encrypt;this.decrypt=decrypt;db.exec('CREATE TABLE IF NOT EXISTS account_credentials(candidate_id TEXT PRIMARY KEY REFERENCES candidates(id) ON DELETE CASCADE, email TEXT, ciphertext TEXT, gmail_codes INTEGER NOT NULL DEFAULT 0, pending TEXT)');}
 row(id){return this.db.prepare('SELECT * FROM account_credentials WHERE candidate_id=?').get(id);}
 status(id){const r=this.row(id);return {configured:!!r?.ciphertext,email:r?.email??'',gmailCodes:!!r?.gmail_codes,pending:r?.pending?JSON.parse(r.pending):null};}
 save(id,{email,password,gmailCodes=false}){
  if(typeof email!=='string'||!/^\S+@\S+\.\S+$/.test(email)||typeof password!=='string'||password.length<8||password.length>1024)throw Error('Geçerli e-posta ve en az 8 karakterli şifre gerekli.');
  const ciphertext=this.encrypt(password); // Fail closed if OS encryption unavailable.
  this.db.prepare('INSERT INTO account_credentials(candidate_id,email,ciphertext,gmail_codes) VALUES(?,?,?,?) ON CONFLICT(candidate_id) DO UPDATE SET email=excluded.email,ciphertext=excluded.ciphertext,gmail_codes=excluded.gmail_codes').run(id,email.trim().toLowerCase(),ciphertext,gmailCodes?1:0);
  return this.status(id);
 }
 request(id,request){this.db.prepare('INSERT INTO account_credentials(candidate_id,pending) VALUES(?,?) ON CONFLICT(candidate_id) DO UPDATE SET pending=excluded.pending').run(id,JSON.stringify(request));return this.status(id);}
 clearRequest(id){this.db.prepare('UPDATE account_credentials SET pending=NULL WHERE candidate_id=?').run(id);}
 secret(id){const r=this.row(id);return r?.ciphertext?this.decrypt(r.ciphertext):null;}
 remove(id){this.db.prepare('DELETE FROM account_credentials WHERE candidate_id=?').run(id);}
}
