import {templateContract} from './template-contract.mjs';
import {browserDefinition} from './browser-definition.mjs';
import {automationTemplates} from './automation-templates.mjs';

export class TemplateRegistry {
 constructor(drivers=[]){this.drivers=new Map();this.templates=new Map();this.register({...browserDefinition,templates:automationTemplates});for(const driver of drivers)this.register(driver);}
 register(driver){
  if(!/^[a-z][a-z0-9_-]*$/.test(driver.id)||this.drivers.has(driver.id))throw Error('Yürütücü kimliği benzersiz olmalı');
  this.drivers.set(driver.id,driver);
  for(const template of driver.templates??[]){if(this.templates.has(template.id))throw Error('Template kimliği benzersiz olmalı');this.templates.set(template.id,{...template,execution:{...template.execution,driver:driver.id}});}
 }
 driver(input){const id=input.execution?.driver??(input.kind?[...this.drivers.values()].find(d=>d.kind===input.kind)?.id:browserDefinition.id);const driver=this.drivers.get(id);if(!driver)throw Error('Template uzantısı yüklü değil: '+(id??input.kind));return driver;}
 supports(input){try{this.driver(input);return true;}catch{return false;}}
 normalize(input){return templateContract(input,this.driver(input));}
 template(id){const template=this.templates.get(id);if(!template)throw Error('Template bulunamadı');return this.normalize(structuredClone(template));}
 catalog(){return [...this.templates.keys()].map(id=>this.template(id));}
}
