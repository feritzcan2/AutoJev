// CUA Chrome tab IDs and Jev CDP target IDs belong to different namespaces.
// Preserve an unfinished draft's original tool instead of recreating its tab.
export function browserResume(profile,job){
 const checkpoint=job?.resumeContext;
 if(!checkpoint||['submitted','skipped'].includes(job.status))return null;
 if(profile.browserMode!=='jev'||checkpoint.browser==='Jev Chrome')return null;
 if(!/^Chrome profile .+\([^)]+\)$/.test(checkpoint.browser)||!/^\d+$/.test(checkpoint.tabId))return null;
 const selected=profile.chromeProfile?.directory;
 if(!selected||!checkpoint.browser.endsWith(`(${selected})`))return {mode:'blocked',instruction:'The saved draft belongs to a different or unverified Chrome profile. Preserve it; verify the selected candidate account before continuing. Do not open a replacement or pass its tabId to Jev.'};
 return {mode:'existing',tabId:checkpoint.tabId,browser:checkpoint.browser,instruction:'This unfinished draft was opened with the existing Chrome browser tools, not Jev. Resume its saved tab using those original tools and verify the selected candidate profile/account. This checkpoint takes precedence over the Jev preference for this application only. Never pass its numeric tabId to browser_jev_* or open a replacement. Use Jev for new applications. If the original tools are unavailable, record an access blocker; do not ask the user to reconnect this tab to Jev.'};
}
