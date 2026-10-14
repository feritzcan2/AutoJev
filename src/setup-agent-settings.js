import {withAgentDefaults} from '../app/agents/settings.mjs';
import './setup-agent-settings.css';

export function setupAgentSettingsPanel({api, getCatalog, refresh}) {
  const root = document.createElement('form');
  root.id = 'setup-agent-settings';
  root.className = 'setup-agent-settings';
  root.setAttribute('aria-label', 'Setup agent settings');
  root.innerHTML =
    '<div class="setup-agent-settings-row"><label>Provider<select name="provider" aria-label="Setup provider"></select></label><label class="setup-agent-model">Model<select name="model" aria-label="Setup model"></select></label><label>Reasoning level<select name="reasoning" aria-label="Setup reasoning level"></select></label><button type="submit" class="primary" data-save disabled>Save</button><button type="button" class="quiet" data-restart title="Restart only the setup chat in a new session">Restart</button></div><details><summary>Other agent settings</summary><div class="setup-agent-settings-row"><label>Permission mode<select name="permission" aria-label="Setup permission mode"></select></label><label>Network access<select name="network"><option value="inherit">Provider default</option><option value="true">On</option><option value="false">Off</option></select></label></div></details><p data-hint>Messages, and reopening the app, continue the same chat. Changing the agent settings or pressing Restart opens a new session.</p><p data-status role="status" hidden></p>';
  const fields = root.elements,
    save = root.querySelector('[data-save]'),
    restart = root.querySelector('[data-restart]'),
    status = root.querySelector('[data-status]');
  let owner = null,
    settings = {},
    baseline = '',
    signature = '',
    dirty = false,
    busy = false;
  const providers = () =>
    getCatalog().filter((p) => p.supported && ['codex', 'claude', 'opencode'].includes(p.id));
  function options(saved = {}) {
    const provider = providers().find((p) => p.id === fields.provider.value),
      defaults = withAgentDefaults({provider: fields.provider.value});
    for (const name of ['model', 'reasoning', 'permission']) {
      const values = provider?.[
        name === 'model' ? 'models' : name === 'permission' ? 'permissions' : 'reasoning'
      ] ?? ['default'];
      fields[name].replaceChildren(...values.map((value) => new Option(value, value)));
      // Preserve saved/custom values when the catalog is temporarily unavailable.
      if (saved[name] && !values.includes(saved[name]))
        fields[name].add(new Option(saved[name], saved[name]));
      fields[name].value =
        saved[name] ??
        (values.includes(defaults[name])
          ? defaults[name]
          : values.includes('default')
            ? 'default'
            : values[0]);
    }
    fields.network.disabled = fields.provider.value !== 'codex';
    fields.network.value = saved.network == null ? 'inherit' : String(saved.network);
  }
  function read() {
    return {
      ...settings,
      provider: fields.provider.value,
      model: fields.model.value,
      reasoning: fields.reasoning.value,
      permission: fields.permission.value,
      network:
        fields.provider.value !== 'codex' || fields.network.value === 'inherit'
          ? null
          : fields.network.value === 'true',
      contextRestartTokens: 0,
    };
  }
  function mark() {
    dirty = JSON.stringify(read()) !== baseline;
    save.disabled = busy || !dirty;
    restart.disabled = busy || dirty;
    status.hidden = false;
    status.textContent = dirty
      ? 'When you save, the setup agent opens a new chat session with these settings.'
      : 'No changes.';
  }
  fields.provider.onchange = () => {
    settings = withAgentDefaults({provider: fields.provider.value});
    options();
    mark();
  };
  root.onchange = mark;
  async function apply(reset) {
    if (busy || !owner) return;
    const id = owner;
    busy = true;
    root.inert = true;
    status.hidden = false;
    status.textContent = reset ? 'Opening a new chat…' : 'Saving settings…';
    try {
      if (reset) await api.setupAgentRestart(id);
      else await api.setupAgentSettings(id, read());
      if (owner === id) {
        dirty = false;
        signature = '';
        await refresh();
        status.textContent = reset ? 'New chat session opened.' : 'Setup agent settings saved.';
      }
    } catch (error) {
      if (owner === id) status.textContent = error.message;
    } finally {
      busy = false;
      root.inert = false;
      save.disabled = !dirty;
      restart.disabled = dirty;
    }
  }
  root.onsubmit = (event) => {
    event.preventDefault();
    if (dirty) void apply(false);
  };
  restart.onclick = () => void apply(true);
  return {
    element: root,
    update(id, snapshot) {
      const next =
        snapshot?.setupAgent?.settings ??
        snapshot?.automation?.setupAgentSettings ??
        snapshot?.automation?.agentSettings ??
        {};
      if (owner !== id) {
        owner = id;
        dirty = false;
        signature = '';
        status.hidden = true;
      }
      if (dirty) return;
      const key = JSON.stringify([id, next, getCatalog()]);
      if (key === signature) return;
      signature = key;
      settings = {...next, contextRestartTokens: 0};
      fields.provider.replaceChildren(...providers().map((p) => new Option(p.label, p.id)));
      if (![...fields.provider.options].some((p) => p.value === settings.provider))
        fields.provider.add(new Option(settings.provider, settings.provider));
      fields.provider.value = settings.provider;
      options(settings);
      baseline = JSON.stringify(read());
      save.disabled = true;
      restart.disabled = busy;
    },
  };
}
