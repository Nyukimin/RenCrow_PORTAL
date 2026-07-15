(() => {
  'use strict';

  const body = document.body;
  const mode = body.dataset.mode === 'lab' ? 'lab' : 'view';
  const messages = document.getElementById('messages');
  const emptyMessage = document.getElementById('emptyMessage');
  const connectionDot = document.getElementById('connectionDot');
  const connectionText = document.getElementById('connectionText');
  const conversationStatus = document.getElementById('conversationStatus');
  const topicText = document.getElementById('topicText');
  const operationStatus = document.getElementById('operationStatus');

  document.querySelectorAll('[data-mode-link]').forEach((link) => {
    if (link.dataset.modeLink === mode) link.setAttribute('aria-current', 'page');
  });

  function api(path) {
    return `/api/${mode}${path}`;
  }

  function setConnection(state, text) {
    connectionDot.className = `status-dot status-dot--${state}`;
    connectionText.textContent = text;
  }

  function setOperation(text, isError = false) {
    operationStatus.textContent = text;
    operationStatus.classList.toggle('operation-status--error', isError);
  }

  function addEvent(event) {
    const content = String(event.content || '').trim();
    if (!content) return;
    if (emptyMessage) emptyMessage.remove();
    const article = document.createElement('article');
    const type = String(event.type || 'event');
    article.className = `message ${type === 'agent.response' ? 'message--response' : 'message--received'}`;
    const meta = document.createElement('div');
    meta.className = 'message__meta';
    const from = String(event.from || 'system');
    const to = event.to ? ` → ${String(event.to)}` : '';
    const timestamp = event.timestamp ? ` · ${String(event.timestamp)}` : '';
    meta.textContent = `${from}${to} · ${type}${timestamp}`;
    const text = document.createElement('p');
    text.className = 'message__content';
    text.textContent = content;
    article.append(meta, text);
    messages.append(article);
    while (messages.children.length > 300) messages.firstElementChild.remove();
    messages.scrollTop = messages.scrollHeight;
    conversationStatus.textContent = type === 'agent.response' ? `${from}が応答` : '会話中';
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

  async function refreshIdleStatus() {
    try {
      const response = await fetch(api('/viewer/idlechat/status'), {cache: 'no-store'});
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const status = await response.json();
      topicText.textContent = String(status.current_topic || '-');
      if (status.mode) conversationStatus.textContent = String(status.mode);
    } catch (error) {
      topicText.textContent = '-';
    }
  }

  function connectEvents() {
    const events = new EventSource(api('/viewer/events'));
    events.onopen = () => setConnection('ready', 'CORE接続済み');
    events.onmessage = (message) => {
      try {
        addEvent(JSON.parse(message.data));
      } catch (error) {
        setConnection('error', 'イベント解析エラー');
      }
    };
    events.onerror = () => setConnection('waiting', '再接続中');
  }

  async function post(path, payload) {
    const options = {method: 'POST'};
    if (payload) {
      options.headers = {'Content-Type': 'application/json'};
      options.body = JSON.stringify(payload);
    }
    const response = await fetch(api(path), options);
    if (!response.ok) {
      const text = await response.text();
      throw new Error(`HTTP ${response.status}: ${text || response.statusText}`);
    }
  }

  if (mode === 'lab') {
    const form = document.getElementById('messageForm');
    const input = document.getElementById('messageInput');
    const recipient = document.getElementById('recipient');
    const sendButton = document.getElementById('sendButton');
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      const message = input.value.trim();
      if (!message) return;
      sendButton.disabled = true;
      setOperation('送信中');
      try {
        await post('/viewer/send', {message, to: recipient.value});
        input.value = '';
        setOperation('送信しました');
      } catch (error) {
        setOperation(`送信できません: ${error.message}`, true);
      } finally {
        sendButton.disabled = false;
        input.focus();
      }
    });
    document.getElementById('idleStart').addEventListener('click', async () => {
      try {
        await post('/viewer/idlechat/start');
        setOperation('IdleChatを開始しました');
        await refreshIdleStatus();
      } catch (error) {
        setOperation(`IdleChatを開始できません: ${error.message}`, true);
      }
    });
    document.getElementById('idleStop').addEventListener('click', async () => {
      try {
        await post('/viewer/idlechat/stop');
        setOperation('IdleChatを停止しました');
        await refreshIdleStatus();
      } catch (error) {
        setOperation(`IdleChatを停止できません: ${error.message}`, true);
      }
    });
  }

  refreshReadiness();
  refreshIdleStatus();
  connectEvents();
  window.setInterval(refreshReadiness, 10000);
  window.setInterval(refreshIdleStatus, 5000);
})();
