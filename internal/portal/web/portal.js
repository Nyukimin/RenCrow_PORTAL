(() => {
  'use strict';

  const body = document.body;
  const requestedMode = String(body.dataset.mode || '').toLowerCase();
  const mode = ['idlechat', 'chat', 'games'].includes(requestedMode) ? requestedMode : 'idlechat';
  const uiMetrics = (() => {
    const enabled = mode === 'chat'
      && new URLSearchParams(window.location.search || '').get('ui_metrics') === '1';
    if (!enabled) return null;

    const capacity = 2048;
    const records = new Array(capacity);
    const capturedMessageIDs = new Set();
    let count = 0;
    let droppedCount = 0;
    let nextSubmissionID = 0;
    const responseReceiptEvents = [
      'ui_response_received',
      'ui_delegation_notice_received',
      'ui_readback_received',
      'ui_report_reply_received',
      'ui_unclassified_response_received',
    ];

    function boundedID(value) {
      const text = String(value || '').trim();
      return text.length <= 128 ? text : '';
    }

    function append(event, context = null, details = {}) {
      if (count >= capacity) {
        droppedCount += 1;
        return false;
      }
      const record = {
        event,
        at_ms: performance.now(),
        submission_id: context && context.id ? context.id : null,
        trace_id: boundedID(context && context.traceID),
        turn_id: boundedID(context && context.turnID),
        message_id: boundedID(context && context.messageID),
        delegation_id: boundedID(context && context.delegationID),
        origin_turn_id: boundedID(context && context.originTurnID),
        origin_input_message_id: boundedID(context && context.originInputMessageID),
      };
      if (details.stage) record.stage = String(details.stage).slice(0, 64);
      if (details.errorName) record.error_name = String(details.errorName).slice(0, 64);
      if (details.kind) record.kind = String(details.kind).trim().toLowerCase().slice(0, 64);
      if (details.visibilityState) record.visibility_state = String(details.visibilityState).slice(0, 32);
      records[count] = record;
      count += 1;
      return true;
    }

    function correlateAcceptedSubmission(context, traceID, turnID, inputMessageID) {
      if (!context || !context.id) return;
      const requestEvents = ['ui_submit', 'ui_send_preparation_end', 'ui_post_start', 'ui_ack_received'];
      const eventRows = [...responseReceiptEvents, 'ui_dom_updated', 'ui_render_opportunity'];
      for (let index = context.startIndex; index < count; index += 1) {
        const record = records[index];
        if (!record) continue;
        if (record.submission_id === context.id && requestEvents.includes(record.event)) {
          if (!record.trace_id) record.trace_id = traceID;
          if (!record.turn_id) record.turn_id = turnID;
          if (!record.origin_input_message_id) record.origin_input_message_id = inputMessageID;
          continue;
        }
        const isEventRow = eventRows.includes(record.event)
          || (record.event === 'ui_error' && record.stage === 'sse_terminal');
        if (traceID && !record.submission_id && record.trace_id === traceID && isEventRow) {
          record.submission_id = context.id;
        }
      }
    }

    function beginSubmission() {
      const context = {
        id: ++nextSubmissionID,
        startIndex: count,
        traceID: '',
        turnID: '',
        messageID: '',
        delegationID: '',
        originTurnID: '',
        originInputMessageID: '',
        clientSubmissionID: '',
      };
      append('ui_submit', context);
      return context;
    }

    function identifySubmission(context, clientSubmissionID) {
      if (!context || !context.id) return;
      context.clientSubmissionID = boundedID(clientSubmissionID);
    }

    function recordError(stage, error, context = null, traceID = '', messageID = '', kind = '') {
      const errorContext = context || {traceID, messageID};
      append('ui_error', errorContext, {
        stage,
        errorName: error && error.name ? error.name : 'Error',
        kind,
      });
    }

    function responseContext(event, submission) {
      const traceID = boundedID(event && event.trace_id);
      const messageID = boundedID(event && event.message_id);
      const responseToTurnID = boundedID(event && event.response_to_turn_id);
      const responseToSubmissionID = boundedID(event && event.response_to_client_submission_id);
      const hasResponseTo = Boolean(responseToTurnID || responseToSubmissionID);
      const turnID = hasResponseTo ? responseToTurnID : boundedID(event && event.turn_id);
      const clientSubmissionID = hasResponseTo ? responseToSubmissionID : boundedID(event && event.client_submission_id);
      const matched = submission && (
        hasResponseTo
          ? ((responseToSubmissionID && submission.clientSubmissionID === responseToSubmissionID)
            || (responseToTurnID && submission.turnID === responseToTurnID))
          : ((submission.traceID && submission.traceID === traceID)
            || (submission.clientSubmissionID && submission.clientSubmissionID === clientSubmissionID)
            || (submission.turnID && submission.turnID === turnID))
      )
        ? submission
        : null;
      return Object.freeze({
        id: matched ? matched.id : 0,
        startIndex: matched ? matched.startIndex : count,
        traceID,
        turnID,
        messageID,
        delegationID: boundedID(event && event.delegation_id),
        originTurnID: boundedID(event && (event.origin_turn_id || (responseToTurnID && event.turn_id))),
        originInputMessageID: boundedID(event && (event.origin_input_message_id
          || event.origin_user_message_id || event.reply_to_message_id)),
      });
    }

    function captureSSE(event, submission) {
      const type = String(event && event.type || '');
      const kind = String(event && event.kind || '').trim().toLowerCase();
      const traceID = boundedID(event && event.trace_id);
      const messageID = boundedID(event && event.message_id);
      const userResponse = type === 'agent.response' && String(event && event.to || '').toLowerCase() === 'user';
      const terminalError = ['turn.error', 'turn_error'].includes(type)
        || (userResponse && ['turn_error', 'handoff_error'].includes(kind));
      const errorEvent = ['agent.error', 'mailbox.error', 'worker.classified_failure', 'viewer.error'].includes(type);
      if (!terminalError && !userResponse && !errorEvent) return null;
      if (messageID) {
        if (capturedMessageIDs.has(messageID)) return null;
        capturedMessageIDs.add(messageID);
        if (capturedMessageIDs.size > capacity) capturedMessageIDs.delete(capturedMessageIDs.values().next().value);
      }
      if (terminalError) {
        const context = responseContext(event, submission);
        recordError('sse_terminal', null, context, traceID, messageID, kind || type);
        return context;
      }
      if (userResponse) {
        const context = responseContext(event, submission);
        const receiptEvent = {
          reply: 'ui_response_received',
          delegation_notice: 'ui_delegation_notice_received',
          readback: 'ui_readback_received',
          report_reply: 'ui_report_reply_received',
        }[kind] || (kind ? 'ui_unclassified_response_received' : 'ui_response_received');
        append(receiptEvent, context, {kind});
        return context;
      }
      if (errorEvent) {
        const context = responseContext(event, submission);
        recordError('sse_terminal', null, context, traceID, messageID, kind);
      }
      return null;
    }

    function acknowledge(context, accepted) {
      if (!context) return;
      const traceID = boundedID(accepted && accepted.trace_id);
      const turnID = boundedID(accepted && accepted.turn_id);
      const inputMessageID = boundedID(accepted && accepted.input_message_id);
      if (!context.traceID) context.traceID = traceID;
      if (!context.turnID) context.turnID = turnID;
      if (!context.originInputMessageID) context.originInputMessageID = inputMessageID;
      append('ui_ack_received', context);
      correlateAcceptedSubmission(context, traceID, turnID, inputMessageID);
    }

    function recordDOMUpdate(context, kind = '') {
      const capturedContext = context ? Object.freeze({...context}) : null;
      append('ui_dom_updated', capturedContext, {kind});
      requestAnimationFrame(() => append('ui_render_opportunity', capturedContext, {kind}));
    }

    function snapshot() {
      const copiedRecords = records.slice(0, count).map((record) => Object.freeze({...record}));
      return Object.freeze({
        version: 1,
        capacity,
        count,
        dropped_count: droppedCount,
        overflowed: droppedCount > 0,
        records: Object.freeze(copiedRecords),
      });
    }

    append('ui_visibility', null, {visibilityState: document.visibilityState});
    document.addEventListener('visibilitychange', () => {
      append('ui_visibility', null, {visibilityState: document.visibilityState});
    });
    window.RenCrowPortalMetrics = Object.freeze({snapshot});

    return Object.freeze({beginSubmission, identifySubmission, append, captureSSE, acknowledge, recordError, recordDOMUpdate});
  })();
  const roomSurface = ['idlechat', 'chat', 'games'].includes(mode);
  const fixedCanvasSurface = mode === 'chat' || mode === 'idlechat';
  const viewportProfiles = Object.freeze({
    landscape: Object.freeze({
      id: 'landscape',
      physicalWidth: 1920,
      physicalHeight: 1080,
      logicalWidth: 1920,
      logicalHeight: 1080,
    }),
    portrait: Object.freeze({
      id: 'portrait',
      physicalWidth: 1179,
      physicalHeight: 2556,
      logicalWidth: 393,
      logicalHeight: 852,
    }),
  });
  const chat = document.getElementById('chat');
  const empty = document.getElementById('empty');
  const input = document.getElementById('roomInput');
  const topicText = document.getElementById('topicText');
  const connectionDot = document.getElementById('connectionDot');
  const connectionText = document.getElementById('connectionText');
  const operationStatus = document.getElementById('operationStatus');
  const idlePlaybackPlay = document.getElementById('idlePlaybackPlay');
  const idlePlaybackNext = document.getElementById('idlePlaybackNext');
  const idlePlaybackPrevious = document.getElementById('idlePlaybackPrevious');
	let idleTopicPlayback = null;
  const chatAutoFollowThreshold = 24;
  const chatScrollState = {
    initialized: false,
    following: true,
  };
  const seenEvents = new Set();
  const partnerStorageKey = 'roomConversation.selectedPartner';
  const ttsPreferenceStorageKey = 'rencrow.portal.ttsPreference';
  const chatTextSizeStorageKey = 'rencrow.portal.chatTextSize';
  const chatTextSizeOrder = Object.freeze(['small', 'medium', 'large']);
  const chatTextSizeLabels = Object.freeze({
    small: Object.freeze({mark: '小', label: '小'}),
    medium: Object.freeze({mark: '中', label: '中'}),
    large: Object.freeze({mark: '大', label: '大'}),
  });
  const storedRecipient = normalizeActor(localStorage.getItem(partnerStorageKey)) || normalizeActor(localStorage.getItem('rencrow.portal.partner')) || 'shiro';
  let selectedRecipient = storedRecipient;
  let selectedPartner = isPartnerActor(storedRecipient) ? storedRecipient : 'shiro';
  let modeSwitchBusy = false;
  let surfaceReady = false;
  let surfaceHeartbeat = null;
  let surfaceRequestSequence = Promise.resolve();
  const surfaceReadyListeners = new Set();
  let surfaceClaimConfirmed = false;
  let needsPresenceClaimAfterEventReconnect = false;
  let pendingRuntimeEpoch = '';
  const responseFirstEnabled = mode === 'chat'
    && new URLSearchParams(window.location.search || '').get('protocol_version') === '2';
  const requestStates = new Map();
  const requestsBySubmissionID = new Map();
  const requestsByTurnID = new Map();
  const requestsByTraceID = new Map();
  const requestsByInputMessageID = new Map();
  let conversationEventSource = null;
  let uncertainV2Submission = null;
  const earlyRequestSignals = [];
  const handledRequestEvents = new Set();
  const delegationBadges = new Map();
  const clarificationPrompts = new Map();
  let selectedClarificationPrompt = null;
  const requestStateLimit = 300;
  let statusRefreshGeneration = 0;
  let chatViewportFrameID = 0;
  let chatOrientationMedia = null;
  const requestGuardTimeoutMS = 305000;
  const viewerClientID = getViewerClientID();
  const surfacePresenceStorageKey = 'rencrow.portal.surfacePresenceV2';
  let surfacePresence = loadSurfacePresence();
  let acceptedControlSnapshot = surfacePresence ? {
    runtimeEpoch: surfacePresence.runtimeEpoch,
    stateRevision: surfacePresence.stateRevision,
    playbackGeneration: surfacePresence.playbackGeneration,
    playbackAllowed: false,
    playbackState: '',
    playbackActive: false,
    cleanupPending: false,
    foregroundReady: false,
  } : null;
  let surfaceLifecycleGeneration = 0;
  let surfaceReleasePending = false;
  window.RenCrowPortalPresence = Object.freeze({
    isReady: () => surfaceReady,
    subscribe(listener) {
      if (typeof listener !== 'function') return () => {};
      surfaceReadyListeners.add(listener);
      listener(surfaceReady);
      return () => surfaceReadyListeners.delete(listener);
    },
  });
  const viewerUserID = 'viewer-user';
  const viewerDeviceName = getViewerDeviceName();
  const attachmentControl = {
    files: [],
    maxTotalBytes: 120 * 1024 * 1024,
    maxFileBytes: 10 * 1024 * 1024,
    maxImageBytes: 20 * 1024 * 1024,
    maxVideoBytes: 100 * 1024 * 1024,
  };
  const ttsControl = {
    enabled: false,
    queue: [],
    playing: false,
    completedResponses: new Set(),
    responseCounts: new Map(),
    responseResults: new Map(),
    responseItems: new Map(),
    sessionResponses: new Map(),
    acknowledged: new Set(),
    seenChunks: new Set(),
    heartbeat: null,
    currentAudio: null,
    currentItem: null,
    currentFetchController: null,
    lifecycleGeneration: 0,
    audioObjectURL: '',
    audioContext: null,
    mediaSource: null,
    analyser: null,
    meterBuffer: null,
    meterFrameID: 0,
    speakingActor: '',
  };
  const sttControl = {
    enabled: false,
    socket: null,
    stream: null,
    context: null,
    source: null,
    processor: null,
    heartbeat: null,
    stopTimer: null,
    releaseOnCleanup: false,
    lastUtteranceError: '',
  };
  // Event decisions live in stt_events.js (pure, unit-tested); this file applies the effects.
  const sttEvents = window.RenCrowSTTEvents;

  const actorInfo = {
    user: {label: 'あなた', mark: 'U', color: '#64748b'},
    mio: {label: 'Mio', mark: 'M', color: '#426af3'},
    shiro: {label: 'Shiro', mark: 'S', color: '#7c62d7'},
    kuro: {label: 'Kuro', mark: 'K', color: '#334155'},
    midori: {label: 'Midori', mark: 'M', color: '#16846b'},
  };
  const avatarRuntimeIDs = {
    mio: 'mioAvatar',
    shiro: 'shiroAvatar',
    kuro: 'kuroAvatar',
    midori: 'midoriAvatar',
  };
  let latestAvatarSpeaker = 'mio';

  function normalizeChatTextSize(value) {
    return chatTextSizeOrder.includes(value) ? value : 'medium';
  }

  function applyChatTextSize(value, persistPreference = false) {
    const size = normalizeChatTextSize(value);
    const currentIndex = chatTextSizeOrder.indexOf(size);
    const nextSize = chatTextSizeOrder[(currentIndex + 1) % chatTextSizeOrder.length];
    const control = document.getElementById('roomTextSizeBtn');
    body.dataset.chatTextSize = size;
    if (control) {
      control.dataset.textSize = size;
      control.dataset.controlState = `TEXT_${size.toUpperCase()}`;
      control.textContent = chatTextSizeLabels[size].mark;
      control.title = `文字サイズ: ${chatTextSizeLabels[size].label}（押すと${chatTextSizeLabels[nextSize].label}へ変更）`;
      control.setAttribute('aria-label', control.title);
    }
    if (persistPreference) localStorage.setItem(chatTextSizeStorageKey, size);
  }

  function bindChatTextSizeControl() {
    const control = document.getElementById('roomTextSizeBtn');
    applyChatTextSize(localStorage.getItem(chatTextSizeStorageKey));
    if (!control) return;
    control.addEventListener('click', () => {
      const currentSize = normalizeChatTextSize(body.dataset.chatTextSize);
      const currentIndex = chatTextSizeOrder.indexOf(currentSize);
      applyChatTextSize(chatTextSizeOrder[(currentIndex + 1) % chatTextSizeOrder.length], true);
    });
  }

  function readLayoutViewportSize() {
    const root = document.documentElement;
    return {
      width: Math.max(1, root.clientWidth || window.innerWidth),
      height: Math.max(1, root.clientHeight || window.innerHeight),
    };
  }

  function resolveViewportProfile(viewport) {
    return viewport.width >= viewport.height ? viewportProfiles.landscape : viewportProfiles.portrait;
  }

  function usesFixedCanvas(profile) {
    return mode === 'chat' || (mode === 'idlechat' && profile.id === 'landscape');
  }

  function setViewportProfileMetadata(profile) {
    body.dataset.viewportProfile = profile.id;
    body.dataset.viewportPhysicalWidth = String(profile.physicalWidth);
    body.dataset.viewportPhysicalHeight = String(profile.physicalHeight);
    body.dataset.viewportLogicalWidth = String(profile.logicalWidth);
    body.dataset.viewportLogicalHeight = String(profile.logicalHeight);
    body.dataset.viewportDevicePixelRatio = String(window.devicePixelRatio || 1);
    document.documentElement.classList.toggle('portal-chat-landscape', profile.id === 'landscape');
    document.documentElement.classList.toggle('portal-chat-portrait', profile.id === 'portrait');
  }

  function fitChatCanvas(profile, viewport) {
    const scale = Math.min(viewport.width / profile.logicalWidth, viewport.height / profile.logicalHeight);
    const offsetX = (viewport.width - (profile.logicalWidth * scale)) / 2;
    const offsetY = (viewport.height - (profile.logicalHeight * scale)) / 2;

    body.style.setProperty('--chat-canvas-scale', String(scale));
    body.style.setProperty('--chat-canvas-offset-x', `${offsetX}px`);
    body.style.setProperty('--chat-canvas-offset-y', `${offsetY}px`);
    body.dataset.chatCanvasWidth = String(profile.logicalWidth);
    body.dataset.chatCanvasHeight = String(profile.logicalHeight);
    body.dataset.chatCanvasScale = String(scale);
    body.dataset.chatCanvasOffsetX = String(offsetX);
    body.dataset.chatCanvasOffsetY = String(offsetY);
  }

  function clearChatCanvasFit() {
    body.style.removeProperty('--chat-canvas-scale');
    body.style.removeProperty('--chat-canvas-offset-x');
    body.style.removeProperty('--chat-canvas-offset-y');
    delete body.dataset.chatCanvasWidth;
    delete body.dataset.chatCanvasHeight;
    delete body.dataset.chatCanvasScale;
    delete body.dataset.chatCanvasOffsetX;
    delete body.dataset.chatCanvasOffsetY;
  }

  function applyChatViewportProfile() {
    if (!fixedCanvasSurface) return;
    const viewport = readLayoutViewportSize();
    const profile = resolveViewportProfile(viewport);
    setViewportProfileMetadata(profile);
    const fixedCanvas = usesFixedCanvas(profile);
    document.documentElement.classList.toggle('portal-chat-fixed-canvas', fixedCanvas);
    if (fixedCanvas) {
      fitChatCanvas(profile, viewport);
    } else {
      clearChatCanvasFit();
    }
  }

  function scheduleChatViewportSync() {
    if (!fixedCanvasSurface) return;
    if (chatViewportFrameID) cancelAnimationFrame(chatViewportFrameID);
    chatViewportFrameID = requestAnimationFrame(() => {
      chatViewportFrameID = 0;
      applyChatViewportProfile();
    });
  }

  function bindChatViewportUpdates() {
    if (!fixedCanvasSurface) return;
    window.addEventListener('resize', scheduleChatViewportSync, {passive: true});
    window.addEventListener('pageshow', scheduleChatViewportSync, {passive: true});

    if (typeof window.matchMedia !== 'function') return;
    chatOrientationMedia = window.matchMedia('(orientation: portrait)');
    if (typeof chatOrientationMedia.addEventListener === 'function') {
      chatOrientationMedia.addEventListener('change', scheduleChatViewportSync);
      return;
    }
    if (typeof chatOrientationMedia.addListener === 'function') {
      chatOrientationMedia.addListener(scheduleChatViewportSync);
    }
  }

  function initializeChatCanvas() {
    if (!fixedCanvasSurface) return;
    if (mode === 'chat') document.documentElement.classList.add('portal-chat-fixed-canvas');
    body.dataset.chatCanvasFitPolicy = 'dynamic-layout-viewport';
    applyChatViewportProfile();
    bindChatViewportUpdates();
  }

  initializeChatCanvas();

  function isChatAtBottom() {
    if (!chat) return true;
    const remaining = chat.scrollHeight - chat.clientHeight - chat.scrollTop;
    return remaining <= chatAutoFollowThreshold;
  }

  function scrollChatToBottom() {
    if (!chat) return;
    chat.scrollTop = chat.scrollHeight;
  }

  function updateChatScrollFollow() {
    if (!chat) return;
    chatScrollState.following = isChatAtBottom();
  }

  function initializeChatScroll() {
    if (!chat || chatScrollState.initialized) return;
    chat.addEventListener('scroll', updateChatScrollFollow, {passive: true});
    chatScrollState.initialized = true;
    chatScrollState.following = true;
    scrollChatToBottom();
  }

  function maintainChatScroll() {
    if (!chat || !chatScrollState.following) return;
    scrollChatToBottom();
  }

  initializeChatScroll();

  function api(path) {
    return `/api/${mode}${path}`;
  }

  function getViewerClientID() {
    const key = 'rencrow.portal.viewerClientID';
    const existing = String(sessionStorage.getItem(key) || '').trim();
    if (existing) {
      let savedSequenceAvailable = false;
      try {
        const saved = JSON.parse(sessionStorage.getItem('rencrow.portal.surfacePresenceV2') || 'null');
        savedSequenceAvailable = Boolean(saved
          && saved.viewerClientID === existing
          && saved.protocolVersion === 2
          && typeof saved.runtimeEpoch === 'string' && saved.runtimeEpoch.trim()
          && typeof saved.registrationReceipt === 'string' && saved.registrationReceipt.trim()
          && Number.isSafeInteger(saved.updateSeq) && saved.updateSeq >= 0);
      } catch (_) {
        savedSequenceAvailable = false;
      }
      if (savedSequenceAvailable) return existing;
      if (typeof sessionStorage.removeItem === 'function') sessionStorage.removeItem('rencrow.portal.surfacePresenceV2');
    }
    const suffix = globalThis.crypto && typeof globalThis.crypto.randomUUID === 'function'
      ? globalThis.crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const created = `portal-${suffix}`;
    sessionStorage.setItem(key, created);
    return created;
  }

  function loadSurfacePresence() {
    try {
      const saved = JSON.parse(sessionStorage.getItem(surfacePresenceStorageKey) || 'null');
      if (!saved || saved.viewerClientID !== viewerClientID || saved.protocolVersion !== 2) return null;
      if (!saved.runtimeEpoch || !saved.registrationReceipt || !Number.isSafeInteger(saved.updateSeq) || saved.updateSeq < 0) return null;
      return {
        viewerClientID,
        protocolVersion: 2,
        runtimeEpoch: String(saved.runtimeEpoch),
        registrationReceipt: String(saved.registrationReceipt),
        surface: String(saved.surface || ''),
        updateSeq: saved.updateSeq,
        claimSeq: Number.isSafeInteger(saved.claimSeq) && saved.claimSeq > 0 ? saved.claimSeq : 0,
        stateRevision: Number.isSafeInteger(saved.stateRevision) && saved.stateRevision >= 0 ? saved.stateRevision : 0,
        playbackGeneration: Number.isSafeInteger(saved.playbackGeneration) && saved.playbackGeneration >= 0 ? saved.playbackGeneration : 0,
      };
    } catch (_) {
      return null;
    }
  }

  function saveSurfacePresence() {
    if (!surfacePresence) {
      if (typeof sessionStorage.removeItem === 'function') sessionStorage.removeItem(surfacePresenceStorageKey);
      return;
    }
    sessionStorage.setItem(surfacePresenceStorageKey, JSON.stringify(surfacePresence));
  }

  function currentSurfacePresenceRef() {
    if (!surfacePresence || surfacePresence.protocolVersion !== 2 || surfacePresence.claimSeq <= 0) return null;
    return {
      protocol_version: 2,
      runtime_epoch: surfacePresence.runtimeEpoch,
      registration_receipt: surfacePresence.registrationReceipt,
      claim_seq: surfacePresence.claimSeq,
    };
  }

  function getViewerDeviceName() {
    const platform = globalThis.navigator && navigator.userAgentData && navigator.userAgentData.platform
      ? navigator.userAgentData.platform
      : (globalThis.navigator && navigator.platform ? navigator.platform : 'unknown');
    return String(platform || 'unknown').trim().slice(0, 120) || 'unknown';
  }

  function normalizeActor(value) {
    const text = String(value || '').trim().toLowerCase();
    if (text === 'shiro' || text === 'しろ') return 'shiro';
    if (text === 'kuro' || text === 'くろ') return 'kuro';
    if (text === 'midori' || text === 'みどり') return 'midori';
    if (text === 'mio' || text === 'みお') return 'mio';
    if (text === 'user' || text === 'human') return 'user';
    return '';
  }

  function isPartnerActor(actor) {
    return ['shiro', 'kuro', 'midori'].includes(String(actor || '').toLowerCase());
  }

  function storeSelectedRecipient(actor) {
    localStorage.setItem(partnerStorageKey, actor);
    localStorage.setItem('rencrow.portal.partner', actor);
  }

  function isTTSExplicitlyDisabled() {
    return localStorage.getItem(ttsPreferenceStorageKey) === 'off';
  }

  function setConnection(state, text) {
    connectionDot.dataset.state = state;
    connectionText.textContent = text;
    document.querySelectorAll('[data-live-connection-dot]').forEach((dot) => { dot.dataset.state = state; });
    document.querySelectorAll('[data-room-connection-text]').forEach((label) => { label.textContent = text; });
  }

  function setOperation(text, isError = false) {
    operationStatus.textContent = text;
    operationStatus.classList.toggle('is-error', isError);
  }

  function setToggleState(control, name, enabled) {
    if (!control) return;
    const state = `${name}_${enabled ? 'ON' : 'OFF'}`;
    control.classList.toggle('off', !enabled);
    control.classList.toggle('is-active', enabled);
    control.setAttribute('aria-pressed', enabled ? 'true' : 'false');
    control.setAttribute('aria-label', state);
    control.title = state;
    control.dataset.controlState = state;
  }

  function makeClientSubmissionID() {
    const suffix = globalThis.crypto && typeof globalThis.crypto.randomUUID === 'function'
      ? globalThis.crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    return `portal-${String(suffix).replace(/[^A-Za-z0-9._:-]/g, '')}`;
  }

  function v2SubmissionFingerprint(payload) {
    const fields = {...payload};
    delete fields.client_submission_id;
    return JSON.stringify(fields);
  }

  function isBlockingRequest(request) {
    return request && ['submitting', 'accepted', 'delegation_pending', 'readback_pending'].includes(request.status);
  }

  function blockingRequest() {
    for (const request of requestStates.values()) {
      if (isBlockingRequest(request)) return request;
    }
    return null;
  }

  function syncRequestControls() {
    const isBusy = Boolean(blockingRequest());
    input.disabled = mode !== 'chat' || !surfaceReady || isBusy;
    setModeSwitcherBusy(modeSwitchBusy);
    if (mode === 'chat' && surfaceReady && !isBusy) input.focus();
  }

  function setRequestOperation(request, text, isError = false) {
    const current = blockingRequest();
    if (current && current !== request) return;
    setOperation(text, isError);
  }

  function boundedCorrelationID(value) {
    const text = String(value || '').trim();
    return text.length > 0 && text.length <= 128 ? text : '';
  }

  function requestIdentifiers(event) {
    const responseToSubmissionID = boundedCorrelationID(event && event.response_to_client_submission_id);
    const responseToTurnID = boundedCorrelationID(event && event.response_to_turn_id);
    const hasResponseTo = Boolean(responseToSubmissionID || responseToTurnID);
    return {
      submissionID: hasResponseTo ? responseToSubmissionID : boundedCorrelationID(event && event.client_submission_id),
      turnID: hasResponseTo ? responseToTurnID : boundedCorrelationID(event && event.turn_id),
      traceID: hasResponseTo ? '' : boundedCorrelationID(event && event.trace_id),
      inputMessageID: hasResponseTo ? '' : boundedCorrelationID(event && event.reply_to_message_id),
    };
  }

  function requestForIdentifiers(identifiers) {
    const matches = [];
    const candidates = [
      [requestsBySubmissionID, identifiers.submissionID],
      [requestsByTurnID, identifiers.turnID],
      [requestsByTraceID, identifiers.traceID],
      [requestsByInputMessageID, identifiers.inputMessageID],
    ];
    for (const [index, id] of candidates) {
      if (!id) continue;
      const request = index.get(id);
      if (request && !matches.includes(request)) matches.push(request);
    }
    return matches.length === 1 ? matches[0] : null;
  }

  function indexRequestIdentifiers(request) {
    if (request.clientSubmissionID) requestsBySubmissionID.set(request.clientSubmissionID, request);
    if (request.turnID) requestsByTurnID.set(request.turnID, request);
    if (request.traceID) requestsByTraceID.set(request.traceID, request);
    if (request.inputMessageID) requestsByInputMessageID.set(request.inputMessageID, request);
  }

  function createTurnRequest(recipient, protocolVersion, metricsSubmission, retrySubmissionID = '') {
    const clientSubmissionID = protocolVersion === 2 ? (retrySubmissionID || makeClientSubmissionID()) : '';
    const key = clientSubmissionID || `legacy-${makeClientSubmissionID()}`;
    const request = {
      key,
      protocolVersion,
      clientSubmissionID,
      recipient,
      turnID: '',
      traceID: '',
      inputMessageID: '',
      sessionID: '',
      status: 'submitting',
      timeoutID: null,
      metricsSubmission,
      serverSignalReceived: false,
      submissionFingerprint: '',
    };
    requestStates.set(key, request);
    indexRequestIdentifiers(request);
    request.timeoutID = window.setTimeout(() => {
      if (requestStates.get(key) !== request || !isBlockingRequest(request)) return;
      uiMetrics?.recordError('request_guard_timeout', null, metricsSubmission);
      finishTurnRequest(request, 'failed', '応答待ちがタイムアウトしました', true);
    }, requestGuardTimeoutMS);
    pruneRequestStates();
    syncRequestControls();
    return request;
  }

  function removeRequestIndexes(request) {
    for (const index of [requestsBySubmissionID, requestsByTurnID, requestsByTraceID, requestsByInputMessageID]) {
      for (const [id, indexed] of index) {
        if (indexed === request) index.delete(id);
      }
    }
  }

  function pruneRequestStates() {
    while (requestStates.size > requestStateLimit) {
      let removed = false;
      for (const [key, request] of requestStates) {
        if (isBlockingRequest(request) || (request.status === 'free' && request.delegationKey)) continue;
        requestStates.delete(key);
        removeRequestIndexes(request);
        if (request.delegationKey) clearDelegationBadge(request.delegationKey);
        removed = true;
        break;
      }
      if (!removed) break;
    }
  }

  function finishTurnRequest(request, status, message = '', isError = false) {
    if (!request || requestStates.get(request.key) !== request) return;
    window.clearTimeout(request.timeoutID);
    request.status = status;
    syncRequestControls();
    if (message) setRequestOperation(request, message, isError);
  }

  function isLegacyTerminalEvent(event) {
    const type = String(event && event.type || '');
    const visibility = String(event && event.visibility || '').trim().toLowerCase();
    if (visibility && visibility !== 'public') return false;
    return (type === 'agent.response' && normalizeActor(event && event.to) === 'user')
      || ['agent.error', 'mailbox.error', 'worker.classified_failure', 'viewer.error'].includes(type);
  }

  function eventActor(event) {
    const actor = event && event.actor;
    if (typeof actor === 'string') return normalizeActor(actor) || normalizeActor(event && event.from);
    if (actor && typeof actor === 'object') {
      return normalizeActor(actor.agent_id || actor.id || actor.name) || normalizeActor(event && event.from);
    }
    return normalizeActor(event && event.from);
  }

  function publicResponseKind(event) {
    const type = String(event && event.type || '');
    const kind = String(event && event.kind || '').trim().toLowerCase();
    const visibility = String(event && event.visibility || '').trim().toLowerCase();
    const actor = eventActor(event);
    const to = normalizeActor(event && event.to);
    const allowedKinds = ['reply', 'delegation_notice', 'readback', 'report_reply', 'clarification_prompt', 'handoff_error', 'turn_error'];
    if (!allowedKinds.includes(kind) || visibility !== 'public') return '';
    if (!['mio', 'shiro', 'kuro', 'midori'].includes(actor) || to !== 'user') return '';
    if (!['agent.response', 'turn.error', 'turn_error'].includes(type)) return '';
    return kind;
  }

  function rememberEarlyRequestSignal(event, kind, legacyFailure = false) {
    const identifiers = requestIdentifiers(event);
    if (!identifiers.submissionID && !identifiers.turnID && !identifiers.traceID && !identifiers.inputMessageID) return;
    earlyRequestSignals.push({
      ...identifiers,
      kind,
      legacyFailure,
      availability: String(event && event.availability || '').trim().toLowerCase(),
      delegationID: boundedCorrelationID(event && event.delegation_id),
    });
    if (earlyRequestSignals.length > 100) earlyRequestSignals.shift();
  }

  function applyRequestSignal(request, signal) {
    if (!request || !signal) return;
    request.serverSignalReceived = true;
    if (uncertainV2Submission && uncertainV2Submission.clientSubmissionID === request.clientSubmissionID) {
      uncertainV2Submission = null;
    }
    if (request.status === 'completed' || request.status === 'failed') return;
    const {kind, legacyFailure, availability} = signal;
    if (request.replyToMessageID
      && ['delegation_notice', 'readback', 'reply', 'report_reply', 'clarification_prompt'].includes(kind)) {
      consumeClarificationPrompt(request);
    }
    if (kind === 'delegation_notice') {
      if (isBlockingRequest(request)) {
        if (signal.delegationID) request.delegationKey = `delegation:${signal.delegationID}`;
        request.status = 'delegation_pending';
        setRequestOperation(request, '委譲を受付済みです。復唱を確認しています');
      }
    } else if (kind === 'readback') {
      request.delegationKey = signal.delegationID
        ? `delegation:${signal.delegationID}`
        : (request.turnID ? `turn:${request.turnID}` : '');
      if (availability === 'free') {
        request.status = 'free';
        setRequestOperation(request, 'Mioは対応可能です');
      } else if (isBlockingRequest(request)) {
        request.status = 'readback_pending';
        setRequestOperation(request, '復唱を受け取りました。対応状態を確認しています');
      }
    } else if (kind === 'reply' || kind === 'report_reply') {
      finishTurnRequest(request, 'completed', kind === 'report_reply' ? '報告への返答を受信しました' : '応答を受信しました');
    } else if (kind === 'clarification_prompt') {
      if (!isBlockingRequest(request) && request.status !== 'free') return;
      request.status = 'needs_clarification';
      setRequestOperation(request, 'Mioから確認事項があります。回答してください');
    } else if (kind === 'turn_error' || kind === 'handoff_error' || legacyFailure) {
      finishTurnRequest(request, 'failed', '応答処理がエラーで終了しました', true);
    }
    syncRequestControls();
  }

  function bindAcceptedRequest(request, accepted) {
    request.traceID = boundedCorrelationID(accepted && accepted.trace_id);
    request.turnID = boundedCorrelationID(accepted && accepted.turn_id);
    request.inputMessageID = boundedCorrelationID(accepted && accepted.input_message_id);
    request.sessionID = boundedCorrelationID(accepted && accepted.session_id);
    if (request.protocolVersion === 2) {
      const acceptedSubmissionID = boundedCorrelationID(accepted && accepted.client_submission_id);
      if (String(accepted && accepted.status || '').toLowerCase() !== 'accepted') throw new Error('CORE v2受付応答がacceptedではありません');
      if (acceptedSubmissionID !== request.clientSubmissionID) throw new Error('CORE受付応答のclient_submission_idが一致しません');
      if (!request.turnID || !request.traceID || !request.sessionID) throw new Error('CORE v2受付応答にTurn相関情報がありません');
    } else if (!request.traceID) {
      throw new Error('CORE応答にtrace_idがありません');
    }
    indexRequestIdentifiers(request);
    if (request.status === 'submitting') request.status = 'accepted';
    uiMetrics?.acknowledge(request.metricsSubmission, accepted);

    for (let index = 0; index < earlyRequestSignals.length;) {
      const signal = earlyRequestSignals[index];
      const matches = (signal.submissionID && signal.submissionID === request.clientSubmissionID)
        || (signal.turnID && signal.turnID === request.turnID)
        || (signal.traceID && signal.traceID === request.traceID)
        || (signal.inputMessageID && signal.inputMessageID === request.inputMessageID);
      if (!matches) {
        index += 1;
        continue;
      }
      earlyRequestSignals.splice(index, 1);
      applyRequestSignal(request, signal);
    }
    syncRequestControls();
  }

  function handleRequestEvent(event) {
    const type = String(event && event.type || '');
    const kind = publicResponseKind(event);
    const legacyTerminal = isLegacyTerminalEvent(event);
    if (!kind && !legacyTerminal) return;
    const messageID = boundedCorrelationID(event && event.message_id);
    const stateEventKey = messageID || [type, event && event.turn_id, event && event.trace_id, kind].map((value) => String(value || '')).join('|');
    if (handledRequestEvents.has(stateEventKey)) return;
    handledRequestEvents.add(stateEventKey);
    if (handledRequestEvents.size > 600) handledRequestEvents.delete(handledRequestEvents.values().next().value);

    const identifiers = requestIdentifiers(event);
    const request = requestForIdentifiers(identifiers);
    const signal = {
      ...identifiers,
      kind: kind || (legacyTerminal && type === 'agent.response' ? 'reply' : ''),
      legacyFailure: legacyTerminal && type !== 'agent.response',
      availability: String(event && event.availability || '').trim().toLowerCase(),
      delegationID: boundedCorrelationID(event && event.delegation_id),
    };
    if (request) {
      if (kind === 'clarification_prompt' && !clarificationPromptMatchesRequest(request, event)) return;
      if (request.protocolVersion === 2 && !kind) return;
      applyRequestSignal(request, signal);
      return;
    }
    // A clarification prompt may release a specific original request only
    // after its accepted input and delegation are both known. Do not keep a
    // pre-ACK control signal that might later match a different active turn.
    if (kind === 'clarification_prompt') return;
    rememberEarlyRequestSignal(event, signal.kind, signal.legacyFailure);
  }

  function clarificationPromptMatchesRequest(request, event) {
    const delegationID = boundedCorrelationID(event && event.delegation_id);
    const replyToMessageID = boundedCorrelationID(event && event.reply_to_message_id);
    const eventTraceID = boundedCorrelationID(event && event.trace_id);
    return request.protocolVersion === 2
      && String(event && event.availability || '').trim().toLowerCase() === 'free'
      && Boolean(delegationID && replyToMessageID && request.inputMessageID)
      && request.delegationKey === `delegation:${delegationID}`
      && request.inputMessageID === replyToMessageID
      && (!eventTraceID || !request.traceID || eventTraceID === request.traceID);
  }

  function eventKey(event) {
    const messageID = String(event && event.message_id || '').trim();
    if (messageID) return `message:${messageID}`;
    const eventID = String(event && event.event_id || '').trim();
    if (eventID) return `event:${eventID}`;
    return [event.seq, event.event_id, event.message_id, event.timestamp, event.type, event.from, event.content].map((value) => String(value || '')).join('|');
  }

  function shouldRenderEvent(event) {
    const content = String(event && event.content || '').trim();
    const type = String(event && event.type || '');
    const actor = eventActor(event);
    const kind = String(event && event.kind || '').trim().toLowerCase();
    const visibility = String(event && event.visibility || '').trim().toLowerCase();
    const allowedTypes = mode === 'chat'
      ? ['message.received', 'conversation.user_message', 'agent.response', 'turn.error', 'turn_error', 'agent.acknowledge', 'agent.progress']
      : ['idlechat.message'];
    if (!content || !allowedTypes.includes(type)) return false;
    if (visibility && visibility !== 'public') return false;
    const from = actor;
    const to = normalizeActor(event.to);
    if (type === 'message.received') return from === 'user';
    if (type === 'conversation.user_message') return responseFirstEnabled && visibility === 'public' && from === 'user';
    if (kind) return Boolean(publicResponseKind(event));
    // News fallback roleplay is public only for the Mio <-> Shiro handoff.
    if (type === 'agent.progress') {
      return event.route === 'CHAT' && ((from === 'mio' && to === 'shiro') || (from === 'shiro' && to === 'mio'));
    }
    // Only Shiro's public handoff readback is rendered from acknowledge events.
    if (type === 'agent.acknowledge') return from === 'shiro' && to === 'mio';
    if (type === 'agent.response') return to === 'user' && ['mio', 'shiro', 'kuro', 'midori'].includes(from);
    return ['mio', 'shiro', 'kuro', 'midori'].includes(from);
  }

  function formatTime(value) {
    const date = value ? new Date(value) : new Date();
    if (Number.isNaN(date.getTime())) return '';
    return new Intl.DateTimeFormat('ja-JP', {hour: '2-digit', minute: '2-digit'}).format(date);
  }

  function isCurrentIdleChatOutput(event) {
    if (mode !== 'idlechat') return true;
    if (!surfaceReady || !surfaceClaimConfirmed || !acceptedControlSnapshot) return false;
    const runtimeEpoch = String(event && event.runtime_epoch || '').trim();
    const playbackGeneration = Number(event && event.playback_generation);
    return runtimeEpoch === acceptedControlSnapshot.runtimeEpoch
      && Number.isSafeInteger(playbackGeneration)
      && playbackGeneration === acceptedControlSnapshot.playbackGeneration;
  }

  function setAvatarInput(actor, input) {
    const runtime = mode === 'chat'
      ? document.getElementById('chatAvatar')
      : document.getElementById(avatarRuntimeIDs[actor]);
    if (mode === 'chat' && normalizeActor(runtime?.getAttribute('character')) !== actor) return;
    if (!runtime || typeof runtime.setInput !== 'function') return;
    runtime.setInput(input);
  }

  function animateSpeaker(actor) {
    const portraitIDs = {shiro: 'shiroPortrait', kuro: 'kuroPortrait', midori: 'midoriPortrait'};
    const target = mode === 'chat'
      ? document.getElementById('chatPortrait')
      : document.getElementById(portraitIDs[actor] || 'mioPortrait');
    if (mode === 'chat' && normalizeActor(target?.dataset.character) !== actor) return;
    if (!target) return;
    latestAvatarSpeaker = actor;
    target.classList.remove('is-speaking');
    requestAnimationFrame(() => target.classList.add('is-speaking'));
    window.setTimeout(() => target.classList.remove('is-speaking'), 1300);
  }

  function boundedEventAttribute(value) {
    const text = String(value || '').trim();
    if (!text || text.length > 128 || !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(text)) return '';
    return text;
  }

  function clearDelegationBadge(key) {
    const badges = delegationBadges.get(key);
    if (!badges) return;
    for (const badge of badges) badge.remove();
    delegationBadges.delete(key);
  }

  function clearSelectedClarificationPrompt(expectedMessageID = '') {
    const selected = selectedClarificationPrompt;
    if (!selected || (expectedMessageID && selected.messageID !== expectedMessageID)) return false;
    selected.action.setAttribute('aria-pressed', 'false');
    if (!clarificationPrompts.get(selected.messageID)?.consumed) selected.action.textContent = 'この確認に回答';
    selected.action.classList.remove('is-active');
    if (selected.context) selected.context.remove();
    selected.row.removeAttribute('data-clarification-reply-selected');
    selectedClarificationPrompt = null;
    uncertainV2Submission = null;
    return true;
  }

  function selectClarificationPrompt(prompt) {
    if (!responseFirstEnabled || !prompt || prompt.consumed || !prompt.row.isConnected) return;
    if (selectedClarificationPrompt?.messageID === prompt.messageID) return;
    clearSelectedClarificationPrompt();
    uncertainV2Submission = null;
    const context = document.createElement('div');
    context.className = 'room-clarification-reply-context';
    context.dataset.clarificationReplyContext = 'true';
    context.dataset.clarificationPromptId = prompt.messageID;
    context.setAttribute('role', 'group');
    const label = document.createElement('span');
    label.textContent = `回答対象: ${prompt.content}`;
    const cancel = document.createElement('button');
    cancel.className = 'room-clarification-reply-cancel';
    cancel.type = 'button';
    cancel.dataset.clarificationReplyCancel = 'true';
    cancel.textContent = '選択を解除';
    cancel.addEventListener('click', () => {
      if (clearSelectedClarificationPrompt(prompt.messageID)) setOperation('確認事項の選択を解除しました');
    });
    context.append(label, cancel);
    prompt.bubble.append(context);
    prompt.row.dataset.clarificationReplySelected = 'true';
    prompt.action.setAttribute('aria-pressed', 'true');
    prompt.action.classList.add('is-active');
    prompt.action.textContent = '選択中';
    selectedClarificationPrompt = {...prompt, context};
    setOperation('選択した確認事項への回答を入力してください');
  }

  function addClarificationReplyAction(row, bubble, event) {
    if (!responseFirstEnabled || publicResponseKind(event) !== 'clarification_prompt') return;
    const messageID = boundedEventAttribute(event && event.message_id);
    const content = String(event && event.content || '').trim();
    if (!messageID || !content) return;
    const action = document.createElement('button');
    action.className = 'room-clarification-reply-action';
    action.type = 'button';
    action.dataset.clarificationReplyAction = 'true';
    action.dataset.clarificationPromptId = messageID;
    action.setAttribute('aria-pressed', 'false');
    action.textContent = 'この確認に回答';
    const prompt = {messageID, content, row, bubble, action, consumed: false};
    clarificationPrompts.set(messageID, prompt);
    action.addEventListener('click', () => selectClarificationPrompt(prompt));
    bubble.append(action);
  }

  function consumeClarificationPrompt(request) {
    const messageID = boundedCorrelationID(request && request.replyToMessageID);
    const prompt = clarificationPrompts.get(messageID);
    if (!prompt) return;
    prompt.consumed = true;
    prompt.action.disabled = true;
    prompt.action.setAttribute('aria-pressed', 'false');
    prompt.action.textContent = '回答を送信しました';
    if (selectedClarificationPrompt?.messageID === messageID) clearSelectedClarificationPrompt(messageID);
  }

  function updateDelegationBadge(row, event, kind) {
    const delegationID = boundedCorrelationID(event && event.delegation_id);
    const turnID = boundedCorrelationID(event && event.turn_id);
    const key = delegationID ? `delegation:${delegationID}` : (turnID ? `turn:${turnID}` : '');
    if (kind === 'report_reply') {
      if (delegationID) clearDelegationBadge(`delegation:${delegationID}`);
      if (turnID) clearDelegationBadge(`turn:${turnID}`);
      return;
    }
    if (kind === 'clarification_prompt' && key) {
      const badges = delegationBadges.get(key) || new Set();
      for (const badge of badges) {
        badge.dataset.delegationStatus = 'needs_clarification';
        badge.textContent = '確認事項あり';
      }
      const badge = document.createElement('span');
      badge.className = 'room-delegation-badge';
      badge.dataset.delegationId = delegationID;
      badge.dataset.turnId = turnID;
      badge.dataset.delegationStatus = 'needs_clarification';
      badge.textContent = '確認事項あり';
      row.append(badge);
      badges.add(badge);
      delegationBadges.set(key, badges);
      return;
    }
    if (kind !== 'readback' || !key) return;
    const badge = document.createElement('span');
    badge.className = 'room-delegation-badge';
    badge.dataset.delegationId = delegationID;
    badge.dataset.turnId = turnID;
    badge.textContent = '委譲作業中';
    row.append(badge);
    const badges = delegationBadges.get(key) || new Set();
    badges.add(badge);
    delegationBadges.set(key, badges);
  }

  function renderEvent(event, metricsContext = null) {
    if (!shouldRenderEvent(event)) return;
    if (mode === 'idlechat' && !isCurrentIdleChatOutput(event)) return;
    const key = eventKey(event);
    if (seenEvents.has(key)) return;
    seenEvents.add(key);
    if (seenEvents.size > 600) seenEvents.delete(seenEvents.values().next().value);

    const actor = eventActor(event) || normalizeActor(event.to) || 'mio';
    const info = actorInfo[actor] || actorInfo.mio;
    if (empty && empty.isConnected) empty.remove();

    const row = document.createElement('article');
    row.className = `msg${actor === 'shiro' ? ' shiro' : ''}`;
    row.dataset.traceId = boundedEventAttribute(event.trace_id);
    row.dataset.taskId = boundedEventAttribute(event.task_id);
    row.dataset.eventType = boundedEventAttribute(event.type);
    row.dataset.messageId = boundedEventAttribute(event.message_id);
    row.dataset.messageKind = boundedEventAttribute(event.kind);
    row.dataset.turnId = boundedEventAttribute(event.turn_id);
    row.dataset.actor = actor;
    const avatar = document.createElement('div');
    avatar.className = 'av';
    avatar.style.color = info.color;
    avatar.textContent = info.mark;
    const bubble = document.createElement('div');
    bubble.className = 'mb';
    const meta = document.createElement('div');
    meta.className = 'mh';
    const name = document.createElement('span');
    name.className = 'an';
    name.style.color = info.color;
    name.textContent = info.label;
    const time = document.createElement('span');
    time.className = 'tm';
    time.textContent = formatTime(event.timestamp);
    const content = document.createElement('div');
    content.className = 'mc';
    content.textContent = String(event.content || '').trim();
    meta.append(name, time);
    bubble.append(meta, content);
    addClarificationReplyAction(row, bubble, event);
    row.append(avatar, bubble);
    updateDelegationBadge(row, event, String(event.kind || '').trim().toLowerCase());
    chat.append(row);
    while (chat.children.length > 300) chat.firstElementChild.remove();
    maintainChatScroll();
    const kind = String(event.kind || '').trim().toLowerCase();
    if (uiMetrics && event.type === 'agent.response' && String(event.to || '').toLowerCase() === 'user'
      && !['turn_error', 'handoff_error'].includes(kind)) {
      uiMetrics.recordDOMUpdate(metricsContext, kind);
    }
    if (['mio', 'shiro', 'kuro', 'midori'].includes(actor)) animateSpeaker(actor);
  }

  function setChip(id, active) {
    const chip = document.getElementById(id);
    if (!chip) return;
    chip.classList.toggle('is-active', active);
    chip.setAttribute('aria-current', active ? 'true' : 'false');
    chip.setAttribute('aria-pressed', active ? 'true' : 'false');
  }

  function setConversationState(isIdle, recipient = selectedRecipient) {
    if (!roomSurface) return;
    const previousRecipient = selectedRecipient;
    let normalizedRecipient = normalizeActor(recipient);
    const request = blockingRequest();
    if (request && normalizedRecipient !== request.recipient) normalizedRecipient = request.recipient;
    if (!isIdle && (normalizedRecipient === 'mio' || isPartnerActor(normalizedRecipient))) {
      selectedRecipient = normalizedRecipient;
      if (isPartnerActor(normalizedRecipient)) selectedPartner = normalizedRecipient;
      storeSelectedRecipient(selectedRecipient);
    }
    if (selectedRecipient !== previousRecipient) uncertainV2Submission = null;
    body.classList.toggle('room-idlechat-mode', isIdle);
    body.classList.toggle('room-chat-mode', !isIdle);
    ['mio', 'shiro', 'kuro', 'midori'].forEach((actor) => body.classList.remove(`room-partner-${actor}`));
    const candidateRecipient = isIdle ? normalizedRecipient : selectedRecipient;
    const portraitRecipient = ['mio', 'shiro', 'kuro', 'midori'].includes(candidateRecipient) ? candidateRecipient : 'mio';
    body.classList.add(`room-partner-${portraitRecipient}`);
    body.dataset.roomConversationMode = isIdle ? 'idle' : 'chat';
    body.dataset.roomPartner = portraitRecipient;
    body.dataset.roomSelectedPartner = isIdle ? selectedPartner : selectedRecipient;
    if (!isIdle) {
      const chatPortrait = document.getElementById('chatPortrait');
      const chatAvatar = document.getElementById('chatAvatar');
      if (chatPortrait) {
        chatPortrait.dataset.character = portraitRecipient;
        chatPortrait.setAttribute('aria-label', actorInfo[portraitRecipient]?.label || portraitRecipient);
      }
      if (chatAvatar) {
        chatAvatar.setAttribute('character', portraitRecipient);
        chatAvatar.setAttribute('aria-label', `${actorInfo[portraitRecipient]?.label || portraitRecipient} PuruPuru avatar`);
      }
    }
    setChip('roomMioChip', !isIdle && selectedRecipient === 'mio');
    setChip('roomShiroChip', !isIdle && selectedRecipient === 'shiro');
    setChip('roomKuroChip', !isIdle && selectedRecipient === 'kuro');
    setChip('roomMidoriChip', !isIdle && selectedRecipient === 'midori');
  }

  async function refreshStatus() {
    const refreshGeneration = ++statusRefreshGeneration;
    try {
      const response = await fetch(api('/viewer/idlechat/status'), {cache: 'no-store'});
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const status = await response.json();
      if (refreshGeneration !== statusRefreshGeneration) return false;
      topicText.textContent = String(status.current_topic || '-');
	  idleTopicPlayback = status.topic_stock_playback || null;
	  updateIdlePlaybackControls();
      if (mode === 'idlechat') setConversationState(true, selectedPartner);
      return true;
    } catch (error) {
      if (refreshGeneration !== statusRefreshGeneration) return false;
      topicText.textContent = '-';
	  idleTopicPlayback = null;
	  updateIdlePlaybackControls(true);
      return false;
    }
  }

  async function refreshReadiness() {
    try {
      const response = await fetch('/health/ready', {cache: 'no-store'});
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      setConnection('ready', 'CORE接続済み');
    } catch (error) {
      setConnection('error', 'CORE未接続');
    }
  }

  function connectEvents() {
    const closedState = Number.isFinite(EventSource.CLOSED) ? EventSource.CLOSED : 2;
    if (conversationEventSource && conversationEventSource.readyState !== closedState) return conversationEventSource;
    if (conversationEventSource) {
      conversationEventSource.close();
      conversationEventSource.onopen = null;
      conversationEventSource.onmessage = null;
      conversationEventSource.onerror = null;
    }
    const events = new EventSource(api(responseFirstEnabled ? '/viewer/conversation/events' : '/viewer/events'));
    conversationEventSource = events;
    let resetHandled = false;
    if (typeof events.addEventListener === 'function') {
      events.addEventListener('reset', () => {
        if (resetHandled) return;
        resetHandled = true;
        events.close();
        setSurfaceReady(false);
        window.location.reload();
      });
      events.addEventListener('idlechat.control', (message) => {
        try {
          handleIdleChatControlEvent(JSON.parse(message.data));
        } catch (error) {
          uiMetrics?.recordError('sse_control', error, blockingRequest()?.metricsSubmission || null);
        }
      });
    }
    events.onopen = () => {
      setConnection('ready', 'CORE接続済み');
      if (needsPresenceClaimAfterEventReconnect && document.visibilityState === 'visible') claimVisibleSurface();
    };
    events.onmessage = (message) => {
      let metricsContext = blockingRequest()?.metricsSubmission || null;
      try {
        const event = JSON.parse(message.data);
        const request = requestForIdentifiers(requestIdentifiers(event));
        if (request) metricsContext = request.metricsSubmission;
        metricsContext = uiMetrics?.captureSSE(event, metricsContext) || metricsContext;
        if (request && request === blockingRequest() && event.type === 'agent.start' && request.traceID === boundedCorrelationID(event.trace_id)) {
          setRequestOperation(request, `${actorInfo[request.recipient].label}が応答を生成中です`);
        }
        handleRequestEvent(event);
        handleControlEvent(event);
        renderEvent(event, metricsContext);
      } catch (error) {
        uiMetrics?.recordError('sse_message', error, metricsContext);
        setConnection('error', 'イベント解析エラー');
      }
    };
    events.onerror = () => {
      uiMetrics?.recordError('sse_connection', null, blockingRequest()?.metricsSubmission || null);
      setConnection('waiting', '再接続中');
      if (!needsPresenceClaimAfterEventReconnect) {
        needsPresenceClaimAfterEventReconnect = true;
        surfaceLifecycleGeneration += 1;
        surfaceClaimConfirmed = false;
        acceptedControlSnapshot = null;
        stopSurfaceHeartbeat();
      }
      invalidateLocalPlaybackState();
      setSurfaceReady(false);
    };
    return events;
  }

  function reconnectClosedV2StreamAfterAcceptance() {
    if (!responseFirstEnabled || !conversationEventSource) return;
    const closedState = Number.isFinite(EventSource.CLOSED) ? EventSource.CLOSED : 2;
    if (conversationEventSource.readyState === closedState) connectEvents();
  }

  async function post(path, payload, metricsSubmission = null) {
    if (mode !== 'chat') throw new Error(`${mode}モードは閲覧専用です`);
    if (!surfaceReady) throw new Error('Chat画面の準備が完了していません');
    const options = {method: 'POST'};
    if (payload instanceof FormData) {
      options.body = payload;
    } else if (payload) {
      options.headers = {'Content-Type': 'application/json'};
      options.body = JSON.stringify(payload);
    }
    const requestURL = api(path);
    if (path === '/viewer/send') uiMetrics?.append('ui_post_start', metricsSubmission);
    let response;
    try {
      response = await fetch(requestURL, options);
    } catch (error) {
      if (path !== '/viewer/send') throw error;
      const uncertainError = new Error(error && error.message ? error.message : String(error));
      uncertainError.name = error && error.name ? error.name : 'Error';
      uncertainError.postOutcomeUnknown = true;
      throw uncertainError;
    }
    if (!response.ok) {
      let details;
      try {
        details = await response.text();
      } catch (error) {
        if (path !== '/viewer/send' || response.status < 500) throw error;
        const uncertainError = new Error(error && error.message ? error.message : String(error));
        uncertainError.name = error && error.name ? error.name : 'Error';
        uncertainError.postOutcomeUnknown = true;
        throw uncertainError;
      }
      const error = new Error(`HTTP ${response.status}: ${details}`);
      if (path === '/viewer/send') error.postOutcomeUnknown = response.status >= 500;
      throw error;
    }
    try {
      const contentType = String(response.headers.get('content-type') || '');
      return contentType.includes('application/json') ? await response.json() : null;
    } catch (error) {
      if (path !== '/viewer/send') throw error;
      const uncertainError = new Error(error && error.message ? error.message : String(error));
      uncertainError.name = error && error.name ? error.name : 'Error';
      uncertainError.postOutcomeUnknown = true;
      throw uncertainError;
    }
  }

  function updateIdlePlaybackControls(forceDisabled = false) {
	const playback = idleTopicPlayback || {};
	const disabled = mode !== 'idlechat' || !surfaceReady || forceDisabled;
	if (idlePlaybackPlay) idlePlaybackPlay.disabled = disabled || (!playback.current && !playback.can_next);
	if (idlePlaybackNext) idlePlaybackNext.disabled = disabled || !playback.can_next;
	if (idlePlaybackPrevious) idlePlaybackPrevious.disabled = disabled || !playback.can_previous;
  }

  async function postIdleChatPlayback(action) {
	if (mode !== 'idlechat') throw new Error('IdleChatモード専用の操作です');
	if (!surfaceReady) throw new Error('IdleChat画面の準備が完了していません');
	const presence = currentSurfacePresenceRef();
	if (!presence) throw new Error('IdleChatのpresence V2 claimを確認できません');
	const lifecycleGeneration = surfaceLifecycleGeneration;
	const expectedStateRevision = surfacePresence.stateRevision;
	const expectedRuntimeEpoch = presence.runtime_epoch;
	const expectedPlaybackGeneration = acceptedControlSnapshot && acceptedControlSnapshot.playbackGeneration;
	updateIdlePlaybackControls(true);
	const response = await fetch(api('/viewer/idlechat/playback'), {
	  method: 'POST',
	  headers: {'Content-Type': 'application/json'},
	  body: JSON.stringify({
	    protocol_version: 2,
	    viewer_client_id: viewerClientID,
	    runtime_epoch: presence.runtime_epoch,
	    registration_receipt: presence.registration_receipt,
	    claim_seq: presence.claim_seq,
	    expected_state_revision: expectedStateRevision,
	    action,
	  }),
	});
	if (!response.ok) throw new Error(`HTTP ${response.status}: ${await response.text()}`);
	const result = await response.json();
	if (lifecycleGeneration !== surfaceLifecycleGeneration || !surfaceReady || document.visibilityState !== 'visible') return null;
	const currentControl = acceptedControlSnapshot;
	if (!currentControl || currentControl.runtimeEpoch !== expectedRuntimeEpoch
	  || currentControl.playbackGeneration !== expectedPlaybackGeneration
	  || !currentControl.playbackAllowed || currentControl.cleanupPending
	  || (result.runtime_epoch && result.runtime_epoch !== expectedRuntimeEpoch)
	  || (Number.isSafeInteger(result.playback_generation) && result.playback_generation !== expectedPlaybackGeneration)
	  || (Number.isSafeInteger(result.state_revision) && result.state_revision < Math.max(expectedStateRevision, currentControl.stateRevision))) {
	  setSurfaceReady(false);
	  throw new Error('COREのIdleChat再生応答が現在の状態版と一致しません');
	}
	if (Number.isSafeInteger(result.state_revision)) {
	  surfacePresence.stateRevision = Math.max(surfacePresence.stateRevision, result.state_revision);
	  acceptedControlSnapshot.stateRevision = Math.max(acceptedControlSnapshot.stateRevision, result.state_revision);
	  saveSurfacePresence();
	}
	idleTopicPlayback = result.playback || null;
	updateIdlePlaybackControls();
	return result;
  }

  function bindIdleChatPlaybackControls() {
	if (mode !== 'idlechat') return;
	[
	  [idlePlaybackPlay, 'play', '再生'],
	  [idlePlaybackNext, 'next', '次の話題へ移動'],
	  [idlePlaybackPrevious, 'previous', '前の話題へ移動'],
	].forEach(([control, action, label]) => {
	  if (!control) return;
	  control.addEventListener('click', async () => {
		setOperation(`${label}中`);
		try {
		  const result = await postIdleChatPlayback(action);
		  if (!result) return;
		  await refreshStatus();
		  setOperation(action === 'play' ? '再生を開始しました' : `${label}しました`);
		} catch (error) {
		  setOperation(`${label}できません: ${error.message}`, true);
		  await refreshStatus();
		}
	  });
	});
	updateIdlePlaybackControls();
  }

  async function postSurfacePresence(payload, keepalive = false) {
    const response = await fetch(api('/viewer/surface-presence'), {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify(payload),
      keepalive,
    });
    if (!response.ok) {
      const details = await response.text();
      const error = new Error(`HTTP ${response.status}: ${details}`);
      error.status = response.status;
      error.details = details;
      throw error;
    }
    return response.json();
  }

  function setSurfaceReady(ready) {
    const nextReady = Boolean(ready);
    const changed = surfaceReady !== nextReady;
    surfaceReady = nextReady;
	if (!nextReady) invalidateLocalPlaybackState();
	updateIdlePlaybackControls();
    if (mode === 'chat') {
      syncRequestControls();
      document.querySelectorAll('#roomAudioBtn, #roomMicBtn').forEach((control) => {
        control.disabled = !surfaceReady;
        control.setAttribute('aria-disabled', control.disabled ? 'true' : 'false');
      });
    }
    if (changed) surfaceReadyListeners.forEach((listener) => listener(surfaceReady));
  }

  function validV2Registration(response) {
    return response && response.ok === true && response.protocol_version === 2
      && typeof response.runtime_epoch === 'string' && response.runtime_epoch.trim() !== ''
      && typeof response.registration_receipt === 'string' && response.registration_receipt.trim() !== ''
      && Number.isSafeInteger(response.last_update_seq) && response.last_update_seq >= 0;
  }

  function validV2Update(response, state, request) {
    if (!response || response.protocol_version !== 2
      || response.runtime_epoch !== state.runtimeEpoch
      || response.registration_receipt !== state.registrationReceipt
      || response.accepted_update_seq !== request.update_seq
      || !Number.isSafeInteger(response.state_revision) || response.state_revision < 0
      || !Number.isSafeInteger(response.playback_generation) || response.playback_generation < 0) return false;
    if (request.action === 'claim') return response.current_claim_seq === request.update_seq;
    if (request.action === 'heartbeat') return response.current_claim_seq === request.claim_seq;
    return true;
  }

  function currentSurfaceAttempt(generation) {
    return generation === surfaceLifecycleGeneration;
  }

  function invalidateLocalPlaybackState() {
    if (mode === 'idlechat' && chat) chat.replaceChildren();
    clearTTSPlayback();
  }

  function controlSnapshotFrom(value) {
    const runtimeEpoch = String(value && value.runtime_epoch || '').trim();
    const stateRevision = Number(value && value.state_revision);
    const playbackGeneration = Number(value && value.playback_generation);
    if (!runtimeEpoch || !Number.isSafeInteger(stateRevision) || stateRevision < 0
      || !Number.isSafeInteger(playbackGeneration) || playbackGeneration < 0) return null;
    return {
      runtimeEpoch,
      stateRevision,
      playbackGeneration,
      playbackState: String(value.playback_state || ''),
      playbackAllowed: value.playback_allowed === true,
      playbackActive: value.playback_active === true,
      cleanupPending: value.cleanup_pending === true,
      generationState: String(value.generation_state || ''),
      generationQuiesced: value.generation_quiesced === true,
      backendResourceState: String(value.backend_resource_state || ''),
      foregroundReady: value.foreground_ready === true,
    };
  }

  function currentControlVersion() {
    if (acceptedControlSnapshot) return acceptedControlSnapshot;
    if (!surfacePresence) return null;
    return {
      runtimeEpoch: surfacePresence.runtimeEpoch,
      stateRevision: surfacePresence.stateRevision,
      playbackGeneration: surfacePresence.playbackGeneration,
    };
  }

  function beginRuntimeEpochRecovery(runtimeEpoch) {
    const nextEpoch = String(runtimeEpoch || '').trim();
    if (!nextEpoch || pendingRuntimeEpoch === nextEpoch) return;
    pendingRuntimeEpoch = nextEpoch;
    surfaceClaimConfirmed = false;
    setSurfaceReady(false);
    invalidateLocalPlaybackState();
    if (document.visibilityState === 'visible') claimVisibleSurface();
  }

  function acceptControlSnapshot(value, source, expectedEpoch = '') {
    const snapshot = controlSnapshotFrom(value);
    if (!snapshot) return false;
    if (expectedEpoch && snapshot.runtimeEpoch !== expectedEpoch) return false;
    const current = currentControlVersion();
    if (current && snapshot.runtimeEpoch !== current.runtimeEpoch) {
      if (source === 'control') beginRuntimeEpochRecovery(snapshot.runtimeEpoch);
      return false;
    }
    if (current && (snapshot.stateRevision < current.stateRevision
      || snapshot.playbackGeneration < current.playbackGeneration)) return false;

    const previous = acceptedControlSnapshot;
    acceptedControlSnapshot = snapshot;
    if (surfacePresence && surfacePresence.runtimeEpoch === snapshot.runtimeEpoch) {
      surfacePresence.stateRevision = snapshot.stateRevision;
      surfacePresence.playbackGeneration = snapshot.playbackGeneration;
      saveSurfacePresence();
    }
    const generationChanged = previous
      && previous.runtimeEpoch === snapshot.runtimeEpoch
      && previous.playbackGeneration !== snapshot.playbackGeneration;
    const idlePlaybackBlocked = mode === 'idlechat'
      && (snapshot.playbackAllowed !== true || snapshot.cleanupPending);
    if (generationChanged || idlePlaybackBlocked) invalidateLocalPlaybackState();

    if (source === 'control' && mode === 'idlechat') {
      setSurfaceReady(surfaceClaimConfirmed
        && !needsPresenceClaimAfterEventReconnect
        && snapshot.playbackAllowed
        && !snapshot.cleanupPending);
      if (!snapshot.playbackAllowed || snapshot.cleanupPending) {
        setOperation('別の画面またはCMDを使用中のため、再生を停止しています');
      } else {
        setOperation('IdleChat再生を利用できます');
      }
    }
    return true;
  }

  function handleIdleChatControlEvent(value) {
    const snapshot = controlSnapshotFrom(value);
    if (!snapshot) return;
    const current = currentControlVersion();
    if (current && snapshot.runtimeEpoch !== current.runtimeEpoch) {
      beginRuntimeEpochRecovery(snapshot.runtimeEpoch);
      return;
    }
    acceptControlSnapshot(value, 'control');
  }

  async function registerSurfacePresence(generation) {
    const response = await postSurfacePresence({
      protocol_version: 2,
      viewer_client_id: viewerClientID,
      action: 'register',
    });
    if (!currentSurfaceAttempt(generation) || document.visibilityState !== 'visible') return false;
    if (!validV2Registration(response)) throw new Error('COREはsurface-presence V2 registerに対応していません');
    const previousEpoch = surfacePresence && surfacePresence.runtimeEpoch;
    if ((previousEpoch && previousEpoch !== response.runtime_epoch)
      || (acceptedControlSnapshot && acceptedControlSnapshot.runtimeEpoch !== response.runtime_epoch)) {
      acceptedControlSnapshot = null;
      surfaceClaimConfirmed = false;
      invalidateLocalPlaybackState();
    }
    if (pendingRuntimeEpoch) {
      if (pendingRuntimeEpoch !== response.runtime_epoch) {
        acceptedControlSnapshot = null;
      }
      pendingRuntimeEpoch = '';
    }
    const sameReceipt = surfacePresence
      && surfacePresence.runtimeEpoch === response.runtime_epoch
      && surfacePresence.registrationReceipt === response.registration_receipt;
    surfacePresence = {
      viewerClientID,
      protocolVersion: 2,
      runtimeEpoch: response.runtime_epoch,
      registrationReceipt: response.registration_receipt,
      surface: sameReceipt ? surfacePresence.surface : '',
      updateSeq: Math.max(sameReceipt ? surfacePresence.updateSeq : 0, response.last_update_seq),
      claimSeq: sameReceipt ? surfacePresence.claimSeq : 0,
      stateRevision: sameReceipt ? surfacePresence.stateRevision : 0,
      playbackGeneration: sameReceipt ? surfacePresence.playbackGeneration : 0,
    };
    saveSurfacePresence();
    return true;
  }

  function applySurfacePresenceResponse(response) {
    if (!acceptControlSnapshot(response, 'presence', surfacePresence && surfacePresence.runtimeEpoch)) return false;
    const ready = surfaceClaimConfirmed && (mode === 'idlechat'
      ? acceptedControlSnapshot.playbackAllowed && !acceptedControlSnapshot.cleanupPending
      : acceptedControlSnapshot.foregroundReady);
    setSurfaceReady(ready);
    if (mode === 'chat') {
      setOperation(ready ? 'Chat準備完了' : '前景利用を確認しています', !ready);
    } else if (mode === 'idlechat') {
      if (String(response.effective_mode || '').toLowerCase() === 'chat' || response.playback_state === 'blocked') {
        setOperation('別の画面またはCMDを使用中のため、再生を停止しています');
      } else if (ready) {
        setOperation('IdleChat再生を利用できます');
      } else {
        setOperation('接続を確認しています', true);
      }
    }
    return true;
  }

  function queueSurfacePresence(action, generation = surfaceLifecycleGeneration, keepalive = false) {
    surfaceRequestSequence = surfaceRequestSequence.catch(() => {}).then(async () => {
      if (!currentSurfaceAttempt(generation)) return null;
      if (action !== 'release' && document.visibilityState !== 'visible') return null;
      if (action === 'claim' && !await registerSurfacePresence(generation)) return null;
      async function submitUpdate(allowRegistrationRefresh) {
        const state = surfacePresence;
        if (!state) return null;
        const updateSeq = state.updateSeq + 1;
        const request = {
          protocol_version: 2,
          viewer_client_id: viewerClientID,
          runtime_epoch: state.runtimeEpoch,
          registration_receipt: state.registrationReceipt,
          surface: mode,
          action,
          update_seq: updateSeq,
        };
        if (action === 'heartbeat' || action === 'release') request.claim_seq = state.claimSeq;
        state.updateSeq = updateSeq;
        if (action === 'claim') state.claimSeq = updateSeq;
        state.surface = mode;
        saveSurfacePresence();
        let response;
        try {
          response = await postSurfacePresence(request, keepalive);
        } catch (error) {
          const registrationRequired = error.status === 409 && String(error.details || '').includes('registration_required');
          if (!allowRegistrationRefresh || action !== 'claim' || !registrationRequired
            || !currentSurfaceAttempt(generation)) throw error;
          surfacePresence = null;
          saveSurfacePresence();
          if (!await registerSurfacePresence(generation)) return null;
          return submitUpdate(false);
        }
        if (!currentSurfaceAttempt(generation)) return null;
        if (action !== 'release' && document.visibilityState !== 'visible') return null;
        if (response && response.runtime_epoch && response.runtime_epoch !== state.runtimeEpoch) {
          beginRuntimeEpochRecovery(response.runtime_epoch);
          throw new Error('COREの起動世代が変わりました');
        }
        if (!validV2Update(response, state, request)) throw new Error('COREのsurface-presence V2応答が一致しません');
        if (action === 'release') {
          surfacePresence = null;
          saveSurfacePresence();
          return response;
        }
        if (action === 'claim') {
          surfaceClaimConfirmed = true;
          needsPresenceClaimAfterEventReconnect = false;
        }
        if (!applySurfacePresenceResponse(response)) {
          if (action === 'claim') surfaceClaimConfirmed = false;
          throw new Error('COREのsurface-presence応答が古い状態版です');
        }
        return response;
      }
      return submitUpdate(action === 'claim');
    });
    return surfaceRequestSequence;
  }

  function stopSurfaceHeartbeat() {
    window.clearInterval(surfaceHeartbeat);
    surfaceHeartbeat = null;
  }

  function startSurfaceHeartbeat() {
    stopSurfaceHeartbeat();
    surfaceHeartbeat = window.setInterval(() => {
      if (document.visibilityState !== 'visible') return;
      if (!surfacePresence || surfacePresence.surface !== mode || surfacePresence.claimSeq <= 0) {
        claimVisibleSurface();
        return;
      }
      queueSurfacePresence('heartbeat').then((response) => {
        if (!response || !currentSurfaceAttempt(surfaceLifecycleGeneration)) return;
      }).catch((error) => {
        setSurfaceReady(false);
        setOperation(`画面状態を維持できません: ${error.message}`, true);
        claimVisibleSurface();
      });
    }, 10000);
  }

  function claimVisibleSurface() {
    if (!roomSurface || document.visibilityState !== 'visible') return;
    const generation = ++surfaceLifecycleGeneration;
    surfaceReleasePending = false;
    surfaceClaimConfirmed = false;
    setSurfaceReady(false);
    invalidateLocalPlaybackState();
    setOperation(mode === 'chat' ? 'Chatの準備中' : mode === 'games' ? 'Gamesの準備中' : 'IdleChatの準備中');
    queueSurfacePresence('claim', generation)
      .then((response) => {
        if (response && currentSurfaceAttempt(generation)) startSurfaceHeartbeat();
      })
      .catch((error) => {
        if (!currentSurfaceAttempt(generation)) return;
        setSurfaceReady(false);
        setOperation(`${mode === 'chat' ? 'Chat' : mode === 'games' ? 'Games' : 'IdleChat'}を準備できません: ${error.message}`, true);
        if (document.visibilityState === 'visible') startSurfaceHeartbeat();
      });
  }

  function releaseSurface() {
    if (!roomSurface) return;
    if (surfaceReleasePending) return;
    const generation = ++surfaceLifecycleGeneration;
    surfaceReleasePending = true;
    surfaceClaimConfirmed = false;
    stopSurfaceHeartbeat();
    setSurfaceReady(false);
    clearTTSPlayback();
    queueSurfacePresence('release', generation, true).catch(() => {});
  }

  function releaseSurfaceOnPageHide() {
    if (!roomSurface) return;
    if (surfaceReleasePending) return;
    surfaceLifecycleGeneration += 1;
    surfaceReleasePending = true;
    surfaceClaimConfirmed = false;
    stopSurfaceHeartbeat();
    setSurfaceReady(false);
    clearTTSPlayback();
    if (!surfacePresence) return;
    const state = surfacePresence;
    const request = {
      protocol_version: 2,
      viewer_client_id: viewerClientID,
      runtime_epoch: state.runtimeEpoch,
      registration_receipt: state.registrationReceipt,
      surface: mode,
      action: 'release',
      update_seq: state.updateSeq + 1,
      claim_seq: state.claimSeq,
    };
    state.updateSeq = request.update_seq;
    saveSurfacePresence();
    const body = JSON.stringify(request);
    if (navigator.sendBeacon) {
      navigator.sendBeacon(api('/viewer/surface-presence'), new Blob([body], {type: 'application/json'}));
      return;
    }
    postSurfacePresence(request, true).catch(() => {});
  }

  function bindSurfacePresenceLifecycle() {
    if (!roomSurface) return;
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') claimVisibleSurface();
      else releaseSurface();
    });
    window.addEventListener('pagehide', releaseSurfaceOnPageHide);
    claimVisibleSurface();
  }

  async function setActiveControl(kind, action, reason) {
    return post('/viewer/active-control', {
      viewer_client_id: viewerClientID,
      kind,
      action,
      reason,
    });
  }

  function controlPayload(event) {
    try {
      return JSON.parse(String(event && event.content || '{}'));
    } catch (_) {
      return {};
    }
  }

  function handleControlEvent(event) {
    const type = String(event && event.type || '');
    if (type === 'tts.audio_chunk' || type === 'tts.session_completed') {
      if (!surfaceReady) return;
      const eventChannel = String(event.channel || '').toLowerCase();
      const eventSession = String(event.session_id || '').toLowerCase();
      const isIdleChatTTS = eventChannel === 'idlechat' || eventSession.startsWith('idle-');
      if ((mode === 'chat' && isIdleChatTTS) || (mode === 'idlechat' && !isIdleChatTTS)) return;
      handleTTSEvent(event);
      return;
    }
    if (type !== 'viewer.active_control') return;
    const payload = controlPayload(event);
    if (ttsControl.enabled && payload.active_audio_viewer_id && payload.active_audio_viewer_id !== viewerClientID) {
      disableTTS(false, '別のViewerへTTS再生権を移しました');
    }
    if (sttControl.enabled && payload.active_input_viewer_id && payload.active_input_viewer_id !== viewerClientID) {
      stopSTT(false, '別のViewerへSTT入力権を移しました');
    }
  }

  function resolveTTSAudioURL(payload) {
    const sourceURL = String(payload.audio_url || '').trim();
    const sourcePath = String(payload.audio_path || '').trim();
    const base = api('/viewer/tts/audio');
    if (sourceURL) return `${base}?url=${encodeURIComponent(sourceURL)}`;
    if (sourcePath) return `${base}?path=${encodeURIComponent(sourcePath)}`;
    return '';
  }

  function normalizeTTSEvent(event) {
    const payload = controlPayload(event);
    const sessionId = String(payload.session_id || event.session_id || '').trim();
    const payloadRuntimeEpoch = String(payload.runtime_epoch || '').trim();
    const eventRuntimeEpoch = String(event.runtime_epoch || '').trim();
    const payloadPlaybackGeneration = payload.playback_generation == null ? null : Number(payload.playback_generation);
    const eventPlaybackGeneration = event.playback_generation == null ? null : Number(event.playback_generation);
    const runtimeEpoch = payloadRuntimeEpoch || eventRuntimeEpoch;
    const playbackGeneration = payloadPlaybackGeneration == null ? eventPlaybackGeneration : payloadPlaybackGeneration;
    return {
      responseId: String(payload.response_id || ttsControl.sessionResponses.get(sessionId) || '').trim(),
      sessionId,
      utteranceId: String(payload.utterance_id || '').trim(),
      chunkIndex: Number.isFinite(Number(payload.chunk_index)) ? Number(payload.chunk_index) : -1,
      url: resolveTTSAudioURL(payload),
      runtimeEpoch,
      playbackGeneration,
      surfaceMode: mode,
      objectURL: '',
      fenceValid: (!payloadRuntimeEpoch || !eventRuntimeEpoch || payloadRuntimeEpoch === eventRuntimeEpoch)
        && (payloadPlaybackGeneration == null || eventPlaybackGeneration == null
          || payloadPlaybackGeneration === eventPlaybackGeneration),
      actor: normalizeActor(payload.character_id || payload.characterId || payload.actor || payload.speaker || payload.from || event.from) || latestAvatarSpeaker,
    };
  }

  function isCurrentTTSFence(item) {
    return Boolean(item && item.fenceValid && acceptedControlSnapshot && surfaceClaimConfirmed && surfaceReady
      && item.surfaceMode === mode
      && item.runtimeEpoch === acceptedControlSnapshot.runtimeEpoch
      && item.playbackGeneration === acceptedControlSnapshot.playbackGeneration);
  }

  function stopTTSMeter() {
    if (ttsControl.meterFrameID) cancelAnimationFrame(ttsControl.meterFrameID);
    ttsControl.meterFrameID = 0;
    if (ttsControl.speakingActor) setAvatarInput(ttsControl.speakingActor, {voiceRaw: 0});
    ttsControl.speakingActor = '';
    ttsControl.mediaSource?.disconnect();
    ttsControl.analyser?.disconnect();
    ttsControl.mediaSource = null;
    ttsControl.analyser = null;
    ttsControl.meterBuffer = null;
  }

  async function unlockTTSPlayback() {
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextClass) throw new Error('このブラウザは音声再生に対応していません');
    if (!ttsControl.audioContext) ttsControl.audioContext = new AudioContextClass();
    await ttsControl.audioContext.resume();
  }

  async function startTTSMeter(audio, actor, isCurrent = () => true) {
    await unlockTTSPlayback();
    if (!isCurrent()) return false;
    stopTTSMeter();
    const source = ttsControl.audioContext.createMediaElementSource(audio);
    const analyser = ttsControl.audioContext.createAnalyser();
    analyser.fftSize = 1024;
    analyser.smoothingTimeConstant = 0;
    source.connect(analyser);
    analyser.connect(ttsControl.audioContext.destination);
    ttsControl.mediaSource = source;
    ttsControl.analyser = analyser;
    ttsControl.meterBuffer = new Float32Array(analyser.fftSize);
    ttsControl.speakingActor = ['mio', 'shiro', 'kuro', 'midori'].includes(actor) ? actor : latestAvatarSpeaker;

    const measure = () => {
      if (!ttsControl.analyser || !ttsControl.meterBuffer) return;
      ttsControl.analyser.getFloatTimeDomainData(ttsControl.meterBuffer);
      let sum = 0;
      for (let index = 0; index < ttsControl.meterBuffer.length; index += 1) {
        const sample = ttsControl.meterBuffer[index];
        sum += sample * sample;
      }
      const rms = Math.sqrt(sum / ttsControl.meterBuffer.length);
      setAvatarInput(ttsControl.speakingActor, {voiceRaw: Math.min(2, rms)});
      ttsControl.meterFrameID = requestAnimationFrame(measure);
    };
    measure();
    return true;
  }

  function handleTTSEvent(event) {
    if (!ttsControl.enabled) return;
    const item = normalizeTTSEvent(event);
    if (!item.responseId || !Number.isSafeInteger(item.playbackGeneration) || !isCurrentTTSFence(item)) return;
    ttsControl.responseItems.set(item.responseId, item);
    if (event.type === 'tts.session_completed') {
      ttsControl.completedResponses.add(item.responseId);
      maybeAcknowledgeTTS(item.responseId);
      return;
    }
    ttsControl.sessionResponses.set(item.sessionId, item.responseId);
    const chunkKey = `${item.sessionId}|${item.responseId}|${item.utteranceId}|${item.chunkIndex}`;
    if (ttsControl.seenChunks.has(chunkKey)) return;
    ttsControl.seenChunks.add(chunkKey);
    if (ttsControl.seenChunks.size > 2000) ttsControl.seenChunks.clear();
    ttsControl.responseCounts.set(item.responseId, (ttsControl.responseCounts.get(item.responseId) || 0) + 1);
    if (!item.url) {
      finishTTSItem(item, 'error', new Error('TTS audio URL is missing'));
      return;
    }
    ttsControl.queue.push(item);
    playNextTTS();
  }

  function finishTTSItem(item, status, error) {
    const remaining = Math.max(0, (ttsControl.responseCounts.get(item.responseId) || 1) - 1);
    if (remaining) ttsControl.responseCounts.set(item.responseId, remaining);
    else ttsControl.responseCounts.delete(item.responseId);
    if (status !== 'ended' && !ttsControl.responseResults.has(item.responseId)) {
      ttsControl.responseResults.set(item.responseId, {status: 'error', error});
    }
    maybeAcknowledgeTTS(item.responseId);
  }

  async function acknowledgeTTS(item, result) {
    if (!isCurrentTTSFence(item)) return;
    try {
      await post('/viewer/tts/playback-ack', {
        response_id: item.responseId,
        session_id: item.sessionId,
        utterance_id: item.utteranceId,
        viewer_client_id: viewerClientID,
        status: result ? result.status : 'ended',
        error_code: result ? 'TTS_AUDIO_PLAYBACK_ERROR' : '',
        error: result && result.error ? String(result.error.message || result.error) : '',
      });
    } catch (error) {
      console.warn('TTS playback ACK failed', error);
    }
  }

  function maybeAcknowledgeTTS(responseID) {
    if (!ttsControl.completedResponses.has(responseID)) return;
    if ((ttsControl.responseCounts.get(responseID) || 0) > 0) return;
    if (ttsControl.acknowledged.has(responseID)) return;
    const item = ttsControl.responseItems.get(responseID);
    if (!item) return;
    if (!isCurrentTTSFence(item)) return;
    ttsControl.acknowledged.add(responseID);
    if (ttsControl.acknowledged.size > 2000) {
      ttsControl.acknowledged.clear();
      ttsControl.acknowledged.add(responseID);
    }
    acknowledgeTTS(item, ttsControl.responseResults.get(responseID));
    ttsControl.completedResponses.delete(responseID);
    ttsControl.responseResults.delete(responseID);
    ttsControl.responseItems.delete(responseID);
    if (ttsControl.sessionResponses.get(item.sessionId) === responseID) ttsControl.sessionResponses.delete(item.sessionId);
  }

  function playNextTTS() {
    if (!ttsControl.enabled || ttsControl.playing || !ttsControl.queue.length) return;
    const item = ttsControl.queue.shift();
    if (!isCurrentTTSFence(item)) return;
    const runGeneration = ttsControl.lifecycleGeneration;
    const isCurrentRun = () => runGeneration === ttsControl.lifecycleGeneration
      && ttsControl.currentItem === item
      && isCurrentTTSFence(item);
    const Controller = globalThis.AbortController;
    const controller = typeof Controller === 'function' ? new Controller() : null;
    ttsControl.currentFetchController = controller;
    ttsControl.currentItem = item;
    ttsControl.playing = true;
    let audio = null;
    let settled = false;
    const releaseAudio = () => {
      if (!audio) return;
      audio.pause();
      audio.removeAttribute('src');
      if (item.objectURL && typeof URL.revokeObjectURL === 'function') URL.revokeObjectURL(item.objectURL);
      if (ttsControl.audioObjectURL === item.objectURL) ttsControl.audioObjectURL = '';
      item.objectURL = '';
    };
    const complete = (status, error) => {
      if (settled) return;
      settled = true;
      if (!isCurrentRun() || ttsControl.currentAudio !== audio) {
        releaseAudio();
        return;
      }
      stopTTSMeter();
      ttsControl.playing = false;
      ttsControl.currentAudio = null;
      ttsControl.currentItem = null;
      ttsControl.currentFetchController = null;
      releaseAudio();
      if (!ttsControl.enabled || !isCurrentTTSFence(item)) return;
      finishTTSItem(item, status, error);
      playNextTTS();
    };
    (async () => {
      try {
        const options = controller ? {signal: controller.signal} : undefined;
        const response = await fetch(item.url, options);
        if (!response.ok) throw new Error(`HTTP ${response.status}: ${await response.text()}`);
        const audioBlob = await response.blob();
        if (!isCurrentRun()) return;
        audio = new Audio();
        ttsControl.currentAudio = audio;
        audio.addEventListener('ended', () => complete('ended'), {once: true});
        audio.addEventListener('error', () => complete('error', audio.error || new Error('audio playback failed')), {once: true});
        item.objectURL = URL.createObjectURL(audioBlob);
        ttsControl.audioObjectURL = item.objectURL;
        audio.src = item.objectURL;
        const meterReady = await startTTSMeter(audio, item.actor, isCurrentRun);
        if (!meterReady || !isCurrentRun()) return;
        await audio.play();
        if (!isCurrentRun()) releaseAudio();
      } catch (error) {
        if (isCurrentRun()) {
          if (audio) {
            complete('error', error);
          } else {
            settled = true;
            ttsControl.playing = false;
            ttsControl.currentItem = null;
            ttsControl.currentFetchController = null;
            finishTTSItem(item, 'error', error);
            playNextTTS();
          }
        }
      }
    })();
  }

  async function enableTTS() {
    const control = document.getElementById('roomAudioBtn');
    try {
      await unlockTTSPlayback();
      await setActiveControl('audio', 'claim', 'portal_tts_on');
      ttsControl.enabled = true;
      localStorage.setItem(ttsPreferenceStorageKey, 'on');
      setToggleState(control, 'TTS', true);
      window.clearInterval(ttsControl.heartbeat);
      ttsControl.heartbeat = window.setInterval(() => {
        setActiveControl('audio', 'heartbeat', 'portal_tts_heartbeat').catch(() => disableTTS(false, 'TTS再生権を維持できません'));
      }, 30000);
      setOperation('TTSをONにしました');
      return true;
    } catch (error) {
      uiMetrics?.recordError('send_preparation', error, blockingRequest()?.metricsSubmission || null);
      setToggleState(control, 'TTS', false);
      setOperation(`TTSをONにできません: ${error.message}`, true);
      return false;
    }
  }

  function clearTTSPlayback() {
    ttsControl.lifecycleGeneration += 1;
    ttsControl.queue.length = 0;
    if (ttsControl.currentFetchController) ttsControl.currentFetchController.abort();
    ttsControl.currentFetchController = null;
    stopTTSMeter();
    if (ttsControl.currentAudio) {
      ttsControl.currentAudio.pause();
      ttsControl.currentAudio.removeAttribute('src');
    }
    if (ttsControl.audioObjectURL && typeof URL.revokeObjectURL === 'function') URL.revokeObjectURL(ttsControl.audioObjectURL);
    ttsControl.audioObjectURL = '';
    ttsControl.currentAudio = null;
    ttsControl.currentItem = null;
    ttsControl.playing = false;
    ttsControl.responseCounts.clear();
    ttsControl.responseResults.clear();
    ttsControl.completedResponses.clear();
    ttsControl.responseItems.clear();
    ttsControl.sessionResponses.clear();
  }

  async function disableTTS(release = true, message = 'TTSをOFFにしました', persistPreference = release) {
    const control = document.getElementById('roomAudioBtn');
    ttsControl.enabled = false;
    if (persistPreference) localStorage.setItem(ttsPreferenceStorageKey, 'off');
    window.clearInterval(ttsControl.heartbeat);
    ttsControl.heartbeat = null;
    clearTTSPlayback();
    setToggleState(control, 'TTS', false);
    if (release) {
      try {
        await setActiveControl('audio', 'release', 'portal_tts_off');
      } catch (error) {
        setOperation(`TTS再生権を解放できません: ${error.message}`, true);
        return;
      }
    }
    setOperation(message);
  }

  function resamplePCM16(inputSamples, inputRate, outputRate = 16000) {
    if (inputRate === outputRate) {
      const output = new Int16Array(inputSamples.length);
      for (let i = 0; i < inputSamples.length; i += 1) output[i] = Math.max(-32768, Math.min(32767, inputSamples[i] * 32768));
      return output;
    }
    const ratio = inputRate / outputRate;
    const length = Math.max(1, Math.floor(inputSamples.length / ratio));
    const output = new Int16Array(length);
    for (let i = 0; i < length; i += 1) {
      const start = Math.floor(i * ratio);
      const end = Math.min(inputSamples.length, Math.floor((i + 1) * ratio));
      let sum = 0;
      for (let j = start; j < end; j += 1) sum += inputSamples[j];
      const sample = sum / Math.max(1, end - start);
      output[i] = Math.max(-32768, Math.min(32767, sample * 32768));
    }
    return output;
  }

  function webSocketURL(path) {
    const url = new URL(path, window.location.href);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    url.searchParams.set('viewer_client_id', viewerClientID);
    return url.href;
  }

  function handleSTTMessage(message) {
    let payload;
    try {
      payload = JSON.parse(String(message.data || '{}'));
    } catch (_) {
      return;
    }
    const event = sttEvents.classifySTTMessage(payload);
    if (event.kind === 'draft') {
      input.value = event.text;
      return;
    }
    if (event.kind === 'final') {
      input.value = event.text;
      send('stt');
      if (!sttControl.enabled) cleanupSTT(true);
      return;
    }
    if (event.kind === 'utterance_error') {
      // One utterance failed (it carries an utterance_id). The microphone and the input right stay as they are.
      sttControl.lastUtteranceError = event.detail;
      if (sttControl.enabled) setOperation(`STT発話エラー: ${event.detail}`, true);
      return;
    }
    if (event.kind === 'session_error') {
      stopSTT(true, `STTエラー: ${event.detail}`, true);
    }
  }

  async function startSTT() {
    const control = document.getElementById('roomMicBtn');
    if (sttControl.stopTimer) {
      setOperation('STTの終了処理中です', true);
      return;
    }
    if (!navigator.mediaDevices || typeof navigator.mediaDevices.getUserMedia !== 'function') {
      setOperation('このブラウザではマイク入力を利用できません', true);
      return;
    }
    if (!sttEvents) {
      setOperation('STTをONにできません: stt_events.jsを読み込めていません', true);
      return;
    }
    sttControl.lastUtteranceError = '';
    try {
      await setActiveControl('input', 'claim', 'portal_stt_on');
      const stream = await navigator.mediaDevices.getUserMedia({audio: true});
      const AudioContextClass = window.AudioContext || window.webkitAudioContext;
      const context = new AudioContextClass();
      const source = context.createMediaStreamSource(stream);
      const processor = context.createScriptProcessor(4096, 1, 1);
      const socket = new WebSocket(webSocketURL(api('/stt')));
      socket.binaryType = 'arraybuffer';
      sttControl.stream = stream;
      sttControl.context = context;
      sttControl.source = source;
      sttControl.processor = processor;
      sttControl.socket = socket;
      sttControl.enabled = true;
      processor.onaudioprocess = (event) => {
        if (!sttControl.enabled || socket.readyState !== WebSocket.OPEN) return;
        socket.send(resamplePCM16(event.inputBuffer.getChannelData(0), context.sampleRate).buffer);
      };
      source.connect(processor);
      processor.connect(context.destination);
      socket.addEventListener('open', () => {
        socket.send(JSON.stringify({type: 'start', sample_rate: 16000, channels: 1, format: 'pcm_s16le'}));
      });
      socket.addEventListener('message', handleSTTMessage);
      socket.addEventListener('error', () => setOperation('STT WebSocketへ接続できません', true));
      socket.addEventListener('close', (closeEvent) => {
        // Only an unintended close of the current connection stops the microphone. The close of a
        // connection that cleanupSTT already replaced or released must not stop a newer session.
        if (sttControl.socket !== socket || !sttControl.enabled) return;
        stopSTT(true, sttEvents.describeSTTClose(closeEvent, sttControl.lastUtteranceError));
      });
      setToggleState(control, 'STT', true);
      window.clearInterval(sttControl.heartbeat);
      sttControl.heartbeat = window.setInterval(() => {
        setActiveControl('input', 'heartbeat', 'portal_stt_heartbeat').catch(() => stopSTT(false, 'STT入力権を維持できません'));
      }, 30000);
      setOperation('STTをONにしました');
    } catch (error) {
      cleanupSTT(false);
      try { await setActiveControl('input', 'release', 'portal_stt_start_failed'); } catch (_) {}
      setToggleState(control, 'STT', false);
      setOperation(`STTをONにできません: ${error.message}`, true);
    }
  }

  function cleanupSTT(closeSocket = true) {
    window.clearTimeout(sttControl.stopTimer);
    sttControl.stopTimer = null;
    window.clearInterval(sttControl.heartbeat);
    sttControl.heartbeat = null;
    if (sttControl.processor) sttControl.processor.disconnect();
    if (sttControl.source) sttControl.source.disconnect();
    if (sttControl.stream) sttControl.stream.getTracks().forEach((track) => track.stop());
    if (sttControl.context) sttControl.context.close().catch(() => {});
    if (closeSocket && sttControl.socket && sttControl.socket.readyState < WebSocket.CLOSING) sttControl.socket.close();
    sttControl.processor = null;
    sttControl.source = null;
    sttControl.stream = null;
    sttControl.context = null;
    sttControl.socket = null;
    if (sttControl.releaseOnCleanup) {
      sttControl.releaseOnCleanup = false;
      setActiveControl('input', 'release', 'portal_stt_off').catch((error) => {
        setOperation(`STT入力権を解放できません: ${error.message}`, true);
      });
    }
  }

  function stopSTT(release = true, message = 'STTをOFFにしました', isError = false) {
    const control = document.getElementById('roomMicBtn');
    sttControl.enabled = false;
    sttControl.releaseOnCleanup = release;
    setToggleState(control, 'STT', false);
    if (sttControl.socket && sttControl.socket.readyState === WebSocket.OPEN) {
      sttControl.socket.send(JSON.stringify({type: 'stop'}));
      sttControl.stopTimer = window.setTimeout(() => cleanupSTT(true), 1500);
    } else {
      cleanupSTT(true);
    }
    setOperation(message, isError);
  }

  function bindTTSControl() {
    const control = document.getElementById('roomAudioBtn');
    if (!control) return;
    setToggleState(control, 'TTS', false);
    control.addEventListener('click', () => {
      if (ttsControl.enabled) disableTTS();
      else enableTTS();
    });
  }

  function bindSTTControl() {
    const control = document.getElementById('roomMicBtn');
    if (!control) return;
    setToggleState(control, 'STT', false);
    control.addEventListener('click', () => {
      if (sttControl.enabled) stopSTT();
      else startSTT();
    });
  }

  function attachmentLimit(file) {
    const type = String(file && file.type || '').toLowerCase();
    const name = String(file && file.name || '');
    if (type.startsWith('image/') || /\.(png|jpe?g|gif|webp|bmp)$/i.test(name)) return attachmentControl.maxImageBytes;
    if (type.startsWith('video/') || /\.(mp4|mov|webm|m4v)$/i.test(name)) return attachmentControl.maxVideoBytes;
    return attachmentControl.maxFileBytes;
  }

  function isSupportedAttachment(file) {
    const type = String(file && file.type || '').toLowerCase();
    if (type.startsWith('image/') || type.startsWith('video/') || type.startsWith('audio/') || type.startsWith('text/')) return true;
    if (['application/pdf', 'application/json', 'application/x-yaml', 'application/yaml', 'application/xml'].includes(type)) return true;
    return /\.(png|jpe?g|gif|webp|bmp|mp4|mov|webm|m4v|wav|mp3|flac|ogg|m4a|pdf|txt|md|json|csv|ya?ml|xml)$/i.test(String(file && file.name || ''));
  }

  function updateAttachmentControl() {
    const control = document.getElementById('roomAttachBtn');
    if (!control) return;
    const count = attachmentControl.files.length;
    control.classList.toggle('is-active', count > 0);
    control.setAttribute('aria-pressed', count > 0 ? 'true' : 'false');
    control.setAttribute('aria-label', count > 0 ? `添付ファイル ${count}件` : 'ファイルを添付');
    control.title = count > 0 ? `添付ファイル ${count}件（Enterで送信）` : 'ファイルを添付';
  }

  function addAttachments(files) {
    const incoming = Array.from(files || []);
    if (!incoming.length) return;
    const next = attachmentControl.files.slice();
    const known = new Set(next.map((file) => `${file.name}|${file.size}|${file.lastModified}`));
    for (const file of incoming) {
      if (!isSupportedAttachment(file)) throw new Error(`${file.name}はCOREが対応していない形式です`);
      if (file.size > attachmentLimit(file)) throw new Error(`${file.name}がCOREのファイル上限を超えています`);
      const key = `${file.name}|${file.size}|${file.lastModified}`;
      if (!known.has(key)) {
        known.add(key);
        next.push(file);
      }
    }
    const total = next.reduce((sum, file) => sum + file.size, 0);
    if (total > attachmentControl.maxTotalBytes) throw new Error('添付ファイルの合計がCOREの120 MiB上限を超えています');
    attachmentControl.files = next;
    updateAttachmentControl();
    setOperation(`${next.length}件を添付しました。メッセージを入力してEnterで送信できます`);
  }

  function clearAttachments() {
    attachmentControl.files = [];
    const picker = document.getElementById('roomAttachmentInput');
    if (picker) picker.value = '';
    updateAttachmentControl();
  }

  function buildViewerSendPayload(message, recipient, inputSource, attachments, protocolVersion = 1, clientSubmissionID = '') {
    const fields = {
      message,
      to: recipient,
      viewer_client_id: viewerClientID,
      input_source: inputSource === 'stt' ? 'stt' : 'text',
      user_id: viewerUserID,
      device_name: viewerDeviceName,
      audio_output: ttsControl.enabled ? 'requested' : 'disabled',
    };
    const presence = currentSurfacePresenceRef();
    if (presence) fields.presence = presence;
    if (protocolVersion === 2) {
      fields.audio_output = 'disabled';
      fields.protocol_version = 2;
      fields.client_submission_id = clientSubmissionID;
    }
    if (!attachments.length) return fields;
    const form = new FormData();
    Object.entries(fields).forEach(([name, value]) => form.append(name, name === 'presence' ? JSON.stringify(value) : value));
    attachments.forEach((file) => form.append('attachments', file, file.name));
    return form;
  }

  function bindAttachmentControl() {
    const control = document.getElementById('roomAttachBtn');
    const picker = document.getElementById('roomAttachmentInput');
    if (!control || !picker) return;
    updateAttachmentControl();
    control.addEventListener('click', () => picker.click());
    picker.addEventListener('change', () => {
      try {
        addAttachments(picker.files);
      } catch (error) {
        setOperation(`添付できません: ${error.message}`, true);
      } finally {
        picker.value = '';
      }
    });
  }

  function waitForVideoFrame(video) {
    if (video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA && video.videoWidth > 0) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const timeoutID = window.setTimeout(() => reject(new Error('映像を取得できませんでした')), 10000);
      video.addEventListener('loadeddata', () => {
        window.clearTimeout(timeoutID);
        resolve();
      }, {once: true});
    });
  }

  function videoFrameFile(video, source) {
    const canvas = document.createElement('canvas');
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const context = canvas.getContext('2d');
    if (!context) return Promise.reject(new Error('画像を作成できませんでした'));
    context.drawImage(video, 0, 0, canvas.width, canvas.height);
    return new Promise((resolve, reject) => {
      canvas.toBlob((blob) => {
        if (!blob) {
          reject(new Error('画像を作成できませんでした'));
          return;
        }
        const stamp = new Date().toISOString().replace(/[:.]/g, '-');
        resolve(new File([blob], `${source}-${stamp}.png`, {type: 'image/png', lastModified: Date.now()}));
      }, 'image/png');
    });
  }

  async function captureAttachment(source) {
    if (!navigator.mediaDevices) throw new Error('このブラウザはメディア取得に対応していません');
    const stream = source === 'screen'
      ? await navigator.mediaDevices.getDisplayMedia({video: true, audio: false})
      : await navigator.mediaDevices.getUserMedia({video: true, audio: false});
    const preview = document.getElementById('roomCameraLivePreview');
    const video = document.getElementById('roomCameraLiveVideo');
    try {
      if (!video) throw new Error('プレビューを初期化できませんでした');
      video.srcObject = stream;
      if (preview) preview.classList.add('is-visible');
      await video.play();
      await waitForVideoFrame(video);
      addAttachments([await videoFrameFile(video, source)]);
    } finally {
      stream.getTracks().forEach((track) => track.stop());
      if (video) video.srcObject = null;
      if (preview) preview.classList.remove('is-visible');
    }
  }

  function bindCaptureControl(id, source, label) {
    const control = document.getElementById(id);
    if (!control) return;
    control.addEventListener('click', async () => {
      const request = blockingRequest();
      if (request) {
        setOperation(`${actorInfo[request.recipient].label}の応答を待っています`, true);
        return;
      }
      setOperation(`${label}を取得中`);
      try {
        await captureAttachment(source);
      } catch (error) {
        setOperation(`${label}を取得できません: ${error.message}`, true);
      }
    });
  }

  async function send(inputSource = 'text') {
    const message = input.value.trim();
    const attachments = attachmentControl.files.slice();
    if ((!message && !attachments.length) || mode !== 'chat') return;
    const metricsSubmission = uiMetrics && uiMetrics.beginSubmission();
    const recipient = selectedRecipient;
    const selectedPrompt = selectedClarificationPrompt;
    const canonicalPrompt = selectedPrompt && clarificationPrompts.get(selectedPrompt.messageID);
    if (selectedPrompt && (!canonicalPrompt || canonicalPrompt.consumed || !canonicalPrompt.row.isConnected
      || !boundedEventAttribute(selectedPrompt.messageID))) {
      clearSelectedClarificationPrompt(selectedPrompt.messageID);
      setOperation('選択した確認事項を表示できないため、もう一度選んでください', true);
      return;
    }
    const replyToMessageID = selectedPrompt ? selectedPrompt.messageID : '';
    if (responseFirstEnabled && (recipient !== 'mio' || inputSource !== 'text' || attachments.length > 0)) {
      uiMetrics?.recordError('unsupported_v2_input', null, metricsSubmission);
      setOperation('Response-firstはMioへのテキスト送信だけ利用できます。宛先と添付を確認してください', true);
      return;
    }
    const waitingRequest = blockingRequest();
    if (waitingRequest) {
      uiMetrics?.recordError('request_guard', null, metricsSubmission);
      setOperation(`${actorInfo[waitingRequest.recipient].label}の応答を待っています`, true);
      return;
    }
    if (!surfaceReady) {
      uiMetrics?.recordError('request_guard', null, metricsSubmission);
      return;
    }
    const protocolVersion = responseFirstEnabled ? 2 : 1;
    let v2BasePayload = null;
    let submissionFingerprint = '';
    let retrySubmissionID = '';
    if (protocolVersion === 2) {
      v2BasePayload = buildViewerSendPayload(message, recipient, inputSource, attachments, 2, '');
      if (replyToMessageID) v2BasePayload.reply_to_message_id = replyToMessageID;
      submissionFingerprint = v2SubmissionFingerprint(v2BasePayload);
      if (uncertainV2Submission && uncertainV2Submission.fingerprint === submissionFingerprint) {
        retrySubmissionID = uncertainV2Submission.clientSubmissionID;
      }
      uncertainV2Submission = null;
    }
    const request = createTurnRequest(recipient, protocolVersion, metricsSubmission, retrySubmissionID);
    request.replyToMessageID = replyToMessageID;
    uiMetrics?.identifySubmission(metricsSubmission, request.clientSubmissionID);
    request.submissionFingerprint = submissionFingerprint;
    if (request.protocolVersion === 1 && !ttsControl.enabled && !isTTSExplicitlyDisabled()) {
      if (!await enableTTS()) {
        finishTurnRequest(request, 'failed');
        return;
      }
    }
    setOperation('送信中');
    try {
      const payload = v2BasePayload
        ? {...v2BasePayload, client_submission_id: request.clientSubmissionID}
        : buildViewerSendPayload(message, recipient, inputSource, attachments, request.protocolVersion, request.clientSubmissionID);
      request.payload = payload;
      uiMetrics?.append('ui_send_preparation_end', metricsSubmission);
      const accepted = await post('/viewer/send', payload, metricsSubmission);
      try {
        bindAcceptedRequest(request, accepted);
        reconnectClosedV2StreamAfterAcceptance();
      } catch (error) {
        if (request.protocolVersion === 2) error.postOutcomeUnknown = true;
        throw error;
      }
      if (request.protocolVersion === 1) {
        if (normalizeActor(accepted.recipient) !== recipient) throw new Error('CORE受付先が選択中の相手と一致しません');
        if (Number(accepted.attachment_count || 0) !== attachments.length) throw new Error('COREで受理された添付数が一致しません');
      }
      input.value = '';
      clearAttachments();
      if (request.status === 'accepted' && blockingRequest() === request) setOperation(`${actorInfo[recipient].label}の応答を待っています`);
    } catch (error) {
      uiMetrics?.recordError('send', error, metricsSubmission);
      if (request.protocolVersion === 2 && error && error.postOutcomeUnknown && !request.serverSignalReceived) {
        uncertainV2Submission = {
          clientSubmissionID: request.clientSubmissionID,
          fingerprint: request.submissionFingerprint,
        };
      }
      finishTurnRequest(request, 'failed');
      setOperation(`送信できません: ${error.message}`, true);
    }
  }

  function setModeSwitcherBusy(busy) {
    modeSwitchBusy = Boolean(busy);
    const requestBusy = Boolean(blockingRequest());
    document.querySelectorAll('[data-room-switch]').forEach((control) => {
      control.disabled = modeSwitchBusy || requestBusy || mode !== 'chat' || !surfaceReady;
      control.setAttribute('aria-disabled', control.disabled ? 'true' : 'false');
    });
    document.querySelectorAll('#roomAttachBtn, #roomScreenBtn, #roomCameraBtn').forEach((control) => {
      control.disabled = modeSwitchBusy || requestBusy || mode !== 'chat' || !surfaceReady;
      control.setAttribute('aria-disabled', control.disabled ? 'true' : 'false');
    });
  }

  async function switchConversation(partner) {
    if (blockingRequest()) return;
    if (mode !== 'chat' || modeSwitchBusy || !surfaceReady) return;
    const nextRecipient = normalizeActor(partner) || selectedPartner;
    const runtime = document.getElementById('chatAvatar');
    setModeSwitcherBusy(true);
    setOperation('Chatの相手を切り替え中');
    let prepared = false;
    try {
      if (!runtime || typeof runtime.prepareCharacter !== 'function') throw new Error('キャラクター描画を準備できません');
      await runtime.prepareCharacter(nextRecipient);
      prepared = true;
      const confirmed = await post('/viewer/recipient-selection', {viewer_client_id: viewerClientID, recipient: nextRecipient});
      if (normalizeActor(confirmed.recipient) !== nextRecipient) throw new Error('CORE recipient selection mismatch');
      runtime.commitPreparedCharacter(nextRecipient);
      prepared = false;
      setConversationState(false, nextRecipient);
      input.focus();
      setOperation(`${actorInfo[nextRecipient].label}とのChatへ切り替えました`);
    } catch (error) {
      if (prepared) runtime.discardPreparedCharacter();
      setOperation(`切り替えできません: ${error.message}`, true);
    } finally {
      setModeSwitcherBusy(false);
    }
  }

  function updateDateTime() {
    const element = document.getElementById('roomDateTimePanel');
    const now = new Date();
    element.dateTime = now.toISOString();
    element.textContent = new Intl.DateTimeFormat('ja-JP', {
      era: 'long', year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'short',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
    }).format(now);
  }

  if (mode === 'chat') {
    setSurfaceReady(false);
    input.addEventListener('input', () => {
      if (responseFirstEnabled) uncertainV2Submission = null;
    });
    input.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter') return;
      if (event.isComposing || event.keyCode === 229) return;
      if (event.shiftKey || event.ctrlKey || event.altKey || event.metaKey) return;
      event.preventDefault();
      send('text');
    });
    document.querySelectorAll('[data-room-switch]').forEach((chip) => {
      chip.addEventListener('click', () => {
        switchConversation(chip.dataset.roomSwitch);
      });
    });
    bindTTSControl();
    bindSTTControl();
    bindChatTextSizeControl();
    bindAttachmentControl();
    bindCaptureControl('roomScreenBtn', 'screen', '画面');
    bindCaptureControl('roomCameraBtn', 'camera', 'カメラ画像');
    setConversationState(false, selectedRecipient);
  } else if (mode === 'idlechat') {
    input.disabled = true;
    document.querySelectorAll('.room-footer-controls .room-icon-btn').forEach((control) => { control.disabled = true; });
    document.querySelectorAll('.room-partner-chip').forEach((chip) => chip.disabled = true);
    setConversationState(true, selectedRecipient);
	bindIdleChatPlaybackControls();
  }

  document.addEventListener('purupuru-ready', (event) => {
    const actor = normalizeActor(event.detail && event.detail.character);
    const portrait = document.querySelector(`.purupuru-avatar[data-character="${actor}"]`);
    if (portrait) portrait.classList.add('is-renderer-ready');
    setAvatarInput(actor, {voiceRaw: 0});
  });

  document.addEventListener('purupuru-error', (event) => {
    const actor = normalizeActor(event.detail && event.detail.character) || 'unknown';
    console.error(`PuruPuru ${actor} failed: ${String(event.detail && event.detail.message || 'unknown error')}`);
  });

  updateDateTime();
  window.setInterval(updateDateTime, 1000);
  refreshReadiness();
  window.setInterval(refreshReadiness, 10000);
  if (mode !== 'games') {
    connectEvents();
    if (mode === 'idlechat') {
      refreshStatus();
      window.setInterval(refreshStatus, 5000);
    }
  }
  bindSurfacePresenceLifecycle();
})();
