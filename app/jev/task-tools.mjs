// @ts-check

// Tools and instructions the parent agent uses to delegate work to Jev.
const object = (properties, required = []) => ({
  type: 'object',
  properties,
  required,
  additionalProperties: false,
});
const str = (maxLength = 2000) => ({type: 'string', minLength: 1, maxLength});
export const JEV_OPERATIONS = [
  'prepare_search',
  'scan_results',
  'classify_results',
  'collect_details',
  'fill_form',
];
export const JEV_REVIEW_INSTRUCTIONS =
  'Review batch: every 20 assessed listings Jev pauses and the pause response already lists the whole batch with item numbers (1-based, fixed for that batch); do not read it again. Read the briefs with read_listing_brief evidenceIds (up to 5 per call), then save suitable listings together with record_automation_results (reuse known records). For the other unsaved items send review:[{item:3,decision:"reject" or "defer",reason}]: reject unsuitable items, defer unresolved ones so they stay pending. Confirmed Jev mismatches at >=85% confidence need no decision; the batch acknowledgement covers them. Then resume with taskId, reviewedBatchId=batch.id and review (an empty list is allowed). Read read_listing_brief(evidenceId) before scoring; use read_listing_evidence only for a missing or conflicting fact. A review never completes source coverage.';
// With agent decisions nothing is pre-judged: every batch item needs a decision.
export const AGENT_REVIEW_INSTRUCTIONS =
  'Review batch: every 20 read listings the task pauses and the pause response already lists the whole batch with item numbers (1-based, fixed for that batch); do not read it again. No listing is judged before you: decide every item. Read the briefs with read_listing_brief evidenceIds (up to 5 per call), then save suitable listings together with record_automation_results (reuse known records). For the other unsaved items send review:[{item:3,decision:"reject" or "defer",reason}]: reject unsuitable items, including a page that is not one individual listing, and defer an item whose content did not load so it stays pending. Then resume with taskId, reviewedBatchId=batch.id and review (an empty list is allowed when every item is saved). Use read_listing_evidence only for a missing or conflicting fact. A review never completes source coverage.';
export const AGENT_LINK_INSTRUCTIONS =
  'Link selection: scan_results pauses on each results page with issue links_ready and linkSelection, the numbered candidate links of up to 30 cards with their card text. Resume with taskId, reviewedBatchId=linkSelection.id, selected=[item numbers of the individual listings to read] and review=[{item,decision:"reject",reason}] for listings whose card clearly conflicts with the user\'s hard constraints or shows a clearly different kind of work. Leave out links that are not individual listings (filters, categories, company or account pages, navigation). Select a listing whose card is ambiguous; reading its detail decides. Selected links go to the pending queue; rejected listings are remembered and not offered again.';
export const AGENT_PAGINATION_INSTRUCTIONS =
  'Pagination: when the observed page numbers do not show the next results page, scan_results pauses with issue pagination_choice and paginationChoice.options. Resume with taskId and next set to the option key of the immediate next results page, "scroll" when more results load further down, or "end" when the page visibly is the last results page. When no option is right, do not resume; resolve the page with the browser tools.';
