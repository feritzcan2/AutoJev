// Per-tab file/field budget survives fresh observation IDs. No submission retry.
export function takeUploadAttempt(slot,key,now=Date.now()){
 slot.uploadAttempts??=new Map();
 const state=slot.uploadAttempts.get(key)??{startedAt:now,attempts:0};
 slot.uploadAttempts.set(key,state);
 if(state.attempts>=2||now-state.startedAt>=60000)return false;
 state.attempts++;return true;
}
