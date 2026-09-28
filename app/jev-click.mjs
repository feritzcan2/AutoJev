import {observedId,actionIdentity} from './jev-ids.mjs';

// The caller selects an observed target, never a selector or guessed coordinate.
export function captureClickTargets(slot,owner){
  const previous=slot.clickTargets??new Map();slot.clickTargets=new Map();
  return slot.observed.actions.filter(a=>a.kind==='click').map(action=>{
    const identity=actionIdentity(slot.observed,action);
    const saved=[...previous].find(([,entry])=>entry.owner===owner&&entry.identity===identity);
    const targetId=saved?.[0]??observedId('t');
    slot.clickTargets.set(targetId,{owner,identity,action,observed:slot.observed});
    const {label,role,checked,pressed,choice}=action;
    return {targetId,label,role,checked,pressed,choice};
  });
}

export function takeClickTarget(slot,targetId,owner){
  const target=slot.clickTargets?.get(targetId);
  if(!target)return null;
  if(target.owner!==owner)throw Error('Bu oturuma ait güncel targetId gerekli.');
  // Consume this target even if the click has no effect. Unchanged unrelated
  // targets can keep their IDs in the fresh observation returned afterwards.
  slot.clickTargets.delete(targetId);slot.pending=null;
  return {...target,operation:'CLICK'};
}
