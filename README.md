# OnePort 365 — Service Delivery Field Channel (MVP)

This repository contains two front-end prototypes that operate against **one
shared milestone record**, per the Service Delivery Field Channel product
spec:

| File | Role |
|---|---|
| `freight-operations-workspace.html` | **Admin Portal** — desktop, office-based shipment/service-delivery management. |
| `index.html` | **Field Channel (new)** — mobile-first execution surface for Operations Staff. |
| `shared/milestone-store.js` | The shared milestone record both surfaces read and write against. |

> One workflow. One milestone record. Multiple channels of interaction.

## Why a shared store, not two mock datasets

The spec's core requirement (sections 11–12) is that the Admin Portal and
Field Channel must never maintain independent milestone states. The
original Admin Portal prototype generated its milestones locally, in
memory, with `Math.random()`-based ids on every page load — there was
nothing for a second surface to share.

`shared/milestone-store.js` replaces that with a single authoritative
milestone record, persisted to `localStorage` and shared by both HTML
files via a `<script src="shared/milestone-store.js">` include. The Admin
Portal's `buildShipmentDetail()` no longer invents milestones; it asks the
store for them (`MilestoneStore.sync.getMilestonesForShipment(jobRef)`),
and its Reassign / Mark Complete actions call the store's mutation
functions instead of mutating a local array directly. This is the
"shared source of truth" from spec section 11.2 — not two databases that
periodically reconcile.

Cross-tab/cross-app updates are propagated via `BroadcastChannel` (with
the native `storage` event as a fallback), and both apps call
`MilestoneStore.subscribe(...)` to revalidate and re-render when a change
arrives — this is the "revalidation" mechanism spec section 36 asks for.
Neither app treats its last-rendered state as authoritative; every
completion is validated against the store immediately before it mutates
anything (spec section 28).

**This is a prototype-grade backend**, not a production one. In a real
deployment, everything inside `MilestoneStore.*` gets replaced with real
HTTP calls to the existing Service Delivery backend — the function names
were chosen to mirror the conceptual REST endpoints in spec section 27:

```
getMyMilestones(userId)     -> GET  /milestones?assigned_to=me
getMilestone(id)            -> GET  /milestones/{id}
completeMilestone(id, ...)  -> POST /milestones/{id}/complete
reassignMilestone(...)      -> existing Admin assignment APIs (spec 27.4)
addComment(id, ...)         -> POST /milestones/{id}/comments
updateShipmentTeam(...)     -> existing Admin team-assignment APIs
getNotifications(userId, ...)      -> GET  /notifications?assigned_to=me
getUnreadNotificationCount(userId) -> GET  /notifications/unread-count
markNotificationRead(id, userId)   -> POST /notifications/{id}/read
```

## Running it

Both files are static HTML/JS — no build step. For full-fidelity
cross-tab sync testing (BroadcastChannel/`storage` events need a real
origin), serve the folder rather than opening the files directly:

```bash
python3 -m http.server 8080
# Admin Portal:  http://localhost:8080/freight-operations-workspace.html
# Field Channel: http://localhost:8080/index.html
```

Open both in the same browser to see completions and reassignments made
in one reflect live in the other, with no reload.

Opening the files directly via `file://` still works for each app
individually (per-tab), but same-origin cross-tab sync isn't guaranteed
by browsers for `file://` URLs.

### Simulating a network failure

Append `?simulateOffline=1` to `index.html`'s URL to make every
store call reject, so you can see the "Unable to update this milestone.
Please check your connection and try again." error path (spec section
30–31) without needing real network conditions.

## Field Channel — what's implemented

Following the spec's recommended screens (section 42) and delivery
sequence (section 43):

- **Sign-in (simulated)** — a login form (Staff Member + Password) that
  stands in for the org's real authentication (spec section 26). The
  password field accepts anything and isn't checked against anything —
  only the selected staff member matters. A real build replaces this with
  SSO/org auth and derives the same stable internal user id server-side —
  the client never gets to declare its own identity for a completion
  (`completeMilestone` takes the acting user id, but a real backend would
  derive it from the session/token, not trust a client-supplied value).
