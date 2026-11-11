(() => {
  const living = document.querySelector('.living');
  const image = document.querySelector('#house-image');
  const caption = document.querySelector('#house-caption');
  const openBoard = document.querySelector('#open-board');
  const people = [...document.querySelectorAll('[data-person]')];
  const views = [...document.querySelectorAll('[data-view]')];
  const scenes = {
    lcp: { image: 'lcp.jpg', label: '全体（LCP）', alt: 'HOUSEの三層正面断面の参考図' },
    workplace: { image: 'workplace.jpg', label: '1階（Workplace）', alt: 'HOUSEの1階にある仕事場の参考図' },
  };
  const scrollKey = 'rencrow-living-scroll';
  let person;
  let view;

  function render() {
    people.forEach(button => button.setAttribute('aria-pressed', String(button === person)));
    views.forEach(button => button.setAttribute('aria-pressed', String(button.dataset.view === view)));
    const scene = scenes[view];
    image.src = '/assets/living/' + scene.image;
    image.alt = scene.alt;
    caption.textContent = scene.label + ' · 参考図';

    if (openBoard) {
      const target = new URL(living.dataset.boardUrl);
      target.searchParams.set('agent', person.dataset.participant);
      target.searchParams.set('from', 'living');
      target.searchParams.set('person', person.dataset.person);
      target.searchParams.set('view', view);
      openBoard.href = target.href;
      openBoard.textContent = person.querySelector('.person-name').textContent + ' の会話をBOARDで開く';
    }
  }

  function restoreSelection() {
    const params = new URLSearchParams(window.location.search);
    person = people.find(button => button.dataset.person === params.get('person')) || people[0];
    view = views.some(button => button.dataset.view === params.get('view')) ? params.get('view') : 'lcp';
    render();
  }

  function saveSelection() {
    const url = new URL(window.location.href);
    url.searchParams.set('person', person.dataset.person);
    url.searchParams.set('view', view);
    history.replaceState(history.state, '', url);
    render();
  }

  people.forEach(button => button.addEventListener('click', () => {
    person = button;
    saveSelection();
  }));
  views.forEach(button => button.addEventListener('click', () => {
    view = button.dataset.view;
    saveSelection();
  }));
  openBoard?.addEventListener('click', () => {
    try {
      sessionStorage.setItem(scrollKey, JSON.stringify({ person: person.dataset.person, view, y: window.scrollY }));
    } catch {}
  });

  window.addEventListener('pageshow', () => {
    restoreSelection();
    const params = new URLSearchParams(window.location.search);
    if (!params.has('person')) return;
    person.focus({ preventScroll: true });
    try {
      const saved = JSON.parse(sessionStorage.getItem(scrollKey));
      if (saved?.person === person.dataset.person && saved.view === view && Number.isFinite(saved.y)) {
        requestAnimationFrame(() => window.scrollTo(0, saved.y));
      }
    } catch {}
  });
  restoreSelection();
})();
