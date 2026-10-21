// @ts-check
import {automaticAssessmentError} from '../../../src/scoring-state.js';
import {taskRecordIds, taskHasRecord} from '../../records/task-scope.mjs';
import {validateNotSubmitted} from '../../records/outcome.mjs';
import {
  pendingRecordQuestion,
  recordSource,
  savedBeforeAutoApply,
} from '../../records/operations.mjs';
import {recordAssessment, assessmentCells} from '../../scoring/record-scoring.mjs';
import {saveScoreThreshold, autoApplyThreshold} from '../../scoring/thresholds.mjs';
import {activeRecordSql, foundRecordSql, foundRunSql} from '../../records/identity.mjs';
import {observedRecordAliases} from '../../records/aliases.mjs';
import {collectorRun} from '../../sources/collectors.mjs';
import {activeSearch, countScan} from '../../sources/scan-work.mjs';
import {collectorFindingInput} from '../../sources/collector-worker.mjs';
import {findOperation, operationFor} from '../../templates/contract.mjs';
import {randomUUID, createHash} from 'node:crypto';
import {boundedText, webUrl} from '../../templates/catalog.mjs';
import {sameSite} from '../../browser/site-access.mjs';
import {recordUrlKey} from '../../records/identity.mjs';
import {keepListingDescription} from '../../records/description.mjs';
import {keepListingContacts} from '../contacts.mjs';

