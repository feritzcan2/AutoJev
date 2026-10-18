import {questionForm} from './question-form.js';
import {automationAttention} from '../app/automation/attention.mjs';
import {attentionTabs} from './automation-attention.js';
import './answers-page.css';
const el = (tag, text, cls) => {
  const node = document.createElement(tag);
  if (text != null) node.textContent = text;
  if (cls) node.className = cls;
  return node;
};
const button = (text, click, cls = 'quiet') => {
  const node = el('button', text, cls);
  node.type = 'button';
  node.onclick = click;
  return node;
};

// The Answers page lists every open record question as its own card. Cards stay
// mounted across refreshes so a half-written answer is never rebuilt.
export function answersPage(root, api, {refresh}) {
  let snapshot = null,
    workspace = null;
  const cards = new Map(),
    list = el('div', null, 'answers-list'),
    empty = el(
      'p',
      'No open questions. Questions the agent asks about a record appear here.',
      'answers-empty',
    );
  root.className = 'answers-page';
  root.innerHTML =
    '<div class="section-title"><h2>Answers</h2><span>Questions the agent asked about records</span></div>';
  root.append(empty, list);

  function card(issue) {
    const id = issue.id,
      record = snapshot.results.find((r) => r.id === issue.recordId),
      node = el('article', null, 'answer-card');
    node.dataset.questionId = id;
    const head = el('header', null, 'answer-card-head'),
      heading = el('div'),
      title = el('h3', record?.title ?? 'Question about a record');
    heading.append(
      el(
        'span',
        issue.verification ? 'CAPTCHA TO SOLVE' : 'AWAITING ANSWER',
        'answer-card-eyebrow',
      ),
      title,
    );
    if (record?.url)
      heading.append(
        el('p', new URL(record.url).hostname.replace(/^www\./, ''), 'answer-card-source'),
      );
    head.append(heading);
    const body = el('div', null, 'answer-card-body'),
      form = questionForm(
        workspace,
        {id, question: issue.message, fields: issue.fields},
        async (value) => {
          await api.workspaceAnswer(workspace, id, value);
          await refresh();
        },
      );
    body.append(el('p', issue.message, 'answer-card-message'), form);
    const footer = el('footer', null, 'answer-card-footer'),
      tools = el('div', null, 'answer-card-tools'),
      feedback = el('p', null, 'answer-card-feedback'),
      choices = el('div', null, 'answer-card-tabs'),
      owner = workspace;
    feedback.setAttribute('role', 'status');
    const tab = button('Go to tab ↗', async () => {
      tab.disabled = true;
      feedback.textContent = '';
      try {
        const tabs = attentionTabs(issue, await api.workspaceTabs(owner), snapshot?.sources ?? []);
        if (!tabs.length) throw Error('No open tab was found for this record.');
        if (tabs.length === 1) {
          await api.focusWorkspaceTab(owner, tabs[0].tabId);
          return;
        }
        choices.replaceChildren(el('p', 'Choose the open tab:'));
        for (const item of tabs)
          choices.append(
            button(item.url, async () => {
              try {
                await api.focusWorkspaceTab(owner, item.tabId);
                choices.replaceChildren();
              } catch (error) {
                feedback.textContent = error.message;
              }
            }),
          );
      } catch (error) {
        feedback.textContent = error.message;
      } finally {
        tab.disabled = false;
      }
    });
    const attach = button('Add document', async () => {
      attach.disabled = true;
      feedback.textContent = '';
      try {
        if (await api.pickDocument(owner)) {
          feedback.textContent =
            'Document added. The agent will review it when you send your answer.';
          await refresh();
        }
      } catch (error) {
        feedback.textContent = error.message;
      } finally {
        attach.disabled = false;
      }
    });
    tools.append(tab, attach);
    if (issue.canDismissRecord) {
      const dismiss = button(
        'Skip',
        async () => {
          const controls = [...node.querySelectorAll('button,input,textarea,select')],
            disabled = controls.map((c) => c.disabled);
          controls.forEach((c) => (c.disabled = true));
          feedback.textContent = '';
          try {
            await api.automationDismiss(owner, issue.recordId);
            await refresh();
          } catch (error) {
            feedback.textContent = error.message;
          } finally {
            controls.forEach((c, n) => (c.disabled = disabled[n]));
          }
        },
        'quiet answer-card-dismiss',
      );
      dismiss.dataset.recordDismiss = issue.recordId;
      dismiss.title = 'Skip this record and close its pending questions';
      tools.append(dismiss);
    }
    footer.append(tools, choices, feedback);
    node.append(head, body, footer);
    return node;
  }

  return {
    update(value) {
      snapshot = value;
      const owner = value?.automation.id ?? null;
      if (owner !== workspace) {
        cards.clear();
        list.replaceChildren();
        workspace = owner;
      }
      const issues = value
        ? automationAttention(value).filter((q) => q.kind === 'question' && q.recordId)
        : [];
      const open = new Set(issues.map((q) => q.id));
      for (const [id, node] of cards)
        if (!open.has(id)) {
          node.remove();
          cards.delete(id);
        }
      for (const issue of issues) if (!cards.has(issue.id)) cards.set(issue.id, card(issue));
      // Move only out-of-place cards; moving a card drops focus from its form.
      issues.forEach((q, n) => {
        const node = cards.get(q.id);
        if (list.children[n] !== node) list.insertBefore(node, list.children[n] ?? null);
      });
      empty.hidden = issues.length > 0;
    },
    focus(id) {
      const node = cards.get(id) ?? list.firstElementChild;
      if (!node) return;
      node.scrollIntoView({block: 'nearest'});
      node
        .querySelector(
          'input:not([type=hidden]):not(:disabled),textarea:not(:disabled),select:not(:disabled)',
        )
        ?.focus({preventScroll: true});
    },
  };
}
