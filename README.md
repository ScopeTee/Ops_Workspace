# OnePort 365 — Service Delivery Field Channel (MVP)

This repository contains two front-end prototypes that operate against **one
shared milestone record**, per the Service Delivery Field Channel product
spec:

| File | Role |
|---|---|
| `freight-operations-workspace.html` | **Admin Portal** — desktop, office-based shipment/service-delivery management. |
| `field-channel.html` | **Field Channel (new)** — mobile-first execution surface for Operations Staff. |
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
# Field Channel: http://localhost:8080/field-channel.html
```

Open both in the same browser to see completions and reassignments made
in one reflect live in the other, with no reload.

Opening the files directly via `file://` still works for each app
individually (per-tab), but same-origin cross-tab sync isn't guaranteed
by browsers for `file://` URLs.

### Simulating a network failure

Append `?simulateOffline=1` to `field-channel.html`'s URL to make every
store call reject, so you can see the "Unable to update this milestone.
Please check your connection and try again." error path (spec section
30–31) without needing real network conditions.

## Field Channel — what's implemented

Following the spec's recommended screens (section 42) and delivery
sequence (section 43):

- **Sign-in (simulated)** — stands in for the org's real authentication
  (spec section 26). Pick an Operations Staff member to "sign in" as.
  A real build replaces this with SSO/org auth and derives the same
  stable internal user id server-side — the client never gets to declare
  its own identity for a completion (`completeMilestone` takes the acting
  user id, but a real backend would derive it from the session/token, not
  trust a client-supplied value).
- **To-Dos** — milestones assigned to the signed-in user, with
  All / Not Started / Completed filters, due-date labels (Today /
  Tomorrow / Overdue), and the "You're all caught up" / "No completed
  milestones yet" empty states from spec sections 35–36.
- **Milestone Detail** — milestone name, status, instruction, and the
  minimum shipment context from spec section 19 (reference, service type,
  route, location). Completed milestones show who completed them, when,
  and the optional note.
- **Completion confirmation** — a bottom sheet with an optional note,
  requiring a deliberate second action before the mutation fires (spec
  section 16.2).
- **Concurrency & idempotency** — before completing, the app re-fetches
  the milestone from the store; if it's been reassigned, already
  completed, or no longer exists, it shows the corresponding message from
  spec section 31 instead of pretending the action succeeded.

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
- **Persistence** is `localStorage`, not a real database — it's scoped to
  one browser, which is why the two apps must be opened in the same
  browser to observe shared state.
- `MilestoneStore` seeds fresh demo data on first load per browser and
  keeps mutations after that. Call `MilestoneStore.resetDemoData()` from
  either app's console to start over.
