// @ts-check
import {taskHasRecord} from '../records/task-scope.mjs';
import {validateWorkCompletion, hasUnblockedScanWork} from '../sources/scan-work.mjs';
import {scanCheckpoint} from '../sources/automation-scan.mjs';
import {sourceScan} from '../sources/scan-issues.mjs';
import {validateLoginQuestion, LOGGED_IN_FIELD} from './login-question.mjs';
import {OUTCOME_FIELD} from './question-forms.mjs';
import {sourceStop} from './stop.mjs';
import {holdForTechnicalRetry} from './recovery.mjs';

// finish_automation_run: check that the reported status is backed by the saved
// task state, ask the user what only they can answer, then report the run.
export function finishAutomationRun({
  db,
  id,
  run,
  active,
  automation,
  args,
  collecting,
  snapshot,
  report,
}) {
  const status = args.status;
  if (collecting && status === 'completed' && !active.scan?.complete)
    throw Error('CLI sayfaları ve Jev/agent incelemesi bitmedi; collect_source_page ile devam et.');
  if (
    sourceScan(active) &&
    args.stop?.kind === 'access' &&
    ['blocked', 'failed'].includes(status)
  ) {
    const sites = new Set(
      db.jevTasks.list(id, active.taskId ?? run.id).flatMap((t) =>
        t.items
          .filter((i) => i.error === 'access_barrier')
          .map((i) => i.blockedSite)
          .filter(Boolean),
      ),
    );
    if (active.siteWait) sites.add(active.siteWait.site);
    if (sites.size && hasUnblockedScanWork(active, sites))
      throw Object.assign(
        Error(
          'Erişim engeli yalnızca bildirilen sitelerde. Diğer sitelerde bekleyen ilanlar veya aramalar var; onları işle, engelli adresleri bekleyen kuyrukta bırak.',
        ),
        {code: 'JEV_WORK_REMAINS'},
      );
  }
  const stop =
    collecting && active.collectorError && ['failed', 'blocked'].includes(status)
      ? {kind: 'technical', evidence: active.collectorError, issueIds: []}
      : sourceStop(active, args);
  // A login form on the last observed page is an app-verified barrier: the
  // app asks the user itself instead of judging the agent's summary text.
  let loginAsked = false;
  if (
    ['blocked', 'failed'].includes(status) &&
    active.kind !== 'interview' &&
    snapshot &&
    !(automation.questions ?? []).some(
      (q) =>
        q.answer == null &&
        q.accessCheck?.kind === 'login' &&
        (active.recordId
          ? taskHasRecord(active, q.recordId)
          : !q.recordId && q.sourceUrl === active.sourceUrl),
    )
  ) {
    let accessCheck = null;
    try {
      accessCheck = validateLoginQuestion(snapshot, {
        kind: 'login',
        snapshotId: snapshot.id,
        evidence: stop?.evidence,
      });
    } catch {}
    if (accessCheck) {
      db.askQuestion(
        id,
        {
          text: args.summary,
          accessCheck: {...accessCheck, checkedAt: db.now()},
          fields: [LOGGED_IN_FIELD],
          ...(active.recordId ? {recordId: active.recordId} : {}),
        },
        {runId: run.id},
      );
      loginAsked = true;
    }
  }
  // A verify task that ends without portal proof has no next step for the
  // agent. The user knows the outcome; the app asks and applies it.
  if (
    ['blocked', 'failed'].includes(status) &&
    active.recordOperation === 'verify' &&
    active.recordId &&
    !loginAsked
  ) {
    const item = db.result(id, active.recordId);
    if (
      item.status === 'uncertain' &&
      !(automation.questions ?? []).some((q) => q.recordId === item.id && q.answer == null)
    )
      db.askQuestion(
        id,
        {
          text: `${item.title ?? item.url} için gönderim sonucu doğrulanamadı.\nAgent notu: ${String(args.summary ?? '').slice(0, 1500)}`,
          recordId: item.id,
          fields: [OUTCOME_FIELD],
          outcome: true,
        },
        {runId: run.id},
      );
  }
  if (
    status === 'completed' &&
    active.siteWait &&
    db.siteAccess.status('https://' + active.siteWait.site)
  )
    throw Error('Site için ortak bekleme sürüyor; bu turu blocked olarak bildir.');
  if (active.kind === 'trial' && !active.browserSteps)
    throw Error(
      'Bu denemede henüz kaynak kontrolü yapılmadı. Önce browser_open ile güncel erişimi kontrol et. Önceki denemenin engel raporu bu tur için kanıt değildir.',
    );
  if (status === 'completed' && active.kind === 'run' && active.sourceUrl && !active.recordId) {
    if (Object.keys(active.scanIssues ?? {}).length)
      throw Error(
        'Çözümlenmemiş sayfa sorunları var. Bu adresleri browser_open ile yeniden aç; yüklenmiyorsa failed bildir, uygulama sonra yeniden dener.',
      );
    const scan = scanCheckpoint(active, args.scan);
    if (!scan.complete && args.goalReached) throw Error('Eksik taramada hedefe ulaşıldı denemez');
    if (collecting) scan.reason = active.scan.reason;
    if (!scan.complete)
      throw Error(
        'Kaynak taraması bitmedi. Süre veya adım sınırı yok; aynı görevde kalan sayfaları işlemeye devam et ve complete_scan_search ile kapat. Gerçek erişim engelini blocked olarak bildir.',
      );
    validateWorkCompletion(active, scan);
    if (scan.completion === 'cutoff' && args.goalReached)
      throw Error(
        'Yeni ilan kontrolünün tarih sınırına ulaşması otomasyonun hedefinin bittiği anlamına gelmez.',
      );
    db.putRun({...active, scan});
  }
  if (stop?.kind === 'technical') {
    const retry = holdForTechnicalRetry(db, id, run.id, {
      stop,
      urls: Object.values(db.run(run.id).scanIssues ?? {})
        .filter((i) => stop.issueIds.includes(i.id))
        .map((i) => i.url),
      summary: args.summary,
    });
    if (retry) return report(id, run.id, retry.status, retry.summary, false);
  } else if (stop) db.putRun({...db.run(run.id), stop});
  return report(id, run.id, status, args.summary, args.goalReached === true);
}
