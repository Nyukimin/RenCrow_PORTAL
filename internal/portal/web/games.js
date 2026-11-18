(() => {
  'use strict';

  if (String(document.body.dataset.mode || '').toLowerCase() !== 'games') return;

  const gameCatalog = [
    {
      id: 'nethack',
      title: 'NetHack',
      reasonPlaceholder: 'NetHackを遊んでください',
    },
    {
      id: 'survival_garden',
      title: 'Survival Garden',
      reasonPlaceholder: 'Survival Gardenを遊んでください',
    },
    {
      id: 'territory_commander',
      title: 'Territory Commander',
      reasonPlaceholder: 'Territory Commanderを遊んでください',
    },
    {
      id: 'herzog_zwei',
      title: 'Herzog Zwei',
      reasonPlaceholder: 'Herzog Zweiを遊んでください',
    },
  ];
  const titleNames = Object.fromEntries(gameCatalog.map(game => [game.id, game.title]));
  const actorNames = {mio: 'Mio', shiro: 'Shiro', kuro: 'Kuro', midori: 'Midori', aka: 'Aka', ao: 'Ao', kin: 'Kin', gin: 'Gin'};
  const knownActorIDs = new Set(Object.keys(actorNames));
  const fourPlayerGameIDs = new Set(['survival_garden', 'herzog_zwei']);
  const fourPlayerPersonas = ['aka', 'ao', 'kin', 'gin'];
  const state = {
    gameID: 'nethack',
    supportedGames: new Set(),
    selectedSessionID: '',
    selectedSession: null,
    sessions: [],
    launchBusy: false,
    presenceReady: false,
    frameCount: 0,
  };

  const catalog = document.getElementById('gamesCatalog');
  const form = document.getElementById('gamesLaunchForm');
  const agentSelect = document.getElementById('gamesAgentSelect');
  const singleAgentField = document.getElementById('gamesSingleAgentField');
  const fourPlayerRoster = document.getElementById('gamesFourPlayerRoster');
  const rosterGuidance = document.getElementById('gamesRosterGuidance');
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
  const stagePanel = document.querySelector('.games-stage-panel');
  const returnLivingLink = document.getElementById('gamesReturnLiving');
  const routeParams = new URLSearchParams(window.location.search);
  const requestedSession = routeParams.get('session');
  const requestedGame = routeParams.get('game');
  const requestedPersona = routeParams.get('persona');
  const hasRequestedSession = requestedSession !== null || requestedGame !== null || requestedPersona !== null;
  let requestedSessionHandled = false;

  function isKnownActor(actor) {
    return typeof actor === 'string' && knownActorIDs.has(actor);
  }

  function setOperation(message, isError = false) {
    operationStatus.textContent = message || '';
    operationStatus.classList.toggle('is-error', Boolean(isError));
  }

  function supportedGameIDs(payload) {
    if (payload?.decision_mode !== 'agent' || !Array.isArray(payload.supported_games)) return new Set();
    const reported = new Set(
      payload.supported_games
        .filter(value => typeof value === 'string')
        .map(value => value.trim().toLowerCase()),
    );
    return new Set(gameCatalog.filter(game => reported.has(game.id)).map(game => game.id));
  }

  function updateGameGuidance() {
    const game = gameCatalog.find(item => item.id === state.gameID);
    if (game) reasonInput.placeholder = game.reasonPlaceholder;
    const fourPlayer = fourPlayerGameIDs.has(state.gameID);
    if (singleAgentField) singleAgentField.hidden = fourPlayer;
    if (fourPlayerRoster) fourPlayerRoster.hidden = !fourPlayer;
    if (rosterGuidance) rosterGuidance.textContent = fourPlayer ? 'Aka・Ao・Kin・Ginの4 Agentで遊びます' : '1 Agentで遊びます';
  }

  function sessionPersonas(session) {
    if (!session || typeof session !== 'object') return [];
    if (Array.isArray(session.personas)) {
      if (!session.personas.length || session.personas.some(persona => !isKnownActor(persona) || !persona.trim()) ||
          new Set(session.personas).size !== session.personas.length ||
          (session.persona !== undefined && (!isKnownActor(session.persona) || !session.personas.includes(session.persona)))) return [];
      return session.personas.slice();
    }
    return isKnownActor(session.persona) ? [session.persona] : [];
  }

  function sessionActorLabel(session) {
    const personas = sessionPersonas(session);
    return personas.length ? personas.map(persona => actorNames[persona]).join('・') : 'Agent';
  }

  function updateLivingReturnLink(persona) {
    if (!returnLivingLink) return;
    const url = new URL('/living', window.location.origin);
    url.searchParams.set('view', 'workplace');
    if (isKnownActor(persona)) url.searchParams.set('person', persona);
    returnLivingLink.href = `${url.pathname}${url.search}`;
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
      if (capability) capability.textContent = supported ? 'プレイできます' : '現在はプレイできません';
    });
    launchButton.disabled = state.launchBusy || !state.presenceReady || !state.supportedGames.has(state.gameID);
    updateSessionActions();
  }

  function updateSessionActions() {
    const canAct = state.presenceReady && Boolean(state.selectedSessionID);
    retryButton.disabled = !canAct;
    startOverButton.disabled = !canAct;
  }

  function updatePresenceReady(ready) {
    state.presenceReady = Boolean(ready);
    updateCatalog();
    updateSessionActions();
    if (!state.presenceReady) setOperation('COREの前景接続を確認しています');
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
      state.supportedGames = supportedGameIDs(payload);
      if (!state.supportedGames.has(state.gameID)) {
        state.gameID = gameCatalog.find(game => state.supportedGames.has(game.id))?.id || 'nethack';
      }
      if (!state.selectedSessionID) stageTitle.textContent = titleNames[state.gameID] || state.gameID;
      updateGameGuidance();
      bridgeStatus.textContent = payload.decision_mode === 'agent'
        ? `Agent bridge ready · ${state.supportedGames.size} title${state.supportedGames.size === 1 ? '' : 's'}`
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
    detail.textContent = `${sessionActorLabel(session)} · turn ${Number(session.turn || 0)} · ${session.status || 'unknown'}`;
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
    const personas = sessionPersonas(session);
    const linkedPersona = requestedPersona && personas.includes(requestedPersona)
      ? requestedPersona
      : (session.persona && personas.includes(session.persona) ? session.persona : personas[0]);
    stageSession.textContent = `${state.selectedSessionID} · ${sessionActorLabel(session)}`;
    updateLivingReturnLink(linkedPersona);
    screenShell.classList.add('has-session');
    updateSessionActions();
    setOverlayAgent(linkedPersona || session.persona || agentSelect.value);
    observerFrame.src = `/viewer/games/observer?session=${encodeURIComponent(state.selectedSessionID)}&game=${encodeURIComponent(session.game_id || '')}`;
    renderSessions();
    refreshSelectedFrames();
  }

  function requestedGameSession(payload) {
    if (!hasRequestedSession) return { state: 'none' };
    if (!requestedSession || !requestedGame || !isKnownActor(requestedPersona) || payload?.ok !== true ||
        payload?.source !== 'local_observer' || !Array.isArray(payload?.active_agent_sessions)) {
      return { state: 'invalid' };
    }
    const activeSessionsValid = payload.active_agent_sessions.every(session =>
      session && typeof session.session_id === 'string' && session.session_id.trim() &&
      typeof session.game_id === 'string' && session.game_id.trim() &&
      Array.isArray(session.personas) && session.personas.length > 0 &&
      session.personas.every(persona => typeof persona === 'string' && persona.trim()) &&
      new Set(session.personas).size === session.personas.length &&
      session.personas.every(isKnownActor) &&
      (session.persona === undefined || (isKnownActor(session.persona) && session.personas.includes(session.persona))) &&
      (session.status === 'launching' || session.status === 'running')
    );
    if (!activeSessionsValid) return { state: 'invalid' };
    const activeMatches = payload.active_agent_sessions.filter(session =>
      session && session.session_id === requestedSession && session.game_id === requestedGame &&
      Array.isArray(session.personas) && session.personas.includes(requestedPersona) &&
      (session.status === 'launching' || session.status === 'running')
    );
    if (activeMatches.length === 1) {
      return {
        state: 'active',
        session: {
          game_id: activeMatches[0].game_id,
          session_id: activeMatches[0].session_id,
          personas: activeMatches[0].personas.slice(),
          persona: requestedPersona,
          status: activeMatches[0].status,
          turn: 0,
        },
      };
    }
    if (activeMatches.length > 1 || payload.active_agent_sessions.some(session =>
      session?.session_id === requestedSession)) return { state: 'invalid' };

    const summaries = Array.isArray(payload.sessions) ? payload.sessions.filter(session =>
      session && session.session_id === requestedSession) : [];
    if (summaries.length !== 1) return { state: 'invalid' };
    const summary = summaries[0];
    if (summary.game_id !== requestedGame || !sessionPersonas(summary).includes(requestedPersona) || summary.status !== 'completed') {
      return { state: 'invalid' };
    }
    return { state: 'completed', session: summary };
  }

  async function refreshSessions(preferredSessionID = '') {
    try {
      const payload = await requestJSON('/viewer/games/observer-api/games/sessions?limit=30');
      state.sessions = Array.isArray(payload.sessions) ? payload.sessions : [];
      if (hasRequestedSession && !requestedSessionHandled) {
        requestedSessionHandled = true;
        const requested = requestedGameSession(payload);
        if (requested.state === 'active' || requested.state === 'completed') {
          selectSession(requested.session);
          stagePanel?.scrollIntoView({ behavior: 'auto', block: 'start' });
        } else {
          setOperation('指定されたゲームsessionは進行中ではないか、参加Agentが一致しません。', true);
        }
      }
      const wanted = preferredSessionID || state.selectedSessionID;
      if (wanted) {
        const updated = state.sessions.find(session => String(session.session_id) === String(wanted));
        if (updated) {
          state.selectedSession = updated;
          stageSession.textContent = `${wanted} · ${sessionActorLabel(updated)} · turn ${Number(updated.turn || 0)}`;
        }
      }
      renderSessions();
    } catch (error) {
      if (hasRequestedSession && !requestedSessionHandled) setOperation(`指定ゲームsessionを確認できません: ${error.message}`, true);
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
    if (!state.presenceReady) {
      setOperation('Gamesのforeground_readyを確認してから起動できます', true);
      return;
    }
    if (state.launchBusy || !state.supportedGames.has(state.gameID)) return;
    state.launchBusy = true;
    updateCatalog();
    const personas = fourPlayerGameIDs.has(state.gameID) ? fourPlayerPersonas.slice() : [agentSelect.value];
    setOperation(`${personas.map(persona => actorNames[persona]).join('・')}が${titleNames[state.gameID] || state.gameID}を起動中`);
    setOverlayAgent(personas[0]);
    try {
      const turns = Math.max(1, Math.min(500, Number.parseInt(turnsInput.value, 10) || 32));
      const payload = await requestJSON('/api/games/viewer/games/launch', {
        method: 'POST',
        body: JSON.stringify({
          game_id: state.gameID,
          personas,
          turns,
          reason: reasonInput.value.trim(),
        }),
      });
      if (!payload.session_id) throw new Error('CORE応答にsession_idがありません');
      setOperation(`session ${payload.session_id} を起動しました`);
      await refreshSessions(payload.session_id);
      const session = state.sessions.find(item => String(item.session_id) === String(payload.session_id)) || {
        game_id: payload.game_id || state.gameID,
        session_id: payload.session_id,
        personas,
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
    if (!state.presenceReady) {
      setOperation('Gamesのforeground_readyを確認してから操作できます', true);
      return;
    }
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
        personas: sessionPersonas(state.selectedSession).length ? sessionPersonas(state.selectedSession) : [agentSelect.value],
        status: result.status || 'launching',
        turn: 0,
      };
      selectSession(session);
    } catch (error) {
      setOperation(`sessionを操作できません: ${error.message}`, true);
      updateSessionActions();
    }
  }

  catalog.addEventListener('click', event => {
    const card = event.target.closest('[data-game-id]');
    if (!card || card.disabled) return;
    state.gameID = card.dataset.gameId;
    stageTitle.textContent = titleNames[state.gameID] || state.gameID;
    updateGameGuidance();
    updateCatalog();
  });
  agentSelect.addEventListener('change', () => setOverlayAgent(agentSelect.value));
  form.addEventListener('submit', launchGame);
  retryButton.addEventListener('click', () => runSessionAction('retry'));
  startOverButton.addEventListener('click', () => runSessionAction('start_over'));

  const portalPresence = window.RenCrowPortalPresence;
  if (portalPresence && typeof portalPresence.subscribe === 'function') {
    portalPresence.subscribe(updatePresenceReady);
  } else {
    updatePresenceReady(false);
  }

  updateGameGuidance();
  setOverlayAgent(agentSelect.value);
  refreshBridgeStatus();
  refreshSessions();
  window.setInterval(refreshBridgeStatus, 10000);
  window.setInterval(refreshSessions, 3000);
  window.setInterval(refreshSelectedFrames, 2000);
})();
