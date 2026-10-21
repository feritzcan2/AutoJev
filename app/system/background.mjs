import {
  app,
  autoUpdater,
  dialog,
  Menu,
  nativeImage,
  Notification,
  powerSaveBlocker,
  shell,
  Tray,
} from 'electron';
import path from 'node:path';
import {quickAnswer} from '../automation/question-forms.mjs';

// Windows and Linux login items pass this flag; macOS reports the login launch itself.
const BACKGROUND_ARG = '--background';

// Started by the login item: the window stays hidden until the user opens it.
export function openedInBackground() {
  if (process.platform === 'darwin') return app.getLoginItemSettings().wasOpenedAtLogin === true;
  return process.argv.includes(BACKGROUND_ARG);
}

const SCAN_PROBLEMS = {failed: 'failed', blocked: 'was blocked', timeout: 'timed out'};
const TRAY_QUESTIONS = 8;
const firstLine = (text, max) => {
  const line = String(text ?? '')
    .split('\n')[0]
    .trim();
  return line.length > max ? line.slice(0, max - 1) + '…' : line;
};

// Keeps the app running after its window closes: a menu bar (tray) icon, no
// App Nap while work runs, an optional login item, question notifications
// that take the answer directly and notifications for scans that hit a problem.
export function startBackgroundMode({
  root,
  window,
  quitting,
  activity,
  workspaceTitle,
  answer,
  openWorkspace,
}) {
  const mac = process.platform === 'darwin',
    place = mac ? 'menu bar' : 'system tray',
    // An unpackaged build would register the Electron binary, not AutoJob.
    loginSupported = app.isPackaged && ['darwin', 'win32'].includes(process.platform),
    loginOptions = mac ? {} : {args: [BACKGROUND_ARG]};
  let openAtLogin = loginSupported && app.getLoginItemSettings(loginOptions).openAtLogin,
    closingForUpdate = false,
    toldOnce = false,
    blocker = null,
    menuKey = '',
    // macOS refuses notifications until the user allows them for the app.
    notificationsBlocked = false;
  const notifications = new Map(),
    // Questions already shown in a notification during this app session.
    notified = new Set(),
    // One notification per workspace; later scan problems update its count.
    scanProblems = new Map();
  const show = () => {
    const current = window();
    if (!current || current.isDestroyed()) return;
    current.show();
    current.focus();
  };
  const open = (id, view) => {
    show();
    openWorkspace(id, view);
  };
  // The updater closes the windows itself before installing.
  autoUpdater.on('before-quit-for-update', () => {
    closingForUpdate = true;
  });
  window().on('close', (event) => {
    if (quitting() || closingForUpdate) return;
    event.preventDefault();
    window().hide();
    // Only the menu bar icon stays; the Dock icon returns with the window.
    if (mac) app.dock?.hide();
    if (toldOnce || !Notification.isSupported()) return;
    toldOnce = true;
    new Notification({
      title: 'AutoJob keeps running',
      body: `Work continues in the background. Quit from the ${place} icon.`,
      silent: true,
    }).show();
  });
  app.on('activate', show);
  window().on('focus', () => scanProblems.clear());
  // Every way of opening the window (menu, notification, second launch) brings the Dock icon back.
  window().on('show', () => {
    if (mac && !app.dock?.isVisible())
      app.dock?.show().then(() => {
        // Without a Dock icon the app was not active; bring it to the front.
        app.focus({steal: true});
        if (!window()?.isDestroyed()) window().focus();
      });
  });
  // Opened at login: the window starts hidden, so does the Dock icon.
  if (mac && !window().isVisible()) app.dock?.hide();

  const tray = new Tray(
    nativeImage.createFromPath(
      path.join(root, mac ? 'app/assets/trayTemplate.png' : 'app/assets/tray.png'),
    ),
  );
  if (!mac) tray.on('click', show);
  function setOpenAtLogin(value) {
    if (!loginSupported)
      throw Error('Opening at login is available in the installed app on macOS and Windows.');
    app.setLoginItemSettings({...loginOptions, openAtLogin: value});
    openAtLogin = app.getLoginItemSettings(loginOptions).openAtLogin;
    update();
    return status();
  }
  const status = () => ({supported: loginSupported, openAtLogin, place});

  // A waiting question in the tray menu: short choices answer it directly.
  function questionMenu({workspaceId, question}) {
    const quick = quickAnswer(question),
      fields = question.fields ?? [];
    return {
      label: `${workspaceTitle(workspaceId)}: ${firstLine(question.text, 50)}`,
      submenu: [
        {label: firstLine(question.text, 80), enabled: false},
        ...(fields.length === 1 ? [{label: firstLine(fields[0].label, 80), enabled: false}] : []),
        {type: 'separator'},
        ...(quick?.options ?? []).map((option) => ({
          label: option,
          click: () => send(workspaceId, question, quick.choose(option)),
        })),
        {label: 'Open in AutoJob', click: () => open(workspaceId)},
      ],
    };
  }

  function update() {
    const {running, questions} = activity();
    // Questions asked while the window was in front, or before a restart, get
    // their notification once the window is in the background.
    if (!window()?.isFocused())
      for (const [questionId, {workspaceId, question}] of questions)
        if (!notified.has(questionId)) questionAsked(workspaceId, question);
    // Without App Nap the scheduler, Jev waits and agent turns keep their pace.
    // The assertion also stops idle sleep, so it lasts only while work runs.
    if (running && blocker === null) blocker = powerSaveBlocker.start('prevent-app-suspension');
    if (!running && blocker !== null) {
      powerSaveBlocker.stop(blocker);
      blocker = null;
    }
    for (const [questionId, notification] of notifications)
      if (!questions.has(questionId)) {
        notifications.delete(questionId);
        notification.close();
      }
    const summary =
      [
        running ? `${running} task${running === 1 ? '' : 's'} running` : '',
        questions.size
          ? `${questions.size} question${questions.size === 1 ? '' : 's'} waiting`
          : '',
      ]
        .filter(Boolean)
        .join(' · ') || 'Nothing running';
    const waiting = [...questions.values()].sort(
        (a, b) => a.question.createdAt - b.question.createdAt,
      ),
      key = `${summary}|${openAtLogin}|${notificationsBlocked}|${[...questions.keys()].join()}`;
    if (key === menuKey) return;
    menuKey = key;
    tray.setToolTip(`AutoJob · ${summary}`);
    tray.setContextMenu(
      Menu.buildFromTemplate([
        {label: summary, enabled: false},
        ...waiting.slice(0, TRAY_QUESTIONS).map(questionMenu),
        ...(waiting.length > TRAY_QUESTIONS
          ? [{label: `${waiting.length - TRAY_QUESTIONS} more in AutoJob…`, click: show}]
          : []),
        ...(notificationsBlocked && mac
          ? [
              {type: 'separator'},
              {
                label: 'Notifications are off · Allow in System Settings…',
                click: () =>
                  shell.openExternal(
                    'x-apple.systempreferences:com.apple.Notifications-Settings.extension',
                  ),
              },
            ]
          : []),
        {type: 'separator'},
        {label: 'Open AutoJob', click: show},
        ...(loginSupported
          ? [
              {
                label: 'Open at login',
                type: 'checkbox',
                checked: openAtLogin,
                click: (item) => setOpenAtLogin(item.checked),
              },
            ]
          : []),
        {type: 'separator'},
        {label: 'Quit AutoJob', click: () => app.quit()},
      ]),
    );
  }
  update();
  const timer = setInterval(update, 5000);

  async function send(id, question, value) {
    notifications.delete(question.id);
    try {
      await answer(id, question.id, value);
    } catch (error) {
      dialog.showErrorBox('Answer not saved', String(error.message ?? error));
      open(id);
    }
    update();
  }
  function watch(notification) {
    notification.on('failed', () => {
      notificationsBlocked = true;
      update();
    });
    notification.on('show', () => {
      notificationsBlocked = false;
    });
  }
  function questionAsked(id, question) {
    if (!Notification.isSupported() || window()?.isFocused()) return;
    notified.add(question.id);
    const quick = quickAnswer(question),
      fields = question.fields ?? [];
    const notification = new Notification({
      title: workspaceTitle(id),
      ...(fields.length === 1 ? {subtitle: fields[0].label} : {}),
      body: question.text.slice(0, 300),
      ...(quick?.reply ? {hasReply: true, replyPlaceholder: 'Your answer'} : {}),
      ...(quick?.options ? {actions: quick.options.map((text) => ({type: 'button', text}))} : {}),
    });
    // Kept referenced so its reply and action events still arrive.
    notifications.set(question.id, notification);
    notification.on('click', () => {
      notifications.delete(question.id);
      open(id);
    });
    notification.on('reply', (details, reply) =>
      send(id, question, quick.reply(details?.reply ?? reply)),
    );
    notification.on('action', (details, index) =>
      send(id, question, quick.choose(quick.options[details?.actionIndex ?? index])),
    );
    watch(notification);
    notification.show();
  }

  function scanFailed(run) {
    if (!Notification.isSupported() || window()?.isFocused()) return;
    const id = run.automationId,
      previous = scanProblems.get(id),
      count = (previous?.count ?? 0) + 1;
    previous?.notification.close();
    let site = 'A source';
    try {
      site = new URL(run.sourceUrl ?? run.sources?.[0]).host;
    } catch {}
    const notification = new Notification({
      title: `${workspaceTitle(id)} · scan ${SCAN_PROBLEMS[run.status] ?? run.status}`,
      body: (
        (count > 1 ? `${count} scans had problems. Latest: ` : '') +
        `${site}${run.summary ? ': ' + run.summary : ''}`
      ).slice(0, 300),
    });
    scanProblems.set(id, {notification, count});
    watch(notification);
    notification.on('click', () => {
      scanProblems.delete(id);
      open(id, 'sources');
    });
    notification.show();
  }

  return {
    questionAsked,
    scanFailed,
    status,
    setOpenAtLogin,
    dispose() {
      clearInterval(timer);
      if (blocker !== null) powerSaveBlocker.stop(blocker);
      tray.destroy();
    },
  };
}
