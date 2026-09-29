export const MAIN_WORKER='main';
export const MAX_WORKERS=8;
export const workerKey=(candidate,worker=MAIN_WORKER)=>worker===MAIN_WORKER?candidate:`${candidate}~${worker}`;
