// Lifecycle fixtures without candidate evidence must not fabricate a fit score.
export const unknownScorecard=()=>({dimensions:['technical','experience','role','preferences'].map(key=>({key,level:'unknown',listingQuote:'',candidateSource:'facts',candidateQuote:'',reason:'Candidate evidence is not part of this lifecycle fixture.'})),requirements:[]});
