export function validate(schema,value,path='arguments'){
 try{
  if(Array.isArray(schema.type)){
    const type=schema.type.find(type=>type==='null'?value===null:type==='array'?Array.isArray(value):type==='integer'?Number.isInteger(value):value!==null&&typeof value===type);
    if(!type)throw Error('Invalid argument type');
    return validate({...schema,type},value,path);
  }
  if(schema.type==='null'){if(value!==null)throw Error('Expected null');
  }else if(schema.type==='object'){
    if(!value||typeof value!=='object'||Array.isArray(value))throw Error('arguments must be an object');
    for(const key of schema.required??[])if(!(key in value))throw Error(`Missing ${key}`);
    for(const [key,item]of Object.entries(value)){if(!schema.properties[key])throw Error(`Unknown field ${key}`);validate(schema.properties[key],item,`${path}.${key}`);}
  }else if(schema.type==='array'){if(!Array.isArray(value)||value.length<(schema.minItems??0)||value.length>(schema.maxItems??100))throw Error('Invalid array');for(const [index,item] of value.entries())validate(schema.items,item,`${path}[${index}]`);
  }else if(schema.type==='integer'||schema.type==='number'){if(typeof value!=='number'||!Number.isFinite(value)||schema.type==='integer'&&!Number.isInteger(value)||value<(schema.minimum??-Infinity)||value>(schema.maximum??Infinity))throw Error('Invalid number');
  }else if(schema.type==='boolean'){if(typeof value!=='boolean')throw Error('Invalid boolean');
  }else if(typeof value!=='string'||schema.minLength!==0&&!value.trim()||value.length<(schema.minLength??0)||value.length>(schema.maxLength??12000)||schema.enum&&!schema.enum.includes(value))throw Error(`Invalid argument: expected ${schema.enum?schema.enum.join(' | '):'non-empty string'}`);
 }catch(error){if(!error.validationPath){error.message=`${path}: ${error.message}`;error.validationPath=path;}throw error;}
}
