import {applicationMailContract} from '../../mail-contract.mjs';
import {jobSearchSources} from './sources.mjs';
import {browserDefinition} from '../../browser-definition.mjs';
// Domain instructions and fields only. Execution, sources and UI use the same
// browser automation contract as every other template.
export const jobSearchTemplate = {
  mail: applicationMailContract,
  defaultSources: jobSearchSources,
  id: 'job-search',
  version: 2,
  kind: 'web',
  title: 'İş arama',
  icon: '↗',
  description: 'Uygun ilanları bul, değerlendir, başvuruları hazırla ve sonuçlarını takip et.',
  defaultMode: 'observe',
  records: {
    identity: 'url',
    dismissLabel: 'Başvuruyu ele',
    states: browserDefinition.records.states.map((state) =>
      state.id === 'completed' ? {...state, label: 'Başvuruldu'} : state,
    ),
  },
  recordOperations: {
    prepare: {
      label: 'Başvuruyu hazırla',
      instructions:
        'Read the full vacancy, candidate CV and saved application rules. Inspect the actual application form. Prepare exact answers and document paths, explaining eligibility and any missing facts through record-scoped questions. Save the complete application as a proposal. Do not submit an application during preparation.',
    },
    execute: {
      label: 'Başvur',
      runningLabel: 'Başvuruluyor',
      reviewLabel: 'Onayla ve başvur',
      successCriteria:
        'The employer or portal shows confirmation for this exact vacancy and candidate, or its application history lists this application. Save the observed confirmation; an Apply button click is insufficient.',
    },
  },
  fields: [
    {
      id: 'preferences',
      label: 'İş tercihleri',
      question: 'Hangi roller, ülkeler ve çalışma şekilleri uygun?',
      required: true,
      type: 'text',
    },
    {
      id: 'location',
      label: 'Arama konumu',
      question: 'İlanlar hangi şehir veya ülkede aransın? (ör. Berlin, Germany)',
      required: false,
      type: 'text',
    },
    {
      id: 'experience',
      label: 'Deneyim ve yetkinlikler',
      question: 'CV ve belgelerine göre hangi deneyim ve yetkinliklerin var?',
      required: false,
      type: 'text',
    },
    {
      id: 'constraints',
      label: 'Kesin şartlar',
      question: 'Maaş, çalışma izni, dil ve başlangıç tarihi şartların neler?',
      required: false,
      type: 'text',
    },
    {
      id: 'application_policy',
      label: 'Başvuru kuralları',
      question: 'Başvurularda hangi şartlara ve onay tercihlerine uyulmalı?',
      required: false,
      type: 'text',
    },
  ],
  table: {
    title: 'Başvuru akışı',
    columns: [
      {key: 'source', label: 'Kaynak', type: 'text'},
      {key: 'title', label: 'Pozisyon', type: 'text'},
      {key: 'company', label: 'Şirket', type: 'text'},
      {key: 'location', label: 'Konum', type: 'text'},
      {key: 'score', label: 'Uygunluk puanı', type: 'number'},
    ],
  },
  steps: [
    'Profili ve CV belgelerini incele',
    'Güncel ilanları bul ve uygunluğunu değerlendir',
    'Başvuru belgelerini ve cevaplarını hazırla',
    'Yetki kapsamında başvur ve sonucu doğrula',
  ],
  guidance: `## Setup
1. Ask for the CV and explain the "Belge ekle" control. Ask for target roles, countries and work modes. Save the main search place in criteria.location as job sites spell it (for example "Berlin, Germany"); recipes fill {location} with it.
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
- template.defaultSources lists the starting sources. Sources without countries are already in the workspace. Sources with countries serve only those countries (ISO codes): propose the ones matching the user's target countries with save_automation_plan, keeping the existing sources. Adding one keeps its saved recipe and instructions.
`,
};
