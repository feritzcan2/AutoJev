import assert from 'node:assert/strict';

// Smoke-test consumer of the wire contract: the agent retains this same map
// from full observations and applies subsequent changes/removals by ID.
export function controlState(){
  const tabs=new Map();
  return value=>{
    if(!value.observationId)return value;
    let state=tabs.get(value.tabId);
    if(value.observationMode==='full'||value.controlMaps==='replace')state={};
    else{
      assert.ok(state,'A delta needs an earlier full observation');
      assert.equal(value.baseObservationId,state.observationId,'Apply observations in order');
    }
    const maps={};
    for(const [key,id,removed] of [['controls','controlId','removedControls'],['clickTargets','targetId','removedClickTargets'],['fillFields','fieldId','removedFillFields'],['scrollTargets','controlId','removedScrollTargets']]){
      if(key!=='controls'&&key in value&&value.mapDeltas!==true)state[key]=new Map();
      state[key]??=new Map();
      for(const itemId of value[removed]??[])state[key].delete(itemId);
      for(const item of value[key]??[])state[key].set(item[id],item);
      if(key in value)maps[key]=[...state[key].values()];
    }
    state.observationId=value.observationId;tabs.set(value.tabId,state);
    return {...value,...maps};
  };
}
