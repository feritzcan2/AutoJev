// @ts-check
import {instructionPart} from './instruction-log.mjs';
import {automationTools} from '../automation/tools.mjs';
import {automationPrompt} from '../automation/prompts.mjs';

export function webPromptCatalog(plan) {
  const tasks = [
    ['interview', 'Setup chat'],
    ['trial', 'Source trial'],
    ['run', 'Run the assigned task'],
  ].map(([kind, title]) => ({
    id: kind,
    title,
    when:
      kind === 'run'
        ? 'When a source scan or record operation starts.'
        : 'When the related agent session starts.',
    text: automationPrompt({
      kind,
      ...(kind === 'run' ? {operation: '{{assigned operation}}'} : {}),
    }),
  }));
  const tools = automationTools.map((t) => ({
    name: t.name,
    description: t.description,
    params: Object.entries(t.inputSchema?.properties ?? {}).map(([name, schema]) => ({
      name,
      type: schema.enum ? schema.enum.join(' | ') : (schema.type ?? 'object'),
      required: (t.inputSchema.required ?? []).includes(name),
    })),
  }));
  return {instructions: [], tasks, skills: [], tools};
}

// The Agent inspector and Configuration use the same current instruction parts.
// Domain drivers supply only their additional prompt, skill and tool catalogs.
export async function configurationCatalog({id, workspaces, profiles}) {
  const workspace = workspaces.store.get(id),
    driver = workspaces.template(id);
  const [parts, catalog] = await Promise.all([
    driver.instructions?.(id) ?? [],
    driver.configuration?.(id) ?? {},
  ]);
  const library = profiles.list(id, driver.agentRoles?.(id) ?? []);
  const instructions = [
    ...library.agents.map((p) =>
      instructionPart(
        'agent-profile:' + p.id,
        p.name + ' agent instructions',
        'system',
        p.instructions,
        {when: p.when},
      ),
    ),
    ...parts.filter((p) => p.source !== 'skill'),
    ...(catalog.instructions ?? [])
      .filter((p) => !['agents-md', 'chrome-profile', 'jev-browser'].includes(p.id))
      .map((p) =>
        instructionPart(p.id, p.title, 'system', p.text, {
          when: [p.where, p.when].filter(Boolean).join(' · '),
        }),
      ),
  ];
  return {
    workspace,
    instructions,
    tasks: catalog.tasks ?? [],
    skills: catalog.skills ?? [],
    tools: catalog.tools ?? [],
  };
}
