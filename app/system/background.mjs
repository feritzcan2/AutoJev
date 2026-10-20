import {app, autoUpdater, Menu, nativeImage, Notification, powerSaveBlocker, Tray} from 'electron';
import path from 'node:path';
import {quickAnswer} from '../automation/question-forms.mjs';

// Windows and Linux login items pass this flag; macOS reports the login launch itself.
const BACKGROUND_ARG = '--background';

// Started by the login item: the window stays hidden until the user opens it.
export function openedInBackground() {
  if (process.platform === 'darwin') return app.getLoginItemSettings().wasOpenedAtLogin === true;
  return process.argv.includes(BACKGROUND_ARG);
}

// Keeps the app running after its window closes: a menu bar (tray) icon, no
// App Nap while work runs, an optional login item and question notifications
// that take the answer directly.
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
    menuKey = '';
  const notifications = new Map();
  const show = () => {
    const current = window();
    if (!current || current.isDestroyed()) return;
    current.show();
    current.focus();
  };
  const open = (id) => {
    show();
    openWorkspace(id);
  };
  // The updater closes the windows itself before installing.
  autoUpdater.on('before-quit-for-update', () => {
    closingForUpdate = true;
  });
  window().on('close', (event) => {
    if (quitting() || closingForUpdate) return;
    event.preventDefault();
    window().hide();
    if (toldOnce || !Notification.isSupported()) return;
    toldOnce = true;
    new Notification({
      title: 'AutoJob keeps running',
      body: `Work continues in the background. Quit from the ${place} icon.`,
      silent: true,
    }).show();
  });
  app.on('activate', show);

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

  function update() {
    const {running, questions} = activity();
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
    const key = `${summary}|${openAtLogin}`;
    if (key === menuKey) return;
    menuKey = key;
    tray.setToolTip(`AutoJob · ${summary}`);
    tray.setContextMenu(
      Menu.buildFromTemplate([
        {label: summary, enabled: false},
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
      const failed = new Notification({
        title: 'Answer not saved',
        body: String(error.message ?? error).slice(0, 300),
      });
      failed.on('click', () => open(id));
      failed.show();
    }
  }
  function questionAsked(id, question) {
    if (!Notification.isSupported() || window()?.isFocused()) return;
    const quick = quickAnswer(question);
    const notification = new Notification({
      title: workspaceTitle(id),
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
    notification.show();
  }

  return {
    questionAsked,
    status,
    setOpenAtLogin,
    dispose() {
      clearInterval(timer);
      if (blocker !== null) powerSaveBlocker.stop(blocker);
      tray.destroy();
    },
  };
}
