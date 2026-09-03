/* ==========================================================================
   OnePort 365 — Shared Milestone Store
   ==========================================================================
   This module simulates the backend/API contract described in the Service
   Delivery Field Channel spec (section 27): a single authoritative
   milestone record that both the Admin Portal and the Field Channel read
   and write against, instead of two independently-maintained states.

   In a real deployment, everything in this file behind the `MilestoneStore.*`
   function names would be replaced by real HTTP calls to the existing
   Service Delivery backend. The function signatures are deliberately shaped
   like the conceptual endpoints in the spec:

     getMyMilestones(userId)        -> GET /milestones?assigned_to=me
     getMilestone(id)               -> GET /milestones/{id}
     completeMilestone(id, ...)     -> POST /milestones/{id}/complete
     assignMilestone / reassign     -> existing Admin assignment APIs

   Persistence for this prototype is localStorage, namespaced under
   STORAGE_KEY, with cross-tab notification via BroadcastChannel (falling
   back to the native `storage` event). Both the Admin Portal and the Field
   Channel call `MilestoneStore.subscribe()` and re-render on change, which
   is the "revalidation" mechanism called for in spec section 36 — nobody
   trusts local state as authoritative.

   NOTE ON file:// TESTING: cross-tab BroadcastChannel/storage sync requires
   a real origin. Opening the HTML files directly (file://) mostly works
   per-tab, but for true cross-channel sync between two open tabs, serve
   this folder with a static server, e.g.:
     python3 -m http.server 8080
   and open both apps from http://localhost:8080/...
   ========================================================================== */
