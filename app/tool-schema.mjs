export function validate(schema,value,path='arguments'){
 const errors=[];
 inspect(schema,value,path,errors);
 if(errors.length){const error=errors[0];error.message=errors.map(e=>e.message).join('\n');error.validationIssues=errors.map(e=>e.validationIssue);throw error;}
}

const valueType=value=>value===undefined?'missing':value===null?'null':Array.isArray(value)?'array':typeof value;
const issue=(schema,value,path)=>({path,expected:schema.type,received:valueType(value),
 ...(typeof value==='string'||Array.isArray(value)?{length:value.length}:{}),
 ...(schema.type==='array'?{minItems:schema.minItems??0,maxItems:schema.maxItems??100}:{})});
const hint=schema=>schema.description?` ${schema.description.slice(0,500)}`:'';

// Report independent field problems together so a retry can fix the complete
// call. Bound the response and report paths/types without echoing input text.
function inspect(schema,value,path,errors){
 if(errors.length>=8)return;
 const invalid=(message,detail=issue(schema,value,path))=>{if(errors.length<8){const error=Error(`${path}: ${message}`);error.validationPath=path;error.validationIssue=detail;errors.push(error);}};
 try{
  if(Array.isArray(schema.type)){
    const type=schema.type.find(type=>type==='null'?value===null:type==='array'?Array.isArray(value):type==='integer'?Number.isInteger(value):value!==null&&typeof value===type);
    if(!type)throw Error(`Invalid argument type: expected ${schema.type.join(' or ')}${schema.minimum!==undefined&&schema.maximum!==undefined?` (${schema.minimum}–${schema.maximum})`:''}`);
    return inspect({...schema,type},value,path,errors);
  }
  if(schema.type==='null'){if(value!==null)throw Error('Expected null');
  }else if(schema.type==='object'){
    if(!value||typeof value!=='object'||Array.isArray(value))throw Error('arguments must be an object');
    for(const key of schema.required??[])if(!(key in value)){const property=schema.properties?.[key]??{};invalid(`Missing ${key}${hint(property)}`,issue(property,undefined,`${path}.${key}`));}
    for(const [key,item]of Object.entries(value)){const property=schema.properties?.[key];if(!property){if(schema.additionalProperties===true)continue;invalid(`Unknown field ${key}`);continue;}inspect(property,item,`${path}.${key}`,errors);}
  }else if(schema.type==='array'){
    if(!Array.isArray(value))throw Error(`Expected array; received ${valueType(value)}.${hint(schema)}`);
    if(value.length<(schema.minItems??0))throw Error(`Array too short: received ${value.length} items; minimum ${schema.minItems}.${hint(schema)}`);
    if(value.length>(schema.maxItems??100))throw Error(`Array too long: received ${value.length} items; maximum ${schema.maxItems??100}.${hint(schema)}`);
    for(const [index,item] of value.entries())inspect(schema.items,item,`${path}[${index}]`,errors);
  }else if(schema.type==='integer'||schema.type==='number'){
    if(typeof value!=='number'||!Number.isFinite(value)||schema.type==='integer'&&!Number.isInteger(value))throw Error(`Invalid number: expected a finite ${schema.type}`);
    if(value<(schema.minimum??-Infinity))throw Error(`Number below minimum ${schema.minimum}; received ${value}`);
    if(value>(schema.maximum??Infinity))throw Error(`Number exceeds maximum ${schema.maximum}; received ${value}`);
  }else if(schema.type==='boolean'){if(typeof value!=='boolean')throw Error('Invalid boolean');
  }else{
    if(typeof value!=='string')throw Error('Invalid argument: expected a string');
    if(schema.minLength!==0&&!value.trim())throw Error('Invalid argument: expected non-empty string');
    if(value.length<(schema.minLength??0))throw Error(`String too short: received ${value.length} characters; minimum ${schema.minLength}`);
    if(value.length>(schema.maxLength??12000))throw Error(`String too long: received ${value.length} characters; maximum ${schema.maxLength??12000}. Shorten this field before retrying`);
    if(schema.enum&&!schema.enum.includes(value))throw Error(`Invalid argument: expected ${schema.enum.join(' | ')}`);
  }
 }catch(error){invalid(error.message);}
}
