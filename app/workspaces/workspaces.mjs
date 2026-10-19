import {withAgentDefaults, DECISION_MODES} from '../agents/settings.mjs';
const INITIAL_WORKERS = 3;
// A workspace is a template plus shared settings/state. Domain extensions define
// eligibility and task instructions; the app exposes one control surface.
export class Workspaces {
  constructor(
    store,
    {
      templates,
      validateSettings = async () => {},
      changing = new Set(),
      assertAvailable = () => {},
      changed = () => {},
      workerRemoved = () => {},
    },
  ) {
    Object.assign(this, {
      store,
      templates,
      validateSettings,
      changing,
      assertAvailable,
      changed,
      workerRemoved,
    });
  }
  assertMutable(id) {
    this.store.get(id);
    this.assertAvailable(id);
    if (this.changing.has(id)) throw Error('The workspace is being updated.');
  }
  template(id) {
    const definition = this.store.definition(id);
    const driver = this.templates[definition.execution.driver];
    if (!driver) throw Error('Template driver not found: ' + definition.execution.driver);
    return driver;
  }
  async create(templateId, input = {}) {
    const definition = this.store.template(templateId),
      driver = this.templates[definition.execution.driver];
    if (!driver) throw Error('Template extension is not loaded');
    if (input.agentSettings) {
      input = {...input, agentSettings: withAgentDefaults(input.agentSettings)};
      await this.validateSettings(input.agentSettings);
    }
    const result = await driver.create(templateId, input);
    // New workspaces start with three workers (or fewer when the template caps it).
    const initial = Math.min(INITIAL_WORKERS, definition.execution.maxWorkers ?? 8);
    for (let n = this.store.workers.list(result.id).length; n < initial; n++)
      this.store.workers.add(result.id);
    this.changed(result.id);
    return result;
  }
  list() {
    return this.store
      .list()
      .filter((w) => this.store.supports(w.templateId))
      .map((w) => ({
        ...w,
        kind: this.store.definition(w.id).kind,
        driver: this.store.definition(w.id).execution.driver,
      }))
      .filter((w) => this.templates[w.driver]);
  }
  snapshot(id) {
    const result = this.template(id).snapshot(id),
      decorate = (value) => ({...value, workspace: this.store.get(id)});
    return result?.then ? result.then(decorate) : decorate(result);
  }
  start(id, options) {
    this.assertMutable(id);
    return this.template(id).start(id, options);
  }
  stop(id) {
    this.assertMutable(id);
    return this.template(id).stop(id);
  }
  restart(id, options) {
    this.assertMutable(id);
    return this.template(id).restart(id, options);
  }
  rename(id, name) {
    this.assertMutable(id);
    const result = this.template(id).rename(id, name);
    this.changed(id);
    return result;
  }
  async remove(id) {
    this.assertMutable(id);
    const workers = this.store.workers.list(id);
    this.changing.add(id);
    try {
      await this.template(id).remove(id);
      for (const worker of workers) await this.workerRemoved(id, worker.id);
      this.changed(id);
      return {deleted: true};
    } finally {
      this.changing.delete(id);
    }
  }
  // Reading a terminal or fitting its grid is safe while documents or workers
  // change. Commands still require the mutation lock and every call checks ownership.
  validateWorker(id, worker = 'main', {mutable = true} = {}) {
    if (mutable) this.assertMutable(id);
    else {
      this.store.get(id);
      this.assertAvailable(id);
    }
    return this.store.workers.get(id, worker);
  }
  async addWorker(id, input) {
    this.validateWorker(id);
    const result = await this.template(id).workers.add(id, input);
    this.changed(id);
    return result;
  }
  async startWorker(id, worker) {
    this.validateWorker(id, worker);
    const result = await this.template(id).workers.start(id, worker);
    this.changed(id);
    return result;
  }
  async stopWorker(id, worker) {
    this.validateWorker(id, worker);
    const result = await this.template(id).workers.stop(id, worker);
    this.changed(id);
    return result;
  }
  async restartWorker(id, worker) {
    this.validateWorker(id, worker);
    const driver = this.template(id).workers;
    this.changing.add(id);
    try {
      const state = await driver.restartState?.(id, worker);
      await driver.stop(id, worker);
      const history = this.store.history(id, worker);
      if (!state?.resume)
        for (const provider of ['codex', 'claude', 'opencode']) {
          const native = history.conversation(id, provider);
          if (native) history.forgetConversation(id, provider, native);
        }
      return await driver.start(id, worker, state);
    } finally {
      this.changing.delete(id);
      this.changed(id);
    }
  }
  async removeWorker(id, worker) {
    this.validateWorker(id, worker);
    if (worker === 'main') throw Error('The first worker cannot be removed.');
    await this.template(id).workers.remove(id, worker);
    await this.workerRemoved(id, worker);
    this.changed(id);
  }
  beforeInput(id, text, worker = 'main') {
    this.validateWorker(id, worker);
    return this.template(id).beforeInput?.(id, text, worker);
  }
  message(id, text, worker = 'main') {
    this.validateWorker(id, worker);
    if (typeof text !== 'string' || !text.trim() || text.length > 12000)
      throw Error('Write a message of 1–12000 characters');
    return this.template(id).message(id, text, worker);
  }
  async settings(id, input) {
    this.assertMutable(id);
    const fields = ['agentSettings', 'chromeProfile'];
    if (!input || Object.keys(input).some((key) => !fields.includes(key)))
      throw Error('Invalid agent setting');
    if (input.agentSettings) {
      const s = withAgentDefaults(input.agentSettings);
      input = {...input, agentSettings: s};
      if (
        !['codex', 'claude', 'opencode'].includes(s.provider) ||
        ![true, false, null].includes(s.network) ||
        !DECISION_MODES.includes(s.decisions)
      )
        throw Error('Invalid agent settings');
      await this.validateSettings(s);
    }
    return this.template(id).settings(id, input);
  }
}
