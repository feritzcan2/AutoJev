// Source discovery follows the saved method. Record operations and interviews
// have their own workflow and can use the browser without a source search.
export function sourceMethodIssue(run,source){
 if(source?.searchMethod!=='tool'||!run.sourceUrl||run.recordId||run.recordOperation||!['trial','run'].includes(run.kind))return null;
 const check=run.sourceToolCheck;
 if(!check||check.status==='running')return 'Bu kaynak özel araç modunda. Önce get_workspace_source_instructions ile hazır skill ve CLI açıklamasını oku, ardından run_workspace_source_tool ile gerçek bir arama yap. Tarayıcıdan başlama.';
 if(check.status==='help')return 'Yardım çıktısı kaynak denemesi değildir. run_workspace_source_tool ile güncel kriterlere uygun gerçek bir arama yap.';
 if(check.status==='failed'&&(source.fallback??'web')==='none')return 'Kaynak aracı başarısız oldu ve alternatif yöntem kapalı. Aracı düzelterek yeniden dene veya hatayı blocked olarak bildir; tarayıcıya geçme.';
 return null;
}

export const SOURCE_METHOD_INSTRUCTIONS=`For assigned source trials and scans, the saved searchMethod determines the first operation. Read get_workspace_source_instructions completely before using the source. In tool mode, test the existing skill through run_workspace_source_tool FIRST: use its documented search/filter/sort/page or cursor arguments with current criteria. Use the app wrapper even if the upstream skill names Bash, a local script or a forked agent. A --help/--version check is not a real search. Do not replace a configured CLI with browser discovery, even when learnedSkill contains browser notes from an earlier turn. A successful empty result is not tool failure: adjust supported criteria through the same tool and record unknowns honestly. After successful tool search, use documented detail commands or inspect observed detail URLs in the browser when needed. Only an actual tool failure permits fallback: browser means the assigned source's browser flow; web means web discovery through the managed browser; none means report the error without switching methods. In browser mode test visible source controls; in free mode use managed web discovery and browsing. Record which method you tested and any actual failure/fallback in the learned skill. Browser fallback notes do not verify the primary CLI. Existing user instructions and action permissions still apply.`;

export function sourceMethodGuidance(source){
 if(source.searchMethod==='tool')return `Start with run_workspace_source_tool using the existing skill's documented arguments. Test a real search, then its page/cursor and detail method. Do not start with browser_open or reuse browser discovery notes as the primary method. On actual tool failure, the configured fallback is ${source.fallback??'web'}. `;
 if(source.searchMethod==='browser')return 'Start with the assigned source in the managed browser and test its visible search, filters, pagination and details. ';
 return 'Use managed web discovery and browsing within the current criteria; learn the source controls from observed pages. ';
}
