(() => {
  const image = document.getElementById('luminaCharacter');
  const status = document.getElementById('luminaStatus');
  const labels = {normal: '通常表情', smile: 'にこにこ', blink: 'まばたき'};
  const source = '/assets/lumina-assets/';
  const images = {normal: 'Lumina.png', smile: 'Lumina_basic_01.png', blink: 'eyes-closed-mouth-closed.png'};
  document.querySelectorAll('[data-expression]').forEach((button) => {
    button.addEventListener('click', () => {
      const expression = button.dataset.expression;
      image.src = source + images[expression];
      image.alt = `Lumina（${labels[expression]}）`;
      status.textContent = labels[expression];
      document.querySelectorAll('[data-expression]').forEach((item) => item.classList.toggle('is-active', item === button));
    });
  });
})();