// The same listing reached through a redirect to another host of the same
// site (de.example.com -> www.example.com, trailing slash) is still that page.
function samePage(a, b) {
  const x = recordUrlKey(a),
    y = recordUrlKey(b);
  if (!x || !y) return false;
  if (x === y) return true;
  const u = new URL(x),
    v = new URL(y);
  return sameSite(x, y) && u.pathname === v.pathname && u.search === v.search;
}
import {automationCells} from '../../templates/catalog.mjs';
import {sourceMode} from '../../sources/automation-sources.mjs';
// AutomationStore methods: records: lookup, saving findings, review, reservation and outcomes.
export const recordMethods = {
  results(id) {
    this.assertExists(id);
    return this.store.workspaces.records.list(id, {limit: -1});
  },
  runFoundCounts(id) {
    this.assertExists(id);
    // Count the full table, including records outside the recent-results window.
    return new Map(
      this.db
        .prepare(
          `SELECT ${foundRunSql} AS runId,count(*) AS foundCount
   FROM workspace_records WHERE workspace_id=? AND ${foundRecordSql} GROUP BY runId`,
        )
        .all(id)
        .map((row) => [row.runId, row.foundCount]),
    );
  },
  resultCounts(id) {
    this.assertExists(id);
    return this.db
      .prepare(
        `SELECT count(*) AS storedCount,
  count(CASE WHEN NOT json_extract(data,'$.trial') THEN 1 END) AS resultCount,
  count(CASE WHEN NOT json_extract(data,'$.trial') AND json_extract(data,'$.status')='prepared' AND NOT coalesce(json_extract(data,'$.approvedDigest')=json_extract(data,'$.digest'),0) THEN 1 END) AS pendingCount,
  count(CASE WHEN NOT json_extract(data,'$.trial') AND json_extract(data,'$.status')='completed' THEN 1 END) AS completedCount,
  count(CASE WHEN NOT json_extract(data,'$.trial') AND json_extract(data,'$.status')='uncertain' THEN 1 END) AS uncertainCount
  FROM workspace_records WHERE workspace_id=? AND ${activeRecordSql}`,
      )
      .get(id);
  },
  result(id, itemId) {
    this.assertExists(id);
    const item = this.store.workspaces.records.identities.resolve(id, itemId);
    if (!item) throw Error('The result does not belong to this automation');
    return item;
  },
  putResult(item, {run = undefined} = {}) {
    return this.store.workspaces.tasks.atomic(() => {
      const previous = this.store.workspaces.records.find(item.automationId, item.key),
        saved = this.store.workspaces.records.put(item.automationId, item.key, item);
      if (run) {
        if (run.automationId !== item.automationId)
          throw Error('The run does not belong to this automation');
        this.putRun(run);
      }
      if (!previous) this.event(item.automationId, 'job_found', {id: saved.id});
      else if (JSON.stringify(previous) !== JSON.stringify(saved))
        this.event(
          item.automationId,
          previous.status !== item.status && item.status === 'completed'
            ? 'submission_recorded'
            : 'record_updated',
          {id: saved.id},
        );
      return saved;
    });
  },
  configureTable(id, input) {
    this.get(id);
    this.store.workspaces.configureTable(id, input);
    return this.get(id);
  },
  setSaveScoreThreshold(id, value, {expectedValue = undefined} = {}) {
    return this.store.workspaces.tasks.atomic(() => {
      if (value != null && !['string', 'number'].includes(typeof value))
        throw Error('Minimum record score: a whole number between 0 and 100 is required.');
      const a = this.get(id),
        threshold = saveScoreThreshold({save_score_threshold: value}),
        next = threshold === null ? '' : String(threshold),
        current = String(a.criteria.save_score_threshold ?? '');
      if (expectedValue !== undefined && String(expectedValue ?? '') !== current)
        throw Error('The minimum record score changed. Review the current value and save again.');
      if (next === current) return a;
      const updated = {
        ...a,
        criteria: {...a.criteria, save_score_threshold: next},
        updatedAt: this.now(),
      };
      // A pending profile or conversation draft must not undo this newer choice.
      for (const key of ['planDraft', 'profileUpdate'])
        if (updated[key]?.plan)
          updated[key] = {
            ...updated[key],
            plan: {
              ...updated[key].plan,
              criteria: {...a.criteria, ...updated[key].plan.criteria, save_score_threshold: next},
            },
          };
      // This is a write-time filter, not a new scoring rubric or worker assignment.
      const saved = this.put(updated);
      this.event(id, 'save_score_threshold_changed', {value: threshold});
      return saved;
    });
  },
  rename(id, title) {
    // A title change does not affect a running round, so it is allowed mid-run.
    return this.put({...this.get(id), title: boundedText(title, 'Name', 150)});
  },
  updateCells(id, itemId, input) {
    return this.store.workspaces.updateCells(id, itemId, input);
  },
  record(id, runId, input) {
    return this.store.workspaces.tasks.atomic(() => this.recordAtomic(id, runId, input));
  },
  recordAtomic(id, runId, input) {
    const run = this.activeRun(id, runId),
      research = run.kind === 'interview';
    if (collectorRun(this.get(id), run)) input = collectorFindingInput(this, run, input);
    if (run.recordOperation === 'score')
      throw Error('Save the scoring result with record_automation_score');
    const observedUrl = webUrl(input.url),
      inputKey = boundedText(input.key ?? observedUrl, 'Result key', 2000);
    let url = observedUrl,
      key = this.template(this.get(id).templateId).records.identity === 'url' ? url : inputKey;
    let previous = this.store.workspaces.records.find(id, key),
      actionUrl = previous?.actionUrl;
    const records = this.store.workspaces.records,
      urlIdentity = records.usesUrl(id),
      aliases = urlIdentity && !run.recordId ? observedRecordAliases(this, id, run, url) : [];
    if (urlIdentity && !run.recordId) {
      const matches = [
        ...new Set(
          [previous?.id, ...aliases.map((alias) => records.find(id, alias)?.id)].filter(Boolean),
        ),
      ];
      if (matches.length > 1)
        previous = records.identities.merge(id, matches, {reason: 'observed_canonical'});
      else if (matches.length) previous = records.get(id, matches[0]);
      if (previous) {
        key = previous.key;
        url = previous.url;
        actionUrl = previous.actionUrl;
        const urlAliases = [...new Set([...(previous.urlAliases ?? []), ...aliases])].filter(
          (alias) => alias !== previous.url,
        );
        if (JSON.stringify(urlAliases) !== JSON.stringify(previous.urlAliases ?? []))
          previous = records.put(id, key, {...previous, urlAliases});
      }
    }
    if (run.recordId) {
      // A redirect to an application/booking form does not create a new record.
      // The durable assignment owns identity; URLs only describe its destination.
      const assigned = this.result(id, run.recordId),
        keyRecord = this.store.workspaces.records.find(id, inputKey);
      if (
        (input.recordId && input.recordId !== assigned.id) ||
        (previous && previous.id !== assigned.id) ||
        (keyRecord && keyRecord.id !== assigned.id)
      )
        throw Error('The record does not belong to this task');
      if (inputKey !== assigned.key && inputKey !== observedUrl)
        throw Error('Use the existing key of the assigned record');
      previous = assigned;
      key = assigned.key;
      url = assigned.url;
      actionUrl = assigned.actionUrl;
      const destination = input.actionUrl
        ? webUrl(input.actionUrl)
        : observedUrl !== url
          ? observedUrl
          : actionUrl;
      const destinationRecord = destination && this.store.workspaces.records.find(id, destination);
      if (destinationRecord && destinationRecord.id !== assigned.id)
        throw Error('The record does not belong to this task');
      if (
        destination &&
        destination !== url &&
        destination !== actionUrl &&
        !run.observations.some((o) => o.url === destination && o.evidence?.trim())
      )
        throw Error('Observe the action address in the browser in this task first');
      actionUrl = destination === url ? undefined : destination;
    } else if (input.recordId || input.actionUrl)
      throw Error('A record ID and action address are only allowed in an assigned record task');
    if (research) {
      if (input.proposal?.trim())
        throw Error('Setup can only save a research sample; it cannot create an action draft');
      if (!run.observations.some((o) => o.url === url && o.evidence.trim()))
        throw Error('Observe the research sample’s detail page in this round first');
    }
    if (run.recordId && run.recordId !== previous?.id)
      throw Error('The record does not belong to this task');
    // Neither setup nor trial samples may demote live records or clear approvals.
    if (run.kind !== 'run' && previous && !previous.trial) return {...previous, duplicate: true};
    if (previous && ['completed', 'uncertain', 'executing', 'dismissed'].includes(previous.status))
      return {...previous, duplicate: true};
    if (
      previous &&
      !run.recordId &&
      this.store.workspaces.tasks
        .list(id, {states: ['running', 'reported', 'paused']})
        .some((t) => taskHasRecord(t, previous.id))
    )
      return {...previous, duplicate: true};
    const title = boundedText(input.title, 'Title', 300),
      summary = boundedText(input.summary, 'Summary', 6000),
      proposal = boundedText(input.proposal ?? previous?.proposal ?? '', 'Action draft', 12000, {
        empty: true,
      });
    const digest = createHash('sha256')
      .update(JSON.stringify(actionUrl ? [url, proposal, actionUrl] : [url, proposal]))
      .digest('hex');
    if (
      input.proposal !== undefined &&
      (input.proposal.trim() || previous?.proposal) &&
      run.operation &&
      findOperation(this.template(this.get(id).templateId), run.operation) &&
      operationFor(this.template(this.get(id).templateId), run.operation).effect === 'read'
    )
      throw Error('This step can only observe and assess');
    const cells = input.cells === undefined ? {} : automationCells(input.cells, this.get(id).table);
    const scoring = this.template(this.get(id).templateId).recordOperations?.score;
    if (
      scoring &&
      run.kind === 'run' &&
      run.sourceUrl &&
      !run.recordId &&
      (!previous || previous.trial) &&
      !input.assessment
    )
      throw Error('Score a new listing before saving it and send the score field in the save call');
    if (input.assessment && (run.kind !== 'run' || !scoring))
      throw Error('A fit score cannot be saved in this task');
    const assessment = input.assessment
      ? recordAssessment(this, id, run, input.assessment, url)
      : previous?.assessment;
    const saveThreshold = saveScoreThreshold(this.get(id).criteria);
    if (
      run.kind === 'run' &&
      run.sourceUrl &&
      !run.recordId &&
      !previous &&
      saveThreshold !== null &&
      assessment?.status === 'scored' &&
      assessment.score < saveThreshold
    ) {
      const message = `Score ${assessment.score}/100, minimum record score ${saveThreshold}; excluded without saving.`;
      this.rememberSeenListings(id, run.sourceUrl, [observedUrl, url, ...aliases], message);
      const counted = this.countScanRecord(id, runId, 'belowThreshold');
      if (counted) this.putRun(counted);
      return {
        saved: false,
        skipped: true,
        reason: 'below_save_threshold',
        key,
        url,
        score: assessment.score,
        saveThreshold,
        message,
      };
    }
    const initial = this.template(this.get(id).templateId).records.initial;
    const item = {
      ...previous,
      ...(urlIdentity && aliases.some((alias) => alias !== url)
        ? {
            urlAliases: [...new Set([...(previous?.urlAliases ?? []), ...aliases])].filter(
              (alias) => alias !== url,
            ),
          }
        : {}),
      ...(!previous?.workflowState && initial && initial !== 'found'
        ? {workflowState: initial}
        : {}),
      id: previous?.id ?? randomUUID(),
      automationId: id,
      key,
      url,
      ...(actionUrl || previous?.actionUrl ? {actionUrl} : {}),
      title,
      summary,
      proposal,
      digest,
      status: proposal ? 'prepared' : 'found',
      approvedDigest: previous?.digest === digest ? previous.approvedDigest : null,
      createdAt: previous?.createdAt ?? this.now(),
      updatedAt: this.now(),
      runId,
      revision:
        proposal && input.proposal === undefined && previous ? previous.revision : run.revision,
      trial: run.kind !== 'run',
      sampleKind: research ? 'interview' : null,
      cells: {...previous?.cells, ...cells},
      starred: previous?.starred ?? false,
    };
    if (
      run.recordOperation === 'execute' &&
      run.request?.manual &&
      run.request.direct !== true &&
      digest !== run.request.digest
    )
      item.requiresReview = true;
    // Rediscovery and later record operations must retain the original scan's credit.
    if (run.kind === 'run')
      item.discoveredRunId =
        previous && !previous.trial ? (previous.discoveredRunId ?? previous.runId ?? runId) : runId;
    if (run.sourceUrl) item.sourceUrl = run.sourceUrl;
    if (run.collector) item.collectedBy = run.collector;
    if (assessment) {
      item.assessment = assessment;
      item.cells = assessmentCells(this.get(id).table, item.cells, assessment);
    }
    const saved = this.putResult(item, {
      run: previous && !previous.trial ? undefined : this.countScanRecord(id, runId, 'saved'),
    });
    keepListingDescription(this, id, run, saved.id, observedUrl);
    if (!previous) keepListingContacts(this, id, run, saved.id, observedUrl);
    return saved;
  },
  // A source scan counts its saved and below-threshold findings for the source row.
  countScanRecord(id, runId, key) {
    const run = this.activeRun(id, runId);
    if (run.kind !== 'run' || !run.sourceUrl || run.recordId || !run.scan?.work?.counted)
      return undefined;
    const work = structuredClone(run.scan.work);
    countScan(activeSearch(work) ?? work.searches[0], key);
    return {...run, scan: {...run.scan, work}};
  },
  assertRecordIdle(id, itemId) {
    const resolved = this.result(id, itemId).id;
    if (
      this.store.workspaces.tasks
        .list(id, {states: ['pending', 'running', 'reported', 'paused']})
        .some((t) => taskRecordIds(t).some((recordId) => this.result(id, recordId).id === resolved))
    )
      throw Error('An action for this record is queued or running');
  },
  // The user confirms outside the app (confirmation mail, portal) that this
  // record was submitted; the app records that without a browser run.
  markSubmitted(id, itemId) {
    return this.store.workspaces.tasks.atomic(() => {
      const item = this.result(id, itemId);
      if (item.trial || !['found', 'prepared', 'uncertain', 'executing'].includes(item.status))
        throw Error('This record cannot be marked as submitted');
      this.assertRecordIdle(id, itemId);
      const at = this.now(),
        a = this.get(id);
      const saved = this.putResult({
        ...item,
        status: 'completed',
        approvedDigest: null,
        evidence: 'The user confirmed the record was submitted.',
        verifiedAt: at,
        updatedAt: at,
      });
      this.put({
        ...a,
        questions: (a.questions ?? []).map((q) =>
          q.recordId === item.id && q.answer == null
            ? {
                ...q,
                answer: 'The user marked the record as submitted.',
                answeredAt: at,
                resolution: 'record_completed',
              }
            : q,
        ),
      });
      this.event(id, 'record_completed', {itemId: item.id, by: 'user'});
      return saved;
    });
  },
  star(id, itemId, starred) {
    if (typeof starred !== 'boolean') throw Error('Invalid star state');
    const item = this.result(id, itemId);
    return this.putResult({...item, starred});
  },
  approve(id, itemId) {
    this.assertRecordIdle(id, itemId);
    const a = this.get(id),
      item = this.result(id, itemId);
    if (
      !['prepared'].includes(item.status) ||
      !item.proposal ||
      item.trial ||
      item.revision !== a.revision
    )
      throw Error('An action draft from a current run result is required');
    return this.putResult({...item, approvedDigest: item.digest});
  },
  dismiss(id, itemId, {stopActive = false} = {}) {
    return this.store.workspaces.tasks.atomic(() => {
      const item = this.result(id, itemId);
      if (['executing', 'completed'].includes(item.status))
        throw Error('Action history cannot be changed');
      if (!stopActive) this.assertRecordIdle(id, item.id);
      // An uncertain record may already be submitted; the skip remembers that
      // so Restore brings it back as uncertain, never as a fresh record.
      return this.excludeRecord(id, item, {
        summary: 'The user rejected this record. Do not continue working on it.',
        resolution: 'record_dismissed',
        event: 'record_dismissed',
        extra: item.status === 'uncertain' ? {skippedFrom: 'uncertain'} : {},
      });
    });
  },
  // The user takes back a skip: the record returns to the found list and can
  // be applied again, or to uncertain when it was skipped there. Questions
  // closed by the skip stay closed.
  restore(id, itemId) {
    return this.store.workspaces.tasks.atomic(() => {
      const item = this.result(id, itemId);
      if (item.status !== 'dismissed' || item.trial)
        throw Error('Only a skipped record can be restored');
      this.assertRecordIdle(id, item.id);
      const {closed, skippedFrom, ...rest} = item;
      const saved = this.putResult({
        ...rest,
        status: skippedFrom ?? 'found',
        updatedAt: this.now(),
      });
      this.event(id, 'record_restored', {itemId: item.id});
      return saved;
    });
  },
  // An execute run found the record's destination itself saying it is gone
  // (removed, expired, not found). The quote must be on the observed page and
  // nothing may have been reserved; the record leaves every queue like a
  // dismissal and keeps the evidence.
  // closed: the record page says the listing is gone. applied: it says the
  // user already applied, so the record is complete without a new submission.
  closeRecord(id, runId, itemId, {status = 'closed', evidence, url}, page) {
    return this.store.workspaces.tasks.atomic(() => {
      const run = this.activeRun(id, runId),
        item = this.result(id, itemId);
      if (run.recordOperation !== 'execute' || run.recordId !== item.id)
        throw Error(`${status} is only allowed in the execute task of the assigned record.`);
      if (!['found', 'prepared'].includes(item.status) || run.actionId)
        throw Error(
          `A submission was already started, so the record cannot be marked ${status}. Record uncertain.`,
        );
      const proofUrl = webUrl(url);
      if (!page || !samePage(page.url, proofUrl))
        throw Error('First observe the record page in the browser during this task.');
      const quote = boundedText(evidence, 'Page evidence', 600),
        // Letters and digits only: page lines joined with dashes, colons or
        // line breaks are still the same page text.
        words = (text) =>
          String(text ?? '')
            .toLowerCase()
            .replace(/[^\p{L}\p{N}]+/gu, ' ')
            .trim();
      let text = page.text;
      try {
        text = JSON.parse(page.text.slice(page.text.indexOf('{'))).text ?? page.text;
      } catch {}
      const pageWords = ` ${words(text)} `,
        onPage = (part) => !!words(part) && pageWords.includes(` ${words(part)} `),
        // Evidence may describe the page around quoted parts; then every
        // quoted part must be on the page.
        quoted = [...quote.matchAll(/["“”„«»]([^"“”„«»]+)["“”„«»]/g)].map((m) => m[1]),
        verified =
          (words(quote).length >= 8 && onPage(quote)) ||
          (quoted.some((part) => words(part).length >= 8) && quoted.every(onPage));
      if (!verified)
        throw Error(
          `The quote is not in the current page text. Send only the page text that says ${status === 'applied' ? 'you already applied' : 'the listing is gone'}, copied word for word, or put each copied page part in double quotes.`,
        );
      if (status === 'applied')
        return this.putResult({
          ...item,
          status: 'completed',
          evidence: quote,
          proofUrl,
          verifiedAt: this.now(),
          alreadyApplied: {at: this.now(), url: proofUrl, evidence: quote, runId},
        });
      return this.excludeRecord(id, item, {
        summary: 'The record is no longer available at its source: ' + quote,
        resolution: 'record_closed',
        event: 'record_closed',
        extra: {closed: {at: this.now(), url: proofUrl, evidence: quote, runId}},
      });
    });
  },
  excludeRecord(id, item, {summary, resolution, event, extra = {}}) {
    const itemId = item.id,
      a = this.get(id),
      at = this.now(),
      queue = this.store.workspaces.tasks;
    // Persist exclusion before closing a worker; late proposals and reservations
    // cannot revive the record, and other records keep their own tasks/questions.
    const saved = this.putResult({
      ...item,
      ...extra,
      status: 'dismissed',
      approvedDigest: null,
      updatedAt: at,
    });
    this.put({
      ...a,
      questions: (a.questions ?? []).map((q) =>
        q.recordId === itemId && q.answer == null
          ? {...q, answer: summary, answerValues: null, answeredAt: at, resolution}
          : q,
      ),
    });
    for (const task of queue.list(id).filter((t) => taskHasRecord(t, itemId))) {
      if (task.resumeRecordAfterAnswer) queue.put({...task, resumeRecordAfterAnswer: false});
      if (task.state === 'pending') queue.finish(id, task.id, 'cancelled', summary);
    }
    this.event(id, event, {itemId});
    return saved;
  },
  reserve(id, runId, itemId) {
    const run = this.activeRun(id, runId),
      a = this.get(id),
      item = this.result(id, itemId),
      source = run.sourceUrl ?? recordSource(a, item),
      mode = source ? sourceMode(a, source) : 'observe';
    if (
      run.operation &&
      findOperation(this.template(a.templateId), run.operation) &&
      operationFor(this.template(a.templateId), run.operation).effect !== 'write'
    )
      throw Error('This task step cannot submit');
    if (run.recordId && run.recordId !== itemId)
      throw Error('The record does not belong to this task');
    // A repeated reserve in the same run (after a late field fix) keeps the reservation.
    if (run.actionId === item.id && item.status === 'executing' && item.attemptRunId === runId)
      return {
        reserved: true,
        alreadyReserved: true,
        itemId: item.id,
        proposal: item.proposal,
        url: item.actionUrl ?? item.url,
      };
    // No draft approval: the user's execute request is the authority. Automatic
    // runs still need an eligible score and an auto-mode source.
    const explicit = run.recordOperation === 'execute' && run.request?.manual === true;
    if (run.kind !== 'run' || (mode === 'observe' && !explicit))
      throw Error('This run can only observe');
    if (!explicit) {
      if (mode !== 'auto') throw Error('Applying requires a user request');
      if (!item.assessment) throw Error('Score first before applying automatically');
      if (savedBeforeAutoApply(a, item))
        throw Error('Saved before Find and apply was turned on; apply it yourself');
      const error = automaticAssessmentError(item.assessment, autoApplyThreshold(a.criteria));
      if (error) throw Error(error);
    }
    if (item.trial || !['found', 'prepared'].includes(item.status))
      throw Error('This record is not in a sendable state');
    if (run.actionId) throw Error('Verify the result of the current action first');
    if (pendingRecordQuestion(a, item))
      throw Error('Answer the pending questions for this action first');
    // Both reservation and attempted state are durable before any browser write.
    this.putResult(
      {
        ...item,
        status: 'executing',
        attemptedAt: this.now(),
        attemptRunId: runId,
        approvedDigest: null,
      },
      {run: {...run, actionId: item.id}},
    );
    return {
      reserved: true,
      itemId: item.id,
      proposal: item.proposal,
      url: item.actionUrl ?? item.url,
    };
  },
  resolve(id, runId, itemId, {status, evidence, url, notSubmittedProof}, page) {
    const run = this.activeRun(id, runId),
      item = this.result(id, itemId);
    if (
      run.kind === 'run' &&
      ['completed', 'uncertain'].includes(status) &&
      ['found', 'prepared'].includes(item.status)
    )
      throw Error(
        'No submission was reserved for this record, so the app counts nothing as sent. A status a site shows without your own final submit click (for example Applied after a redirect to another site) is not a submission. If the page still offers a way to continue (a form, or a link to the site that takes the application), continue there and call reserve_automation_action right before the final submit click.',
      );
    if (
      run.kind !== 'run' ||
      !['completed', 'uncertain', 'not_submitted'].includes(status) ||
      !['executing', 'uncertain'].includes(item.status)
    )
      throw Error('No action to verify was found');
    if (item.status === 'executing' && run.actionId !== item.id)
      throw Error('The action does not belong to this run');
    if (run.recordId && run.recordId !== itemId)
      throw Error('The record does not belong to this task');
    const proofUrl = webUrl(url);
    if (!run.observations.some((o) => o.url === proofUrl && o.at >= (item.attemptedAt ?? 0)))
      throw Error(
        'Observe the result page in the browser first; url must be the current page address.',
      );
    if (status === 'not_submitted') {
      if (
        run.recordOperation !== 'verify' ||
        run.recordId !== item.id ||
        item.status !== 'uncertain' ||
        page?.url !== proofUrl
      )
        throw Error(
          'A not-submitted result can only be reported in an assigned record verification',
        );
      const proof = validateNotSubmitted(item, notSubmittedProof, page),
        at = this.now();
      return this.putResult(
        {
          ...item,
          status: item.proposal ? 'prepared' : 'found',
          approvedDigest: null,
          requiresReview: true,
          evidence: boundedText(evidence, 'Result evidence', 4000),
          proofUrl,
          verifiedAt: at,
          notSubmitted: {...proof, at, runId, attemptRunId: item.attemptRunId, digest: item.digest},
        },
        {run: {...run, verifiedNotSubmitted: item.id}},
      );
    }
    return this.putResult(
      {
        ...item,
        status,
        evidence: boundedText(evidence, 'Result evidence', 4000),
        proofUrl,
        verifiedAt: this.now(),
      },
      {run: run.actionId === itemId ? {...run, actionId: null} : undefined},
    );
  },
};
