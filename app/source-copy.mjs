import catalog from '../source-library/sources.json' with {type:'json'};

// Resolve the built-in guide once, when a source is copied or its tool selected.
// Persisted sources always own their text, including an intentionally empty skill.
export function copySourceSkill(source){
 if(source.skill!==undefined||!source.tool)return {...source};
 return {...source,skill:catalog.find(entry=>entry.tool===source.tool)?.skill??''};
}
