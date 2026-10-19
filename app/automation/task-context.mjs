// @ts-check
import {taskHasRecord, batchScoring, recordScoredInTask} from '../records/task-scope.mjs';
import {recordListingReads} from '../records/listing-reader.mjs';
import {scoringPolicy} from '../scoring/policy.mjs';
import {COLLECTOR_INSTRUCTIONS, collectorProgress} from '../sources/collector-worker.mjs';
import {jevContextTasks} from '../jev/task-summary.mjs';
import {scanWorkSummary, scanPlanView, scanProgressView} from '../sources/scan-work.mjs';
import {isConversation, conversationRequest} from '../workspaces/conversation.mjs';
import {setupAgentOnboarding} from '../agents/setup-agent.mjs';
import {findOperation, operationFor} from '../templates/contract.mjs';
import {sourceMode} from '../sources/automation-sources.mjs';
import {SOURCE_SCAN_INSTRUCTIONS} from '../sources/scan.mjs';
import {directRecordInstructions} from '../records/operation-definitions.mjs';
import {siteExtensionKind} from '../site-extensions/index.mjs';
import {createHash} from 'node:crypto';

const pick = (value, keys) =>
  Object.fromEntries(
    keys.filter((key) => value[key] !== undefined).map((key) => [key, value[key]]),
  );
// Setup proposes starting sources by address, country and remote work; the store copies a
// source's recipe and instructions when one is added, so the agent never
// needs them (a template may list dozens of country boards).
const templateContext = (definition) => ({
  ...definition,
  ...(definition.defaultSources
    ? {
        defaultSources: definition.defaultSources.map((s) =>
          pick(s, ['url', 'name', 'countries', 'remote']),
        ),
      }
    : {}),
});
function contextRun(run) {
  return {
    ...pick(run, [
      'id',
      'taskId',
      'kind',
      'operation',
      'recordOperation',
      'sourceUrl',
      'recordId',
      'recordIds',
      'status',
      'startedAt',
      'finishedAt',
      'summary',
      'revision',
      'resumeContext',
      'pageProgress',
      'observedPage',
      'actionId',
      'recovery',
      'protocolReset',
    ]),
    browserSteps: run.browserSteps ?? 0,
    navigationCount: run.navigation?.length ?? 0,
    observations: (run.observations ?? []).slice(-3).map(({url, at}) => ({url, at})),
  };
}
// An answered form no longer needs its options and help texts; the answer
// carries the facts. Open questions keep the full definition for follow-ups.
const questionContext = (q) => ({
  ...pick(q, [
    'id',
    'text',
    'fields',
    'answer',
    'answerValues',
    'documents',
    'createdAt',
    'answeredAt',
    'recordId',
    'sourceUrl',
    'taskId',
    'resolution',
  ]),
  ...(q.instruction
    ? {
        instruction: true,
        instructionNote:
          'The user did not answer this question. answer is their instruction for this task: carry it out within the saved policy and your tools. If it cannot be done, ask again and say why.',
      }
    : {}),
  ...(q.answer != null && Array.isArray(q.fields)
    ? {fields: q.fields.map((f) => pick(f, ['id', 'label', 'type']))}
    : {}),
});
const previousRunContext = (run) =>
  pick(run, [
    'id',
    'taskId',
    'kind',
    'operation',
    'recordOperation',
    'sourceUrl',
    'recordId',
    'status',
    'startedAt',
    'finishedAt',
    'summary',
    'protocolReset',
  ]);
export const conversationContextVersion = (a) =>
  createHash('sha256')
    .update(
      JSON.stringify(
        pick(a, [
          'revision',
          'title',
          'goal',
          'criteria',
          'instructions',
          'facts',
          'mode',
          'sources',
          'sourceSettings',
          'planDraft',
          'sourceDraft',
          'profileUpdate',
        ]),
      ),
    )
    .digest('hex');

// Keep current rules and exact authorizations; old runs and unrelated rows are
// available through lookup tools instead of replaying them at every start.
// A listing read through a site extension: the text a scan assesses, without site chrome.
const readerLabel = (reader) =>
  `${reader.extension} site extension (${reader.kind === 'api' ? 'API collector' : 'HTTP reader'})`;
const SITE_READER_LISTING =
  "The listing's own text (title, stated facts and description), read through the site's reader the way a scan reads it, without site menus. Score from it with browser_read_part or browser_search on its snapshotId; do not open the listing page in the browser to score. It is historical evidence; actions and availability require a current observation.";
