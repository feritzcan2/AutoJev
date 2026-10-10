// @ts-check
import {automaticAssessmentError} from '../../../src/scoring-state.js';
import {taskRecordIds, taskHasRecord} from '../../records/task-scope.mjs';
import {validateNotSubmitted} from '../../records/outcome.mjs';
import {pendingRecordQuestion, recordSource} from '../../records/operations.mjs';
import {recordAssessment, assessmentCells} from '../../scoring/record-scoring.mjs';
import {saveScoreThreshold} from '../../scoring/thresholds.mjs';
import {activeRecordSql} from '../../records/identity.mjs';
import {observedRecordAliases} from '../../records/aliases.mjs';
import {collectorRun} from '../../sources/collectors.mjs';
import {collectorFindingInput} from '../../sources/collector-worker.mjs';
import {findOperation, operationFor} from '../../templates/contract.mjs';
import {randomUUID, createHash} from 'node:crypto';
import {boundedText, webUrl} from '../../templates/catalog.mjs';
import {automationCells} from '../../templates/catalog.mjs';
import {sourceMode} from '../../sources/automation-sources.mjs';
// AutomationStore methods: records: lookup, saving findings, review, reservation and outcomes.
export const recordMethods = {
  results(id, {all = false} = {}) {
    this.get(id);
    return this.store.workspaces.records.list(id, {limit: all ? -1 : 500});
  },
  runFoundCounts(id) {
    this.get(id);
    // Count the full table, including records outside the recent-results window.
    return new Map(
      this.db
        .prepare(
          `SELECT coalesce(json_extract(data,'$.discoveredRunId'),json_extract(data,'$.runId')) AS runId,count(*) AS foundCount
   FROM workspace_records WHERE workspace_id=? AND ${activeRecordSql} AND NOT coalesce(json_extract(data,'$.trial'),0) GROUP BY runId`,
        )
        .all(id)
        .map((row) => [row.runId, row.foundCount]),
    );
  },
  resultCounts(id) {
    this.get(id);
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
    this.get(id);
    const item = this.store.workspaces.records.identities.resolve(id, itemId);
    if (!item) throw Error('Sonuç bu otomasyona ait değil');
    return item;
  },
  putResult(item, {run = undefined} = {}) {
    return this.store.workspaces.tasks.atomic(() => {
      const previous = this.store.workspaces.records.find(item.automationId, item.key),
        saved = this.store.workspaces.records.put(item.automationId, item.key, item);
      if (run) {
        if (run.automationId !== item.automationId) throw Error('Çalışma bu otomasyona ait değil');
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
        throw Error('Minimum kayıt puanı: 0–100 arası tam sayı gerekli.');
      const a = this.get(id),
        threshold = saveScoreThreshold({save_score_threshold: value}),
        next = threshold === null ? '' : String(threshold),
        current = String(a.criteria.save_score_threshold ?? '');
      if (expectedValue !== undefined && String(expectedValue ?? '') !== current)
        throw Error('Minimum kayıt puanı değişti. Güncel değeri inceleyip yeniden kaydet.');
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
    this.assertIdle(id);
    return this.put({...this.get(id), title: boundedText(title, 'Ad', 150)});
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
      throw Error('Puanlama sonucunu record_automation_score ile kaydet');
    const observedUrl = webUrl(input.url),
      inputKey = boundedText(input.key ?? observedUrl, 'Sonuç anahtarı', 2000);
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
        throw Error('Kayıt bu göreve ait değil');
      if (inputKey !== assigned.key && inputKey !== observedUrl)
        throw Error('Atanmış kaydın mevcut key değerini kullan');
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
        throw Error('Kayıt bu göreve ait değil');
      if (
        destination &&
        destination !== url &&
        destination !== actionUrl &&
        !run.observations.some((o) => o.url === destination && o.evidence?.trim())
      )
        throw Error('İşlem adresini önce bu görevde tarayıcıda gözlemle');
      actionUrl = destination === url ? undefined : destination;
    } else if (input.recordId || input.actionUrl)
      throw Error('Kayıt ID ve işlem adresi yalnızca atanmış kayıt görevinde kullanılabilir');
    if (research) {
      if (input.proposal?.trim())
        throw Error(
          'Kurulumda yalnızca araştırma örneği kaydedilebilir; işlem taslağı oluşturulamaz',
        );
      if (!run.observations.some((o) => o.url === url && o.evidence.trim()))
        throw Error('Araştırma örneğinin detay sayfasını önce bu turda gözlemle');
    }
    if (run.recordId && run.recordId !== previous?.id) throw Error('Kayıt bu göreve ait değil');
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
    const title = boundedText(input.title, 'Başlık', 300),
      summary = boundedText(input.summary, 'Özet', 6000),
      proposal = boundedText(input.proposal ?? previous?.proposal ?? '', 'İşlem taslağı', 12000, {
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
      throw Error('Bu adım yalnızca gözlem ve değerlendirme yapabilir');
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
      throw Error('Yeni ilanı kaydetmeden önce puanla ve kayıt çağrısında score alanını gönder');
    if (input.assessment && (run.kind !== 'run' || !scoring))
      throw Error('Bu görevde uygunluk puanı kaydedilemez');
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
      const message = `Puan ${assessment.score}/100, minimum kayıt puanı ${saveThreshold}; kaydedilmeden elendi.`;
      this.rememberSeenListings(id, run.sourceUrl, [observedUrl, url, ...aliases], message);
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
    return this.putResult(item);
  },
  assertRecordIdle(id, itemId) {
    const resolved = this.result(id, itemId).id;
    if (
      this.store.workspaces.tasks
        .list(id, {states: ['pending', 'running', 'reported', 'paused']})
        .some((t) => taskRecordIds(t).some((recordId) => this.result(id, recordId).id === resolved))
    )
      throw Error('Bu kayıt için işlem sırada veya çalışıyor');
  },
  // The user confirms outside the app (confirmation mail, portal) that this
  // record was submitted; the app records that without a browser run.
  markSubmitted(id, itemId) {
    return this.store.workspaces.tasks.atomic(() => {
      const item = this.result(id, itemId);
      if (item.trial || !['found', 'prepared', 'uncertain', 'executing'].includes(item.status))
        throw Error('Bu kayıt gönderildi olarak işaretlenemez');
      this.assertRecordIdle(id, itemId);
      const at = this.now(),
        a = this.get(id);
      const saved = this.putResult({
        ...item,
        status: 'completed',
        approvedDigest: null,
        evidence: 'Kullanıcı kaydın gönderildiğini onayladı.',
        verifiedAt: at,
        updatedAt: at,
      });
      this.put({
        ...a,
        questions: (a.questions ?? []).map((q) =>
          q.recordId === item.id && q.answer == null
            ? {
                ...q,
                answer: 'Kullanıcı kaydı gönderildi olarak işaretledi.',
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
    if (typeof starred !== 'boolean') throw Error('Geçersiz yıldız durumu');
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
      throw Error('Güncel bir çalışma sonucundaki işlem taslağı gerekli');
    return this.putResult({...item, approvedDigest: item.digest});
  },
  dismiss(id, itemId, {stopActive = false} = {}) {
    return this.store.workspaces.tasks.atomic(() => {
      const item = this.result(id, itemId);
      itemId = item.id;
      if (['executing', 'completed', 'uncertain'].includes(item.status))
        throw Error('İşlem geçmişi değiştirilemez');
      if (!stopActive) this.assertRecordIdle(id, itemId);
      const summary = 'Kullanıcı bu kaydı eledi. Bu kayıt için işleme devam etme.',
        a = this.get(id),
        at = this.now(),
        queue = this.store.workspaces.tasks;
      // Persist exclusion before closing a worker; late proposals and reservations
      // cannot revive the record, and other records keep their own tasks/questions.
      const saved = this.putResult({
        ...item,
        status: 'dismissed',
        approvedDigest: null,
        updatedAt: at,
      });
      this.put({
        ...a,
        questions: (a.questions ?? []).map((q) =>
          q.recordId === itemId && q.answer == null
            ? {
                ...q,
                answer: summary,
                answerValues: null,
                answeredAt: at,
                resolution: 'record_dismissed',
              }
            : q,
        ),
      });
      for (const task of queue.list(id).filter((t) => taskHasRecord(t, itemId))) {
        if (task.resumeRecordAfterAnswer) queue.put({...task, resumeRecordAfterAnswer: false});
        if (task.state === 'pending') queue.finish(id, task.id, 'cancelled', summary);
      }
      this.event(id, 'record_dismissed', {itemId});
      return saved;
    });
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
      throw Error('Bu görev adımı gönderim yapamaz');
    if (run.recordId && run.recordId !== itemId) throw Error('Kayıt bu göreve ait değil');
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
      throw Error('Bu çalışma yalnızca gözlem yapabilir');
    if (!explicit) {
      if (mode !== 'auto') throw Error('Başvuru için kullanıcı isteği gerekli');
      if (!item.assessment) throw Error('Otomatik başvuru için önce puanla');
      const error = automaticAssessmentError(item.assessment, a.revision);
      if (error) throw Error(error);
    }
    if (item.trial || !['found', 'prepared'].includes(item.status))
      throw Error('Bu kayıt gönderilebilir durumda değil');
    if (run.actionId) throw Error('Önce mevcut işlemin sonucunu doğrula');
    if (pendingRecordQuestion(a, item)) throw Error('Önce bu işlem için bekleyen soruları yanıtla');
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
      run.kind !== 'run' ||
      !['completed', 'uncertain', 'not_submitted'].includes(status) ||
      !['executing', 'uncertain'].includes(item.status)
    )
      throw Error('Doğrulanabilecek işlem bulunamadı');
    if (item.status === 'executing' && run.actionId !== item.id)
      throw Error('İşlem bu çalışmaya ait değil');
    if (run.recordId && run.recordId !== itemId) throw Error('Kayıt bu göreve ait değil');
    const proofUrl = webUrl(url);
    if (!run.observations.some((o) => o.url === proofUrl && o.at >= (item.attemptedAt ?? 0)))
      throw Error('Önce sonuç adresindeki güncel durumu tarayıcıda gözlemle');
    if (status === 'not_submitted') {
      if (
        run.recordOperation !== 'verify' ||
        run.recordId !== item.id ||
        item.status !== 'uncertain' ||
        page?.url !== proofUrl
      )
        throw Error('Gönderilmedi sonucu yalnızca atanmış kayıt doğrulamasında bildirilebilir');
      const proof = validateNotSubmitted(item, notSubmittedProof, page),
        at = this.now();
      return this.putResult(
        {
          ...item,
          status: item.proposal ? 'prepared' : 'found',
          approvedDigest: null,
          requiresReview: true,
          evidence: boundedText(evidence, 'Sonuç kanıtı', 4000),
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
        evidence: boundedText(evidence, 'Sonuç kanıtı', 4000),
        proofUrl,
        verifiedAt: this.now(),
      },
      {run: run.actionId === itemId ? {...run, actionId: null} : undefined},
    );
  },
};
