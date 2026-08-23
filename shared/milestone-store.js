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

  function buildInitialState() {
    const shipments = {};
    const milestones = {};
    SHIPMENTS_SEED.forEach((s, shipmentIndex) => {
      shipments[s.jobRef] = { ...s };
      seedMilestonesForShipment(s, shipmentIndex).forEach((m) => { milestones[m.id] = m; });
    });
    return { shipments, milestones, version: 1 };
  }

  // ------------------------------------------------------------------
  // Persistence
  // ------------------------------------------------------------------
  function loadState() {
    try {
      const raw = global.localStorage.getItem(STORAGE_KEY);
      if (raw) return JSON.parse(raw);
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
      m.flagHistory = [...m.flagHistory, { note: (note || '').trim(), by: actingUserId, at: new Date().toISOString() }];
      m.updatedAt = new Date().toISOString();
      commit('flag');
      return { ok: true, milestone: { ...m } };
    });
  }

  function resetDemoData() {
    state = buildInitialState();
    commit('reset');
  }

  global.MilestoneStore = {
    getUsers, getOperationsStaff, getUserById, isAdmin,
    getShipments, getShipment, getMilestonesForShipment,
    getMyMilestones, getMilestone,
    reassignMilestone, completeMilestone, flagMilestone,
    subscribe, resetDemoData, getSyncLink,
    ADMIN_USER_ID: ADMIN_USER.id,
    sync: {
      getShipments: _getShipments,
      getShipment: _getShipment,
      getMilestonesForShipment: _getMilestonesForShipment,
      getMyMilestones: _getMyMilestones,
      getMilestone: _getMilestone,
    },
  };
})(window);
