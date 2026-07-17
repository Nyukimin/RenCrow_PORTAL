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
  const partnerChip = document.getElementById('labModePartnerChip');
  const partnerOptions = document.getElementById('labPartnerOptions');
  const seenEvents = new Set();
  const partnerStorageKey = 'labConversation.selectedPartner';
  const storedRecipient = normalizeActor(localStorage.getItem(partnerStorageKey)) || normalizeActor(localStorage.getItem('rencrow.portal.partner')) || 'shiro';
  let selectedRecipient = storedRecipient;
  let selectedPartner = isPartnerActor(storedRecipient) ? storedRecipient : 'shiro';
  let modeSwitchBusy = false;

  const actorInfo = {
    user: {label: 'あなた', mark: 'U', color: '#64748b'},
    mio: {label: 'Mio', mark: 'M', color: '#426af3'},
    shiro: {label: 'Shiro', mark: 'S', color: '#7c62d7'},
    kuro: {label: 'Kuro', mark: 'K', color: '#334155'},
    midori: {label: 'Midori', mark: 'M', color: '#16846b'},
  };

  function api(path) {
    return `/api/${mode}${path}`;
  }

  function normalizeActor(value) {
    const text = String(value || '').trim().toLowerCase();
    if (text.includes('shiro') || text.includes('しろ')) return 'shiro';
    if (text.includes('kuro') || text.includes('くろ')) return 'kuro';
    if (text.includes('midori') || text.includes('みどり')) return 'midori';
    if (text.includes('mio') || text.includes('みお') || text === 'chat') return 'mio';
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

  function eventKey(event) {
    return [event.seq, event.event_id, event.message_id, event.timestamp, event.type, event.from, event.content].map((value) => String(value || '')).join('|');
  }

  function shouldRenderEvent(event) {
    const content = String(event && event.content || '').trim();
    if (!content || event.type === 'tts.audio_chunk' || event.type === 'metrics.latency') return false;
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
    const target = document.getElementById(actor === 'shiro' ? 'shiroPortrait' : 'mioPortrait');
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
    const normalizedRecipient = normalizeActor(recipient);
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
    setChip('labModeChatChip', !isIdle);
    setChip('labModeIdleChip', isIdle);
    setChip('labModeMioChip', isIdle || selectedRecipient === 'mio');
    setChip('labModePartnerChip', !isIdle && isPartnerActor(selectedRecipient));
    partnerChip.textContent = actorInfo[selectedPartner].label;
    partnerChip.disabled = modeSwitchBusy || isIdle || mode !== 'lab';
    partnerChip.setAttribute('aria-disabled', partnerChip.disabled ? 'true' : 'false');
    partnerOptions.hidden = true;
    partnerChip.setAttribute('aria-expanded', 'false');
    document.querySelectorAll('[data-lab-partner-option]').forEach((option) => {
      const actor = normalizeActor(option.dataset.labPartnerOption);
      option.hidden = actor === selectedPartner;
      option.disabled = modeSwitchBusy;
      option.setAttribute('aria-disabled', option.disabled ? 'true' : 'false');
    });
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
        renderEvent(JSON.parse(message.data));
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
  }

  async function send() {
    const message = input.value.trim();
    if (!message || mode !== 'lab') return;
    input.disabled = true;
    setOperation('送信中');
    try {
      await post('/viewer/send', {message, to: selectedRecipient});
      input.value = '';
      setOperation('送信しました');
    } catch (error) {
      setOperation(`送信できません: ${error.message}`, true);
    } finally {
      input.disabled = false;
      input.focus();
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
    const isIdle = body.classList.contains('lab-idle-mode');
    document.querySelectorAll('[data-lab-switch], [data-lab-partner-toggle], [data-lab-partner-option]').forEach((control) => {
      const partnerToggle = control.hasAttribute('data-lab-partner-toggle');
      control.disabled = modeSwitchBusy || mode !== 'lab' || (partnerToggle && isIdle);
      control.setAttribute('aria-disabled', control.disabled ? 'true' : 'false');
    });
    if (modeSwitchBusy || isIdle) {
      partnerOptions.hidden = true;
      partnerChip.setAttribute('aria-expanded', 'false');
    }
  }

  async function switchConversation(nextMode, partner) {
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
        send();
      }
    });
    document.querySelectorAll('[data-lab-switch]').forEach((chip) => {
      chip.addEventListener('click', () => {
        const action = chip.dataset.labSwitch;
        if (action === 'idle') switchConversation('idle');
        else if (action === 'mio') switchConversation('chat', 'mio');
        else switchConversation('chat', selectedPartner);
      });
    });
    partnerChip.addEventListener('click', (event) => {
      event.preventDefault();
      if (!body.classList.contains('lab-chat-mode') || modeSwitchBusy) return;
      partnerOptions.hidden = !partnerOptions.hidden;
      partnerChip.setAttribute('aria-expanded', partnerOptions.hidden ? 'false' : 'true');
    });
    document.querySelectorAll('[data-lab-partner-option]').forEach((option) => {
      option.addEventListener('click', () => {
        partnerOptions.hidden = true;
        partnerChip.setAttribute('aria-expanded', 'false');
        switchConversation('chat', option.dataset.labPartnerOption);
      });
    });
    document.addEventListener('click', (event) => {
      const picker = document.getElementById('labPartnerPicker');
      if (picker && picker.contains(event.target)) return;
      partnerOptions.hidden = true;
      partnerChip.setAttribute('aria-expanded', 'false');
    });
    bindCoreViewerControl('labAudioBtn', 'TTS');
    bindCoreViewerControl('labMicBtn', 'STT');
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
