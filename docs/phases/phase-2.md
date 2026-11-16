# Phase 2 — Leads and pipeline

## What gets built

- **Data:** `Lead`, `LeadDuplicate`, `LeadActivity`, `StageHistory`, `LossReason`, `OutboxEvent` (written now, published in Phase 4). Organization gets a `country` for phone normalisation; memberships get `isSample` and `preferences`.
- **API:** lead create, view, edit, archive, restore; list with search, filters, sort and cursor pagination; notes and the activity timeline; pipeline rename and stage configuration; loss reasons; assignable members; saved filters per user; delete sample data.
- **Rules (packages/domain):** normalisation (trim, lower-case email, E.164 phone from the org's country), duplicate keys, lead visibility and edit scope per role, stage-move rules (Lost needs a loss reason; Won needs a deal value when the org setting is on), stage configuration rules, SLA due time, the sample workspace generator.
- **Web:** leads table with filters that persist per user, kanban with drag-and-drop and keyboard moves and optimistic rollback, lead detail with timeline, notes and duplicate links, new-lead form, pipeline settings, a "Delete sample data" action.
- **Sample workspace:** every new organization starts with a fictional agency's 60 leads and 3 reps, all `isSample`. The 2 sample workflows follow in Phase 4, when workflows exist.

## Requirements covered

LEAD-01, LEAD-02, LEAD-03, LEAD-05, LEAD-06, PIPE-01, PIPE-02, PIPE-03, ORG-04.

## Tests

| Kind          | What                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Unit (domain) | Normalisation and its errors; duplicate keys; visibility and edit scope per role; stage-move rules; stage configuration rules; SLA due time; sample generator shape (60 leads, 3 reps, all sample)                                                                                                                                                                                                                                                      |
| Integration   | CRUD with strict schemas; field-level 422 for a bad email; duplicates found on email, phone and name + company and never merged; Rep scope (assigned + pool, setting on and off); timeline entries for every change, with "Workflow: name" actors; stage rules (cannot delete a stage with leads; Lost/Won rejected without reason/value); outbox event in the same transaction; sample delete leaves real data; cross-tenant cases for every new route |
| Performance   | LEAD-05: p95 under 300 ms across filtered list requests with 10,000 leads in one organization                                                                                                                                                                                                                                                                                                                                                           |
| E2E           | Board: drag a card, move one with the keyboard, roll back on an API error; table filters persist across reloads; axe on each screen                                                                                                                                                                                                                                                                                                                     |

## Gate

LEAD-05 p95 under 300 ms with 10,000 seeded leads; keyboard moves work on the board; deleting sample data leaves real data untouched.