- **Bottom tab navigation** — Tasks / Expense / More. Tasks is the To-Dos
  flow described below. Expense is a placeholder screen with a "Request
  Expense" button that isn't wired up yet (shows a toast, same convention
  the Admin Portal already uses for unbuilt actions). More is an
  intentional dead end for this MVP — tapping it doesn't navigate
  anywhere.
- **To-Dos** — milestones assigned to the signed-in user, sorted by due
  date (earliest first). A completed milestone is not shown here at all —
  once done, it's off the Field Channel, so there's no separate
  "Completed" filter. A search box filters the list by shipment number,
  customer name, or task name. Each card shows the customer, the
  shipment's transport type, the route, and an SLA indicator (Healthy /
  At Risk / Breached, both date and time, derived from the due date)
  alongside "Mark Complete" and "Flag" actions (icon + text, in that
  left-to-right order), so a milestone can be completed or flagged
  straight from the list without opening it. The "You're all caught up"
  empty state is from spec section 35. There's no manual refresh button —
  the list already revalidates on load, on return to this screen, and
  whenever the store notifies of a change elsewhere (spec section 36), so
  a button that does the same thing on demand was redundant.
- **Milestone Detail** — an SLA/status banner (sharing a row with the
  "Blocker flagged" banner when the milestone has one, instead of
  stacking), the milestone name, the shipment context needed to execute
  it (reference, customer, shipment type, transport, B/L or AWB number,
  route, location), and a collapsible comment history (see "Flag a
  blocker" below). No shipment/customer subtitle under the milestone name
  — that's already in the info card right below it. "Mark as Complete"
  and "Flag" sit side by side at the bottom, same order as the To-Dos
  card, always reachable without scrolling — pinned below the
  independently-scrollable content, never the page itself. The Flag
  button always looks the same regardless of whether the milestone
  already has comments — flagging is a repeatable action, not a toggle,
  so it doesn't get an "active" state. Opened only for a milestone that
  is still `NOT_STARTED` and assigned to the signed-in user; if it's
  already been completed or
  reassigned elsewhere by the time the screen loads, the app shows the
  message and returns to To-Dos rather than rendering a dead page.
- **Completion confirmation** — a bottom sheet with an optional note,
  requiring a deliberate second action before the mutation fires (spec
  section 16.2). Reachable from either the To-Dos card or the Detail
  screen; either path lands back on To-Dos afterward, since a completed
  milestone is no longer accessible here.
- **Flag a blocker** — a "Flag" button, reachable from the To-Dos card or
  the Detail screen, opens a sheet for an optional note describing what's
  blocking the milestone. This is deliberately *not* a status change —
  MVP has only `NOT_STARTED`/`COMPLETED` (spec sections 7–8) — so flagging
  appends a timestamped comment to the milestone's history rather than
  introducing a `BLOCKED` state or overwriting a single note; a milestone
  can carry a running discussion of blockers over time. A flagged
  milestone also shows a banner on Detail and a "Flagged" pill on its
  To-Dos card — visible everywhere through the same shared record, not a
  Field-Channel-only note.
- **Comments** — a separate, general-purpose "Comment" button on the
  Detail screen, independent of Flag: anyone who opens the milestone can
  add a plain note, whether or not it's currently assigned to them, since
  this is a shared discussion rather than an execution action. It's a
  flat, append-only list — no delete, no reply/threading, no @ mentions.
  The Detail screen renders one merged "Comments" feed combining Flag
  notes and plain comments (`MilestoneStore.getActivity`), newest first;
  it's collapsed by default but always shows the most recent entry, with
  older ones revealed by expanding it. Every entry shows its author and
  timestamp — a flag-sourced entry also gets a "Blocker flagged by…"
  label so the two kinds stay visually distinct within the one feed.
- **Concurrency & idempotency** — before completing, the app re-fetches
  the milestone from the store; if it's been reassigned, already
  completed, or no longer exists, it shows the corresponding message from
  spec section 31 instead of pretending the action succeeded. The app
  also suppresses its own cross-tab revalidation while a completion it
  triggered is in flight, so that revalidation can't race the completion
  and show a spurious "already completed" message for a request that
  actually just succeeded.
- **Notifications** — a bell in the To-Dos topbar, badged with the unread
  count, opens a dedicated Notifications screen. Every notification here
  is sourced from something that happened on the Admin Portal, never from
  the Field Channel's own actions, and only ever about *this* user's own
  milestones or team membership — nobody is notified about someone else's
  work, and a milestone with no assignee notifies no one:
  - Someone other than you comments on a milestone assigned to you (never
    fired for your own comment on your own milestone).
  - You're added to or removed from a shipment's team.
  - Your role on a shipment's team changes (upgraded to Owner, or reduced
    to Supporting).
  - One of your milestones breaches its SLA — detected by a lightweight
    periodic check (`checkSlaBreaches`, every 60s) that simulates a
    server-side job; it's idempotent per milestone, so it can safely run
    in more than one open tab without double-notifying anyone.
  Each message is intentionally short — one line, no body text. Tapping a
  comment notification opens that milestone's Detail screen (the closest
  thing to "the shipment" the Field Channel has) and marks it read on the
  way in; every other kind is purely informational, so a tap just marks it
  read in place. The badge and the open notifications list both update
  live via the same `MilestoneStore.subscribe` mechanism everything else
  in this app already uses — no polling, no manual refresh. The list loads
  10 at a time with a "Load more" button rather than infinite scroll: on a
  small screen, an explicit tap is easier to reason about (and to recover
  from) than content that shifts under your thumb as you scroll.
  - **Seeing every notification type without triggering them yourself:**
    `seedDemoNotifications` (in `shared/milestone-store.js`) plants one
    example of each non-breach type on fresh demo data, consistent with
    each shipment's actual seeded team so nothing on screen contradicts
    itself. `sla_breached` isn't hand-seeded — it appears on its own,
    for whichever milestones are already overdue the day you load the
    app — so which profiles show it can shift day to day; the rest are
    fixed. Sign in as each to see:
    | Profile | comment | team_added | team_removed | role_updated |
    |---|---|---|---|---|
    | u1 — James Adewale | ✓ | | | ✓ (reduced) |
    | u2 — Sarah Adeyemi | ✓ | | | ✓ (reduced) |
    | u3 — Michael Ibe | ✓ | | ✓ | |
    | u4 — Titi Aluko | ✓ | ✓ | | |
    | u5 — Chidi Eze | ✓ | ✓ | | ✓ (upgraded) |
    | u6 — Ada Nwosu | ✓ | ✓ | ✓ | |
    Already have older demo data in this browser? These only seed into a
    *fresh* store — run `MilestoneStore.resetDemoData()` from the console
    (either app) to reseed and pick them up.

