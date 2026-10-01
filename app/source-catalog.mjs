export const sourceIntegrations=[
 {id:'linkedin',name:'LinkedIn',url:'https://www.linkedin.com/jobs/',market:'global'},
 {id:'freehire',name:'FreeHire',url:'https://freehire.me/',market:'global'},
 {id:'jobindex',name:'Jobindex',url:'https://www.jobindex.dk/',market:'DK'},
 {id:'jobnet',name:'Jobnet',url:'https://jobnet.dk/',market:'DK'},
 {id:'jobdanmark',name:'Jobdanmark',url:'https://jobdanmark.dk/',market:'DK'},
 {id:'jobbank',name:'Akademikernes Jobbank',url:'https://jobbank.dk/',market:'DK'},
];
export function integration(id){return sourceIntegrations.find(x=>x.id===id);}
