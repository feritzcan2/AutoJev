import {profilePlan, profileChanged} from './profile-updates.mjs';
import {convertLegacyProfile} from './legacy-profile.mjs';
import {taskSnapshot} from '../browser/automation-snapshot.mjs';
import {automationSnapshotReader} from '../browser/automation-snapshot-reader.mjs';
import {JevTaskStore} from '../jev/task-store.mjs';
import {BrowserEvidenceStore} from '../browser/evidence-store.mjs';
import {isConversation, conversationWaiting} from '../workspaces/conversation.mjs';
import {setupAgentOnboarding} from '../agents/setup-agent.mjs';
import {recordOperationState} from '../records/operations.mjs';
import {taskRecordIds} from '../records/task-scope.mjs';
import {SiteAccess} from '../browser/site-access.mjs';
import {automationTrialReady} from '../sources/trial.mjs';
import {removeImportedWorkspace} from '../workspaces/imported.mjs';
import {withAgentDefaults, DECISION_MODES} from '../agents/settings.mjs';
import {
  DEFAULT_SCAN_INTERVAL_MINUTES,
  globalTemplateSource,
  templateSourceSettings,
} from '../templates/sources.mjs';
import {domainData} from '../workspaces/store.mjs';
import {contextCompactTokens} from '../agents/context-compaction.mjs';
import {contextRestartTokens} from '../agents/context-usage.mjs';
import {randomUUID} from 'node:crypto';
import {siteKey} from '../browser/site-key.mjs';
import {recipeNeedsTerms} from '../sources/recipe.mjs';
import {
  reusableTemplate,
  planInput,
  missingPlanFields,
  missingProfileFields,
  defaultAutomationSettings,
  boundedText,
} from '../templates/catalog.mjs';
import {automationTable, defaultAutomationTable} from '../templates/catalog.mjs';
import {json, finishedSourceRun, runSource} from './store/rows.mjs';
import {sourceMethods} from './store/sources.mjs';
import {questionMethods} from './store/questions.mjs';
import {scanMethods} from './store/scan.mjs';
import {recordMethods} from './store/records.mjs';
import {runMethods} from './store/runs.mjs';
const integer = (value, label, min, max) => {
  if (!Number.isInteger(value) || value < min || value > max)
    throw Error(`${label}: a whole number between ${min} and ${max} is required`);
  return value;
};
// Score thresholds only decide what is saved or applied to; they do not change
// how records are scored, so they never start a new revision or stale old scores.
const scoringCriteria = ({score_threshold, save_score_threshold, ...criteria} = {}) => criteria;
const planKey = (value) =>
  JSON.stringify([
    value.title,
    value.goal,
    scoringCriteria(value.criteria),
    value.sources,
    value.instructions,
    value.facts,
  ]);