export const jevTaskTools = [
  {
    name: 'browser_run_task',
    description:
      'Delegate browser work; intermediate pages stay outside your context. collect_details reads and classifies listings (url/urls, or no addresses for the assigned record / the selected pending queue; fromTaskId may point to a scan). classify_results + fromTaskId assesses saved details without assessment. scan_results reads a real results page and follows pagination. prepare_search fills supplied answers into a search form. fill_form fills verified answers without submitting, uploading or consenting. status=running: poll read_browser_task; continue: resume with taskId; needs_agent: follow next, do not repeat the failed input.',
    inputSchema: object({
      operation: {type: 'string', enum: JEV_OPERATIONS},
      taskId: str(80),
      reviewedBatchId: str(80),
      review: {
        type: 'array',
        maxItems: 20,
        items: object(
          {
            item: {
              type: 'integer',
              description:
                'Use the 1-based item number from the current review batch. Choose item or url, not both.',
            },
            url: {
              ...str(4000),
              description: 'Legacy selector; prefer item to avoid copying long URLs.',
            },
            decision: {type: 'string', enum: ['reject', 'defer']},
            reason: str(1500),
          },
          ['decision', 'reason'],
        ),
      },
      fromTaskId: str(80),
      url: str(4000),
      urls: {type: 'array', minItems: 1, maxItems: 100, items: str(4000)},
      goal: str(3000),
      answers: {
        type: 'array',
        maxItems: 30,
        items: object(
          {key: str(100), label: str(300), value: {type: 'string', minLength: 0, maxLength: 12000}},
          ['key', 'label', 'value'],
        ),
      },
    }),
  },
  {
    name: 'read_browser_task',
    description:
      'Wait for a running Jev task (the call blocks until Jev has a result or the wait window ends, often minutes; starts nothing) or read a saved one: confirmed listing links first, then uncertain leads; lastPage/pages hold exact pagination evidence and checkpoint status. Page with offset or pageOffset instead of rereading the board. Originals stay in read_listing_evidence.',
    inputSchema: object(
      {
        taskId: {
          ...str(80),
          description:
            'The Jev taskId returned by browser_run_task or listed in jevTasks; not the assigned task ID or a background task ID of your client.',
        },
        batchId: str(80),
        offset: {type: 'integer', minimum: 0},
        limit: {
          type: 'integer',
          minimum: 1,
          description: 'Requested index size; responses are capped at 20 items.',
        },
        pageOffset: {type: 'integer', minimum: 0},
        view: {
          type: 'string',
          enum: ['compact', 'details'],
          description:
            'Review batches default to compact numbered entries. Use details only when full URLs or assessment metadata are needed.',
        },
      },
      ['taskId'],
    ),
  },
  {
    name: 'read_listing_brief',
    description:
      'Read listing assessment briefs FIRST instead of full page text: Jev selects the source sections for duties, mandatory qualifications, location/work mode and pay. evidenceIds reads up to 5 listings in one call. Poll if running; read nextOffset pages until null. Use read_listing_evidence only for a missing or conflicting fact.',
    inputSchema: object({
      evidenceId: str(80),
      evidenceIds: {
        type: 'array',
        minItems: 1,
        maxItems: 5,
        items: str(80),
        description: 'Several briefs in one call (first pages). Use instead of evidenceId.',
      },
      offset: {type: 'integer', minimum: 0},
    }),
  },
  {
    name: 'read_listing_evidence',
    description:
      'Read one source section after read_listing_brief for a missing or conflicting fact, with offset/limit (1–6000 characters). Not for routine scoring. Historical text proves no later submission. No browser or model call.',
    inputSchema: object(
      {
        evidenceId: str(80),
        offset: {type: 'integer', minimum: 0},
        limit: {type: 'integer', minimum: 1, maximum: 6000},
      },
      ['evidenceId'],
    ),
  },
];
// Observation and tab rules shared by both decision settings.
const BROWSER_BASICS = `Observations are structured. Use clickTargets.targetId for clicks, fillFields.fieldId for typing and controls.controlId for dropdowns, options, reveal and scrolling, all through browser_interact. A scroll with a current scrollTargets.controlId loads lazy lists; stop on no_progress. browser_open and browser_read already include rendered text and links below the viewport.

Tabs: in a source scan first call browser_tabs. Continue on an existing results or detail tab with browser_use_tab instead of reopening page one, after comparing it with scanProgress. Close finished or duplicate tabs with browser_close_tab. Keep tabs with a pending CAPTCHA or login, an unsaved draft or an uncertain submission.`;
export const JEV_TASK_INSTRUCTIONS = `## Jev managed browser
${BROWSER_BASICS}

Delegation with browser_run_task is the normal way to do routine source work, also after a needs_agent issue is resolved. It replaces opening and reading each listing yourself.
- collect_details reads listing details. {operation:"collect_details"} reads the selected search's pending queue. {operation:"collect_details",urls:[...]} reads specific observed listings. fromTaskId reads the listings of a finished scan. No prior Jev task ID is required. Every read listing is classified automatically; do not run classify_results on the same evidence. classify_results is only for imported details that have no assessment.
- scan_results discovers listings on a real results, search or company-board URL. Confirmed listing links come first and uncertain leads are marked. lastPage/pages hold the exact pagination quotes and the checkpoint state; checkpointSaved=true means the queue and page number are already saved. Read more index pages with read_browser_task. When chronology is unverified, cover the board to its observed end. Then run collect_details with fromTaskId. A vendor's marketing or root page is not a job board. Do not invent URLs or company slugs.
- prepare_search applies exact search answers and filters to a search form. Never use it to open, find or extract a listing. If the page has no search control, use scan_results on its visible listings.
- fill_form enters exact verified answers from the profile or the approved proposal. It never submits, uploads, accepts consent or fills passwords/OTP; those belong to the authorized record workflow.
- Progress: when status=running, poll read_browser_task(taskId); the helper continues in the background. When status=continue, resume with the same taskId only. Do not use other browser tools or restart the task while it runs. On needs_agent, follow next for that one issue, keep the saved evidence, then delegate the remaining work. A checkpoint never completes source coverage; finish only after the queue and coverage are really complete.
- ${JEV_REVIEW_INSTRUCTIONS}
- Jev task IDs and raw evidence live in RAM for this app session. After an app restart, start a new collect_details from the durable pending queue. They never prove present availability, processing or submission; get current evidence before retiring work or claiming completion.
- Keep uncertain candidates; preliminary triage cannot establish final eligibility. Keep unknown facts unknown and use the current criteria.`;
export const JEV_LAUNCH_INSTRUCTIONS =
  'Jev delegation is available in this turn. First resume saved pending details with browser_run_task collect_details (url/urls or the selected queue; fromTaskId is optional) before repeating any search. Use scan_results on real results pages and reuse its lastPage/pages instead of rereading the board. Jev task IDs are RAM-only; after an app restart start a new collect_details from the durable queue. When status=running poll read_browser_task; do not use shell sleep. Source completion and final scores still require the existing checks.';
