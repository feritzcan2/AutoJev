import {ageLabel, elapsedLabel} from './activity.js';
import {renderMessageText} from './message-text.js';

export function activityPanels(single, {openLink, notice}) {
  const parts = ['title', 'detail', 'state', 'age', 'link', 'events'];
  for (const name of parts) single.querySelector(`#now-${name}`).dataset.activityPart = name;
  let candidate = null;
  function bind(panel) {
    const card = {
      panel,
      parts: Object.fromEntries(
        parts.map((name) => [name, panel.querySelector(`[data-activity-part="${name}"]`)]),
      ),
    };
    const disclosure = document.createElement('details'),
      summary = document.createElement('summary');
    disclosure.className = 'activity-description';
    summary.textContent = 'Açıklamayı göster';
    disclosure.append(summary);
    card.parts.detail.before(disclosure);
    card.disclosure = disclosure;
    disclosure.ontoggle = () => {
      summary.textContent = disclosure.open ? 'Açıklamayı gizle' : 'Açıklamayı göster';
    };
    card.parts.link.onclick = async () => {
      try {
        if (card.view?.url) await openLink(card.view.url);
      } catch (error) {
        notice(error.message);
      }
    };
    return card;
  }
  const primary = bind(single);
  function draw(card, view, history) {
    card.view = view;
    const {panel, parts: p} = card;
    panel.dataset.tone = view.tone;
    p.title.textContent = view.title;
    renderMessageText(p.detail, view.detail);
    p.state.textContent = view.state;
    const long = (view.detail ?? '').length > 240 || (view.detail ?? '').split('\n').length > 3;
    if (card.descriptionKey !== view.title) {
      card.disclosure.open = false;
      card.descriptionKey = view.title;
    }
    card.disclosure.hidden = !long;
    if (long) {
      if (p.detail.parentElement !== card.disclosure) card.disclosure.append(p.detail);
    } else if (p.detail.parentElement === card.disclosure) card.disclosure.after(p.detail);
    p.age.textContent = view.running && view.at ? elapsedLabel(view.at) : ageLabel(view.at);
    p.age.title = view.at ? new Date(view.at).toLocaleString('tr-TR') : '';
    p.link.hidden = !view.url;
    if (!history) return;
    p.events.replaceChildren(
      ...view.history.map((event) => {
        const li = document.createElement('li'),
          time = document.createElement('time'),
          label = document.createElement('span');
        time.textContent = new Date(event.at).toLocaleTimeString('tr-TR');
        label.textContent = event.data.message;
        li.append(time, label);
        return li;
      }),
    );
    if (!view.history.length) {
      const li = document.createElement('li');
      li.textContent = 'Henüz kaydedilmiş işlem yok.';
      p.events.append(li);
    }
  }
  return {
    update(snapshot, history = false) {
      if (candidate !== snapshot?.workspace?.id) {
        candidate = snapshot?.workspace?.id;
        primary.disclosure.open = false;
        history = true;
      }
      draw(primary, snapshot.activity, history);
    },
  };
}
