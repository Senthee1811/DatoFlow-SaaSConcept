# Phase 3 — Tasks and the next-step rule

## What gets built

- **Data:** `Task` (lead, title, type, due date-time, priority, assignee, status) and `Notification` (in-app notifications, plus the delivery record for every reminder and digest, keyed so each is sent once). `Lead` gets `nextStepDueAt` (its earliest open next step) and `stuckAt` (when the radar flagged it).
- **API:** `GET/POST …/tasks`, `PATCH …/tasks/:id`, `GET …/me/day`; touches (call, email, WhatsApp, meeting) on `POST …/leads/:id/activities` with the next-step rule; notification centre (`GET …/notifications`, unread count, mark one or all read); reminder preferences per member.
- **Rules (packages/domain):** the next-step rule (TASK-02) with the "warn only" setting, overdue next steps, the full stuck definition (stage SLA or overdue next step), My day ordering, the reminder key (task + type + due time), the reminder window (15 minutes before due), the 08:00 digest time in the organization's timezone, and the daily email budget (digests go first).
- **Worker:** three BullMQ job schedulers that survive restarts:
  - **Radar**, every 5 minutes: flags leads that became stuck with no other change and clears ones that recovered. The API runs the same check on every change.
  - **Reminders**, every minute: writes an in-app reminder and, when the member wants it and the plan includes email reminders, an email reminder 15 minutes before each next step is due.
  - **Digest**, every minute: one email per member at 08:00 in the organization's timezone with their overdue next steps, today's next steps and their stuck leads.
    Every delivery is a row with a unique key, claimed before it is sent, so a restart never sends one twice.
- **Web:** My day, next steps and "Log a touch" on the lead page (a touch on an open lead saves only with a next step or a move to Won or Lost), a notification centre with an unread count that polls every 30 s, reminder preferences on the Account page, the "warn only" switch in Settings, and a next-step column in the leads table.
- **Sample workspace:** open sample leads get next steps assigned to the sample reps, some overdue, so the radar and My day have something to show.

## Requirements covered

TASK-01, TASK-02, TASK-03, TASK-04, TASK-05, NOT-01.

## Tests

| Kind          | What                                                                                                                                                                                                                                                                                                                                                                                         |
| ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Unit (domain) | Next-step rule (require, warn, Won/Lost exemption, closed leads); overdue and stuck reasons; My day buckets and order; reminder key and window; digest time across timezones and daylight saving; email budget                                                                                                                                                                               |
| Integration   | Task CRUD with an assignee from the same organization only; Rep scope on tasks; 422 `NEXT_STEP_REQUIRED` and the warn-only setting; touch plus Won/Lost; radar on change and on the 5-minute sweep; My day order; reminders and digest sent once, including across a worker restart and an interrupted send; daily email budget; notification centre; cross-tenant cases for every new route |
| E2E           | UF-8 (a rep's day: My day order, log a call, the next step is required, reminder in-app and by email) and UF-2 (lead lifecycle: through the open stages, Won and Lost, the radar flags a lead, a manager reassigns it); axe on each new screen                                                                                                                                               |

## Gate

UF-8 and UF-2 E2E pass; each reminder is sent exactly once across a worker restart.
