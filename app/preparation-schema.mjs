const text={type:'string',minLength:1,maxLength:3000};
const choice=values=>({type:'string',enum:values});
export const preparationSchema={type:'object',additionalProperties:false,required:['jobId','revision','profileKey','status','coverage','formUrl','coverageNote','note','requirements'],properties:{
 jobId:text,profileKey:text,revision:{type:'integer',minimum:0},status:choice(['inspecting','drafting','waiting','partial','ready']),coverage:choice(['partial','complete']),formUrl:text,coverageNote:text,note:text,
 requirements:{type:'array',maxItems:60,items:{type:'object',additionalProperties:false,required:['id','label','kind','required','status','evidence'],properties:{
  id:{...text,maxLength:100},label:{...text,maxLength:300},kind:choice(['document','answer']),required:choice(['required','optional','unknown']),status:choice(['pending','ready','missing','omitted']),evidence:text,format:text,language:text,source:text,note:text,documentPath:{...text,maxLength:1000},answer:{...text,maxLength:12000},maxBytes:{type:'integer',minimum:1},maxLength:{type:'integer',minimum:1},acceptedExtensions:{type:'array',minItems:1,maxItems:10,items:text}
 }}}
}};
