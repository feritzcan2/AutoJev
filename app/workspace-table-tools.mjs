const text={type:'string',minLength:1,maxLength:2000};
const object=(properties,required=Object.keys(properties))=>({type:'object',properties,required,additionalProperties:false});
export const workspaceCellsSchema={type:'array',maxItems:10,items:object({key:text,value:{type:'string',minLength:0,maxLength:2000}}),description:'Send at most 10 custom cells as [{"key":"configured_column","value":"observed text"}]. Use configured column keys and string values; use "" for unknown. A map of column keys to strings is also accepted. When saving a result, omit cells if unused.'};
export function normalizeCellToolArgs(name,args){
 if(!['record_automation_result','update_workspace_cells'].includes(name))return args;
 const cells=args?.cells;
 // Stored records expose a map. Accept the same values on write without
 // guessing missing facts, parsing JSON text or discarding invalid entries.
 if(!cells||Array.isArray(cells)||typeof cells!=='object'||![Object.prototype,null].includes(Object.getPrototypeOf(cells)))return args;
 if(!Object.values(cells).every(value=>typeof value==='string'))return args;
 return {...args,cells:Object.entries(cells).map(([key,value])=>({key,value}))};
}
export const workspaceTableTools=[
 {name:'transition_workspace_record',description:'Apply a template-defined classification transition to one record. This never changes submission state, evidence, permissions or approvals.',inputSchema:object({itemId:text,actionId:text})},
 {name:'configure_workspace_table',description:'Configure the workspace table: rename, reorder or add typed columns. source and title stay; status, activity and actions are app-owned. Presentation only.',inputSchema:object({title:text,columns:{type:'array',minItems:2,maxItems:10,items:object({key:text,label:text,type:{type:'string',enum:['text','number','money','date','url']}})}})},
 {name:'update_workspace_cells',description:'Update custom cells of a saved record after reading its details or observing the source. Empty string means unknown. Presentation only; keeps state, approvals and proof.',inputSchema:object({itemId:text,cells:workspaceCellsSchema})},
 {name:'get_workspace_records',description:'Find saved records by literal query (title, company, location, URL, summary, cells) or browse a compact index: identity, state, fields and score only. Read one full record with itemId before judging or acting. Do not enumerate the table to find one listing.',inputSchema:object({itemId:text,query:{type:'string',minLength:1,maxLength:200},offset:{type:'integer',minimum:0,maximum:100000},limit:{type:'integer',minimum:1,maximum:50}},[])}
];
const pick=(value,keys)=>Object.fromEntries(keys.filter(key=>value[key]!==undefined).map(key=>[key,value[key]]));
export function workspaceRecordIndex(record){
 return {...pick(record,['id','workspaceId','url','title','state','operationState','fields','updatedAt','trial']),...(record.assessment?{assessment:pick(record.assessment,['status','score','revision','scoredAt'])}:{})};
}
export function workspaceTableCall(store,id,name,args){
 const workspaces=store.workspaces,w=workspaces.get(id);
 if(name==='transition_workspace_record')return workspaces.transition(id,args.itemId,args.actionId);
 if(name==='configure_workspace_table')return workspaces.configureTable(id,args);
 if(name==='update_workspace_cells')return workspaces.updateCells(id,args.itemId,args.cells);
 if(name==='get_workspace_records'){
  const offset=args.offset??0,limit=args.limit??25,definition=workspaces.definition(id),project=record=>workspaces.records.project(id,record,definition),tableDefinition=pick(definition,['id','version','title','records']);
  if(args.itemId)return {definition:tableDefinition,table:w.table,record:project(workspaces.records.get(id,args.itemId))};
  const query=args.query?.trim();
  if(args.query!==undefined&&!query)throw Error('Kayıt araması için boş olmayan bir metin gerekli.');
  const found=query?workspaces.records.search(id,{query,offset,limit}):{total:workspaces.records.count(id),records:workspaces.records.list(id,{offset,limit,descending:false})};
  const records=found.records.map(project).map(workspaceRecordIndex);
  return {definition:tableDefinition,table:w.table,total:found.total,nextOffset:offset+records.length<found.total?offset+records.length:null,records,detail:'This is a table index. Read get_workspace_records(itemId) for the complete record, proposal, evidence and uncertainties before judging or acting.'};
 }
 throw Error('Bilinmeyen tablo aracı');
}
