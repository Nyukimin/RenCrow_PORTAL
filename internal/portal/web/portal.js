(() => {
  'use strict';

  const body = document.body;
  const requestedMode = String(body.dataset.mode || '').toLowerCase();
  const mode = ['idlechat', 'chat', 'games'].includes(requestedMode) ? requestedMode : 'idlechat';
  const roomSurface = ['idlechat', 'chat'].includes(body.dataset.surface);
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
  let pendingRequest = null;
  let chatViewportFrameID = 0;
  let chatOrientationMedia = null;
  const earlyTerminalJobIDs = new Set();
  const requestGuardTimeoutMS = 305000;
  const viewerClientID = getViewerClientID();
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
  };

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
    if (existing) return existing;
    const suffix = globalThis.crypto && typeof globalThis.crypto.randomUUID === 'function'
      ? globalThis.crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const created = `portal-${suffix}`;
    sessionStorage.setItem(key, created);
    return created;
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

  function isTerminalResponseEvent(event) {
    const type = String(event && event.type || '');
    if (type === 'agent.response' && String(event && event.to || '').toLowerCase() === 'user') return true;
    return ['agent.error', 'mailbox.error', 'worker.classified_failure', 'viewer.error'].includes(type);
  }

  function finishRequestGuard(message = '', isError = false) {
    if (!pendingRequest) return;
    window.clearTimeout(pendingRequest.timeoutID);
    pendingRequest = null;
    setModeSwitcherBusy(modeSwitchBusy);
    input.disabled = mode !== 'chat' || !surfaceReady;
    if (message) setOperation(message, isError);
    if (mode === 'chat') input.focus();
  }

  function beginRequestGuard(recipient) {
    if (pendingRequest || !surfaceReady) return false;
    const guard = {jobID: '', recipient, timeoutID: null};
    guard.timeoutID = window.setTimeout(() => {
      if (pendingRequest !== guard) return;
      finishRequestGuard('応答待ちがタイムアウトしました', true);
    }, requestGuardTimeoutMS);
    pendingRequest = guard;
    input.disabled = true;
    setModeSwitcherBusy(modeSwitchBusy);
    return true;
  }

  function handleRequestTerminalEvent(event) {
    if (!pendingRequest || !isTerminalResponseEvent(event)) return;
    const jobID = String(event.job_id || '').trim();
    if (!jobID) return;
    if (!pendingRequest.jobID) {
      earlyTerminalJobIDs.add(jobID);
      if (earlyTerminalJobIDs.size > 100) earlyTerminalJobIDs.delete(earlyTerminalJobIDs.values().next().value);
      return;
    }
    if (String(event.job_id || '') !== pendingRequest.jobID) return;
    const failed = event.type !== 'agent.response';
    finishRequestGuard(failed ? '応答処理がエラーで終了しました' : '応答を受信しました', failed);
  }

  function eventKey(event) {
    const messageID = String(event && event.message_id || '').trim();
    if (messageID && ['message.received', 'agent.response', 'idlechat.message'].includes(String(event.type || ''))) {
      return `message:${messageID}`;
    }
    const eventID = String(event && event.event_id || '').trim();
    if (eventID) return `event:${eventID}`;
    return [event.seq, event.event_id, event.message_id, event.timestamp, event.type, event.from, event.content].map((value) => String(value || '')).join('|');
  }

  function shouldRenderEvent(event) {
    const content = String(event && event.content || '').trim();
    const type = String(event && event.type || '');
    const allowedTypes = mode === 'chat'
      ? ['message.received', 'agent.response', 'agent.acknowledge', 'agent.progress']
      : ['idlechat.message'];
    if (!content || !allowedTypes.includes(type)) return false;
    const from = normalizeActor(event.from);
    const to = normalizeActor(event.to);
    if (type === 'message.received') return from === 'user';
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

  function renderEvent(event) {
    if (!shouldRenderEvent(event)) return;
    const key = eventKey(event);
    if (seenEvents.has(key)) return;
    seenEvents.add(key);
    if (seenEvents.size > 600) seenEvents.delete(seenEvents.values().next().value);

    const actor = normalizeActor(event.from) || normalizeActor(event.to) || 'mio';
    const info = actorInfo[actor] || actorInfo.mio;
    if (empty && empty.isConnected) empty.remove();

    const row = document.createElement('article');
    row.className = `msg${actor === 'shiro' ? ' shiro' : ''}`;
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
    row.append(avatar, bubble);
    chat.append(row);
    while (chat.children.length > 300) chat.firstElementChild.remove();
    maintainChatScroll();
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
    let normalizedRecipient = normalizeActor(recipient);
    if (pendingRequest && normalizedRecipient !== pendingRequest.recipient) normalizedRecipient = pendingRequest.recipient;
    if (!isIdle && (normalizedRecipient === 'mio' || isPartnerActor(normalizedRecipient))) {
      selectedRecipient = normalizedRecipient;
      if (isPartnerActor(normalizedRecipient)) selectedPartner = normalizedRecipient;
      storeSelectedRecipient(selectedRecipient);
    }
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
    try {
      const response = await fetch(api('/viewer/idlechat/status'), {cache: 'no-store'});
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const status = await response.json();
      topicText.textContent = String(status.current_topic || '-');
      if (mode === 'idlechat') setConversationState(true, selectedPartner);
      return true;
    } catch (error) {
      topicText.textContent = '-';
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
    const events = new EventSource(api('/viewer/events'));
    events.onopen = () => setConnection('ready', 'CORE接続済み');
    events.onmessage = (message) => {
      try {
        const event = JSON.parse(message.data);
        if (pendingRequest && event.type === 'agent.thinking' && String(event.job_id || '') === pendingRequest.jobID) {
          setOperation(`${actorInfo[pendingRequest.recipient].label}が応答を生成中です`);
        }
        handleRequestTerminalEvent(event);
        handleControlEvent(event);
        renderEvent(event);
      } catch (error) {
        setConnection('error', 'イベント解析エラー');
      }
    };
    events.onerror = () => setConnection('waiting', '再接続中');
  }

  async function post(path, payload) {
    if (mode !== 'chat') throw new Error(`${mode}モードは閲覧専用です`);
    if (!surfaceReady) throw new Error('Chat画面の準備が完了していません');
    const options = {method: 'POST'};
    if (payload instanceof FormData) {
      options.body = payload;
    } else if (payload) {
      options.headers = {'Content-Type': 'application/json'};
      options.body = JSON.stringify(payload);
    }
    const response = await fetch(api(path), options);
    if (!response.ok) throw new Error(`HTTP ${response.status}: ${await response.text()}`);
    const contentType = String(response.headers.get('content-type') || '');
    return contentType.includes('application/json') ? response.json() : null;
  }

  async function postSurfacePresence(action, keepalive = false) {
    const response = await fetch(api('/viewer/surface-presence'), {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({viewer_client_id: viewerClientID, surface: mode, action}),
      keepalive,
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}: ${await response.text()}`);
    return response.json();
  }

  function setSurfaceReady(ready) {
    surfaceReady = Boolean(ready);
    if (mode !== 'chat') return;
    input.disabled = !surfaceReady || Boolean(pendingRequest);
    setModeSwitcherBusy(modeSwitchBusy);
    document.querySelectorAll('#roomAudioBtn, #roomMicBtn').forEach((control) => {
      control.disabled = !surfaceReady;
      control.setAttribute('aria-disabled', control.disabled ? 'true' : 'false');
    });
    if (surfaceReady && !pendingRequest) input.focus();
  }

  function applySurfacePresenceResponse(response) {
    const effectiveMode = String(response && response.effective_mode || '').toLowerCase();
    const idleChatActive = response && response.idlechat_active === true;
    if (mode === 'chat') {
      const ready = effectiveMode === 'chat' && !idleChatActive;
      setSurfaceReady(ready);
      if (!ready) throw new Error('COREでIdleChat停止を確認できません');
      setOperation('Chat準備完了');
      return;
    }
    setSurfaceReady(effectiveMode === 'idlechat' && idleChatActive);
    if (effectiveMode === 'chat') {
      setOperation('別のChat画面を表示中のため待機中');
      return;
    }
    if (!surfaceReady) throw new Error('COREでIdleChat開始を確認できません');
    setOperation('IdleChat実行中');
  }

  function queueSurfacePresence(action, keepalive = false) {
    surfaceRequestSequence = surfaceRequestSequence.catch(() => {}).then(async () => {
      const response = await postSurfacePresence(action, keepalive);
      if (action !== 'release' && document.visibilityState === 'visible') applySurfacePresenceResponse(response);
      return response;
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
      queueSurfacePresence('heartbeat').catch((error) => {
        setSurfaceReady(false);
        setOperation(`画面状態を維持できません: ${error.message}`, true);
      });
    }, 10000);
  }

  function claimVisibleSurface() {
    if (!roomSurface || document.visibilityState !== 'visible') return;
    setSurfaceReady(false);
    setOperation(mode === 'chat' ? 'IdleChat停止を確認中' : 'IdleChat開始を確認中');
    queueSurfacePresence('claim')
      .then(startSurfaceHeartbeat)
      .catch((error) => {
        setSurfaceReady(false);
        setOperation(`${mode === 'chat' ? 'IdleChatを停止' : 'IdleChatを開始'}できません: ${error.message}`, true);
        if (document.visibilityState === 'visible') startSurfaceHeartbeat();
      });
  }

  function releaseSurface() {
    if (!roomSurface) return;
    stopSurfaceHeartbeat();
    setSurfaceReady(false);
    clearTTSPlayback();
    queueSurfacePresence('release', true).catch(() => {});
  }

  function releaseSurfaceOnPageHide() {
    if (!roomSurface) return;
    stopSurfaceHeartbeat();
    setSurfaceReady(false);
    clearTTSPlayback();
    const body = JSON.stringify({viewer_client_id: viewerClientID, surface: mode, action: 'release'});
    if (navigator.sendBeacon) {
      navigator.sendBeacon(api('/viewer/surface-presence'), new Blob([body], {type: 'application/json'}));
      return;
    }
    postSurfacePresence('release', true).catch(() => {});
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
    return {
      responseId: String(payload.response_id || ttsControl.sessionResponses.get(sessionId) || '').trim(),
      sessionId,
      utteranceId: String(payload.utterance_id || '').trim(),
      chunkIndex: Number.isFinite(Number(payload.chunk_index)) ? Number(payload.chunk_index) : -1,
      url: resolveTTSAudioURL(payload),
      actor: normalizeActor(payload.character_id || payload.characterId || payload.actor || payload.speaker || payload.from || event.from) || latestAvatarSpeaker,
    };
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

  async function startTTSMeter(audio, actor) {
    await unlockTTSPlayback();
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
  }

  function handleTTSEvent(event) {
    if (!ttsControl.enabled) return;
    const item = normalizeTTSEvent(event);
    if (!item.responseId) return;
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
    const audio = new Audio(item.url);
    ttsControl.currentAudio = audio;
    ttsControl.playing = true;
    let settled = false;
    const complete = (status, error) => {
      if (settled) return;
      settled = true;
      stopTTSMeter();
      ttsControl.playing = false;
      ttsControl.currentAudio = null;
      if (!ttsControl.enabled) return;
      finishTTSItem(item, status, error);
      playNextTTS();
    };
    audio.addEventListener('ended', () => complete('ended'), {once: true});
    audio.addEventListener('error', () => complete('error', audio.error || new Error('audio playback failed')), {once: true});
    startTTSMeter(audio, item.actor)
      .then(() => audio.play())
      .catch((error) => complete('error', error));
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
      setToggleState(control, 'TTS', false);
      setOperation(`TTSをONにできません: ${error.message}`, true);
      return false;
    }
  }

  function clearTTSPlayback() {
    ttsControl.queue.length = 0;
    stopTTSMeter();
    if (ttsControl.currentAudio) {
      ttsControl.currentAudio.pause();
      ttsControl.currentAudio.removeAttribute('src');
    }
    ttsControl.currentAudio = null;
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
    const type = String(payload.type || '').toLowerCase();
    const text = String(payload.text || payload.transcript || '').trim();
    if (type === 'draft' || type === 'partial') {
      if (text) input.value = text;
      return;
    }
    if (type === 'final' && text) {
      input.value = text;
      send('stt');
      if (!sttControl.enabled) cleanupSTT(true);
      return;
    }
    if (type === 'error') {
      stopSTT(true, `STTエラー: ${payload.error || payload.message || 'unknown'}`, true);
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
      socket.addEventListener('close', () => {
        if (sttControl.enabled) stopSTT(true, 'STT接続が終了しました');
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

  function buildViewerSendPayload(message, recipient, inputSource, attachments) {
    const fields = {
      message,
      to: recipient,
      viewer_client_id: viewerClientID,
      input_source: inputSource === 'stt' ? 'stt' : 'text',
      user_id: viewerUserID,
      device_name: viewerDeviceName,
    };
    if (!attachments.length) return fields;
    const form = new FormData();
    Object.entries(fields).forEach(([name, value]) => form.append(name, value));
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
      if (pendingRequest) {
        setOperation(`${actorInfo[pendingRequest.recipient].label}の応答を待っています`, true);
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
    if (pendingRequest) {
      setOperation(`${actorInfo[pendingRequest.recipient].label}の応答を待っています`, true);
      return;
    }
    const recipient = selectedRecipient;
    if (!beginRequestGuard(recipient)) return;
    if (!ttsControl.enabled && !isTTSExplicitlyDisabled()) {
      if (!await enableTTS()) {
        finishRequestGuard();
        return;
      }
    }
    setOperation('送信中');
    try {
      const accepted = await post('/viewer/send', buildViewerSendPayload(message, recipient, inputSource, attachments));
      pendingRequest.jobID = String(accepted.job_id || '').trim();
      if (!pendingRequest.jobID) throw new Error('CORE応答にjob_idがありません');
      if (normalizeActor(accepted.recipient) !== recipient) throw new Error('CORE受付先が選択中の相手と一致しません');
      if (Number(accepted.attachment_count || 0) !== attachments.length) throw new Error('COREで受理された添付数が一致しません');
      input.value = '';
      clearAttachments();
      if (earlyTerminalJobIDs.delete(pendingRequest.jobID)) {
        finishRequestGuard('応答を受信しました');
        return;
      }
      setOperation(`${actorInfo[recipient].label}の応答を待っています`);
    } catch (error) {
      finishRequestGuard();
      setOperation(`送信できません: ${error.message}`, true);
    }
  }

  function setModeSwitcherBusy(busy) {
    modeSwitchBusy = Boolean(busy);
    document.querySelectorAll('[data-room-switch]').forEach((control) => {
      control.disabled = modeSwitchBusy || Boolean(pendingRequest) || mode !== 'chat' || !surfaceReady;
      control.setAttribute('aria-disabled', control.disabled ? 'true' : 'false');
    });
    document.querySelectorAll('#roomAttachBtn, #roomScreenBtn, #roomCameraBtn').forEach((control) => {
      control.disabled = modeSwitchBusy || Boolean(pendingRequest) || mode !== 'chat' || !surfaceReady;
      control.setAttribute('aria-disabled', control.disabled ? 'true' : 'false');
    });
  }

  async function switchConversation(partner) {
    if (pendingRequest) return;
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
  } else if (roomSurface) {
    input.disabled = true;
    document.querySelectorAll('.room-footer-controls .room-icon-btn').forEach((control) => { control.disabled = true; });
    document.querySelectorAll('.room-partner-chip').forEach((chip) => chip.disabled = true);
    setConversationState(true, selectedRecipient);
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
    bindSurfacePresenceLifecycle();
  }
})();