export const AGENT_TASK_INSTRUCTIONS = `## Managed browser (agent decisions)
${BROWSER_BASICS}

In this workspace you make every listing decision. browser_run_task reads pages, keeps the queue and the page number and hands you what it read; it calls no model and judges nothing. Delegate routine source work to it, also after a needs_agent issue is resolved; it replaces opening and reading each listing yourself.
- scan_results reads a real results, search or company-board URL and follows its pagination. lastPage/pages hold the exact pagination quotes and the checkpoint state; checkpointSaved=true means the queue and page number are already saved. When chronology is unverified, cover the board to its observed end. A vendor's marketing or root page is not a job board. Do not invent URLs or company slugs.
- ${AGENT_LINK_INSTRUCTIONS}
- ${AGENT_PAGINATION_INSTRUCTIONS}
- collect_details reads listing details. {operation:"collect_details"} reads the selected search's pending queue. {operation:"collect_details",urls:[...]} reads specific observed listings. fromTaskId reads the listings you selected in a scan. Listings are read, not judged; the review batch asks for your decision.
- Search and application forms: fill them yourself with browser_interact (type, autocomplete, select, click). browser_run_task does not fill forms in this workspace.
- Progress: when status=running, poll read_browser_task(taskId); the helper continues in the background. When status=continue, resume with the same taskId only. Do not use other browser tools or restart the task while it runs. On needs_agent, follow next for that one issue, keep the saved evidence, then delegate the remaining work. A checkpoint never completes source coverage; finish only after the queue and coverage are really complete.
- ${AGENT_REVIEW_INSTRUCTIONS}
- Task IDs and raw evidence live in RAM for this app session. After an app restart, start a new collect_details from the durable pending queue. They never prove present availability, processing or submission; get current evidence before retiring work or claiming completion.
- Keep unknown facts unknown and use the current criteria.`;
export const AGENT_LAUNCH_INSTRUCTIONS =
  'Browser delegation is available in this turn; you make the listing decisions. First resume saved pending details with browser_run_task collect_details (url/urls or the selected queue; fromTaskId is optional) before repeating any search. Use scan_results on real results pages, choose the listings to read when it pauses with links_ready, and reuse its lastPage/pages instead of rereading the board. Task IDs are RAM-only; after an app restart start a new collect_details from the durable queue. When status=running poll read_browser_task; do not use shell sleep. Source completion and final scores still require the existing checks.';
// browser_run_task and read_listing_brief as the agent sees them when it decides.
export const AGENT_OPERATIONS = JEV_OPERATIONS.filter(
  (operation) => !['prepare_search', 'fill_form'].includes(operation),
);
export function agentDecisionTools(tools) {
  return tools.map((tool) => {
    if (tool.name === 'read_listing_brief')
      return {
        ...tool,
        description:
          'Read the original listing text FIRST, in pages of about 6000 characters, instead of rereading the page. evidenceIds reads up to 5 listings in one call. Read nextOffset pages until null for the facts you need. No model selects or drops any text.',
      };
    if (tool.name !== 'browser_run_task') return tool;
    const {answers, goal, ...properties} = tool.inputSchema.properties;
    return {
      ...tool,
      description:
        'Delegate browser work; intermediate pages stay outside your context and no model judges anything. scan_results reads a real results page, pauses with links_ready for you to choose its listings, and follows pagination. collect_details reads listings (url/urls, or no addresses for the assigned record / the selected pending queue; fromTaskId may point to a scan) and pauses every 20 for your review. classify_results + fromTaskId puts saved details into review batches. status=running: poll read_browser_task; continue: resume with taskId; needs_agent: follow next, do not repeat the failed input.',
      inputSchema: {
        ...tool.inputSchema,
        properties: {
          ...properties,
          operation: {type: 'string', enum: AGENT_OPERATIONS},
          selected: {
            type: 'array',
            maxItems: 30,
            items: {type: 'integer', minimum: 1},
            description:
              'With reviewedBatchId=linkSelection.id: item numbers of the individual listings to read.',
          },
          next: {
            type: 'string',
            minLength: 1,
            maxLength: 20,
            description:
              'Answer to a pagination_choice: an option key from paginationChoice.options, "scroll" or "end".',
          },
        },
      },
    };
  });
}