function agentSettings(input) {
  if (!['codex', 'claude', 'opencode'].includes(input?.provider))
    throw Error('Unsupported provider');
  input = withAgentDefaults(input);
  for (const key of ['model', 'permission', 'reasoning']) boundedText(input[key], key, 120);
  if (![true, false, null].includes(input.network)) throw Error('Invalid network setting');
  if (!DECISION_MODES.includes(input.decisions)) throw Error('Invalid decision setting');
  const trialModel = input.trialModel ? boundedText(input.trialModel, 'trialModel', 120) : null,
    contactModel = input.contactModel ? boundedText(input.contactModel, 'contactModel', 120) : null,
    coverLetterModel = input.coverLetterModel
      ? boundedText(input.coverLetterModel, 'coverLetterModel', 120)
      : null;
  return {
    provider: input.provider,
    model: input.model,
    permission: input.permission,
    reasoning: input.reasoning,
    network: input.provider === 'codex' ? input.network : null,
    decisions: input.decisions,
    ...(trialModel || input.trialModel === null ? {trialModel} : {}),
    ...(contactModel || input.contactModel === null ? {contactModel} : {}),
    ...(coverLetterModel || input.coverLetterModel === null ? {coverLetterModel} : {}),
    contextCompactTokens: contextCompactTokens(input.contextCompactTokens),
    ...(input.contextRestartTokens === undefined
      ? {}
      : {contextRestartTokens: contextRestartTokens(input.contextRestartTokens)}),
  };
}
export class AutomationStore {
  constructor(store, {now = () => Date.now()} = {}) {
    this.store = store;
    this.db = store.db;
    this.now = now;
    this.siteAccess = new SiteAccess(this.db, {now});
    this.db
      .exec(`CREATE TABLE IF NOT EXISTS workspace_events(seq INTEGER PRIMARY KEY,workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,kind TEXT NOT NULL,data TEXT NOT NULL,at INTEGER NOT NULL);
   CREATE TABLE IF NOT EXISTS automation_templates(id TEXT PRIMARY KEY,data TEXT NOT NULL);
   CREATE TABLE IF NOT EXISTS automations(id TEXT PRIMARY KEY,data TEXT NOT NULL);
   CREATE TABLE IF NOT EXISTS automation_runs(id TEXT PRIMARY KEY,automation_id TEXT NOT NULL REFERENCES automations(id) ON DELETE CASCADE,data TEXT NOT NULL);
   CREATE TABLE IF NOT EXISTS automation_messages(id TEXT PRIMARY KEY,automation_id TEXT NOT NULL REFERENCES automations(id) ON DELETE CASCADE,data TEXT NOT NULL);
   CREATE INDEX IF NOT EXISTS automation_runs_owner ON automation_runs(automation_id);
   CREATE INDEX IF NOT EXISTS automation_runs_status ON automation_runs(automation_id,json_extract(data,'$.status'));
   CREATE INDEX IF NOT EXISTS automation_runs_source_history ON automation_runs(automation_id,${runSource}) WHERE ${finishedSourceRun};
   CREATE INDEX IF NOT EXISTS automation_runs_record ON automation_runs(automation_id,json_extract(data,'$.recordId'));
   CREATE INDEX IF NOT EXISTS automation_runs_interview ON automation_runs(automation_id) WHERE json_extract(data,'$.kind')='interview';
   CREATE INDEX IF NOT EXISTS automation_messages_owner ON automation_messages(automation_id);
   CREATE TABLE IF NOT EXISTS scan_seen_listings(workspace_id TEXT NOT NULL REFERENCES automations(id) ON DELETE CASCADE,url_key TEXT NOT NULL,scope_key TEXT NOT NULL,reason TEXT NOT NULL,at INTEGER NOT NULL,PRIMARY KEY(workspace_id,url_key));`);
    this.jevTasks = new JevTaskStore(this.db, now);
    this.browserEvidence = new BrowserEvidenceStore(now);
    for (const {id} of this.db.prepare('SELECT id FROM automations').all())
      convertLegacyProfile(this, id);
    for (const {id} of this.list())
      if (this.store.workspaces.records.usesUrl(id))
        this.store.workspaces.records.identities.rebuild(id);
  }
  has(id) {
    return Boolean(this.db.prepare('SELECT 1 FROM automations WHERE id=?').get(id));
  }
  // Checks the automation exists without parsing its large body.
  assertExists(id) {
    if (!this.has(id)) throw Error('Automation not found');
  }
  conversation(id, provider) {
    return this.store.workspaces.history(id).conversation(id, provider);
  }
  conversationSettings(id, provider, nativeId) {
    return this.store.workspaces.history(id).conversationSettings(id, provider, nativeId);
  }
  saveConversation(id, provider, nativeId, settings) {
    return this.store.workspaces.history(id).saveConversation(id, provider, nativeId, settings);
  }
  forgetConversation(id, provider, nativeId) {
    return this.store.workspaces.history(id).forgetConversation(id, provider, nativeId);
  }
  get(id) {
    const a = json(this.db.prepare('SELECT data FROM automations WHERE id=?').get(id));
    if (!a) throw Error('Automation not found');
    delete a.maxActionsTotal;
    delete a.maxActionsPerDay;
    delete a.endAt;
    delete a.timeoutMinutes;
    delete a.maxBrowserSteps;
    if (a.questions) a.questions = a.questions.map((q) => this.questionScope(id, q));
    return {
      ...a,
      ...this.store.workspaces.fields(id),
      table: this.store.workspaces.table(id),
    };
  }
  catalog() {
    return [
      ...this.store.workspaces.registry.catalog(),
      ...this.db
        .prepare('SELECT data FROM automation_templates ORDER BY rowid DESC')
        .all()
        .map(json)
        .filter((input) => this.store.workspaces.registry.supports(input))
        .map((input) => this.store.workspaces.registry.normalize(input)),
    ];
  }
  template(id) {
    return this.store.workspaces.template(id);
  }
  saveTemplate(input) {
    const template = {
      ...reusableTemplate(input, (value) => this.store.workspaces.registry.normalize(value)),
      id: 'template-' + randomUUID(),
      personal: true,
    };
    this.db
      .prepare('INSERT INTO automation_templates VALUES(?,?)')
      .run(template.id, JSON.stringify(template));
    return template;
  }
  list() {
    return this.db
      .prepare('SELECT id FROM automations ORDER BY rowid DESC')
      .all()
      .map((row) => this.get(row.id));
  }
  put(a) {
    a = {...a};
    delete a.maxActionsTotal;
    delete a.maxActionsPerDay;
    delete a.endAt;
    this.db.exec('SAVEPOINT save_workspace_plan');
    try {
      this.store.workspaces.save(a.id, a.templateId, a);
      this.db
        .prepare(
          'INSERT INTO automations VALUES(?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data',
        )
        .run(a.id, JSON.stringify(domainData(a)));
      this.db.exec('RELEASE save_workspace_plan');
      return this.get(a.id);
    } catch (error) {
      this.db.exec('ROLLBACK TO save_workspace_plan; RELEASE save_workspace_plan');
      throw error;
    }
  }
  create(templateId, input = {}) {
    const template = this.template(templateId);
    if (template.kind !== 'web') throw Error('Use the candidate setup for job search');
    const defaults = template.defaultSources ?? [],
      plan = planInput(template, {
        ...input,
        sources: input.sources ?? defaults.filter(globalTemplateSource).map((source) => source.url),
      });
    const sourceSettings = Object.fromEntries(
      defaults
        .filter((source) => plan.sources.includes(source.url))
        .map((source) => [source.url, templateSourceSettings(source)]),
    );
    const a = {
      id: randomUUID(),
      templateId,
      templateVersion: template.version,
      ...plan,
      sourceSettings,
      mode: template.defaultMode,
      chromeProfile: null,
      intervalMinutes: DEFAULT_SCAN_INTERVAL_MINUTES,
      agentSettings: agentSettings(input.agentSettings ?? defaultAutomationSettings),
      revision: 1,
      reviewedRevision: null,
      trial: null,
      status: 'draft',
      nextRunAt: null,
      createdAt: this.now(),
      updatedAt: this.now(),
    };
    a.table = template.table ? automationTable(template.table) : defaultAutomationTable(templateId);
    this.put(a);
    this.message(
      a.id,
      'assistant',
      `Describe what you want to do. ${template.fields[0].question}`,
      {
        conversation: true,
      },
    );
    return a;
  }
  assertIdle(id, {allowConversation = false, allowWaitingConversation = false} = {}) {
    if (
      this.runs(id).some(
        (run) =>
          run.status === 'running' &&
          !(allowConversation && isConversation(run)) &&
          !(allowWaitingConversation && conversationWaiting(run)),
      )
    )
      throw Error('Stop the running automation first');
  }
  save(id, input, {agent = false, allowConversation = false} = {}) {
    const previous = this.get(id),
      template = this.template(previous.templateId),
      plan = planInput(template, input, previous);
    // Provider settings apply on the next launch, like the original Agent page.
    // All plan and authority changes still require an idle workspace.
    if (!agent && !(Object.keys(input).length === 1 && input.agentSettings))
      this.assertIdle(id, {allowWaitingConversation: true, allowConversation});
    const changed = planKey(previous) !== planKey({...previous, ...plan}),
      a = {...previous, ...plan, updatedAt: this.now()};
    if (agent) {
      if (previous.status === 'enabled')
        throw Error('An enabled automation cannot be changed during setup');
    } else {
      const mode = input.mode ?? previous.mode;
      if (!['observe', 'prepare', 'auto'].includes(mode)) throw Error('Invalid action permission');
      a.mode = mode;
      for (const [key, label, min, max] of [['intervalMinutes', 'Scan interval', 1, 10080]])
        a[key] = integer(input[key] ?? previous[key], label, min, max);
      if (input.chromeProfile !== undefined) {
        const profile = input.chromeProfile;
        if (
          profile !== null &&
          (!profile ||
            typeof profile !== 'object' ||
            !/^[-\w ]{1,100}$/.test(profile.directory ?? ''))
        )
          throw Error('Invalid Chrome profile');
        a.chromeProfile =
          profile === null
            ? null
            : {
                directory: profile.directory,
                name: boundedText(profile.name, 'Chrome profile', 300),
              };
      }
      if (input.agentSettings) a.agentSettings = agentSettings(input.agentSettings);
    }
    if (changed) {
      const tasks = this.store.workspaces.tasks;
      // Scan progress restarts, but a plan change never starts a scan before it
      // is due. A batch whose scan tasks all completed waits its interval like a
      // finished scan; an unfinished or interrupted scan resumes right away.
      const nextRun = (url, {batchId, nextRunAt}) => {
        if (!batchId) return nextRunAt;
        const batch = tasks.list(id, {batchId});
        if (!batch.length || batch.some((t) => t.state !== 'completed' || t.operation === 'trial'))
          return null;
        return (
          this.now() +
          (previous.sourceSettings?.[url]?.intervalMinutes ?? previous.intervalMinutes) * 60000
        );
      };
      a.sourceState = Object.fromEntries(
        a.sources
          .filter((url) => previous.sources.includes(url) && previous.sourceState?.[url])
          .map((url) => {
            const state = previous.sourceState[url],
              nextRunAt = nextRun(url, state);
            return [
              url,
              {
                ...(state.trial ? {trial: state.trial} : {}),
                ...(state.lastRunAt ? {lastRunAt: state.lastRunAt} : {}),
                ...(nextRunAt ? {nextRunAt} : {}),
              },
            ];
          })
          .filter(([, state]) => Object.keys(state).length),
      );
      for (const task of tasks.list(id, {states: ['pending']}))
        tasks.finish(id, task.id, 'cancelled', 'Plan changed');
      a.batchId = null;
      a.revision++;
      a.reviewedRevision = null;
      // Profile edits retain the existing trial decision; its original run stays unchanged.
      a.trial = automationTrialReady(previous) ? {...previous.trial, revision: a.revision} : null;
      a.status = 'draft';
      a.nextRunAt = null;
      this.clearApprovals(id);
    }
    if (JSON.stringify(a.chromeProfile) !== JSON.stringify(previous.chromeProfile)) {
      a.status = 'paused';
      a.nextRunAt = null;
    }
    // Saving settings never resumes a paused automation or grants a trial.
    if (
      !agent &&
      ['title', 'goal', 'criteria', 'sources', 'instructions', 'facts', 'mode'].some((key) =>
        Object.hasOwn(input, key),
      )
    ) {
      delete a.planDraft;
      delete a.profileUpdate;
    }
    return this.put(a);
  }
  saveConversationPlan(id, runId, input) {
    const run = this.activeRun(id, runId);
    if (run.kind !== 'interview' || !isConversation(run)) throw Error('A chat session is required');
    const onboarding = setupAgentOnboarding(this, id);
    let a = this.get(id);
    const base = a.profileUpdate ? {...a, ...a.profileUpdate.plan} : a,
      previous = a.planDraft?.baseRevision === a.revision ? {...base, ...a.planDraft.plan} : base;
    // Criteria the agent leaves out keep their saved values (an empty value
    // clears one); a partial update must not drop settings such as the
    // unstated-conditions rule.
    if (input.criteria) input = {...input, criteria: {...previous.criteria, ...input.criteria}};
    const template = this.template(a.templateId),
      plan = planInput(template, input, {
        ...previous,
        sources: a.sourceDraft?.sources ?? a.sources,
      }),
      profile = profilePlan(plan),
      updatedAt = this.now();
    // The initial setup adds the template's sources for a newly saved target
    // country itself, so they get their search terms in the same setup.
    const country = String(plan.criteria?.country ?? '').toUpperCase();
    if (
      onboarding &&
      country &&
      country !== String(previous.criteria?.country ?? '').toUpperCase()
    ) {
      const sites = new Set(plan.sources.map(siteKey));
      for (const source of template.defaultSources ?? [])
        if (
          source.enabled &&
          source.countries?.includes(country) &&
          !sites.has(siteKey(source.url))
        ) {
          sites.add(siteKey(source.url));
          plan.sources = [...plan.sources, source.url];
        }
    }
    if (onboarding) a = this.save(id, profile, {agent: true});
    else if (profileChanged(profile, base))
      a.planDraft = {plan: profile, baseRevision: a.revision, runId, updatedAt};
    else delete a.planDraft;
    const searches = this.proposedSourceSearches(id, plan.sources, input.sourceSearches);
    const changed = JSON.stringify(plan.sources) !== JSON.stringify(a.sources) || searches;
    if (changed)
      a.sourceDraft = {
        id: randomUUID(),
        sources: plan.sources,
        ...(searches ? {searches} : {}),
        runId,
        updatedAt,
      };
    else delete a.sourceDraft;
    this.put(a);
    // The initial setup applies its sources and searches right away, like its
    // profile; the user reviews them on the onboarding form.
    if (onboarding) {
      if (changed) this.resolveSourceDraft(id, a.sourceDraft.id, true);
      const saved = this.get(id),
        withoutTerms = this.sourceSearchOptions(id, saved.sources)
          .filter(({url}) => recipeNeedsTerms(saved.sourceSettings?.[url]?.recipe))
          .map(({url}) => url);
      return {
        saved: true,
        draft: false,
        plan,
        applied: true,
        ...(withoutTerms.length ? {sourcesWithoutTerms: withoutTerms} : {}),
        message:
          'Saved. During the initial setup the profile, sources and source searches apply right away; the user reviews them on the onboarding form.' +
          (withoutTerms.length
            ? ' sourcesWithoutTerms have no search terms yet and will not scan without them: read get_automation_context section profile (sourceSearch notes say what {query} takes, in the site language) and set their terms with sourceSearches.'
            : ''),
      };
    }
    return {
      saved: true,
      draft: true,
      plan,
      applied: false,
      message:
        'Draft saved. Profile changes are reviewed and saved on the Workspace profile screen, source suggestions on the Sources screen. Running work continues with the current settings.',
    };
  }
  normalizeSetupAgentSettings(input) {
    return {...agentSettings(input), contextRestartTokens: 0};
  }
  saveSetupAgentSettings(id, input) {
    return this.put({...this.get(id), setupAgentSettings: this.normalizeSetupAgentSettings(input)});
  }
  review(id, {allowConversation = false} = {}) {
    this.assertIdle(id, {allowWaitingConversation: true, allowConversation});
    const a = this.get(id),
      missing = missingProfileFields(a, this.template(a.templateId));
    if (missing.length) throw Error('Missing information: ' + missing.join(', '));
    return this.put({...a, reviewedRevision: a.revision, status: 'ready', nextRunAt: null});
  }
  enable(id, {sourceUrl = null} = {}) {
    // A source request joins the worker queue while unrelated record work continues.
    // Enabling the whole workspace still requires idle workers.
    if (!sourceUrl) this.assertIdle(id, {allowConversation: true});
    const a = this.get(id);
    if (a.reviewedRevision !== a.revision) throw Error('Save the setup first');
    if (sourceUrl && !a.sources.includes(sourceUrl))
      throw Error('The source does not belong to this workspace');
    if (sourceUrl && a.sourceSettings?.[sourceUrl]?.enabled === false)
      throw Error('Turn on the source first');
    return this.put({
      ...a,
      status: 'enabled',
      batchId: null,
      once: Boolean(sourceUrl),
      onceSources: sourceUrl ? [sourceUrl] : null,
      nextRunAt: this.now(),
    });
  }
  skipTrial(id) {
    this.assertIdle(id);
    const a = this.get(id);
    if (a.reviewedRevision !== a.revision) throw Error('Review and save the setup card first');
    if ((a.questions ?? []).some((q) => q.answer == null))
      throw Error('Answer the setup questions first');
    if (automationTrialReady(a)) return a;
    return this.put({
      ...a,
      trial: {revision: a.revision, status: 'skipped', at: this.now()},
      status: 'ready',
      nextRunAt: null,
      retryPlan: {},
      updatedAt: this.now(),
    });
  }
  pause(id, status = 'paused') {
    const a = this.get(id);
    return this.put({...a, status, nextRunAt: null, retryPlan: {}, updatedAt: this.now()});
  }
  event(id, kind, data) {
    this.assertExists(id);
    this.db
      .prepare('INSERT INTO workspace_events(workspace_id,kind,data,at) VALUES(?,?,?,?)')
      .run(id, kind, JSON.stringify(data), this.now());
  }
  clearApprovals(id) {
    this.db
      .prepare(
        "UPDATE workspace_records SET data=json_remove(data,'$.approvedDigest') WHERE workspace_id=?",
      )
      .run(id);
  }
  message(id, role, text, context = {}) {
    this.assertExists(id);
    if (!['user', 'assistant', 'system'].includes(role)) throw Error('Invalid message');
    const m = {
      id: randomUUID(),
      automationId: id,
      role,
      text: boundedText(text, 'Message', 12000),
      at: this.now(),
      ...context,
    };
    this.db
      .prepare('INSERT INTO automation_messages VALUES(?,?,?)')
      .run(m.id, id, JSON.stringify(m));
    return m;
  }
  // Documents the user added with "Add document"; files agents prepared are not listed.
  userDocuments(id) {
    return this.db
      .prepare(
        "SELECT json_extract(data,'$.document') AS document FROM automation_messages WHERE automation_id=? AND json_extract(data,'$.document') IS NOT NULL ORDER BY rowid",
      )
      .all(id)
      .map((row) => row.document);
  }
  messages(id) {
    this.assertExists(id);
    return this.db
      .prepare(
        `SELECT m.data,json_extract(r.data,'$.kind') AS run_kind FROM
   (SELECT rowid,automation_id,data FROM automation_messages WHERE automation_id=? ORDER BY rowid DESC LIMIT 100) m
   LEFT JOIN automation_runs r ON r.automation_id=m.automation_id AND r.id=json_extract(m.data,'$.runId') ORDER BY m.rowid`,
      )
      .all(id)
      .map((row) => {
        const message = json(row);
        return typeof message.conversation === 'boolean' || !row.run_kind
          ? message
          : {...message, conversation: row.run_kind === 'interview'};
      });
  }
  runs(id, {summary = false} = {}) {
    this.assertExists(id);
    const select = summary
      ? "json_remove(data,'$.scan','$.scanPlan','$.navigation','$.observedLinks','$.observations','$.jevTask') AS data,json_extract(data,'$.observations[#-1].url') AS observedUrl"
      : 'data';
    // Select row identities through indexes before reading the large run bodies.
    // A long-running worker must remain visible even outside recent history,
    // and the history keeps each source's latest searches when record work
    // on other sources fills the recent window.
    const sourceHistory = summary
      ? `UNION SELECT rowid FROM (SELECT rowid,row_number() OVER (PARTITION BY ${runSource} ORDER BY rowid DESC) AS n FROM automation_runs WHERE automation_id=? AND ${finishedSourceRun}) WHERE n<=5`
      : '';
    return this.db
      .prepare(
        `SELECT ${select} FROM automation_runs WHERE rowid IN (
   SELECT rowid FROM automation_runs WHERE automation_id=? AND json_extract(data,'$.status')='running'
   UNION SELECT rowid FROM (SELECT rowid FROM automation_runs WHERE automation_id=? ORDER BY rowid DESC LIMIT 30)
   ${sourceHistory}
  ) ORDER BY rowid DESC`,
      )
      .all(...(summary ? [id, id, id] : [id, id]))
      .map((row) =>
        summary
          ? {...json(row), observations: row.observedUrl ? [{url: row.observedUrl}] : []}
          : json(row),
      );
  }
  run(id) {
    const r = json(this.db.prepare('SELECT data FROM automation_runs WHERE id=?').get(id));
    if (!r) throw Error('Run not found');
    return r;
  }
  putRun(run) {
    this.db
      .prepare(
        'INSERT INTO automation_runs VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data',
      )
      .run(run.id, run.automationId, JSON.stringify(run));
    return run;
  }
  activeRun(automationId, runId) {
    const run = this.run(runId);
    if (run.automationId !== automationId || run.status !== 'running')
      throw Error('Invalid run session');
    return run;
  }
  recover() {
    for (const row of this.db
      .prepare("SELECT data FROM automation_runs WHERE json_extract(data,'$.status')='running'")
      .all()) {
      const run = json(row);
      this.putRun({...run, recoveredAfterCrash: true});
      this.finish(
        run.automationId,
        run.id,
        'interrupted',
        'The app closed. Saved results are kept.',
      );
    }
  }
  remove(id) {
    this.assertIdle(id);
    this.get(id);
    this.db.exec('SAVEPOINT automation_delete');
    try {
      for (const t of ['automation_messages', 'automation_runs'])
        this.db.prepare(`DELETE FROM ${t} WHERE automation_id=?`).run(id);
      this.db.prepare('DELETE FROM automations WHERE id=?').run(id);
      removeImportedWorkspace(this.db, id);
      this.store.workspaces.remove(id);
      this.db.exec('RELEASE automation_delete');
      this.jevTasks.release(id);
      this.browserEvidence.release(id);
    } catch (e) {
      this.db.exec('ROLLBACK TO automation_delete; RELEASE automation_delete');
      throw e;
    }
  }
  snapshot(id) {
    const db = automationSnapshotReader(this),
      a = db.get(id),
      definition = db.template(a.templateId),
      tasks = db.store.workspaces.tasks.list(id, {summary: true}),
      results = db.results(id),
      foundCounts = db.runFoundCounts(id),
      tasksByRecord = new Map();
    for (const task of tasks)
      for (const recordId of taskRecordIds(task)) {
        if (!tasksByRecord.has(recordId)) tasksByRecord.set(recordId, []);
        tasksByRecord.get(recordId).push(task);
      }
    return {
      automation: {...a, questions: (a.questions ?? []).map((q) => db.questionContext(id, q))},
      definition,
      sources: db.sources(id),
      sourceCatalog: db.sourceCatalog(id, a),
      workers: db.store.workspaces.workers.list(id),
      tasks: tasks.slice(-100).reverse().map(taskSnapshot),
      messages: db.messages(id),
      runs: db
        .runs(id, {summary: true})
        .map((run) => ({...run, foundCount: foundCounts.get(run.id) ?? 0})),
      results: results.map((item) => ({
        ...item,
        recordAction: recordOperationState(db, id, item, {
          a,
          definition,
          tasks,
          recordTasks: tasksByRecord.get(item.id) ?? [],
        }),
      })),
      resultCounts: db.resultCounts(id),
      missing: missingPlanFields(a, definition),
    };
  }
}

// The store's larger method groups live in ./store/; they share `this` with
// the core methods above.
Object.assign(
  AutomationStore.prototype,
  sourceMethods,
  questionMethods,
  scanMethods,
  recordMethods,
  runMethods,
);
