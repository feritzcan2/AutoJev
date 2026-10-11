// @ts-check
export function conversationToolLabel(tool = '') {
  const name = tool.replace(/^jobloop_/, '');
  if (/automation_context|context_part/.test(name)) return 'Reviewing workspace information';
  if (/workspace_history/.test(name)) return 'Checking the related history';
  if (/workspace_records|automation_result|scan_results/.test(name))
    return 'Reviewing saved results';
  if (/save_automation_plan/.test(name)) return 'Saving the proposed changes as a draft';
  if (/browser|research/.test(name)) return 'Checking information on the web';
  if (/ask_workspace_question/.test(name)) return 'Preparing questions';
  if (/reply_to_user|finish_automation_run/.test(name)) return 'Finishing the reply';
  if (/task/.test(name)) return 'Reviewing results in detail';
  if (/bash|read|grep/.test(name)) return 'Checking related information';
  return 'Working on a reply';
}
