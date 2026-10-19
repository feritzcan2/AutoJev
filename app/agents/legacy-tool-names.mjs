// @ts-check
// Tool names before 2026-10-19, when tools that are not specific to Jev lost
// "jev" from their names. A resumed agent conversation may still call them.
const LEGACY_TOOL_NAMES = {
  browser_jev_observe: 'browser_observe',
  browser_jev_run: 'browser_run_task',
  browser_jev_click: 'browser_click_target',
  browser_jev_inspect_form: 'browser_inspect_form',
  browser_jev_autocomplete: 'browser_autocomplete',
  browser_jev_open: 'browser_open_page',
  browser_jev_fill_fields: 'browser_fill_fields',
  browser_jev_tabs: 'browser_tabs',
  browser_jev_select_option: 'browser_choose_option',
  browser_jev_list_options: 'browser_list_options',
  browser_jev_select_choice: 'browser_select_choice',
  browser_jev_use_tab: 'browser_use_tab',
  browser_jev_next: 'browser_next',
  browser_jev_reveal: 'browser_reveal',
  browser_jev_close_tab: 'browser_close_tab',
  browser_jev_scroll: 'browser_scroll',
  browser_jev_list_suggestions: 'browser_list_suggestions',
  browser_jev_act: 'browser_act',
  browser_jev_upload: 'browser_upload',
  browser_jev_frame_act: 'browser_frame_act',
  browser_jev_screenshot: 'browser_page_screenshot',
  browser_jev_frame_observe: 'browser_frame_observe',
  browser_jev_options: 'browser_options',
  browser_jev_open_frame: 'browser_open_frame',
  browser_jev_run_code: 'browser_run_code',
  read_jev_brief: 'read_listing_brief',
  read_jev_evidence: 'read_listing_evidence',
  read_jev_task: 'read_browser_task',
};

export const currentToolName = (name) => LEGACY_TOOL_NAMES[name] ?? name;
