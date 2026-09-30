import path from 'node:path';
function scoped(root,relative){const target=path.resolve(root,relative),base=path.resolve(root);if(target!==base&&!target.startsWith(base+path.sep))throw Error('Çalışma alanı dizini geçersiz');return target;}
export const workspaceDirectory=(data,workspace)=>scoped(data,workspace.storagePath??path.join('automations','workspaces',workspace.id));
export const workspaceBrowserDirectory=(data,workspace)=>scoped(data,workspace.browserStoragePath??'automations');
