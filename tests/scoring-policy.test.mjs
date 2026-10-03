import test from 'node:test';
import assert from 'node:assert/strict';
import {scoringPolicy,calculateScorecard,SCORE_DIMENSIONS} from '../app/scoring-policy.mjs';
import {scoringSources} from '../app/scoring-profile.mjs';
import {recordAssessment} from '../app/record-scoring.mjs';
const profile={revision:5,criteria:{ranking:'Direct security program ownership matters most.',weight_technical:'70',weight_experience:'10',weight_role:'10',weight_preferences:'10',score_threshold:'60',preferences:'Remote in Germany'},facts:'Five years owning ISO 27001 and SOC 2 programs. Principal information security manager. Fluent English.'};
const listing='Principal information security manager. Five years owning ISO 27001 and SOC 2 programs. Fluent English. Remote in Germany. AI-native company.';
const proof={listingQuote:'Five years owning ISO 27001 and SOC 2 programs.',candidateSource:'facts',candidateQuote:'Five years owning ISO 27001 and SOC 2 programs.',reason:'The same program ownership is documented.'};
const card=()=>({dimensions:SCORE_DIMENSIONS.map(key=>({key,level:'direct',...proof,...(key==='preferences'?{listingQuote:'Remote in Germany',candidateSource:'preferences',candidateQuote:'Remote in Germany'}:{})})),requirements:[{kind:'qualification',match:'met',...proof}]});
const calculate=(input=card(),a=profile)=>calculateScorecard(input,scoringPolicy(a),{listing,sources:scoringSources(a)});
test('fixed anchors, active weights and rounding produce the same score on every evaluation',()=>{
 const input=card();input.dimensions[0].level='partial';input.dimensions[2].level='transferable';
 const result=calculate(input);assert.equal(result.rawScore,72);assert.equal(result.score,72);assert.equal(result.eligibility,'verified');
 assert.deepEqual(calculate(input),result);assert.equal(result.dimensions.reduce((sum,x)=>sum+x.contribution,0),72);
 assert.equal(calculate().score,100);assert.ok(result.sources.facts.digest);
});
test('mandatory eligibility is independent of weighted fit, without fixed caps',()=>{
 const input=card();input.requirements[0]={...input.requirements[0],match:'unknown',candidateQuote:'',reason:'The CV does not verify required program ownership.'};
 const result=calculate(input);assert.equal(result.rawScore,100);assert.equal(result.score,100);assert.equal(result.eligibility,'unverified');
 input.dimensions[0].level='transferable';assert.equal(calculate(input).score,51);
 input.requirements[0].match='partial';input.requirements[0].candidateQuote=proof.candidateQuote;assert.equal(calculate(input).eligibility,'unverified');
 input.requirements[0].match='unmet';assert.equal(calculate(input).score,51);assert.equal(calculate(input).eligibility,'mismatch');
 assert.equal(scoringPolicy(profile).caps,undefined);
});
test('unknown and mismatched core dimensions affect only their weighted contribution',()=>{
 const input=card();input.dimensions[1]={...input.dimensions[1],level:'unknown',candidateQuote:''};input.requirements=[];
 assert.equal(calculate(input).score,90);
 assert.equal(calculate(input,{...profile,criteria:{...profile.criteria,ranking:'Eşik 45/100.'}}).score,90);
 input.dimensions[1]={...input.dimensions[1],level:'mismatch',candidateQuote:proof.candidateQuote};assert.equal(calculate(input).score,90);
});
test('missing optional salary does not invalidate otherwise verified fit',()=>{
 const input=card();input.dimensions[3]={...input.dimensions[3],level:'unknown',candidateQuote:'',listingQuote:'',reason:'Optional salary is not published.'};
 assert.equal(calculate(input).score,90);assert.equal(calculate(input).cap,null);
});
test('weight fields win over old profile weights and free text; invalid explicit weights fail clearly',()=>{
 const p=scoringPolicy({...profile,referenceData:{profile:{rankWeights:{technical:60,experience:20,role:10,preferences:10}}},planDraft:{plan:{criteria:{weight_technical:'100'}}}});
 assert.deepEqual(p.weights,{technical:70,experience:10,role:10,preferences:10});
 assert.deepEqual(scoringPolicy({criteria:{ranking:'Yetkinlik %70, deneyim %30',weight_technical:'70',weight_experience:'30'}}).weights,{technical:70,experience:30,role:0,preferences:0});
 assert.deepEqual(scoringPolicy({criteria:{ranking:'Yetkinlik %100'}}).weights,{technical:70,experience:10,role:10,preferences:10});
 for(const criteria of [{weight_technical:'70',weight_experience:'20'},{weight_technical:'70.5',weight_experience:'29.5'},{score_threshold:'101'},{score_threshold:'0'}])assert.throws(()=>scoringPolicy({criteria}));
 assert.notEqual(scoringPolicy(profile).digest,scoringPolicy({...profile,revision:6}).digest);
});
test('optional breakdown accepts paraphrases and omitted quotes but retains dimension and source checks',()=>{
 let input=card();input.dimensions[0].candidateQuote='Invented certification';assert.equal(calculate(input).score,100);
 input=card();input.dimensions[0].listingQuote='Made up requirement';assert.equal(calculate(input).score,100);
 input=card();input.dimensions[0].candidateSource='preferences';input.dimensions[0].candidateQuote='Remote in Germany';assert.throws(()=>calculate(input),/tercih metni/);
 input=card();input.dimensions[0].candidateSource='cv';assert.equal(calculate(input).score,100);
 input=card();input.dimensions[0].candidateQuote='Five years\n owning ISO 27001 and SOC 2 programs.';assert.equal(calculate(input).score,100);
 input=card();for(const entry of [...input.dimensions,...input.requirements]){delete entry.listingQuote;delete entry.candidateQuote;}assert.equal(calculate(input).score,100);
 input=card();input.dimensions[1].key='technical';assert.throws(()=>calculate(input),/tekrarlanmamalı/);
 input=card();input.requirements.push({...input.requirements[0]});assert.throws(()=>calculate(input),/tekrarlanamaz/);
});
test('record writes save the supplied score without a mandatory breakdown',()=>{
 const url='https://example.test/job',a={...profile,templateId:'job-search'},run={id:'run',automationId:'one',revision:5,observations:[{url,evidence:listing}]};
 const db={get:()=>a,template:()=>({fields:[{id:'ranking'}]}),now:()=>1};
 const input={status:'scored',score:88,summary:'Adjacent experience only.',evidenceUrl:url,evidence:listing,strengths:[],gaps:[],uncertainties:[],scorecard:card()};
 input.scorecard.dimensions[0].level='transferable';assert.equal(recordAssessment(db,'one',run,input).score,88);
 delete input.scorecard;assert.equal(recordAssessment(db,'one',run,input).score,88);
 assert.equal(recordAssessment(db,'one',run,{score:75}).score,75);
 delete input.score;assert.throws(()=>recordAssessment(db,'one',run,input),/Puan/);
});
test('optional breakdown accepts summaries but reports invalid source categories together',()=>{
 const input=card(),text=listing+' Use "secure by design"\npractices.';input.dimensions[0].listingQuote='Use "secure by design" practices.';
 assert.equal(calculateScorecard(input,scoringPolicy(profile),{listing:'Page URL: https://example.test\n'+JSON.stringify({text}),sources:scoringSources(profile)}).score,100);
 input.dimensions[0].listingQuote='Agent summary';input.dimensions[1].candidateQuote='Candidate summary';assert.equal(calculate(input).score,100);
 input.dimensions[0].candidateSource='unknown';input.dimensions[1].candidateSource='unknown';
 assert.throws(()=>calculate(input),error=>error.message.includes('dimensions.technical')&&error.message.includes('dimensions.experience')&&error.message.includes('tek seferde'));
});