## Admin Portal — what changed

- Milestones for a shipment are now read from `MilestoneStore` instead of
  being generated inline.
- Reassign and Mark Complete route through
  `MilestoneStore.reassignMilestone` / `completeMilestone`.
- The open shipment's Service Delivery tab live-refreshes when the store
  notifies of a change — e.g. a Field Channel completion shows up on
  screen without the Admin needing to navigate away and back.
- Each milestone row has a comment icon + count that opens a Comments
  modal — the same merged Flag+Comment feed as the Field Channel's Detail
  screen, plus a box to post a new comment as the Admin user, via
  `MilestoneStore.addComment`.
- The Assign Owner modal now reads and writes a shipment's team through
  `MilestoneStore` (`updateShipmentTeam`) instead of a local-only object,
  since the Field Channel's notifications depend on that roster being the
  same shared record both apps see — not two independently-maintained
  copies of "who's on this shipment."
- Everything else (containers, documents, physical tracking, shipment
  CRUD) is unchanged local-mock behavior — those are out of MVP scope for
  the Field Channel and were left alone.

## MVP scope

Implemented, matching the spec:

- Two milestone states: `NOT_STARTED` → `COMPLETED`, no other transitions.
- Assignment/reassignment stays an Admin-only action; the Field Channel
  only ever consumes the result.
- Completion is manual, requires confirmation, and records
  `completed_by` / `completed_at` / an optional note.
