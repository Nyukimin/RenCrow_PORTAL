(() => {
  'use strict';

  const body = document.body;
  const requestedMode = String(body.dataset.mode || '').toLowerCase();
  const mode = ['view', 'live', 'lab'].includes(requestedMode) ? requestedMode : 'view';
  const roomSurface = body.dataset.surface === 'lab';
  const chat = document.getElementById('chat');
  const empty = document.getElementById('empty');
  const input = document.getElementById('labInp');
  const topicText = document.getElementById('topicText');
  const connectionDot = document.getElementById('connectionDot');
  const connectionText = document.getElementById('connectionText');
  const operationStatus = document.getElementById('operationStatus');
  const seenEvents = new Set();
  const partnerStorageKey = 'labConversation.selectedPartner';
  const storedRecipient = normalizeActor(localStorage.getItem(partnerStorageKey)) || normalizeActor(localStorage.getItem('rencrow.portal.partner')) || 'shiro';
  let selectedRecipient = storedRecipient;
  let selectedPartner = isPartnerActor(storedRecipient) ? storedRecipient : 'shiro';
  let modeSwitchBusy = false;
  let pendingRequest = null;
  const earlyTerminalJobIDs = new Set();
  const requestGuardTimeoutMS = 305000;
  const viewerClientID = getViewerClientID();
  const viewerUserID = 'viewer-user';
  const viewerDeviceName = getViewerDeviceName();
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
    coder1: {label: 'Coder1', mark: 'C1', color: '#a16207'},
    coder2: {label: 'Coder2', mark: 'C2', color: '#a16207'},
    coder3: {label: 'Coder3', mark: 'C3', color: '#a16207'},
    coder4: {label: 'Coder4', mark: 'C4', color: '#a16207'},
    coder_loop: {label: 'CoderLoop', mark: 'CL', color: '#a16207'},
  };

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
    if (text.includes('shiro') || text.includes('しろ') || text === 'chatworker') return 'shiro';
    if (text.includes('kuro') || text.includes('くろ') || text === 'heavy') return 'kuro';
    if (text.includes('midori') || text.includes('みどり') || text === 'wild') return 'midori';
    if (text.includes('mio') || text.includes('みお') || text === 'chat') return 'mio';
    if (text === 'coder_loop') return 'coder_loop';
    if (/^coder[1-4]$/.test(text)) return text;
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

  function setConnection(state, text) {
    connectionDot.dataset.state = state;
    connectionText.textContent = text;
    document.querySelectorAll('[data-live-connection-dot]').forEach((dot) => { dot.dataset.state = state; });
    document.querySelectorAll('[data-live-connection-text]').forEach((label) => { label.textContent = text; });
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
    input.disabled = mode !== 'lab';
    if (message) setOperation(message, isError);
    if (mode === 'lab') input.focus();
  }

  function beginRequestGuard(recipient) {
    if (pendingRequest) return false;
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
    return [event.seq, event.event_id, event.message_id, event.timestamp, event.type, event.from, event.content].map((value) => String(value || '')).join('|');
  }

  function shouldRenderEvent(event) {
    const content = String(event && event.content || '').trim();
    if (!content || ['tts.audio_chunk', 'tts.session_completed', 'metrics.latency', 'viewer.active_control', 'viewer.recipient_selected'].includes(event.type)) return false;
    const from = normalizeActor(event.from);
    const to = normalizeActor(event.to);
    return Boolean(from || to) && (from !== '' || to === 'user');
  }

  function formatTime(value) {
    const date = value ? new Date(value) : new Date();
    if (Number.isNaN(date.getTime())) return '';
    return new Intl.DateTimeFormat('ja-JP', {hour: '2-digit', minute: '2-digit'}).format(date);
  }

  function animateSpeaker(actor) {
    const portraitIDs = {shiro: 'shiroPortrait', midori: 'midoriPortrait'};
    const target = document.getElementById(portraitIDs[actor] || 'mioPortrait');
    if (!target) return;
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
    chat.scrollTop = chat.scrollHeight;
    if (actor === 'mio' || actor === 'shiro') animateSpeaker(actor);
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
    body.classList.toggle('lab-idle-mode', isIdle);
    body.classList.toggle('lab-chat-mode', !isIdle);
    ['mio', 'shiro', 'kuro', 'midori'].forEach((actor) => body.classList.remove(`lab-partner-${actor}`));
    if (isIdle) {
      body.classList.add('lab-partner-mio', 'lab-partner-shiro');
    } else {
      body.classList.add(`lab-partner-${selectedRecipient}`);
    }
    body.dataset.labConversationMode = isIdle ? 'idle' : 'chat';
    body.dataset.labPartner = isIdle ? 'both' : selectedRecipient;
    body.dataset.labSelectedPartner = isIdle ? selectedPartner : selectedRecipient;
    setChip('labModeMioChip', !isIdle && selectedRecipient === 'mio');
    setChip('labModeShiroChip', !isIdle && selectedRecipient === 'shiro');
    setChip('labModeMidoriChip', !isIdle && selectedRecipient === 'midori');
  }

  function idleStatusActive(status) {
    const raw = String(status && (status.mode || (status.watchdog && status.watchdog.mode)) || '').trim().toLowerCase();
    if (status && (status.manual_mode === true || status.chat_active === true)) return true;
    if (['idle', 'idlechat', 'manual', 'forecast', 'story', 'story-simple'].includes(raw)) return true;
    if (raw === 'chat') return false;
    const sessionID = String(status && (status.active_session_id || (status.watchdog && status.watchdog.session_id)) || '').toLowerCase();
    if (sessionID.startsWith('idle-')) return true;
    return Boolean(status && typeof status.current_topic === 'string' && status.current_topic.trim());
  }

  async function refreshStatus() {
    try {
      const response = await fetch(api('/viewer/idlechat/status'), {cache: 'no-store'});
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const status = await response.json();
      topicText.textContent = String(status.current_topic || '-');
      const isIdle = idleStatusActive(status);
      const statusRecipient = status.persona || status.to || status.recipient || selectedRecipient;
      setConversationState(isIdle, isIdle ? selectedPartner : statusRecipient);
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
    if (mode !== 'lab') throw new Error(`${mode}モードは閲覧専用です`);
    const options = {method: 'POST'};
    if (payload) {
      options.headers = {'Content-Type': 'application/json'};
      options.body = JSON.stringify(payload);
    }
    const response = await fetch(api(path), options);
    if (!response.ok) throw new Error(`HTTP ${response.status}: ${await response.text()}`);
    const contentType = String(response.headers.get('content-type') || '');
    return contentType.includes('application/json') ? response.json() : null;
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
    };
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
      ttsControl.playing = false;
      ttsControl.currentAudio = null;
      if (!ttsControl.enabled) return;
      finishTTSItem(item, status, error);
      playNextTTS();
    };
    audio.addEventListener('ended', () => complete('ended'), {once: true});
    audio.addEventListener('error', () => complete('error', audio.error || new Error('audio playback failed')), {once: true});
    audio.play().catch((error) => complete('error', error));
  }

  async function enableTTS() {
    const control = document.getElementById('labAudioBtn');
    try {
      await setActiveControl('audio', 'claim', 'portal_tts_on');
      ttsControl.enabled = true;
      setToggleState(control, 'TTS', true);
      window.clearInterval(ttsControl.heartbeat);
      ttsControl.heartbeat = window.setInterval(() => {
        setActiveControl('audio', 'heartbeat', 'portal_tts_heartbeat').catch(() => disableTTS(false, 'TTS再生権を維持できません'));
      }, 30000);
      setOperation('TTSをONにしました');
    } catch (error) {
      setOperation(`TTSをONにできません: ${error.message}`, true);
    }
  }

  function clearTTSPlayback() {
    ttsControl.queue.length = 0;
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

  async function disableTTS(release = true, message = 'TTSをOFFにしました') {
    const control = document.getElementById('labAudioBtn');
    ttsControl.enabled = false;
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
    const control = document.getElementById('labMicBtn');
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
    const control = document.getElementById('labMicBtn');
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
    const control = document.getElementById('labAudioBtn');
    if (!control) return;
    setToggleState(control, 'TTS', false);
    control.addEventListener('click', () => {
      if (ttsControl.enabled) disableTTS();
      else enableTTS();
    });
  }

  function bindSTTControl() {
    const control = document.getElementById('labMicBtn');
    if (!control) return;
    setToggleState(control, 'STT', false);
    control.addEventListener('click', () => {
      if (sttControl.enabled) stopSTT();
      else startSTT();
    });
  }

  async function send(inputSource = 'text') {
    const message = input.value.trim();
    if (!message || mode !== 'lab') return;
    if (pendingRequest) {
      setOperation(`${actorInfo[pendingRequest.recipient].label}の応答を待っています`, true);
      return;
    }
    const recipient = selectedRecipient;
    if (!beginRequestGuard(recipient)) return;
    setOperation('送信中');
    try {
      const accepted = await post('/viewer/send', {
        message,
        to: recipient,
        viewer_client_id: viewerClientID,
        input_source: inputSource === 'stt' ? 'stt' : 'text',
        user_id: viewerUserID,
        device_name: viewerDeviceName,
      });
      pendingRequest.jobID = String(accepted.job_id || '').trim();
      if (!pendingRequest.jobID) throw new Error('CORE応答にjob_idがありません');
      if (normalizeActor(accepted.recipient) !== recipient) throw new Error('CORE受付先が選択中の相手と一致しません');
      input.value = '';
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

  function bindCoreViewerControl(id, label) {
    const control = document.getElementById(id);
    if (!control) return;
    control.addEventListener('click', () => {
      setOperation(`${label}は現在CORE Viewer側の機能です`, true);
    });
  }

  function setModeSwitcherBusy(busy) {
    modeSwitchBusy = Boolean(busy);
    document.querySelectorAll('[data-lab-switch]').forEach((control) => {
      control.disabled = modeSwitchBusy || Boolean(pendingRequest) || mode !== 'lab';
      control.setAttribute('aria-disabled', control.disabled ? 'true' : 'false');
    });
  }

  async function switchConversation(nextMode, partner) {
    if (pendingRequest) return;
    if (mode !== 'lab' || modeSwitchBusy) return;
    const isIdle = nextMode === 'idle';
    const nextRecipient = isIdle ? selectedRecipient : (normalizeActor(partner) || selectedPartner);
    if (!isIdle) {
      setConversationState(false, nextRecipient);
      input.focus();
    }
    setModeSwitcherBusy(true);
    setOperation(isIdle ? 'IdleChatを開始中' : 'Chatへ切り替え中');
    try {
      await post(isIdle ? '/viewer/idlechat/start' : '/viewer/idlechat/stop');
      if (!isIdle) {
        await post('/viewer/recipient-selection', {viewer_client_id: viewerClientID, recipient: nextRecipient});
      }
      await refreshStatus();
      setOperation(isIdle ? 'IdleChatを開始しました' : `${actorInfo[nextRecipient].label}とのChatへ切り替えました`);
    } catch (error) {
      await refreshStatus();
      setOperation(`切り替えできません: ${error.message}`, true);
    } finally {
      setModeSwitcherBusy(false);
    }
  }

  function updateDateTime() {
    const element = document.getElementById('labDateTimePanel');
    const now = new Date();
    element.dateTime = now.toISOString();
    element.textContent = new Intl.DateTimeFormat('ja-JP', {
      era: 'long', year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'short',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
    }).format(now);
  }

  if (mode === 'lab') {
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault();
        send('text');
      }
    });
    document.querySelectorAll('[data-lab-switch]').forEach((chip) => {
      chip.addEventListener('click', () => {
        switchConversation('chat', chip.dataset.labSwitch);
      });
    });
    bindTTSControl();
    bindSTTControl();
    bindCoreViewerControl('labAttachBtn', 'ファイル添付');
    bindCoreViewerControl('labScreenBtn', '画面入力');
    bindCoreViewerControl('labCameraBtn', 'カメラ入力');
  } else if (roomSurface) {
    input.disabled = true;
    document.querySelectorAll('.lab-footer-controls .lab-icon-btn').forEach((control) => { control.disabled = true; });
    document.querySelectorAll('.lab-mode-chip').forEach((chip) => chip.disabled = true);
    setConversationState(true, selectedRecipient);
  }

  updateDateTime();
  window.setInterval(updateDateTime, 1000);
  refreshReadiness();
  refreshStatus();
  connectEvents();
  window.setInterval(refreshReadiness, 10000);
  window.setInterval(refreshStatus, 5000);
})();
