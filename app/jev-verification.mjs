import {scanVerificationCheckboxes} from './jev-verification-checkbox.mjs';
import {detectCaptcha,captchaEvidence} from './captcha-detection.mjs';
// Evidence-only detection. Never treats a CAPTCHA widget's mere presence as a
// challenge, never retries Submit, and never solves/bypasses site verification.
export async function verificationEvidence(page,slot){
 if(slot){
  const detection=await detectCaptcha(page);slot.captchaDetection=detection;
  if(detection.state==='active')slot.captchaDocument={id:detection.documentId,url:detection.pageUrl};
  if(detection.state==='cleared'||detection.documentId&&slot.captchaDocument&&(slot.captchaDocument.id!==detection.documentId||slot.captchaDocument.url!==detection.pageUrl))delete slot.captchaDocument;
  if(detection.state==='none'&&slot.captchaDocument)return {state:'checking',capability:'pending',evidence:'Önceki CAPTCHA artık görünmüyor; doğrulama sonucu henüz kanıtlanmadı. Mevcut sekmeyi kontrol et.'};
  if(detection.state==='active'&&detection.target.provider==='turnstile'&&!slot.verificationCheckboxAttempt)return {state:'required',capability:'supported',checkbox:true,evidence:'Turnstile içinde görünür doğrulama kutusu. Önce tek tık ile doğrula.'};
  if(slot.captchaAnswer&&detection.target?.identity===slot.captchaAnswer.identity&&detection.target.token)return {state:'answer_applied',capability:'supported',evidence:slot.captchaAnswer.message};
  if(slot.captchaAnswer&&detection.target?.identity!==slot.captchaAnswer.identity)delete slot.captchaAnswer;
  const evidence=captchaEvidence(detection);
  if(evidence)return evidence;
  if(detection.state==='none'&&slot.verification&&await page.evaluate(()=>document.readyState!=='complete'))return {state:'checking',capability:'pending',evidence:'Önceki doğrulama henüz yeniden okunamadı; sayfa yükleniyor.'};
 }
 const evidence=await page.evaluate(()=>{
  const text=document.body?.innerText??'';
  const error=text.match(/There was an error verifying your application[^\n]*|(?:captcha|human verification) (?:failed|error|expired)[^\n]*/i)?.[0];
  const challenge=text.match(/verify (?:that )?you(?:'re| are) (?:a )?human|complete (?:the |this )?captcha|(?:drag|slide) [^\n]{0,120}(?:puzzle|piece|image|shape|verify|complete)/i)?.[0];
  const frame=[...document.querySelectorAll('iframe')].find(e=>{const r=e.getBoundingClientRect();return e.checkVisibility({checkOpacity:true,checkVisibilityCSS:true})&&r.width>40&&r.height>40&&r.bottom>0&&r.top<innerHeight&&/(?:captcha|verification).*challenge|challenge.*(?:captcha|verification)/i.test(e.title+' '+e.getAttribute('aria-label'));});
  if(!error&&!challenge&&!frame)return null;
  return {evidence:(error||challenge||frame.title||frame.getAttribute('aria-label')).slice(0,800),state:challenge||frame?'required':'verification_error',capability:frame||/drag|slide/i.test(challenge??'')?'not_exposed':challenge?'supported':'unknown',limitation:frame?'Jev cannot interact with controls inside this verification iframe.':/drag|slide/i.test(challenge??'')?'Jev has no drag/slider action.':null};
 });
 const boxes=await scanVerificationCheckboxes(page);
 try{
  if(evidence?.capability==='not_exposed'||evidence?.state==='verification_error')return evidence;
  if(boxes.some(b=>!b.meta.checked))return {state:'required',capability:'supported',evidence:'Visible unchecked verification checkbox',checkbox:true,limitation:'Only the visible checkbox is supported, subject to the executing provider confirmation policy. Image/audio challenges remain manual.'};
  if(boxes.length&&boxes.every(b=>b.meta.checked))return {state:'cleared',capability:'supported',evidence:'Verification checkbox is checked; validate the next site response. Stale inline error alone is not a new challenge.'};
  return evidence;
 }finally{await Promise.all(boxes.map(b=>b.handle.dispose().catch(()=>{})));}
}
export function updateVerification(slot,evidence,now=Date.now()){
 if(!evidence||evidence.state==='cleared'){delete slot.verification;return evidence??null;}
 const old=slot.verification;
 const state={...evidence,startedAt:old?.startedAt??now,attempts:old?.attempts??0,screenshots:old?.screenshots??0};
 if(state.state==='answer_applied'){state.handoff=false;state.message=state.evidence;slot.verification=state;return state;}
 state.deadlineAt=state.startedAt+60000;
 state.handoff=state.capability==='not_exposed'||state.capability==='solver'||state.checkbox&&!!slot.verificationCheckboxAttempt||state.attempts>=2||now>=state.deadlineAt;
 if(state.capability==='pending'&&!state.handoff){state.nextAction='wait_for_verification';state.message='Doğrulama yükleniyor; çözüldüğü veya CAPTCHA olmadığı varsayılamaz. Mevcut sekmeyi yeniden gözlemle.';slot.verification=state;return state;}
 state.nextAction=state.handoff?'ask_candidate_once':state.state==='verification_error'?'inspect_one_screenshot':'try_supported_visible_control';
 state.message=state.state==='verification_error'&&state.handoff?'Verification error remains, but that alone does not prove a CAPTCHA is required. Stop browser retries and never resubmit. If a fresh screenshot confirms a remaining challenge, ask one technical question; otherwise keep uncertain and report the observed technical blocker without inventing a CAPTCHA.':state.handoff?'Do not request another Jev decision or repeat the submission. Ask only for the observed remaining verification step. ask_candidate with recovery.kind=captcha saves the question, preserves uncertain submission state and reports the task in one call; then end the turn.':'At most two supported visible verification attempts within 60 seconds. A visible verification checkbox target may be clicked once when the executing provider permits it (obtain at-action confirmation when required). Image/audio/drag challenges are unavailable. One screenshot only if needed; do not inspect/refill the whole form or repeat Submit.';
 slot.verification=state;return state;
}
export function verificationHandoff(slot){return {browser:'Jev Chrome',tabId:slot.id,url:slot.page.url(),status:'verification_handoff',executed:false,verification:slot.verification,nextAction:'ask_candidate_once',message:slot.verification.message};}
