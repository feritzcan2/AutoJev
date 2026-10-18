// Runs inside each document. Associations are bounded to one field/group;
// never borrow the first question from a surrounding form or another field.
export function installFormSemantics() {
  const clean = (s) => (s ?? '').replace(/\s+/g, ' ').trim().slice(0, 1000);
  // A styled checkbox/radio often lays its transparent native input over the
  // box it draws; that input is still the visible click surface.
  const drawnToggle = (e) => {
    if (e.tagName !== 'INPUT' || !['checkbox', 'radio'].includes(e.type)) return false;
    const box = e.parentElement;
    if (
      !e.checkVisibility({checkVisibilityCSS: true}) ||
      getComputedStyle(e).pointerEvents === 'none' ||
      !box?.checkVisibility({checkOpacity: true, checkVisibilityCSS: true})
    )
      return false;
    const r = e.getBoundingClientRect(),
      b = box.getBoundingClientRect();
    return (
      r.width >= 8 &&
      r.height >= 8 &&
      r.left >= b.left - 1 &&
      r.right <= b.right + 1 &&
      r.top >= b.top - 1 &&
      r.bottom <= b.bottom + 1
    );
  };
  window.__jobloopDrawnToggle = drawnToggle;
  const visible = (e) =>
    (e.checkVisibility({checkOpacity: true, checkVisibilityCSS: true}) || drawnToggle(e)) &&
    !e.closest('[inert],[aria-hidden="true"]');
  const controls =
    'input:not([type="hidden"]):not([type="submit"]):not([type="button"]),textarea,select,[role="combobox"],[role="radio"],[role="checkbox"]';
  const labelText = (e) =>
    !e
      ? ''
      : e.nodeType === Node.TEXT_NODE
        ? e.textContent
        : e.nodeType !== Node.ELEMENT_NODE ||
            e.matches(
              'input,textarea,select,script,style,.dropdown-container,[role="listbox"],[role="option"],[aria-hidden="true"]',
            )
          ? ''
          : [...e.childNodes].map(labelText).join(' ');
  const refNodes = (e, key) =>
    (e.getAttribute(key) ?? '')
      .split(/\s+/)
      .map((id) => e.getRootNode().getElementById?.(id) || document.getElementById(id));
  const refs = (e, key) => refNodes(e, key).map(labelText).join(' ');
  // Many forms draw the required asterisk with CSS (label::after { content: "*" }).
  const starred = (e) =>
    !!e &&
    [e, ...e.querySelectorAll('*')]
      .slice(0, 12)
      .some((n) => ['::before', '::after'].some((p) => /\*/.test(getComputedStyle(n, p).content)));
  // The field's own context; container is the largest ancestor holding no
  // other control, where its question was found.
  const own = (e) => {
    // An open dropdown may mark the page behind its popup aria-hidden, the
    // field included; text hidden only with the field still describes it.
    const hiddenBy = e.closest('[aria-hidden="true"]');
    const shown = (n) =>
      visible(n) ||
      (!!hiddenBy &&
        n.closest('[aria-hidden="true"]') === hiddenBy &&
        !n.closest('[inert]') &&
        (n.checkVisibility({checkOpacity: true, checkVisibilityCSS: true}) || drawnToggle(n)));
    const explicit = clean(
      refs(e, 'aria-labelledby') ||
        e.getAttribute('aria-label') ||
        [...(e.labels ?? [])].map(labelText).join(' '),
    );
    const choice =
      ['radio', 'checkbox'].includes(e.type) ||
      ['radio', 'checkbox'].includes(e.getAttribute('role'));
    let question = '',
      questionNode = null,
      container = null,
      help = clean(refs(e, 'aria-describedby'));
    for (let p = e.parentElement, depth = 0; p && depth < 5; p = p.parentElement, depth++) {
      if (p.matches('form,body,dialog,[role="dialog"]')) break;
      const peers = [...p.querySelectorAll(controls)].filter(shown);
      const sameGroup =
        choice &&
        peers.every(
          (n) =>
            n === e ||
            (n.type === e.type && e.name && n.name === e.name) ||
            p.matches('fieldset,[role="radiogroup"]'),
        );
      if (peers.some((n) => n !== e && !n.contains(e) && !e.contains(n)) && !sameGroup) break;
      container = p;
      if (p.matches('fieldset,[role="group"],[role="radiogroup"]'))
        question = clean(
          refs(p, 'aria-labelledby') ||
            p.getAttribute('aria-label') ||
            [...p.children].find((n) => n.tagName === 'LEGEND')?.textContent,
        );
      if (!question) {
        const preceding = [...p.children].filter(
          (n) =>
            !n.contains(e) &&
            !n.matches(controls) &&
            !n.querySelector(controls) &&
            shown(n) &&
            n.compareDocumentPosition(e) & Node.DOCUMENT_POSITION_FOLLOWING,
        );
        const headings = preceding.filter((n) =>
          n.matches('label,legend,h1,h2,h3,h4,h5,h6,[role="heading"]'),
        );
        const texts = (headings.length ? headings : preceding)
          .map((n) => clean(n.textContent))
          .filter(Boolean);
        if (texts.length) {
          question = texts[0];
          questionNode = (headings.length ? headings : preceding).find(
            (n) => clean(n.textContent) === question,
          );
          if (!help) help = texts.slice(1).join(' ');
        }
      }
      // A file input's own label is often its trigger verb ("Attach"); keep
      // walking to the group that names its purpose ("Resume/CV").
      if (e.type === 'file' && question === explicit) {
        question = '';
        questionNode = null;
      }
      if (question) break;
    }
    // A checkbox or radio without a label of its own is named by the text
    // drawn after it in its own container ("[ ] I agree to the Terms").
    let trailingNode = null;
    if (choice && !explicit && container)
      for (let p = e.parentElement; p && !trailingNode; p = p.parentElement) {
        trailingNode =
          [...p.children].find(
            (n) =>
              !n.contains(e) &&
              !n.matches(controls) &&
              !n.querySelector(controls) &&
              shown(n) &&
              e.compareDocumentPosition(n) & Node.DOCUMENT_POSITION_FOLLOWING &&
              clean(labelText(n)),
          ) ?? null;
        if (p === container) break;
      }
    const named = explicit || clean(labelText(trailingNode));
    const label = named || question || clean(e.getAttribute('placeholder')) || '';
    const required =
      e.required ||
      e.getAttribute('aria-required') === 'true' ||
      /\*/.test(`${label} ${question}`) ||
      [...refNodes(e, 'aria-labelledby'), ...(e.labels ?? []), questionNode].some(starred)
        ? true
        : e.getAttribute('aria-required') === 'false' ||
            /\boptional\b|isteğe bağlı/i.test(`${label} ${question}`)
          ? false
          : null;
    return {
      label,
      question: question || named,
      help,
      required,
      ...(choice ? {option: named || clean(e.value)} : {}),
      named: Boolean(named || question),
      explicitLabel: Boolean(explicit),
      choice,
      container,
      sources: [
        ...refNodes(e, 'aria-labelledby'),
        ...(e.labels ?? []),
        questionNode,
        trailingNode,
        e.hasAttribute('aria-label') ? e : null,
      ].filter(Boolean),
    };
  };
  // A second control of a compound field (amount + currency, area code +
  // number) often has no label of its own. It takes the field's question only
  // when the nearest container holding other controls has exactly one labelled
  // control and that label lies outside the labelled control's own branch.
  const grouped = (e) => {
    for (let p = e.parentElement, depth = 0; p && depth < 5; p = p.parentElement, depth++) {
      if (p.matches('form,body,dialog,[role="dialog"]')) return null;
      const peers = [
        ...p.querySelectorAll(
          `${controls},[aria-haspopup]:not([aria-haspopup="menu"],[aria-haspopup="false"])`,
        ),
      ].filter((n) => n !== e && !n.contains(e) && !e.contains(n) && visible(n));
      if (!peers.length) continue;
      const labelled = peers.map((n) => [n, own(n)]).filter(([, c]) => c.named);
      if (labelled.length !== 1 || labelled[0][1].choice) return null;
      const [peer, context] = labelled[0],
        branch = [...p.children].find((n) => n.contains(peer));
      return context.sources.some((n) => branch.contains(n)) ? null : context;
    }
    return null;
  };
  const context = (e) => {
    const field = own(e),
      group = field.named || field.choice ? null : grouped(e);
    if (!group) return field;
    const hint = clean(e.getAttribute('placeholder') || e.getAttribute('aria-placeholder'));
    return {
      ...field,
      label: hint ? `${group.label} (${hint})` : group.label,
      question: group.question,
      required: field.required ?? group.required,
      container: group.container,
    };
  };
  // A file input hidden behind its own drop zone: the nearest rendered,
  // focusable or clickable ancestor that holds no other file input.
  window.__jobloopFileSurface = (e) => {
    if (e.type !== 'file') return null;
    for (let p = e.parentElement, depth = 0; p && depth < 4; p = p.parentElement, depth++) {
      if (p.matches('form,body') || p.querySelectorAll('input[type=file]').length !== 1)
        return null;
      const r = p.getBoundingClientRect();
      if (
        visible(p) &&
        r.width > 1 &&
        r.height > 1 &&
        (p.tabIndex >= 0 || p.matches('label,[role="button"]'))
      )
        return p;
    }
    return null;
  };
  // A custom dropdown drawn as a plain button without ARIA popup markup: the
  // only button of a field group that carries its own question, and no file
  // input (an upload group's Attach button is not an answer).
  window.__jobloopPicker = (e) => {
    if (!(e.tagName === 'BUTTON' ? e.type === 'button' : e.getAttribute('role') === 'button'))
      return false;
    if (e.closest('[role="listbox"],[role="menu"],[role="option"],[role="tree"]')) return false;
    const field = context(e);
    if (!field.named || !field.container || field.explicitLabel) return false;
    const caption = clean(e.innerText);
    if (!caption || caption.length > 80 || caption === field.question) return false;
    return (
      field.container.querySelectorAll('button,[role="button"],a[href]').length === 1 &&
      !field.container.querySelector('input[type=file]')
    );
  };
  window.__jobloopFieldContext = (e) => {
    const {named, choice, container, sources, explicitLabel, ...field} = context(e);
    return field;
  };
  // Visible validation text tied to the field: its aria-errormessage or
  // aria-describedby targets, or an alert/error element in its own container.
  window.__jobloopFieldError = (e) => {
    const {container} = context(e);
    const candidates = [
      ...refNodes(e, 'aria-errormessage'),
      ...refNodes(e, 'aria-describedby'),
      ...(container?.querySelectorAll('*') ?? []),
    ].filter(
      (n) =>
        n &&
        !e.contains(n) &&
        (n.matches('[role="alert"]') ||
          /error|invalid/i.test(`${n.tagName} ${n.getAttribute('class') ?? ''}`)) &&
        !n.querySelector(controls) &&
        visible(n),
    );
    const texts = candidates
      .filter((n) => !candidates.some((m) => m !== n && m.contains(n)))
      .map((n) => clean(n.innerText));
    return [...new Set(texts.filter(Boolean))].join(' ');
  };
}
