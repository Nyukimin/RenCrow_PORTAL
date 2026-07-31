(() => {
  'use strict';

  if (String(document.body.dataset.mode || '').toLowerCase() !== 'games') return;

  const titleNames = {
    nethack: 'NetHack',
    survival_garden: 'Survival Garden',
    herzog_zwei: 'Herzog Zwei',
    falling_blocks: 'Falling Blocks',
  };
  const actorNames = {mio: 'Mio', shiro: 'Shiro', kuro: 'Kuro', midori: 'Midori'};
  const state = {
    gameID: 'nethack',
    supportedGames: new Set(),
    selectedSessionID: '',
    selectedSession: null,
    sessions: [],
    launchBusy: false,
    frameCount: 0,
  };

  const catalog = document.getElementById('gamesCatalog');
  const form = document.getElementById('gamesLaunchForm');
  const agentSelect = document.getElementById('gamesAgentSelect');
  const turnsInput = document.getElementById('gamesTurns');
  const reasonInput = document.getElementById('gamesReason');
  const launchButton = document.getElementById('gamesLaunchButton');
  const bridgeStatus = document.getElementById('gamesBridgeStatus');
  const operationStatus = document.getElementById('gamesOperationStatus');
  const sessionList = document.getElementById('gamesSessionList');
  const observerFrame = document.getElementById('gamesObserverFrame');
  const screenShell = document.querySelector('.games-screen-shell');
  const stageTitle = document.getElementById('gamesStageTitle');
  const stageSession = document.getElementById('gamesStageSession');
  const retryButton = document.getElementById('gamesRetryButton');
  const startOverButton = document.getElementById('gamesStartOverButton');
  const agentSpeech = document.getElementById('gamesAgentSpeech');

  function setOperation(message, isError = false) {
    operationStatus.textContent = message || '';
    operationStatus.classList.toggle('is-error', Boolean(isError));
  }

  async function requestJSON(path, options = {}) {
    const response = await fetch(path, {
      credentials: 'same-origin',
      cache: 'no-store',
      ...options,
      headers: {
        Accept: 'application/json',
        ...(options.body ? {'Content-Type': 'application/json'} : {}),
        ...(options.headers || {}),
      },
    });
    const text = await response.text();
    let payload = {};
    if (text.trim()) {
      try {
        payload = JSON.parse(text);
      } catch {
        payload = {error: text.trim()};
      }
    }
    if (!response.ok) {
      throw new Error(payload.error || payload.message || text.trim() || `HTTP ${response.status}`);
    }
    return payload;
  }

  function updateCatalog() {
    catalog.querySelectorAll('[data-game-id]').forEach((card) => {
      const gameID = card.dataset.gameId;
      const supported = state.supportedGames.has(gameID);
      card.disabled = !supported;
      card.classList.toggle('is-selected', supported && gameID === state.gameID);
      card.setAttribute('aria-pressed', supported && gameID === state.gameID ? 'true' : 'false');
      const capability = card.querySelector('[data-game-capability]');
      if (capability) capability.textContent = supported ? 'Agent E2E対応' : 'Agent E2E対応待ち';
    });
    launchButton.disabled = state.launchBusy || !state.supportedGames.has(state.gameID);
  }

  function setOverlayAgent(persona) {
    const normalized = String(persona || '').toLowerCase();
    document.querySelectorAll('.purupuru-avatar[data-character]').forEach((portrait) => {
      portrait.classList.toggle('games-overlay-active', portrait.dataset.character === normalized);
    });
  }

  async function refreshBridgeStatus() {
    try {
      const payload = await requestJSON('/api/games/viewer/games/status');
      state.supportedGames = new Set(
        (Array.isArray(payload.supported_games) ? payload.supported_games : [])
          .map(value => String(value || '').trim().toLowerCase())
          .filter(Boolean),
      );
      if (!state.supportedGames.has(state.gameID)) {
        state.gameID = state.supportedGames.values().next().value || 'nethack';
      }
      bridgeStatus.textContent = payload.decision_mode === 'agent'
        ? `Agent bridge ready · ${state.supportedGames.size} title`
        : 'Agent bridgeを確認できません';
      bridgeStatus.classList.toggle('is-ready', payload.decision_mode === 'agent');
      bridgeStatus.classList.toggle('is-error', payload.decision_mode !== 'agent');
      updateCatalog();
    } catch (error) {
      state.supportedGames = new Set();
      bridgeStatus.textContent = `Games bridge unavailable · ${error.message}`;
      bridgeStatus.classList.remove('is-ready');
      bridgeStatus.classList.add('is-error');
      updateCatalog();
    }
  }

  function sessionButton(session) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'games-session-button';
    button.classList.toggle('is-selected', session.session_id === state.selectedSessionID);
    const name = document.createElement('strong');
    name.textContent = titleNames[session.game_id] || session.title || session.game_id || 'Game';
    const detail = document.createElement('span');
    detail.textContent = `${actorNames[session.persona] || session.persona || 'Agent'} · turn ${Number(session.turn || 0)} · ${session.status || 'unknown'}`;
    button.append(name, detail);
    button.addEventListener('click', () => selectSession(session));
    return button;
  }

  function renderSessions() {
    sessionList.replaceChildren();
    if (!state.sessions.length) {
      const empty = document.createElement('p');
      empty.textContent = 'まだsessionはありません';
      sessionList.append(empty);
      return;
    }
    state.sessions.forEach(session => sessionList.append(sessionButton(session)));
  }

  function selectSession(session) {
    if (!session || !session.session_id) return;
    state.selectedSessionID = String(session.session_id);
    state.selectedSession = session;
    state.frameCount = 0;
    stageTitle.textContent = titleNames[session.game_id] || session.title || session.game_id || 'Game';
    stageSession.textContent = `${state.selectedSessionID} · ${actorNames[session.persona] || session.persona || 'Agent'}`;
    screenShell.classList.add('has-session');
    retryButton.disabled = false;
    startOverButton.disabled = false;
    setOverlayAgent(session.persona || agentSelect.value);
    observerFrame.src = `/viewer/games/observer?session=${encodeURIComponent(state.selectedSessionID)}&game=${encodeURIComponent(session.game_id || '')}`;
    renderSessions();
    refreshSelectedFrames();
  }

  async function refreshSessions(preferredSessionID = '') {
    try {
      const payload = await requestJSON('/viewer/games/observer-api/games/sessions?limit=30');
      state.sessions = Array.isArray(payload.sessions) ? payload.sessions : [];
      const wanted = preferredSessionID || state.selectedSessionID;
      if (wanted) {
        const updated = state.sessions.find(session => String(session.session_id) === String(wanted));
        if (updated) {
          state.selectedSession = updated;
          stageSession.textContent = `${wanted} · ${actorNames[updated.persona] || updated.persona || 'Agent'} · turn ${Number(updated.turn || 0)}`;
        }
      }
      renderSessions();
    } catch (error) {
      if (!state.sessions.length) {
        sessionList.innerHTML = '';
        const message = document.createElement('p');
        message.textContent = `sessionを取得できません: ${error.message}`;
        sessionList.append(message);
      }
    }
  }

  function validAgentSpeech(frame) {
    const persona = String(frame?.persona || '').toLowerCase();
    const agentID = String(frame?.decision?.agent_id || '').toLowerCase();
    if (String(frame?.bridge?.decision_mode || '').toLowerCase() !== 'agent') return '';
    if (!persona || agentID !== persona) return '';
    const speech = frame?.result?.speech;
    if (typeof speech === 'string') return speech.trim();
    if (!speech || typeof speech !== 'object') return '';
    return String(speech.text || speech.content || speech.message || '').trim();
  }

  async function refreshSelectedFrames() {
    if (!state.selectedSessionID) return;
    try {
      const encoded = encodeURIComponent(state.selectedSessionID);
      const payload = await requestJSON(`/viewer/games/observer-api/games/sessions/${encoded}/frames`);
      const frames = Array.isArray(payload.frames) ? payload.frames : [];
      state.frameCount = frames.length;
      const latest = frames[frames.length - 1];
      const speech = validAgentSpeech(latest);
      agentSpeech.textContent = speech;
      agentSpeech.hidden = !speech;
      if (latest?.persona) setOverlayAgent(latest.persona);
    } catch {
      agentSpeech.hidden = true;
    }
  }

  async function launchGame(event) {
    event.preventDefault();
    if (state.launchBusy || !state.supportedGames.has(state.gameID)) return;
    state.launchBusy = true;
    updateCatalog();
    setOperation(`${actorNames[agentSelect.value]}が${titleNames[state.gameID] || state.gameID}を起動中`);
    setOverlayAgent(agentSelect.value);
    try {
      const turns = Math.max(1, Math.min(500, Number.parseInt(turnsInput.value, 10) || 32));
      const payload = await requestJSON('/api/games/viewer/games/launch', {
        method: 'POST',
        body: JSON.stringify({
          game_id: state.gameID,
          personas: [agentSelect.value],
          turns,
          mode: 'auto',
          reason: reasonInput.value.trim(),
        }),
      });
      if (!payload.session_id) throw new Error('CORE応答にsession_idがありません');
      setOperation(`session ${payload.session_id} を起動しました`);
      await refreshSessions(payload.session_id);
      const session = state.sessions.find(item => String(item.session_id) === String(payload.session_id)) || {
        game_id: payload.game_id || state.gameID,
        session_id: payload.session_id,
        persona: agentSelect.value,
        status: payload.status || 'launching',
        turn: 0,
      };
      selectSession(session);
    } catch (error) {
      setOperation(`起動できません: ${error.message}`, true);
    } finally {
      state.launchBusy = false;
      updateCatalog();
    }
  }

  async function runSessionAction(action) {
    if (!state.selectedSessionID) return;
    retryButton.disabled = true;
    startOverButton.disabled = true;
    setOperation(action === 'retry' ? 'sessionを再試行中' : '最初から起動中');
    try {
      const encoded = encodeURIComponent(state.selectedSessionID);
      const payload = await requestJSON(`/viewer/games/observer-api/games/sessions/${encoded}/${action}`, {
        method: 'POST',
        body: JSON.stringify({source: 'portal-games'}),
      });
      const result = payload.result || payload;
      const sessionID = String(result.session_id || '');
      if (!sessionID) throw new Error('session action応答にsession_idがありません');
      setOperation(`session ${sessionID} を起動しました`);
      await refreshSessions(sessionID);
      const session = state.sessions.find(item => String(item.session_id) === sessionID) || {
        game_id: state.selectedSession?.game_id || state.gameID,
        session_id: sessionID,
        persona: state.selectedSession?.persona || agentSelect.value,
        status: result.status || 'launching',
        turn: 0,
      };
      selectSession(session);
    } catch (error) {
      setOperation(`sessionを操作できません: ${error.message}`, true);
      retryButton.disabled = false;
      startOverButton.disabled = false;
    }
  }

  catalog.addEventListener('click', event => {
    const card = event.target.closest('[data-game-id]');
    if (!card || card.disabled) return;
    state.gameID = card.dataset.gameId;
    stageTitle.textContent = titleNames[state.gameID] || state.gameID;
    updateCatalog();
  });
  agentSelect.addEventListener('change', () => setOverlayAgent(agentSelect.value));
  form.addEventListener('submit', launchGame);
  retryButton.addEventListener('click', () => runSessionAction('retry'));
  startOverButton.addEventListener('click', () => runSessionAction('start_over'));

  setOverlayAgent(agentSelect.value);
  refreshBridgeStatus();
  refreshSessions();
  window.setInterval(refreshBridgeStatus, 10000);
  window.setInterval(refreshSessions, 3000);
  window.setInterval(refreshSelectedFrames, 2000);
})();