(function (global) {
  'use strict';

  const STORAGE_KEY = 'oneport_milestone_store_v1';
  const CHANNEL_NAME = 'oneport-milestones';
  const SIMULATED_LATENCY_MS = 260;

  let idSeq = 0;
  function makeId(prefix) { idSeq += 1; return `${prefix}-${Date.now().toString(36)}-${idSeq}`; }

  // ------------------------------------------------------------------
  // Reference data — Operations Staff / Admin users
  // ------------------------------------------------------------------
  // These are the same team members the Admin Portal prototype already
  // uses as shipment owners. For MVP, milestone assignment happens against
  // this same roster: an assigned "owner" on a shipment is an Operations
  // Staff member who can execute milestones in the Field Channel.
  const TEAM = [
    { id: 'u1', name: 'James Adewale', role: 'Sales Lead', initials: 'JA', fill: 'dark' },
    { id: 'u2', name: 'Sarah Adeyemi', role: 'Ops Executive', initials: 'SA', fill: 'light' },
    { id: 'u3', name: 'Michael Ibe', role: 'Quotes Manager', initials: 'MI', fill: 'dark' },
    { id: 'u4', name: 'Titi Aluko', role: 'Customs Coordinator', initials: 'TA', fill: 'gold' },
    { id: 'u5', name: 'Chidi Eze', role: 'Documentation', initials: 'CE', fill: 'dark' },
    { id: 'u6', name: 'Ada Nwosu', role: 'Finance', initials: 'AN', fill: 'light' },
  ];
  const ADMIN_USER = { id: 'admin', name: 'Nkechi M.', role: 'Admin', initials: 'NM', fill: 'dark', isAdmin: true };
  const ALL_USERS = [ADMIN_USER, ...TEAM];

  function getUsers() { return ALL_USERS.slice(); }
  function getOperationsStaff() { return TEAM.slice(); }
  function getUserById(id) { return ALL_USERS.find((u) => u.id === id) || null; }
  function isAdmin(userId) { const u = getUserById(userId); return !!(u && u.isAdmin); }

  // ------------------------------------------------------------------
  // Reference data — shipments + service delivery templates
  // ------------------------------------------------------------------
  const SHIPMENTS_SEED = [
    { jobRef: 'ZELO000001', customer: 'Dangote Industries', route: 'Shanghai → Lagos', mode: 'Ocean Import', status: 'Active', eta: '2026-08-02', etd: '2026-07-12', ownerId: 'u1', supportingOwnerIds: ['u5', 'u6'], completedMilestones: 4, incoterm: 'CIF', origin: 'Shanghai, China', destination: 'Lagos, Nigeria', pol: 'Shanghai Yangshan Port', pod: 'Apapa Port, Lagos', serviceType: 'Full Container Load', transportDocNumber: 'MSCUBL8821047' },
    { jobRef: 'ZELO000002', customer: 'Nestlé West Africa', route: 'Rotterdam → Tema', mode: 'Ocean Import', status: 'Active', eta: '2026-07-29', etd: '2026-07-05', ownerId: 'u2', supportingOwnerIds: ['u4'], completedMilestones: 6, incoterm: 'FOB', origin: 'Rotterdam, Netherlands', destination: 'Tema, Ghana', pol: 'Port of Rotterdam', pod: 'Tema Port', serviceType: 'Full Container Load', transportDocNumber: 'OOLUBL8790112' },
    { jobRef: 'ZELO000003', customer: 'Julius Berger Nigeria', route: 'Hamburg → Lagos', mode: 'Ocean Import', status: 'Active', eta: '2026-07-20', etd: '2026-07-01', ownerId: 'u3', supportingOwnerIds: [], completedMilestones: 1, incoterm: 'CFR', origin: 'Hamburg, Germany', destination: 'Lagos, Nigeria', pol: 'Port of Hamburg', pod: 'Apapa Port, Lagos', serviceType: 'Break Bulk', transportDocNumber: 'HLCUBL8744093' },
    { jobRef: 'ZELO000004', customer: 'MTN Nigeria', route: 'Shenzhen → Lagos', mode: 'Air Import', status: 'Cancelled', eta: '2026-07-31', etd: '2026-07-27', ownerId: 'u4', supportingOwnerIds: ['u1'], completedMilestones: 2, incoterm: 'FCA', origin: 'Shenzhen, China', destination: 'Lagos, Nigeria', pol: "Shenzhen Bao'an Airport", pod: 'Murtala Muhammed Airport', serviceType: 'Air Freight', transportDocNumber: '176-88213047' },
    { jobRef: 'ZELO000005', customer: 'Dufil Prima Foods', route: 'Lagos → Douala', mode: 'Ocean Export', status: 'Active', eta: '2026-07-26', etd: '2026-07-14', ownerId: 'u5', supportingOwnerIds: ['u2', 'u3'], completedMilestones: 7, incoterm: 'CIF', origin: 'Lagos, Nigeria', destination: 'Douala, Cameroon', pol: 'Apapa Port, Lagos', pod: 'Port of Douala', serviceType: 'Full Container Load', transportDocNumber: 'CMAUBL8650081' },
    { jobRef: 'ZELO000006', customer: 'Nigerian Breweries', route: 'Antwerp → Lagos', mode: 'Ocean Import', status: 'Completed', eta: '2026-07-10', etd: '2026-06-20', ownerId: 'u6', supportingOwnerIds: [], completedMilestones: 10, incoterm: 'CIF', origin: 'Antwerp, Belgium', destination: 'Lagos, Nigeria', pol: 'Port of Antwerp', pod: 'Apapa Port, Lagos', serviceType: 'Full Container Load', transportDocNumber: 'MAEUBL8590066' },
  ];

  // OneImport / OneExport service-delivery templates (spec section 6).
  // Each entry carries the field instruction + location surfaced on the
  // Field Channel's Milestone Detail screen (spec section 15/19).
  const ONE_IMPORT_TEMPLATE = [
    { name: 'Pre-Alert Receipt', instruction: 'Confirm the pre-alert document set has been received from the shipping line and logged against this job.', locationKey: 'pol' },
    { name: 'Form M Validation', instruction: 'Validate the Form M reference against the shipment invoice and confirm it is still active.', locationKey: 'office' },
    { name: 'PAAR Application', instruction: 'Submit the PAAR application on the customs platform using the validated Form M.', locationKey: 'office' },
    { name: 'Draft Assessment', instruction: 'Review the draft customs assessment for accuracy before it is finalized.', locationKey: 'office' },
    { name: 'Final Assessment', instruction: 'Confirm the final customs assessment amount and route it for payment.', locationKey: 'office' },
    { name: 'THC Payment', instruction: 'Confirm Terminal Handling Charges have been paid and the receipt filed against this shipment.', locationKey: 'pod' },
    { name: 'Delivery', instruction: 'Coordinate cargo release and delivery to the consignee’s nominated address.', locationKey: 'destination' },
    { name: 'Empty Return', instruction: 'Confirm the empty container has been returned to the shipping line’s depot.', locationKey: 'pod' },
    { name: 'Post Delivery Docs', instruction: 'Collect and file the signed delivery note and any post-delivery paperwork.', locationKey: 'destination' },
    { name: 'Document Release', instruction: 'Release final shipment documents to the customer and close out the file.', locationKey: 'office' },
  ];
  const ONE_EXPORT_TEMPLATE = [
    { name: 'Booking Placement', instruction: 'Confirm the shipping line booking has been placed and the booking number logged.', locationKey: 'office' },
    { name: 'Empty Container', instruction: 'Confirm empty container pickup from the depot for stuffing.', locationKey: 'pol' },
    { name: 'Clean CCI', instruction: 'Verify the Clean Certificate of Cargo Inspection has been issued without exceptions.', locationKey: 'office' },
    { name: 'Draft BL to Customer', instruction: 'Send the draft Bill of Lading to the customer for review and sign-off.', locationKey: 'office' },
    { name: 'Gate-In', instruction: 'Confirm the container has gated in at the terminal ahead of vessel cut-off.', locationKey: 'pol' },
    { name: 'Inspection', instruction: 'Attend or confirm the customs/terminal inspection of the container.', locationKey: 'pol' },
    { name: 'Vessel Confirmation', instruction: 'Confirm the container has been loaded on the nominated vessel.', locationKey: 'pol' },
    { name: 'Sailing Confirmation', instruction: 'Confirm vessel sailing and update the shipment tracking status.', locationKey: 'pol' },
    { name: 'OBL Issuance', instruction: 'Confirm the Original Bill of Lading has been issued and dispatched.', locationKey: 'office' },
    { name: 'Document Release', instruction: 'Release final shipment documents to the customer and close out the file.', locationKey: 'office' },
  ];

  function resolveLocation(shipment, key) {
    if (key === 'pol') return shipment.pol;
    if (key === 'pod') return shipment.pod;
    if (key === 'destination') return shipment.destination;
    if (key === 'office') return 'OnePort 365 Office';
    return shipment.destination;
  }

  // Not-started milestones deliberately anchor their due date to TODAY,
  // not to the shipment's fixed 2026 etd/eta — otherwise every date is a
  // fixed point on the calendar that the real world eventually passes,
  // and months later every single milestone reads as "Breached" (as
  // happened here). Cycling through this offset spread means the demo
  // always shows a realistic mix of Breached / At Risk / Healthy, no
  // matter what day it's actually opened.
  const DUE_OFFSET_DAYS_CYCLE = [-9, -5, -2, -1, 0, 1, 2, 4, 6, 10, 16, 24];
  function addDaysFromToday(days, hour, minute) {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    d.setDate(d.getDate() + days);
    d.setHours(hour, minute, 0, 0);
    return d;
  }

  function seedMilestonesForShipment(shipment, shipmentIndex) {
    const template = shipment.mode.includes('Export') ? ONE_EXPORT_TEMPLATE : ONE_IMPORT_TEMPLATE;
    const templateType = shipment.mode.includes('Export') ? 'OneExport' : 'OneImport';
    const teamIds = [shipment.ownerId, ...(shipment.supportingOwnerIds || [])];
    const etd = new Date(shipment.etd + 'T00:00:00');

    return template.map((step, i) => {
      const isDone = i < shipment.completedMilestones;
      const hour = 9 + (i * 3) % 8;
      const minute = (i % 2) * 30;
      // Completed milestones already happened, so their due date sits
      // safely in the past — otherwise a milestone could end up
      // "completed" before its own (today-relative) due date arrives.
      const dueDate = isDone
        ? addDaysFromToday(-(14 + i * 2), hour, minute)
        : addDaysFromToday(DUE_OFFSET_DAYS_CYCLE[(shipmentIndex * 5 + i * 3) % DUE_OFFSET_DAYS_CYCLE.length], hour, minute);
      const assignedTo = teamIds[i % teamIds.length];
      const milestone = {
        id: `${shipment.jobRef}-M${i + 1}`,
        shipmentRef: shipment.jobRef,
        sequence: i + 1,
        templateType,
        name: step.name,
        instruction: step.instruction,
        location: resolveLocation(shipment, step.locationKey),
        status: isDone ? 'COMPLETED' : 'NOT_STARTED',
        assignedTo,
        assignedAt: new Date(etd.getTime() - 2 * 86400000).toISOString(),
        dueDate: dueDate.toISOString(),
        completedBy: isDone ? teamIds[(i + 1) % teamIds.length] : null,
        completedAt: isDone ? new Date(dueDate.getTime() - 3600000).toISOString() : null,
        completionNote: isDone && i % 3 === 0 ? 'Cleared without exceptions.' : '',
        flagged: false,
        flagHistory: [], // [{ note, by, at }], newest appended last
        comments: [], // [{ text, by, at }], newest appended last — general discussion, independent of flagging
        // Deliberately derived from dueDate, not a fresh `new Date()` call
        // — this field isn't part of the demo's day-relative narrative, so
        // it should stay byte-identical across two devices seeding fresh
        // on the same day rather than drift by however many milliseconds
        // apart their page loads happened to land.
        updatedAt: dueDate.toISOString(),
      };
      return milestone;
    });
  }

  // A shipment's team roster, as the Admin Portal's Assign Owner modal and
  // the notification system both need it: one 'owner' plus any number of
  // 'supporting' members. Seeded from the flatter ownerId/supportingOwnerIds
  // shape already in SHIPMENTS_SEED, which stays around for back-compat
  // (updateShipmentTeam below keeps both shapes in sync on every change).
  function deriveTeamFromOwners(s) {
    const team = [{ userId: s.ownerId, role: 'owner' }];
    (s.supportingOwnerIds || []).forEach((userId) => team.push({ userId, role: 'supporting' }));
    return team;
  }
  const TEAM_ROLE_LABEL = { owner: 'Owner', supporting: 'Supporting' };
  const TEAM_ROLE_RANK = { supporting: 1, owner: 2 };

  // Demo-only: seed one example of every non-breach notification type
  // (comment / team_added / team_removed / role_updated — sla_breached
  // already appears on its own via checkSlaBreaches() below, for whoever
  // happens to have an overdue milestone) spread across several different
  // user profiles, so a fresh browser has something in the Notifications
  // screen right away instead of only ever showing breaches. Every entry
  // is chosen to be consistent with the shipment's actual seeded team —
  // e.g. a "reduced to Supporting" notification only goes to someone who
  // is, in fact, currently Supporting on that shipment — so clicking
  // through, or comparing against the Admin Portal, never contradicts
  // what's on screen. A comment notification also appends the matching
  // comment to the milestone itself, so the Detail screen backs it up.
  function seedDemoNotifications(milestones) {
    const notifications = {};
    function firstNotStartedFor(jobRef, userId) {
      return Object.values(milestones).find((m) => m.shipmentRef === jobRef && m.status === 'NOT_STARTED' && m.assignedTo === userId) || null;
    }
    function seedComment(userId, jobRef, byUserId, text) {
      const m = firstNotStartedFor(jobRef, userId);
      if (!m) return; // no matching milestone in this demo data — skip rather than seed a broken reference
      const commentId = makeId('cm');
      m.comments = [...(m.comments || []), { id: commentId, text, by: byUserId, at: new Date().toISOString() }];
      const notifId = 'comment-' + commentId;
      notifications[notifId] = {
        id: notifId, userId, type: 'comment', shipmentRef: jobRef, milestoneId: m.id,
        message: `${getUserById(byUserId).name.split(' ')[0]} commented on "${m.name}"`,
        createdAt: new Date().toISOString(), read: false,
      };
    }
    function seedTeamNotif(userId, jobRef, type, message) {
      const id = makeId('notif-demo');
      notifications[id] = { id, userId, type, shipmentRef: jobRef, milestoneId: null, message, createdAt: new Date().toISOString(), read: false };
    }

    // Comments — every Field Channel profile gets at least one, so
    // whichever user you sign in as, there's something to see.
    seedComment('u1', 'ZELO000001', 'u2', 'Confirmed with the line — go ahead and file this.');
    seedComment('u2', 'ZELO000002', 'admin', 'Any update on this leg? Customer is asking.');
    seedComment('u3', 'ZELO000003', 'u2', 'Flagging that the assessment looks high — please double-check.');
    seedComment('u4', 'ZELO000004', 'u1', 'Docs from customs came back — see attached.');
    seedComment('u5', 'ZELO000005', 'admin', 'Nice work closing this leg out ahead of schedule.');
    seedComment('u6', 'ZELO000001', 'u4', 'Can you confirm the empty return slot for this one?');

    // Team changes — u4, u5, u6 currently support a shipment they weren't
    // originally on; u1, u2 currently hold a reduced (Supporting) role
    // after starting as Owner elsewhere; u3, u6 were once on a shipment
    // team they're not part of today.
    seedTeamNotif('u4', 'ZELO000002', 'team_added', "You were added to ZELO000002's shipment team as Supporting");
    seedTeamNotif('u5', 'ZELO000001', 'team_added', "You were added to ZELO000001's shipment team as Supporting");
    seedTeamNotif('u6', 'ZELO000001', 'team_added', "You were added to ZELO000001's shipment team as Supporting");
    seedTeamNotif('u1', 'ZELO000004', 'role_updated', 'Your role on ZELO000004 was reduced to Supporting');
    seedTeamNotif('u2', 'ZELO000005', 'role_updated', 'Your role on ZELO000005 was reduced to Supporting');
    seedTeamNotif('u5', 'ZELO000005', 'role_updated', 'Your role on ZELO000005 was upgraded to Owner');
    seedTeamNotif('u3', 'ZELO000004', 'team_removed', "You were removed from ZELO000004's shipment team");
    seedTeamNotif('u6', 'ZELO000003', 'team_removed', "You were removed from ZELO000003's shipment team");

    return notifications;
  }

  function buildInitialState() {
    const shipments = {};
    const milestones = {};
    SHIPMENTS_SEED.forEach((s, shipmentIndex) => {
      shipments[s.jobRef] = { ...s, team: deriveTeamFromOwners(s) };
      seedMilestonesForShipment(s, shipmentIndex).forEach((m) => { milestones[m.id] = m; });
    });
    return { shipments, milestones, notifications: seedDemoNotifications(milestones), version: 1 };
  }

  // ------------------------------------------------------------------
  // Persistence
  // ------------------------------------------------------------------
  // A browser that used this app before a schema change (e.g. before
  // flagHistory existed) has old-shaped records sitting in localStorage
  // forever — loadState() below has no version gate, it just returns
  // whatever's there. Every reader downstream assumes the CURRENT shape
  // (flagHistory is an array; new shipment fields exist), so unmigrated
  // data throws mid-render — and because that throw happens inside a
  // .then() callback, it surfaces as a swallowed promise rejection, which
  // callers report as a generic "check your connection" error, hiding
  // the real cause. Migrating on load, once, is what actually fixes it.
  // Each normalizer returns whether it actually changed anything, so
  // callers only pay for a resave when a migration truly happened — not on
  // every already-current-schema read. That matters beyond performance: a
  // reload triggered by a cross-tab sync event runs concurrently with
  // another tab's own commit(), and a resave-no-matter-what would blindly
  // write back whatever this read happened to observe, permanently
  // clobbering a write that lands a moment later from that other tab.
  function normalizeMilestone(m) {
    let changed = false;
    if (!Array.isArray(m.flagHistory)) {
      // Migrate the older single-note shape (flagNote/flaggedBy/flaggedAt)
      // into one comment-history entry; otherwise start with none.
      if (m.flagNote || m.flaggedBy || m.flaggedAt) {
        m.flagHistory = [{
          note: m.flagNote || '',
          by: m.flaggedBy || null,
          at: m.flaggedAt || m.updatedAt || new Date().toISOString(),
        }];
      } else {
        m.flagHistory = [];
      }
      changed = true;
    }
    if (typeof m.flagged !== 'boolean') { m.flagged = m.flagHistory.length > 0; changed = true; }
    if ('flagNote' in m) { delete m.flagNote; changed = true; }
    if ('flaggedBy' in m) { delete m.flaggedBy; changed = true; }
    if ('flaggedAt' in m) { delete m.flaggedAt; changed = true; }
    if (!Array.isArray(m.comments)) { m.comments = []; changed = true; }
    // Comments predate having their own id (needed to key a comment's
    // notification so it can't be created twice) — backfill one in place.
    m.comments.forEach((c) => { if (!c.id) { c.id = makeId('cm'); changed = true; } });
    return changed;
  }

  function normalizeShipment(s) {
    let changed = false;
    const seed = SHIPMENTS_SEED.find((x) => x.jobRef === s.jobRef);
    if (seed) {
      Object.keys(seed).forEach((k) => { if (s[k] === undefined) { s[k] = seed[k]; changed = true; } });
    }
    if (!Array.isArray(s.team)) { s.team = deriveTeamFromOwners(s); changed = true; }
    return changed;
  }

  function loadState() {
    try {
      const raw = global.localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        let migrated = false;
        if (!parsed.notifications) { parsed.notifications = {}; migrated = true; }
        Object.values(parsed.milestones || {}).forEach((m) => { if (normalizeMilestone(m)) migrated = true; });
        Object.values(parsed.shipments || {}).forEach((s) => { if (normalizeShipment(s)) migrated = true; });
        // Only resave when the migration actually changed something — see
        // the note above normalizeMilestone() for why an unconditional
        // resave here is unsafe on an event-triggered reload.
        if (migrated) saveState(parsed);
        return parsed;
      }
    } catch (e) { /* corrupt storage — fall through to reseed */ }
    const fresh = buildInitialState();
    saveState(fresh);
    return fresh;
  }

  function saveState(state) {
    global.localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  }

  // ------------------------------------------------------------------
  // Manual cross-device sync (testing aid only)
  // ------------------------------------------------------------------
  // localStorage is scoped per browser/device, so the Admin Portal and
  // Field Channel only share state automatically when opened in the SAME
  // browser. Testing them on two different devices (e.g. Admin on a
  // laptop, Field Channel on a phone) otherwise looks like the two apps
  // showing "the wrong tasks" — really just two disconnected copies of
  // the demo data. A real deployment replaces this whole file with calls
  // to a real backend, at which point every device is naturally in sync
  // and this workaround goes away. Until then, getSyncLink() encodes the
  // current store into a URL; opening that URL on another device loads
  // the exact same milestone data there.
  function toBase64Unicode(str) { return global.btoa(unescape(encodeURIComponent(str))); }
  function fromBase64Unicode(b64) { return decodeURIComponent(escape(global.atob(b64))); }

  function tryImportFromHash() {
    const hash = global.location.hash;
    if (!hash || !hash.startsWith('#state=')) return null;
    const stripHash = () => global.history.replaceState(null, '', global.location.pathname + global.location.search);
    try {
      const encoded = decodeURIComponent(hash.slice('#state='.length));
      const parsed = JSON.parse(fromBase64Unicode(encoded));
      if (!parsed || !parsed.shipments || !parsed.milestones) throw new Error('malformed sync link');
      const proceed = global.confirm(
        'Load synced test data from this link?\n\nThis replaces the milestone data currently stored on this device.'
      );
      stripHash();
      if (!proceed) return null;
      // The link may have been generated by a device on an older (or
      // newer) build than this one — normalize it the same way loadState()
      // does, so an out-of-date sync link can't crash the receiving device.
      Object.values(parsed.milestones || {}).forEach(normalizeMilestone);
      Object.values(parsed.shipments || {}).forEach(normalizeShipment);
      // Unlike loadState(), this always saves: importing a sync link is a
      // deliberate, one-shot user action, not a background reload racing
      // another tab's commit, so there's no concurrent writer to clobber.
      saveState(parsed);
      return parsed;
    } catch (e) {
      stripHash();
      return null;
    }
  }

  let state = tryImportFromHash() || loadState();

  function getSyncLink() {
    const encoded = encodeURIComponent(toBase64Unicode(JSON.stringify(state)));
    return global.location.origin + global.location.pathname + '#state=' + encoded;
  }

  // ------------------------------------------------------------------
  // Cross-tab notification (simulated "revalidate" signal — see spec 36)
  // ------------------------------------------------------------------
  const listeners = new Set();
  let channel = null;
  try {
    if ('BroadcastChannel' in global) channel = new global.BroadcastChannel(CHANNEL_NAME);
  } catch (e) { channel = null; }

  function notify(reason) {
    listeners.forEach((fn) => { try { fn(reason); } catch (e) { /* listener error is not our problem */ } });
  }

  if (channel) {
    channel.onmessage = (ev) => { state = loadState(); notify(ev.data && ev.data.reason || 'remote-update'); };
  }
  global.addEventListener('storage', (ev) => {
    if (ev.key === STORAGE_KEY) { state = loadState(); notify('storage-event'); }
  });

  function commit(reason) {
    saveState(state);
    if (channel) channel.postMessage({ reason });
    notify(reason);
  }

  function subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); }

  // ------------------------------------------------------------------
  // Async wrapper — simulates a real network round-trip so the UI has to
  // handle loading/latency, matching how a real backend call would behave.
  // ------------------------------------------------------------------
  function simulateOffline() {
    try { return new URLSearchParams(global.location.search).get('simulateOffline') === '1'; }
    catch (e) { return false; }
  }

  function respond(fn) {
    return new Promise((resolve, reject) => {
      global.setTimeout(() => {
        if (simulateOffline()) { reject({ code: 'NETWORK_ERROR' }); return; }
        try { resolve(fn()); } catch (err) { reject(err); }
      }, SIMULATED_LATENCY_MS);
    });
  }

  // ------------------------------------------------------------------
  // Read APIs — each has a synchronous "Sync" twin for callers (like the
  // Admin Portal's existing render pipeline) that hydrate from the same
  // in-memory state without waiting on the simulated network round-trip.
  // Both read from the exact same `state` object, so there is never a
  // fork between "the sync copy" and "the async copy" — one record.
  // ------------------------------------------------------------------
  function _getShipments() { return Object.values(state.shipments).map((s) => ({ ...s })); }
  function _getShipment(jobRef) { return state.shipments[jobRef] ? { ...state.shipments[jobRef] } : null; }
  function _getMilestonesForShipment(jobRef) {
    return Object.values(state.milestones)
      .filter((m) => m.shipmentRef === jobRef)
      .sort((a, b) => a.sequence - b.sequence)
      .map((m) => ({ ...m }));
  }
  function _getMyMilestones(userId) {
    return Object.values(state.milestones)
      .filter((m) => m.assignedTo === userId)
      .map((m) => ({ milestone: { ...m }, shipment: { ...state.shipments[m.shipmentRef] } }))
      .sort((a, b) => new Date(a.milestone.dueDate) - new Date(b.milestone.dueDate));
  }
  function _getMilestone(id) {
    const m = state.milestones[id];
    if (!m) return null;
    return { milestone: { ...m }, shipment: { ...state.shipments[m.shipmentRef] } };
  }

  function getShipments() { return respond(_getShipments); }
  function getShipment(jobRef) { return respond(() => _getShipment(jobRef)); }
  function getMilestonesForShipment(jobRef) { return respond(() => _getMilestonesForShipment(jobRef)); }
  // GET /milestones?assigned_to=me
  function getMyMilestones(userId) { return respond(() => _getMyMilestones(userId)); }
  // GET /milestones/{id}
  function getMilestone(id) { return respond(() => _getMilestone(id)); }

  // ------------------------------------------------------------------
  // Write APIs
  // ------------------------------------------------------------------
  // Assignment / reassignment stays conceptually owned by the existing
  // Admin experience (spec 27.4) — the Field Channel never calls these.
  function reassignMilestone(id, newUserId, actingUserId) {
    return respond(() => {
      const m = state.milestones[id];
      if (!m) return { ok: false, code: 'NOT_FOUND' };
      if (!isAdmin(actingUserId)) return { ok: false, code: 'FORBIDDEN' };
      m.assignedTo = newUserId;
      m.assignedAt = new Date().toISOString();
      m.updatedAt = new Date().toISOString();
      // Reassignment must not reset milestone status (spec section 22).
      commit('reassign');
      return { ok: true, milestone: { ...m } };
    });
  }

  // POST /milestones/{id}/complete
  // Server-side authority: validates auth, assignment, and current state
  // before applying the mutation (spec sections 28, 29, 38).
  function completeMilestone(id, actingUserId, note) {
    return respond(() => {
      const m = state.milestones[id];
      if (!m) return { ok: false, code: 'NOT_FOUND' };

      const actor = getUserById(actingUserId);
      if (!actor) return { ok: false, code: 'UNAUTHENTICATED' };

      const permitted = actor.isAdmin || m.assignedTo === actingUserId;
      if (!permitted) return { ok: false, code: 'FORBIDDEN', milestone: { ...m } };

      if (m.status === 'COMPLETED') {
        // Idempotent: already-completed is not an error, return authoritative state.
        return { ok: true, alreadyCompleted: true, milestone: { ...m } };
      }

      m.status = 'COMPLETED';
      m.completedBy = actingUserId;
      m.completedAt = new Date().toISOString();
      m.completionNote = (note || '').trim();
      m.updatedAt = new Date().toISOString();
      commit('complete');
      return { ok: true, milestone: { ...m } };
    });
  }

  // Flags a blocker on a milestone without changing its status — MVP has
  // no BLOCKED state (spec section 8/39), so this appends a comment to the
  // still-NOT_STARTED milestone's history, not a state transition. Every
  // flag action is kept (not overwritten), so a milestone can carry a
  // running discussion of blockers over time. Same authorization rule as
  // completion: assigned staff or an admin.
  function flagMilestone(id, actingUserId, note) {
    return respond(() => {
      const m = state.milestones[id];
      if (!m) return { ok: false, code: 'NOT_FOUND' };

      const actor = getUserById(actingUserId);
      if (!actor) return { ok: false, code: 'UNAUTHENTICATED' };

      const permitted = actor.isAdmin || m.assignedTo === actingUserId;
      if (!permitted) return { ok: false, code: 'FORBIDDEN', milestone: { ...m } };

      m.flagged = true;
      const priorHistory = Array.isArray(m.flagHistory) ? m.flagHistory : [];
      m.flagHistory = [...priorHistory, { note: (note || '').trim(), by: actingUserId, at: new Date().toISOString() }];
      m.updatedAt = new Date().toISOString();
      commit('flag');
      return { ok: true, milestone: { ...m } };
    });
  }

  // General comments — separate from flagMilestone above. A comment is a
  // plain note anyone with access to the milestone can add and everyone
  // can see; it never changes `flagged` or the milestone's status. Unlike
  // flag/complete, there is no assignee-or-admin gate: any authenticated
  // user (Operations Staff or Admin) may comment on any milestone, since
  // this is meant as a shared discussion, not an execution action. Per
  // product decision there is no delete, no reply/threading, and no @
  // mentions — just an append-only, flat list.
  function addComment(id, actingUserId, text) {
    return respond(() => {
      const m = state.milestones[id];
      if (!m) return { ok: false, code: 'NOT_FOUND' };

      const actor = getUserById(actingUserId);
      if (!actor) return { ok: false, code: 'UNAUTHENTICATED' };

      const trimmed = (text || '').trim();
      if (!trimmed) return { ok: false, code: 'EMPTY_COMMENT' };

      const commentId = makeId('cm');
      const priorComments = Array.isArray(m.comments) ? m.comments : [];
      m.comments = [...priorComments, { id: commentId, text: trimmed, by: actingUserId, at: new Date().toISOString() }];
      m.updatedAt = new Date().toISOString();

      // Only the assignee is notified, and only when someone else left the
      // comment — an admin or co-worker browsing the milestone never pings
      // themselves, and an unassigned milestone notifies no one.
      if (m.assignedTo && m.assignedTo !== actingUserId) {
        addNotification({
          id: 'comment-' + commentId,
          userId: m.assignedTo,
          type: 'comment',
          shipmentRef: m.shipmentRef,
          milestoneId: m.id,
          message: `${actor.name.split(' ')[0]} commented on "${m.name}"`,
        });
      }

      commit('comment');
      return { ok: true, milestone: { ...m } };
    });
  }

  // Replaces a shipment's whole team roster in one call — the Admin
  // Portal's Assign Owner modal always submits the full new roster, not a
  // single add/remove — diffing against the prior roster so only the
  // people actually affected get notified. Every affected person is, by
  // definition, someone other than the admin making the change, so there's
  // no "don't notify yourself" check to make here (unlike addComment).
  function updateShipmentTeam(jobRef, newTeam, actingAdminId) {
    return respond(() => {
      const s = state.shipments[jobRef];
      if (!s) return { ok: false, code: 'NOT_FOUND' };
      if (!isAdmin(actingAdminId)) return { ok: false, code: 'FORBIDDEN' };

      const oldTeam = Array.isArray(s.team) ? s.team : [];
      const oldByUser = new Map(oldTeam.map((t) => [t.userId, t.role]));
      const newByUser = new Map(newTeam.map((t) => [t.userId, t.role]));

      oldByUser.forEach((role, userId) => {
        if (!newByUser.has(userId)) {
          addNotification({
            id: makeId('notif-team-removed'),
            userId,
            type: 'team_removed',
            shipmentRef: jobRef,
            message: `You were removed from ${jobRef}'s shipment team`,
          });
        }
      });
      newByUser.forEach((role, userId) => {
        const priorRole = oldByUser.get(userId);
        if (priorRole === undefined) {
          addNotification({
            id: makeId('notif-team-added'),
            userId,
            type: 'team_added',
            shipmentRef: jobRef,
            message: `You were added to ${jobRef}'s shipment team as ${TEAM_ROLE_LABEL[role]}`,
          });
        } else if (priorRole !== role) {
          const direction = TEAM_ROLE_RANK[role] > TEAM_ROLE_RANK[priorRole] ? 'upgraded' : 'reduced';
          addNotification({
            id: makeId('notif-team-role'),
            userId,
            type: 'role_updated',
            shipmentRef: jobRef,
            message: `Your role on ${jobRef} was ${direction} to ${TEAM_ROLE_LABEL[role]}`,
          });
        }
      });

      s.team = newTeam.map((t) => ({ userId: t.userId, role: t.role }));
      s.ownerId = (s.team.find((t) => t.role === 'owner') || {}).userId || s.ownerId;
      s.supportingOwnerIds = s.team.filter((t) => t.role === 'supporting').map((t) => t.userId);
      commit('team-update');
      return { ok: true, shipment: { ...s } };
    });
  }

  // Merges flagHistory and comments into one flat, chronological feed for
  // display — the product decision was one merged "Comments" list rather
  // than two separate histories, so a flagged blocker note and a plain
  // comment both show up as the same kind of item, tagged by `kind` only
  // so the UI can render a small "Blocker flagged" label on the former.
  // Pure/synchronous: it only reshapes a milestone object already in hand.
  function getActivity(m) {
    const flags = (Array.isArray(m.flagHistory) ? m.flagHistory : [])
      .map((e) => ({ kind: 'flag', text: e.note, by: e.by, at: e.at }));
    const comments = (Array.isArray(m.comments) ? m.comments : [])
      .map((e) => ({ kind: 'comment', text: e.text, by: e.by, at: e.at }));
    return [...flags, ...comments].sort((a, b) => new Date(b.at) - new Date(a.at));
  }

  // ------------------------------------------------------------------
  // Notifications — Field Channel alerts sourced from actions taken on
  // the Admin Portal: a comment on one of my milestones, being added to
  // or removed from a shipment team, my role on a team changing, or one
  // of my milestones breaching its SLA. Never sent to whoever caused the
  // event, and never sent about a milestone that isn't mine.
  // ------------------------------------------------------------------
  function addNotification(fields) {
    // Idempotent by id: the SLA breach check below can run more than once
    // for the same underlying breach (every open tab polls independently),
    // so re-inserting an id that already exists is a no-op, not a dupe.
    if (state.notifications[fields.id]) return false;
    state.notifications[fields.id] = {
      id: fields.id,
      userId: fields.userId,
      type: fields.type,
      shipmentRef: fields.shipmentRef || null,
      milestoneId: fields.milestoneId || null,
      message: fields.message,
      createdAt: new Date().toISOString(),
      read: false,
    };
    return true;
  }

  function _getNotifications(userId, opts) {
    const page = (opts && opts.page) || 1;
    const pageSize = (opts && opts.pageSize) || 10;
    const all = Object.values(state.notifications)
      .filter((n) => n.userId === userId)
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    const start = (page - 1) * pageSize;
    const items = all.slice(start, start + pageSize).map((n) => ({ ...n }));
    return { items, page, pageSize, total: all.length, hasMore: start + items.length < all.length };
  }
  function _getUnreadNotificationCount(userId) {
    return Object.values(state.notifications).filter((n) => n.userId === userId && !n.read).length;
  }
  // GET /notifications?assigned_to=me&page=
  function getNotifications(userId, opts) { return respond(() => _getNotifications(userId, opts)); }
  function getUnreadNotificationCount(userId) { return respond(() => _getUnreadNotificationCount(userId)); }

  // POST /notifications/{id}/read
  function markNotificationRead(id, userId) {
    return respond(() => {
      const n = state.notifications[id];
      if (!n || n.userId !== userId) return { ok: false, code: 'NOT_FOUND' };
      if (!n.read) { n.read = true; commit('notification-read'); }
      return { ok: true };
    });
  }

  // Simulated backend job: a real deployment detects SLA breaches
  // server-side on a schedule, so here whichever client tab(s) happen to
  // be open run the same check periodically instead. The notification id
  // is derived from the milestone id, not random, so the check is
  // idempotent — running it again, in this tab or another, never creates
  // a second notification for the same breach.
  function checkSlaBreaches() {
    const now = Date.now();
    let changed = false;
    Object.values(state.milestones).forEach((m) => {
      if (m.status !== 'NOT_STARTED' || !m.assignedTo) return;
      if (new Date(m.dueDate).getTime() >= now) return;
      const created = addNotification({
        id: 'breach-' + m.id,
        userId: m.assignedTo,
        type: 'sla_breached',
        shipmentRef: m.shipmentRef,
        milestoneId: m.id,
        message: `"${m.name}" (${m.shipmentRef}) is overdue`,
      });
      if (created) changed = true;
    });
    if (changed) commit('sla-breach');
  }
  checkSlaBreaches();
  global.setInterval(checkSlaBreaches, 60000);

  function resetDemoData() {
    state = buildInitialState();
    commit('reset');
  }

  global.MilestoneStore = {
    getUsers, getOperationsStaff, getUserById, isAdmin,
    getShipments, getShipment, getMilestonesForShipment,
    getMyMilestones, getMilestone,
    reassignMilestone, completeMilestone, flagMilestone, addComment, getActivity,
    updateShipmentTeam,
    getNotifications, getUnreadNotificationCount, markNotificationRead,
    subscribe, resetDemoData, getSyncLink,
    ADMIN_USER_ID: ADMIN_USER.id,
    TEAM_ROLE_LABEL,
    sync: {
      getShipments: _getShipments,
      getShipment: _getShipment,
      getMilestonesForShipment: _getMilestonesForShipment,
      getMyMilestones: _getMyMilestones,
      getMilestone: _getMilestone,
      getNotifications: _getNotifications,
      getUnreadNotificationCount: _getUnreadNotificationCount,
    },
  };
})(window);
