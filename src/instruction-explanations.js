const descriptions = {
  criteria:
    'Your selection criteria, such as budget, location or number of rooms. The agent compares the options it finds against them.',
  preferences:
    'The job you are looking for, location, working style and other preferences. The agent evaluates listings against them.',
  instructions:
    'Custom working rules you added for this workspace. For example, you can tell it here to review listings one by one or to rule out certain options.',
  facts:
    'Information you saved about yourself. The agent refers to it when judging fit and when preparing answers or messages.',
  mode: 'States whether the agent should only research, prepare drafts, or carry out the actions you allow.',
  authorization:
    'States how far the agent may go: research, preparation or submission. Task-specific permissions can also be given in the task details.',
  applicationPolicy:
    'How application forms answer consent checkboxes and optional questions such as marketing emails or demographic questions.',
  goal: 'The outcome you want reached in this workspace. The agent interprets its work and what counts as success from it.',
  sources:
    'Sites to research and their start addresses. A worker may be given only the sources it reviews in that task.',
  maxActionsPerDay:
    'The upper limit of external actions per day. The agent learns it when reading the plan; the app also checks this limit in the related action records.',
  maxBrowserSteps:
    'The limit of browser steps in one working round. The agent plans its work with it; the app also counts the steps.',
  timeoutMinutes:
    'The time limit of one working round. The agent learns it when reading the plan; the app tracks the time.',
  guidance:
    'Rules of the selected template specific to this kind of work. For example, it explains which details to review when searching for a home.',
  workflow:
    'The template’s task steps and their order. The agent is assigned the step for that round separately; it is not expected to do all steps in the same round.',
  fields:
    'Defines which information is asked during setup. The agent uses these fields when collecting missing information.',
  title:
    'The name of the workspace or template. It helps the agent understand which job it is working on.',
  records: 'Defines record fields, their statuses and the allowed transitions.',
  execution: 'Defines which runner and browser options the template runs with.',
  table:
    'Defines the columns and field types of the results table. The agent saves results according to this structure.',
};
export function instructionExplanation(part) {
  const key = part.key,
    field = key.split(':').at(-1);
  if (key.startsWith('agent-profile:'))
    return {
      purpose: 'Defines the selected agent’s task and working rules.',
      timing:
        'When a session opens for this agent, it is given directly as the developer instruction to Codex and as an additional system instruction to Claude.',
      change:
        'The version you save is used in the next session. The instructions of an open session do not change; an old conversation on a different version is not resumed.',
    };
  if (key.startsWith('file:'))
    return {
      purpose:
        part.source === 'skill'
          ? 'A skill file that explains how to do a specific job. Not every skill has to be read in every task.'
          : 'A section of an instruction file that shapes how the agent works.',
      timing:
        part.source === 'skill'
          ? 'The file is made accessible while the session is prepared. The agent learns its content if it opens and reads this file for the relevant task.'
          : 'It is placed in the working folder while the session is prepared. The provider or agent learns its content when reading this file.',
      change:
        'A file access record is not proof of reading. This page cannot confirm that the current file was read again into an open conversation.',
    };
  if (key === 'startup-routing' || key === 'browser-profile')
    return {
      purpose:
        key === 'startup-routing'
          ? 'Tells the agent how to start the given task and which instructions to follow.'
          : 'Explains how the selected browser and profile are to be used.',
      timing:
        'It is added to the first message when the agent session starts. Even when the previous conversation is resumed, it is sent again on a new start.',
      change:
        'The current text here is not sent to an open session as a new message on its own. The new text is used on the next start.',
    };
  if (key.includes(':messages:'))
    return {
      purpose:
        part.source === 'user'
          ? 'A message you wrote in this workspace’s conversation. The agent uses it to remember your request and its earlier replies.'
          : 'A message from the workspace’s saved conversation; it helps the next round understand how the conversation continues.',
      timing:
        'When the setup agent asks for the saved task details, it is given together with the latest messages that fit the size limit. The raw setup chat is not sent to Trial and Run agents.',
      change:
        'A message being listed here does not by itself show that it was delivered to that session. You can check the context reply in the delivery history.',
    };
  if (key.startsWith('tool:get_'))
    return {
      purpose:
        descriptions[field] ??
        (part.source === 'template'
          ? 'Information the selected template defines for this work.'
          : 'Task information saved in the workspace.'),
      timing: key.includes('get_task_context')
        ? 'When a new task starts, the agent asks for the saved task details. This information is delivered inside the reply to that request.'
        : 'When starting the setup chat, a trial or a normal working round, the agent asks for the saved plan. This information is delivered inside the reply to that request.',
      change:
        'A change you save is not added to an open conversation automatically. The agent gets the current value when it asks for the task details again. It is not resent on every click.',
    };
  return {
    purpose:
      part.source === 'tool'
        ? 'The description of a tool the agent can use, or information returned by the tool.'
        : 'An instruction or information the agent can use while working.',
    timing: part.when ?? 'Delivered during the related task or tool request.',
    change:
      'You can review the actual delivered text and its time in the Delivery history section.',
  };
}