- Reassignment never resets milestone status.
- The backend (store) is authoritative — the frontend never marks
  something complete without a confirmed response.

Deliberately **not** implemented, per spec section 39 (tasks, blockers,
dependencies, automation, evidence frameworks, chat/collaboration,
template configuration in the Field Channel, independent Field Channel
templates, field-created shipments/milestones). The data model doesn't
preclude adding these later (spec section 40) — milestone records already
carry a stable `id`, `shipmentRef`, and `templateType`, so richer entities
(tasks, evidence, etc.) could hang off a milestone id without a schema
migration on this shape.

## Known simplifications (prototype-only)

- **Auth** is a name picker, not real SSO — see "Sign-in (simulated)"
  above.
- **Authorization** is a simple assigned-to-me-or-admin check inside the
  store, standing in for the organization's real RBAC model (spec section
  38's authorization *sequence* — authenticated → authorized → assigned →
  correct state — is implemented; the specific role model is not).
- **Persistence is `localStorage`, not a real database — read this before
  testing on two devices.** `localStorage` is scoped to one browser on one
  device. The Admin Portal and Field Channel only auto-sync when opened in
  the **same browser** (e.g. two tabs on the same laptop). Testing them on
  two different devices — Admin on a desktop, Field Channel on a phone,
  which is the natural way to try this — will look like the two apps are
  showing completely different, "misaligned" tasks. They're not out of
  sync in the sense the spec cares about; they're just two independent,
  disconnected copies of the demo data, because there is no server in
  between. A real deployment replaces this file's internals with actual
  API calls, at which point every device is naturally in sync and this
  whole caveat disappears.
  - **To test on one device:** open both apps in the same browser
    (two tabs, or one desktop + one mobile-viewport devtools tab). They'll
    share state immediately.
  - **To test on two separate devices:** each app has a small "Copy Sync
    Link" control (Admin Portal: bottom of the sidebar; Field Channel: the
    icon next to the account chip). It copies a URL encoding the current
    milestone data; opening that URL on the other device prompts to load
    it there, bringing both devices back onto the same data. This is a
    manual, one-shot copy for testing convenience — not live sync, so
    re-copy the link any time you want the two devices to match again.
- `MilestoneStore` seeds fresh demo data on first load per browser and
  keeps mutations after that. There's no `Math.random()` anywhere in the
  seed, and most of it is fully fixed — but a not-started milestone's due
  date is deliberately generated relative to *today* (cycling through a
  fixed spread of day-offsets), not pinned to a fixed calendar date. A
  demo whose due dates are hardcoded to specific 2026 dates eventually
  drifts entirely into the past as real time moves on — which is exactly
  what caused every single milestone to show as Breached before this was
  fixed. The trade-off: two devices seeding fresh on different calendar
  days will get different due dates for "the same" milestone, but two
  devices seeding on the same day (the overwhelmingly common case in
  practice) still get identical data, and the sync-link feature above
  transfers actual values rather than re-deriving them, so it's
  unaffected either way. Call `MilestoneStore.resetDemoData()` from either
  app's console to start over.
- **Schema migration on load.** The milestone/shipment record shape has
  changed over the life of this prototype (e.g. `flagHistory` replacing an
  older single `flagNote`/`flaggedBy`/`flaggedAt` shape). A browser with
  data cached from before such a change used to keep the old shape forever
  — `loadState()` had no version gate, so a record missing a field the
  current code assumes exists could crash mid-render (this surfaced as
  Field Channel's Milestone Detail screen showing "Unable to load this
  milestone," a generic message from a `.catch()` that was swallowing the
  real `TypeError`). `loadState()` now normalizes every record it reads —
  backfilling missing fields, migrating old shapes, and re-saving the
  result — so an old-schema browser self-heals on its next load instead of
  crashing. That resave only happens when normalization actually changed
  something: an event-triggered reload (cross-tab `storage`/
  `BroadcastChannel` sync) runs concurrently with whichever tab's own
  `commit()` is in flight, and an unconditional resave there would
  overwrite that tab's fresh write with the stale snapshot this reload
  happened to observe.
