import {randomBytes} from 'node:crypto';
// Short handles, still scoped by the caller's tab/session and live DOM guards.
// The process nonce prevents old handles from aliasing new ones after restart.
const nonce=randomBytes(6).toString('base64url');let sequence=0;
export const observedId=kind=>`${kind}${nonce}-${(++sequence).toString(36)}`;

// Identity and meaning, without transient action IDs or viewport coordinates.
// Every action still checks the latest page/DOM/occlusion before executing.
export function actionIdentity(observed,{id,rect,...action}){
 return JSON.stringify([observed.page_key.slice(0,2),observed.guards[action.node],action]);
}
