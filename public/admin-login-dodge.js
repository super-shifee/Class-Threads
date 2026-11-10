(() => {
  const canDodge = window.matchMedia('(hover: hover) and (pointer: fine) and (min-width: 760px)');
  const link = document.querySelector('.admin-login-link');
  const originalStyle = link.getAttribute('style');
  let startX = 0;
  let startY = 0;
  let nextMoveAt = 0;

  function restoreLink() {
    link.setAttribute('style', originalStyle || '');
    link.querySelectorAll('.laugh-drop').forEach((emoji) => emoji.remove());
  }

  function enableDodge() {
    if (!canDodge.matches) {
      restoreLink();
      return;
    }

    restoreLink();
    const rect = link.getBoundingClientRect();
    startX = rect.left;
    startY = rect.top;
    Object.assign(link.style, {
      position: 'fixed',
      left: `${startX}px`,
      top: `${startY}px`,
      margin: '0',
      zIndex: '20',
    });
  }

  function textRects(element) {
    const rects = [];
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      const range = document.createRange();
      range.selectNodeContents(walker.currentNode);
      rects.push(...range.getClientRects());
    }
    return rects;
  }

  function blockedRects() {
    return [
      ...document.querySelectorAll('.brand, .student-layout, footer'),
      ...textRects(document.querySelector('.hero-title')),
      ...textRects(document.querySelector('.hero-subtitle')),
      ...document.querySelectorAll('.admin-access-link'),
    ].flatMap((element) => element instanceof Element
      ? [element.getBoundingClientRect()]
      : [element]);
  }

  function overlapsBlocked(left, top, width, height, blocked) {
    const gap = 14;
    return blocked.some((rect) => (
      left < rect.right + gap
      && left + width > rect.left - gap
      && top < rect.bottom + gap
      && top + height > rect.top - gap
    ));
  }

  function showLaugh() {
    const emoji = document.createElement('span');
    emoji.className = 'laugh-drop';
    emoji.textContent = '😂';
    emoji.setAttribute('aria-hidden', 'true');
    emoji.addEventListener('animationend', () => emoji.remove(), { once: true });
    link.append(emoji);
  }

  function escapeFrom(event) {
    if (!canDodge.matches || event.pointerType !== 'mouse' || document.activeElement === link) return;
    if (Date.now() < nextMoveAt) return;

    const rect = link.getBoundingClientRect();
    const nearLink = event.clientX >= rect.left - 38
      && event.clientX <= rect.right + 38
      && event.clientY >= rect.top - 38
      && event.clientY <= rect.bottom + 38;
    if (!nearLink) return;

    const dx = rect.left + rect.width / 2 - event.clientX;
    const dy = rect.top + rect.height / 2 - event.clientY;
    const pointerDistance = Math.hypot(dx, dy);
    let awayX = dx;
    let awayY = dy;
    if (pointerDistance < 1) {
      const angle = Math.random() * Math.PI * 2;
      awayX = Math.cos(angle);
      awayY = Math.sin(angle);
    } else {
      awayX /= pointerDistance;
      awayY /= pointerDistance;
    }
    const margin = 12;
    const blocked = blockedRects();
    const candidates = [];

    for (let top = margin; top <= innerHeight - rect.height - margin; top += 32) {
      for (let left = margin; left <= innerWidth - rect.width - margin; left += 32) {
        const moveX = left - rect.left;
        const moveY = top - rect.top;
        const distance = Math.hypot(moveX, moveY);
        if (distance < 150 || overlapsBlocked(left, top, rect.width, rect.height, blocked)) continue;
        const toward = (moveX * awayX + moveY * awayY) / distance;
        if (toward > 0.2) candidates.push({ left, top, score: toward * 120 + distance / 8 + Math.random() * 12 });
      }
    }

    if (candidates.length === 0) {
      for (let top = margin; top <= innerHeight - rect.height - margin; top += 32) {
        for (let left = margin; left <= innerWidth - rect.width - margin; left += 32) {
          const distance = Math.hypot(
            left + rect.width / 2 - event.clientX,
            top + rect.height / 2 - event.clientY,
          );
          if (distance > pointerDistance + 120 && !overlapsBlocked(left, top, rect.width, rect.height, blocked)) {
            candidates.push({ left, top, score: distance + Math.random() * 80 });
          }
        }
      }
    }
    if (candidates.length === 0) return;
    candidates.sort((a, b) => b.score - a.score);
    const choice = candidates[Math.floor(Math.random() * Math.min(12, candidates.length))];
    link.style.left = `${choice.left}px`;
    link.style.top = `${choice.top}px`;
    showLaugh();
    nextMoveAt = Date.now() + 1050;
  }

  link.addEventListener('focus', () => {
    link.style.left = `${startX}px`;
    link.style.top = `${startY}px`;
  });
  window.addEventListener('pointermove', escapeFrom);
  window.addEventListener('resize', enableDodge);
  canDodge.addEventListener('change', enableDodge);
  enableDodge();
})();
