// @ts-check
import {jobSearchMail} from './mail.mjs';
import {jobSearchSources} from './sources.mjs';
import {browserDefinition} from '../browser-definition.mjs';
// Domain instructions and fields only. Execution, sources and UI use the same
// browser automation contract as every other template.
export const jobSearchTemplate = {
  mail: jobSearchMail,
  defaultSources: jobSearchSources,
  id: 'job-search',
  version: 2,
  kind: 'web',
  title: 'Job search',
  icon: '↗',
  description:
    'Find suitable listings, assess them, prepare applications and track their outcomes.',
  defaultMode: 'observe',
  records: {
    identity: 'url',
    dismissLabel: 'Dismiss application',
    states: browserDefinition.records.states.map((state) =>
      state.id === 'completed'
        ? {...state, label: 'Applied'}
        : state.id === 'prepared'
          ? {...state, label: 'Ready to apply'}
          : state,
    ),
  },
  recordOperations: {
    prepare: {
      label: 'Prepare application',
      instructions:
        'Read the full vacancy, candidate CV and saved application rules. Inspect the actual application form. Prepare exact answers and document paths, explaining eligibility and any missing facts through record-scoped questions. Save the complete application as a proposal. Do not submit an application during preparation.',
    },
    execute: {
      label: 'Apply',
      runningLabel: 'Applying',
      successCriteria:
        'The employer or portal shows confirmation for this exact vacancy and candidate, or its application history lists this application. Save the observed confirmation; an Apply button click is insufficient.',
    },
  },
  fields: [
    {
      id: 'preferences',
      label: 'Job preferences',
      question: 'Which roles, countries and work modes fit?',
      required: true,
      type: 'text',
    },
    {
      id: 'country',
      label: 'Target country',
      question:
        'Which country should listings be searched in? Two-letter country code (e.g. DE, GB, US)',
      required: false,
      type: 'text',
    },
    {
      id: 'location',
      label: 'Search location',
      question:
        'Which city or region should listings be searched in? (e.g. London, United Kingdom)',
      required: false,
      type: 'text',
    },
    {
      id: 'experience',
      label: 'Experience and skills',
      question: 'What experience and skills do you have according to your CV and documents?',
      required: false,
      type: 'text',
    },
    {
      id: 'constraints',
      label: 'Hard requirements',
      question: 'What are your salary, work permit, language and start date requirements?',
      required: false,
      type: 'text',
    },
    {
      id: 'application_policy',
      label: 'Application rules',
      question: 'Which conditions and approval preferences should applications follow?',
      required: false,
      type: 'text',
    },
    {
      id: 'application_facts',
      label: 'Application form details',
      question:
        'Details forms often ask for: phone, LinkedIn address, work permit or visa status, language levels, notice period, earliest start, salary expectation, willingness to come to the office, gender (optional). When these are saved, the agent does not ask during the application.',
      required: false,
      type: 'text',
    },
  ],
  table: {
    title: 'Applications',
    columns: [
      {key: 'source', label: 'Source', type: 'text'},
      {key: 'title', label: 'Position', type: 'text'},
      {key: 'company', label: 'Company', type: 'text'},
      {key: 'location', label: 'Location', type: 'text'},
      {key: 'score', label: 'Fit score', type: 'number'},
    ],
  },
  steps: [
    'Review the profile and CV documents',
    'Find current listings and assess their fit',
    'Prepare application documents and answers',
    'Apply within the granted permissions and verify the outcome',
  ],
  // Request of the setup turn started by the welcome screen after a CV upload.
  // The user reviews the saved profile on a form, so the turn asks nothing.
  onboarding: `## Profile from the CV
The user uploaded their CV on the welcome screen. They review your result on a form, not in this chat.
1. Read the uploaded CV from the saved documents. If the request has userNotes, read them too: they are the user's own words and win over the CV.
2. Call save_automation_plan once for the profile. Keep the saved sources, instructions and facts. Set title to the candidate's full name, goal to one sentence naming the roles and places to search, and these criteria keys:
   - preferences: target roles, places and work modes from userNotes; otherwise from the CV's recent titles and seniority.
   - experience: years of experience, main skills, languages with levels, education.
   - country (ISO code) and location: from userNotes; otherwise from the CV address when it shows them.
   - constraints: salary, work permit, language and start date conditions that userNotes state.
   - application_facts: phone, email, LinkedIn and language levels from the CV, plus facts userNotes state such as notice period or salary expectation.
   - ranking: your scoring proposal, weights adding up to 100, following userNotes.
3. Leave a field empty when neither userNotes nor the CV show it. Never guess salary, work permit, start date or work mode.
4. Set the source searches as the Source discovery guidance describes, in a second save_automation_plan call with only sourceSearches.
5. Do not call ask_workspace_question and do not research sources in this turn.
6. Call reply_to_user with two short sentences: what you filled and what the user should check or add on the form. Then call finish_automation_run.`,
  // Sent to Jev with every listing triage; keep it short.
  assessmentHints:
    'Listings are jobs. An unrelated listing is a different profession, judged by its actual responsibilities and professional field. A title naming another specialization is unrelated even when it shares a generic word such as engineer, developer or architect. Salary is a soft preference unless the user makes it mandatory; an omitted salary is not a mismatch. A qualification missing from the CV is unknown, not lacking. Possible home office or hybrid is not full remote. A site salary estimate is not the employer offer.',
  guidance: `## Setup
1. Ask for the CV and explain the "Add document" control. Ask for target roles, countries and work modes. Save the main target country as its ISO 3166 alpha-2 code in criteria.country (for example "GB"), or leave it empty for a worldwide remote search, and the main search place in criteria.location as job sites spell it (for example "London, United Kingdom"); recipes fill {country} and {location} with them.
2. Build the criteria.ranking proposal from technical skills, experience, role fit and work preferences, with weights that add up to 100. Ask about hard constraints such as salary, work permit, language and start date.

## Assessing listings
- Record the exact listing URL, company, role, location and verified requirements.
- Direct experience counts more than partial or transferable skills. The employer's branding or industry alone does not make a role match the target field. A title alone does not prove a seniority mismatch.
- Required skills, language and work permit are mandatory conditions only when the listing says so.
- Possible home office is not confirmed full remote. A site salary estimate is not an employer offer.
- Never invent experience, qualifications, language skills, immigration status, salary, consent or personal facts.
- Current saved criteria take precedence over archived referenceData.

## Applications
- Follow criteria.application_policy for consent and approval decisions.
- Save prepared documents such as cover letters under documents/ and list them in the proposal.

## Source discovery
- template.defaultSources lists the starting sources. Sources without countries or remote are already in the workspace. Sources with countries serve only those countries (ISO codes): propose the ones matching criteria.country and the user's other target countries with save_automation_plan addSources; the existing sources stay. Sources with remote serve remote work (with countries: those countries or remote work): propose them only when the user accepts fully remote work, or for their countries. Adding one keeps its saved recipe and instructions. A national board the user names that is not listed is added by its address; its recipe is learned in the trial.
- Then read get_automation_context section profile. sourceSearch lists the sources whose site extension knows the search: notes say what {query} takes, filters lists the values each filter accepts, terms and current show the present choice. Set them with save_automation_plan sourceSearches: up to 5 terms from the target roles in the form the notes ask for (exact job titles, or a category name where {query} is a category), and only the filter values the criteria decide, such as work mode or seniority. Leave other filters unset. Skip a source when its current choice already fits. Every source listed in sourceSearch needs terms: without them its scans wait, because {query} would hold the source scope sentence.
- When the target roles or work preferences change later, update the affected sourceSearches in the same save_automation_plan call.
`,
};