export function automationTaskContext(db, id, active, {section = undefined} = {}) {
  const saved = db.get(id),
    conversation = isConversation(active),
    draft =
      conversation && saved.planDraft?.baseRevision === saved.revision ? saved.planDraft : null;
  const base =
      conversation && saved.profileUpdate ? {...saved, ...saved.profileUpdate.plan} : saved,
    a = {
      ...base,
      ...draft?.plan,
      ...(conversation && saved.sourceDraft ? {sources: saved.sourceDraft.sources} : {}),
    },
    definition = db.template(a.templateId),
    interview = active.kind === 'interview';
  if (section) {
    if (!conversation)
      throw Error('Extra context sections are only available to the independent conversation.');
    if (section === 'profile')
      return {
        automation: pick(a, [
          'id',
          'title',
          'goal',
          'criteria',
          'sources',
          'instructions',
          'facts',
          'table',
        ]),
        draftPending: Boolean(draft),
        sourceDraftPending: Boolean(saved.sourceDraft),
        sourceSearch: db.sourceSearchOptions(id, a.sources),
      };
    if (section === 'template') return {template: templateContext(definition)};
    if (section === 'questions')
      return {
        questions: (a.questions ?? [])
          .filter((q) => !q.recordId && !q.sourceUrl)
          .map(questionContext),
      };
    throw Error('Unknown context section.');
  }
  const request = conversation ? conversationRequest(db, id, active) : null;
  if (conversation)
    return {
      automation: {
        ...pick(a, [
          'id',
          'templateId',
          'title',
          'goal',
          'criteria',
          'instructions',
          'facts',
          'revision',
        ]),
        mode: saved.mode,
      },
      template: pick(definition, ['id', 'title']),
      messages: request?.message ? [{role: 'user', text: request.message, at: request.at}] : [],
      questions: (a.questions ?? [])
        .filter(
          (q) =>
            q.conversation &&
            (q.answer == null ||
              (active.inputQuestionIds ?? active.continuation?.questionIds ?? []).includes(q.id)),
        )
        .map(questionContext),
      conversation: {
        independent: true,
        persistent: true,
        setupComplete: !setupAgentOnboarding(db, id),
        profileChanges: 'draft',
        draftPending: Boolean(draft),
        sourceDraftPending: Boolean(saved.sourceDraft),
        instructions:
          'Use the existing conversation history. If setupComplete is false, read get_automation_context section template, lead the initial setup and save the unapproved profile for review. Otherwise answer the current message directly; inspect specific records only when needed. Other workers continue. Profile changes are reviewed on the Workspace profile screen. Source suggestions are reviewed and applied separately on the Sources screen; saving the profile does not apply sources. After reply_to_user, call finish_automation_run to wait for the next message in this same session.',
      },
      profileUpdate: saved.profileUpdate
        ? {
            saved: true,
            pending: true,
            error: saved.profileUpdate.error ?? null,
            instructions:
              'The user saved this profile. Workers are being stopped so it can apply before they restart. The setup conversation stays open. If error is present, the profile is not applied; ask the user to retry saving.',
          }
        : null,
      currentRun: pick(active, ['id', 'taskId', 'kind', 'workerId']),
      documentsDirectory: 'documents/',
      contextScope: {
        note: 'History is not loaded automatically, including on fresh sessions. Use get_workspace_history only for relevant earlier messages or worker run evidence. Request get_automation_context section profile, template or questions only when needed. Look up current records with get_automation_result; historical scores may be stale.',
      },
    };
  const batch = batchScoring(active),
    assignedRecord = !batch && active.recordId ? db.result(id, active.recordId) : null;
  const assignedRecords = batch
    ? active.recordIds.map((itemId) => {
        const item = db.result(id, itemId);
        const read = db.browserEvidence.latest(active, item.url);
        return {
          ...pick(item, ['id', 'key', 'url', 'title', 'status']),
          scoredInThisRun: item.assessment?.runId === active.id,
          scoredInThisTask: recordScoredInTask(db, active, item),
          ...(read?.reader
            ? {
                savedListing: {
                  snapshotId: read.id,
                  totalCharacters: read.text.length,
                  readBy: readerLabel(read.reader),
                },
              }
            : {}),
        };
      })
    : null;
  const savedPage = assignedRecord ? db.browserEvidence.latest(active, assignedRecord.url) : null;
  // Answers the user gave for other records, one entry per answered field,
  // newest first. Every short answer is kept so no general fact falls out of
  // view; long free texts are mostly about one listing, so only a few stay.
  const earlierAnswers = [];
  if (assignedRecord && ['prepare', 'execute'].includes(active.recordOperation)) {
    const seen = new Set();
    let longAnswers = 0;
    for (const q of (a.questions ?? [])
      .filter(
        (q) =>
          q.answer != null &&
          q.recordId &&
          q.recordId !== assignedRecord.id &&
          !q.instruction &&
          // A cover letter belongs to its own employer.
          !q.coverLetter &&
          !q.accessCheck &&
          !q.outcome &&
          !q.resolution,
      )
      .sort((x, y) => y.answeredAt - x.answeredAt)) {
      const values = q.answerValues ?? {},
        answered = (q.fields ?? []).filter((f) => values[f.id] != null && values[f.id] !== '');
      const entries = answered.length
        ? answered.map((f) => ({
            question: f.label,
            answer: typeof values[f.id] === 'string' ? values[f.id] : JSON.stringify(values[f.id]),
          }))
        : [{question: q.text, answer: q.answer}];
      for (const {question, answer} of entries) {
        const key = question + '\n' + answer;
        if (seen.has(key)) continue;
        seen.add(key);
        if (answer.length > 200 && ++longAnswers > 3) continue;
        earlierAnswers.push({question: question.slice(0, 200), answer: answer.slice(0, 600)});
      }
    }
  }
  const source = active.sourceUrl ? db.sources(id).find((s) => s.url === active.sourceUrl) : null;
  const recipeInfo = source ? db.sourceRecipe(id, source.url) : null;
  const siteSearch = source ? (siteExtensionKind(source.url, a.templateId)?.search ?? null) : null;
  const assignedSource = source
    ? {
        ...(siteSearch
          ? {
              siteSearch,
              siteSearchGuidance:
                'The site extension knows this results address. Build url_template recipes from siteSearch.template; add only filters from siteSearch.filters as param=value. Your choices are the terms, the filter values and, where siteSearch.notes allow it, the path. The app keeps the sort parameters, pagination and ordering of siteSearch whatever the recipe says. Do not look for other parameters or sort controls on the site, and do not judge the ordering yourself.',
            }
          : {}),
        ...pick(source, [
          'url',
          'name',
          'query',
          'enabled',
          'mode',
          'intervalMinutes',
          'trial',
          'instructions',
          'skill',
          'recipe',
        ]),
        recipeStatus: recipeInfo.status,
        recipeReplay: recipeInfo.replay,
        ...(recipeInfo.replay
          ? {
              recipeGuidance:
                'A saved recipe reaches the results page for the current query. Start with recipeReplay.searches instead of discovering the board and run every search. If a search yields no listings, report the observed page; the app tracks recipe failures.',
            }
          : recipeInfo.status === 'stale'
            ? {
                recipeGuidance:
                  'The saved recipe failed repeatedly and is stale. Discover the results page yourself and save a corrected recipe with save_source_recipe.',
              }
            : {}),
        ...((recipeInfo.status === 'candidate' ||
          (active.kind === 'trial' && recipeInfo.status !== 'verified')) &&
        recipeInfo.recipe?.notes
          ? {
              recipeNotesUnverified: true,
              recipeNotesGuidance:
                'recipe.notes come from an earlier trial and are unverified. Check each claim on the page before repeating it, especially claims that a control or ordering does not exist.',
            }
          : {}),
      }
    : null;
  const questions = (a.questions ?? [])
    .filter((q) => {
      if (interview)
        return (
          !q.recordId && (conversation ? Boolean(q.conversation) || !q.sourceUrl : !q.conversation)
        );
      if (q.conversation) return false;
      if (q.recordId) return taskHasRecord(active, q.recordId);
      const scope = db.questionScope(id, q);
      return !scope.sourceUrl || scope.sourceUrl === active.sourceUrl;
    })
    .map(questionContext);
  let remaining = 30000;
  const messages = [];
  if (interview)
    for (const m of db.messages(id).reverse()) {
      if (m.text.length > remaining) break;
      messages.unshift(m);
      remaining -= m.text.length;
    }
  const results = interview
    ? db
        .results(id)
        .slice(0, 10)
        .map((r) => pick(r, ['id', 'url', 'title', 'status', 'trial']))
    : [];
  let operation =
    active.kind === 'run' && active.operation && findOperation(definition, active.operation)
      ? operationFor(definition, active.operation)
      : null;
  if (active.collector)
    operation = {
      ...operation,
      instructions: 'Follow scanInstructions.',
      successCriteria:
        'Every API page has been read and every queued listing reviewed by Jev and the agent.',
    };
  if (batch)
    operation = {
      ...operation,
      instructions:
        'Batch scoring: skip assignedRecords with scoredInThisTask=true. Score every remaining record with the current criteria.ranking and scoringPolicy, reading each listing or its Jev brief. Save record_automation_score with its itemId; use score=null for inaccessible listings. Ask missing facts with the relevant recordId and continue the other records. Use a separate read-only tab; do not alter proposals, fill or submit forms. Finish only after every assigned record has a saved score or a record-scoped question.',
      successCriteria:
        'Every assigned record has an assessment saved in this task or a record-scoped question.',
    };
  return {
    automation: {
      ...pick(a, [
        'id',
        'templateId',
        'title',
        'goal',
        'criteria',
        'instructions',
        'facts',
        'status',
        'revision',
        'reviewedRevision',
        'table',
      ]),
      mode: active.kind === 'trial' ? 'observe' : sourceMode(a, active.sourceUrl),
      sources: active.sources ?? a.sources,
      // Setup often saves the same text as goal and preferences; send it once.
      ...(a.criteria?.preferences && a.criteria.preferences.trim() === a.goal?.trim()
        ? {criteria: {...a.criteria, preferences: 'Same as automation.goal.'}}
        : {}),
    },
    assignedSource,
    assignedRecord,
    ...(batch ? {assignedRecords} : {}),
    assignedOperation: operation,
    ...(active.request?.changes
      ? {
          requestedChanges: {
            text: active.request.changes,
            rule: 'The user reviewed the saved proposal of assignedRecord and asked for these changes. Revise that proposal accordingly and save it in full; keep everything else that still applies.',
          },
        }
      : {}),
    ...(active.request?.applyAnyway
      ? {
          applyAnyway: {
            rule: 'The user chose to apply to assignedRecord although the listing or form states a requirement the saved facts do not meet. Do not stop for that requirement: answer every form question truthfully from the saved facts, even when the true answer may disqualify the user, and submit. Never answer untruthfully. A missing fact, login, code or CAPTCHA still blocks as usual.',
          },
        }
      : {}),
    ...(earlierAnswers.length
      ? {
          earlierAnswers: {
            answers: earlierAnswers,
            rule: 'Answers the user gave for other records, newest first. Reuse every general fact about the user (gender, permits, languages, start date, notice period, hours, salary, contact details, past employers) even when this form words the question or its options differently: pick the option with the same meaning. Prefer the newest answer. Do not carry over a decision about another record (such as applying despite a requirement) or a text written for another company.',
          },
        }
      : {}),
    ...(savedPage
      ? {
          savedListing: {
            snapshotId: savedPage.id,
            url: savedPage.url,
            observedAt: savedPage.at,
            totalCharacters: savedPage.text.length,
            ...(savedPage.reader ? {readBy: readerLabel(savedPage.reader)} : {}),
            instructions: savedPage.reader
              ? SITE_READER_LISTING
              : 'Use browser_read_part or browser_search to reuse this exact listing text for scoring. It is historical evidence; actions and availability require a current observation.',
          },
        }
      : {}),
    ...(assignedRecords?.some((r) => r.savedListing)
      ? {savedListings: {instructions: SITE_READER_LISTING}}
      : {}),
    ...(recordListingReads(active.id)?.failed.length
      ? {
          listingReadIssues: {
            listings: recordListingReads(active.id).failed,
            rule: 'The site reader could not read these listings before the task; read them in the browser.',
          },
        }
      : {}),
    ...(definition.recordOperations?.score ? {scoringPolicy: scoringPolicy(saved)} : {}),
    jevTasks: jevContextTasks(
      db.jevTasks.list(id, active.taskId ?? active.id),
      active.scan?.work?.activeSearchId ?? 'default',
    ),
    jevGuidance: active.collector
      ? 'Use collect_source_page for fresh CLI evidence and Jev triage; resume only its returned Jev task IDs for review. Final scoring belongs to the agent.'
      : 'Resume saved pending details with browser_run_task collect_details before any new search; use scan_results for discovery. jevTasks lists the RAM-only helper tasks of this task; assessmentRefreshRequired means resume that task first. Final assessments and source completion remain yours.',
    sourceExamples:
      !active.recordId && active.sourceUrl
        ? db
            .results(id)
            .filter((r) => r.sourceUrl === active.sourceUrl)
            .slice(0, 3)
            .map((r) => pick(r, ['url', 'title', 'status']))
        : [],
    template: interview
      ? templateContext(definition)
      : {
          ...pick(definition, ['id', 'version', 'title', 'guidance', 'records', 'table']),
          recordOperations: active.recordOperation ? {[active.recordOperation]: operation} : {},
          workflow: operation ? [operation.id] : [],
        },
    questions,
    messages,
    results,
    ...(conversation
      ? {
          conversation: {
            independent: true,
            profileChanges: 'draft',
            draftPending: Boolean(draft),
            instructions:
              'Answer the user’s current request. Other workers continue their assigned tasks. Do not restart onboarding, stop workers or change their instructions. save_automation_plan saves a proposed profile for review; it does not apply it or alter running work. Explain when a change is a draft. Only ask questions needed for the current request.',
          },
        }
      : {}),
    scanProgress: scanProgressView(active),
    ...(active.kind === 'run' && active.sourceUrl && !active.recordId
      ? {scanWork: scanWorkSummary(active)}
      : {}),
    ...(active.scanPlan
      ? {
          scanPlan: scanPlanView(active.scanPlan),
          scanInstructions: active.collector ? COLLECTOR_INSTRUCTIONS : SOURCE_SCAN_INSTRUCTIONS,
        }
      : {}),
    ...(active.collector
      ? {collector: {id: active.collector, progress: collectorProgress(active)}}
      : {}),
    currentRun: contextRun(active),
    ...(['site_access_response', 'site_access_retry'].includes(active.continuation?.reason)
      ? {
          sourceRecovery: {
            response: active.continuation.response,
            instructions:
              (active.continuation.reason === 'site_access_retry'
                ? 'The scheduled access wait expired.'
                : 'The user responded to this source access intervention.') +
              ' Resume its retained tab and pending work. Verify the current page normally; if access is still blocked, release the source again.',
          },
        }
      : {}),
    ...(active.freshSource
      ? {
          sourceRecovery: {
            instructions:
              'The previous access intervention expired or was dismissed. Its tabs were closed. Start a new scan at the assigned source entry; do not revive old helper IDs, pending URLs or browser history. Saved results remain available for duplicate checks.',
          },
        }
      : {}),
    previousRuns: active.freshSource
      ? []
      : db
          .runs(id)
          .filter(
            (r) =>
              r.id !== active.id &&
              r.kind === active.kind &&
              (r.recordId ?? null) === (active.recordId ?? null) &&
              (!active.sourceUrl || r.sourceUrl === active.sourceUrl),
          )
          .slice(0, 1)
          .map(previousRunContext),
    recordAuthorization: active.recordOperation
      ? {
          operation: active.recordOperation,
          explicitUserRequest: active.request?.manual === true,
          // Every execute applies the record directly; there is no draft digest.
          directExecution: active.recordOperation === 'execute',
          ...(batch ? {recordIds: active.recordIds} : {}),
          rule: batch
            ? 'Score only assignedRecords. Save each individual assessment with record_automation_score(itemId, score). Finish after all assigned records are handled. Do not change proposals or submit.'
            : active.recordOperation === 'score'
              ? 'Score only the assigned listing using the current criteria.ranking and saved profile/documents. Save with record_automation_score. Do not change proposals or submit.'
              : active.recordOperation === 'execute'
                ? directRecordInstructions
                : active.recordOperation === 'cover_letter'
                  ? 'Write one cover letter for the assigned record and save it with save_cover_letter. Do not fill forms, upload or submit; the user reviews the letter.'
                  : 'prepare: no external submission; verify: inspect prior outcome without resubmitting. This request authorizes only this record, without changing workspace or source permissions.',
        }
      : null,
    contextScope: {
      recordId: assignedRecord?.id ?? null,
      ...(batch ? {recordIds: active.recordIds} : {}),
      sourceUrl: active.sourceUrl ?? null,
      note: 'This is the complete task context. Other saved records and audit history are omitted. Use get_automation_result for a specific full record or get_workspace_records for an explicit table query. Do not read unrelated records or reread unchanged context.',
    },
    documentsDirectory: 'documents/',
    runtime: {
      local: true,
      appMustStayOpen: true,
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      now: new Date(db.now?.() ?? Date.now()).toISOString(),
    },
  };
}
