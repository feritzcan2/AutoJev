# Telegram

AutoJev can send every newly discovered job, application receipts and pending questions to each candidate’s private Telegram chat. Candidates can answer text, number, date, boolean, single-choice and multiple-choice questions, review their answers, then submit them through the same handler used by the desktop UI.

## Setup

1. Create a bot with [BotFather](https://t.me/BotFather) using `/newbot`.
2. In AutoJev, select the candidate, open **Bildirimler → Telegram botu**, enter that candidate's bot token and choose **Kaydet ve aç**.
3. Choose **Adayı Telegram’a bağla**. Send the generated link to that candidate. It expires after ten minutes and can be used once.
4. The candidate opens the link and presses **Başlat**. Their name appears in the connection panel. Repeat for another candidate with their own bot token. The same Telegram account can connect to different candidates through different bots; within one bot, an account belongs to one candidate.

The sidebar has a **Bildirimler** page for bot setup, candidate pairing, notification preferences and delivery status. The candidate profile and **Yapılandırma → Bildirimler** also link to this page. Bot settings, enabled state and notification preferences belong to the selected candidate. Switching candidates clears unsaved token input and loads that candidate's bot identity. Saving another bot disconnects only the selected candidate's old pairing; pair them again with the new bot. Rotating the token for the same bot preserves its links, drafts and delivery history.

Notification preferences are separate for new jobs, application receipts and questions. **Her yeni ilanı gönder** is on by default, including for existing connections. Every newly recorded job is queued immediately, regardless of score or application eligibility. The card includes company, role, location, the score if already available, and an **İlanı aç** button. Ranking updates or finding the same job again do not create a second new-job notification. Existing unanswered questions are queued when linking; historical jobs and application receipts are not backfilled automatically.

### Send existing unsent jobs

In the connected candidate’s Telegram settings, **Gönderilmemiş ilanları gönder** queues every job whose application is not completed and whose job card has not been delivered by the current bot. Submitted, already-submitted and manually submitted applications are excluded. There is no score filter or limit on the number of queued jobs. Each job is sent in its own message through the existing paced queue; the pending count updates as it drains. Jobs completed while waiting are checked again and skipped before sending.

This explicit action works even if automatic new-job notifications are off. It leaves their preference unchanged. Repeated clicks do not duplicate pending or delivered cards; failed or suppressed cards can be queued again. Sent cards, including those deleted with **Sil**, remain in a per-candidate, per-bot delivery history. That history survives disconnecting and reconnecting or rotating the same bot’s token. A different bot has its own history. Existing sent-card receipts are migrated into this history; receipts already removed by an older version cannot be reconstructed. Deleting the candidate’s workspace removes the history.

### Status changes in existing messages

Job cards start with a bold status and a colored symbol: blue for found/queued, purple for processing, orange for waiting/uncertain, green for ready/submitted and red for withdrawn. The role and company are bold on separate lines, followed by location and a bold suitability score. Listing text is escaped using Telegram's [HTML formatting](https://core.telegram.org/bots/api#html-style). [Button styles](https://core.telegram.org/bots/api#inlinekeyboardbutton) make **İlanı aç** blue, **Öncelikli başvur** green and **Sil · Vazgeç** red.

AutoJev uses [editMessageText](https://core.telegram.org/bots/api#editmessagetext) to update the original card as the application is prepared, submitted, blocked, completed or skipped. Manual submissions are labeled **kullanıcı beyanı**. Ranking replaces **Henüz puanlanmadı** with the numeric score on the same card. Existing saved job cards receive the new layout through the paced edit queue after restart. Application receipt notifications remain controlled by their separate preference.

Already delivered cards stay current even when new-job notifications are off, including cards sent with the backfill button. Rapid changes are combined into the latest state, and unchanged text does not trigger an API request. Edit state and retry delays survive restarts; saved older cards gain the status line when AutoJev next runs. Settings include pending and failed edits in the message counts and retry action.

Edits use the original message ID and never fall back to sending another card. Deleted or unavailable messages stay removed. Disconnecting a candidate stops further edits to their messages; previously removed message IDs cannot be reconstructed after reconnecting.

### Question answers

Answers saved on desktop or through Telegram update the original question card to **✅ Yanıtlandı**, with a summary of the saved answer. The **Yanıtla** button is removed. Repeated cards opened through `/sorular` and editable form prompts also update, while unfinished Telegram drafts and unsent prompts are invalidated. Closed application questions show **Soru kapandı**.

Question edits take priority over job-card updates and use the same durable retry queue. Existing saved question messages are migrated on restart, including answers whose events were processed by an older version. Deleted messages stay deleted. Previously sent question cards continue to reflect answers when new question notifications are disabled. Telegram's [editing restrictions](https://core.telegram.org/bots/api#updating-messages) prevent editing ForceReply prompts used for text entry; their original question card still updates and their draft can no longer submit another answer.

## Candidate commands

### Queue an application from Telegram

A new, blocked or prepared job card that has no explicit queue request and is not being processed shows **Öncelikli başvur**. The button uses the desktop application's queue handler and starts or resumes the candidate's agent when possible. It applies only to the linked candidate, the sending bot and that exact message. Repeated clicks keep the same request. The card updates to **Başvuru sırasında** or the current processing state, and the button disappears.

The clicked card gets priority in the edit queue as soon as the application request is saved, while browser/agent startup continues. Updates use the same message ID and respect Telegram rate limits. A slow startup or a backlog of other cards does not put this card at the end of the queue. Periodic and click-triggered deliveries are serialized so an older edit cannot overwrite the new status.

An explicit click authorizes submission for that job and puts it ahead of automatic applications, scoring and searches. Manual requests are processed in queue order by the next available suitable worker, without interrupting an active task. They bypass profile research/prepare modes, source find_only/prepare modes, scoring requirements and the shared campaign target. Other jobs keep the saved policy. A closed or inaccessible assessment can be checked again against the live listing.

The request survives restart and candidate replies. Uncertain applications show **Öncelikli doğrula** in the app and Telegram. This queues the existing result for priority verification, even at the campaign target, without authorizing form work or another send. Completed, duplicate and stopped applications retain their submission safeguards. Retrying a blocked application preserves its saved form and unanswered questions; queueing supplies no missing facts or privacy/legal consent.

Older saved job cards receive the button through the normal paced edit queue after updating AutoJev. If the browser or agent cannot start, the application remains queued and the callback reports the reason.

### Pinned applications

Queued and active application cards are automatically added to the chat's [pinned messages](https://core.telegram.org/bots/api#pinchatmessage). They remain pinned while queued or active; completion, withdrawal or leaving those states removes the pin with [unpinChatMessage](https://core.telegram.org/bots/api#unpinchatmessage) for that exact message. Other pinned messages are left alone. This works in the candidate's private bot chat and continues even when new-job notifications are off.

Existing cards are checked on startup. Pin state and retries survive restarts, use each bot's rate limits and appear in the Telegram settings' pending/failed counts. Pin failures do not block status edits. Deleted cards are not recreated, and disconnecting a candidate stops further updates to that chat.

### Commands

- `/start`, `/help`: instructions.
- `/durum`: application counts and pending question count.
- `/sorular`: the first ten unanswered questions.
- `/iptal`: discard the current answer draft.
- `/baglantiyikes`: remove the connection and pending deliveries.

Use the buttons for choices and Telegram’s **Reply** action on the current prompt for text, numbers and dates. A final review step sends the complete answer. `/sorular` can reopen a question. Resolved or changed questions and buttons from older steps cannot submit an outdated answer. Login, CAPTCHA and other actions that need the browser still happen on the computer; Telegram can communicate the candidate’s response.

Job and application receipt cards include **🗑 Sil · Vazgeç**. The button marks the application **Vazgeçildi** in AutoJev, stops its active campaign task through the same action used on desktop, resolves its pending application questions and deletes that Telegram message. The job record and delivery history remain. Repeated callbacks do not withdraw twice or resend the message. Older job cards with the **Sil** label use this same action. Question cards keep their separate **🗑 Sil** action: it removes only the question notification and preserves the question and answer draft.

Deletion is restricted to the linked sender, candidate, bot and exact recorded message. If saving the withdrawal fails, the message stays available for retry. Telegram’s [deleteMessage API](https://core.telegram.org/bots/api#deletemessage) only allows deleting messages younger than 48 hours. If Telegram cannot delete a job card, AutoJev still records **Vazgeçildi** and updates its status on the surviving card. The callback explains the outcome; the user can remove an old message in Telegram itself. Errors appear as alerts without adding another chat message.

## Runtime and storage

The desktop app uses [getUpdates long polling](https://core.telegram.org/bots/api#getupdates), so it needs no public server or inbound port. AutoJev must be open and online. Telegram retains undelivered incoming updates for at most 24 hours; after a longer outage a candidate may need to send their reply again. A configured webhook is rejected without changing it; use a dedicated bot.

Each bot token is encrypted with Electron `safeStorage` and stored in the candidate SQLite database's `telegram_configs` table. It is excluded from renderer status, profiles, agent context and logs. Administrative Telegram IPC endpoints are available only to the desktop renderer. Telegram is the remote access channel; AutoJev does not serve a local-network web client.

Older shared `telegram.json` settings migrate to candidates with an existing Telegram link or pending pairing (or the sole candidate when there is only one). Existing links, drafts, offsets, sent messages and history are preserved, and the old configuration file is removed after migration. Unrelated candidates do not inherit that bot. Multiple candidates can still use a shared bot with separate Telegram accounts; there is one polling worker per bot. Polling offsets and rate limits are isolated by bot. Disabling or changing one candidate's bot does not disable another candidate.

Pairing tokens are stored as hashes. Links, drafts, update offsets and the outgoing queue live in the candidate SQLite database. Workspace deletion removes the candidate’s Telegram data. Both private chat ID and sender user ID must match the connection for every action. Application receipts distinguish observed submissions, existing submissions and candidate-reported submissions.

Failed network deliveries retry with backoff; rate limits respect Telegram’s `retry_after`. Permanent failures appear in settings with a retry action. Sending is paced per chat. Telegram has no idempotency key for `sendMessage`: a crash or network timeout after Telegram accepts a message but before AutoJev records its message ID can result in a duplicate notification. Repeated callbacks cannot record the same answer twice.

## Validation

`node --test tests/telegram*.test.mjs` tests pairing, isolation, form answers, stale replies, durable state, retries, independent bot tokens, shared-account routing and migration. `pnpm build && node scripts/smoke-telegram.mjs` runs the real Electron UI and IPC with two fake Telegram bots in a temporary workspace, including switching candidates during a token save; it sends no real Telegram messages.
