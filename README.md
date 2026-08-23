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
- **Milestone Detail** — an SLA/status banner, the milestone name, the
  shipment context needed to execute it (reference, customer, shipment
  type, transport, B/L or AWB number, route, location), and a collapsible
  comment history (see "Flag a blocker" below). "Mark as Complete" and
  "Flag" sit side by side at the bottom,
  same order as the To-Dos card, always reachable without scrolling —
  pinned below the independently-scrollable content, never the page
  itself. Opened only for a milestone that is still `NOT_STARTED` and
  assigned to the signed-in user; if it's already been completed or
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
  can carry a running discussion of blockers over time. The Detail
  screen's Comments section is collapsed by default but always shows the
  most recent comment; older ones are revealed by expanding it. Field
  Channel comments show only the note and timestamp — no author name,
  since only the milestone's assigned Operations Staff member can add one
  there, so it would be redundant. The Admin Portal's flag tooltip still
  names who flagged it (several people can act from there), showing the
  latest comment plus a count when there's more than one. A flagged
  milestone also shows a banner on Detail and a "Flagged" pill on its
  To-Dos card — visible everywhere through the same shared record, not a
  Field-Channel-only note.
- **Concurrency & idempotency** — before completing, the app re-fetches
  the milestone from the store; if it's been reassigned, already
  completed, or no longer exists, it shows the corresponding message from
  spec section 31 instead of pretending the action succeeded. The app
  also suppresses its own cross-tab revalidation while a completion it
  triggered is in flight, so that revalidation can't race the completion
  and show a spurious "already completed" message for a request that
  actually just succeeded.

## Admin Portal — what changed

- Milestones for a shipment are now read from `MilestoneStore` instead of
  being generated inline.
- Reassign and Mark Complete route through
  `MilestoneStore.reassignMilestone` / `completeMilestone`.
- The open shipment's Service Delivery tab live-refreshes when the store
  notifies of a change — e.g. a Field Channel completion shows up on
  screen without the Admin needing to navigate away and back.
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
