/**
 * 站点导航：在两个游戏之间互跳。
 *
 * 只在经站点网关访问（URL 带 /dnf、/xiuxian 这类路径前缀）时才注入。
 * 直连 8787 / 8788 时 basePath 为空，此时另一个游戏不在同一个源下，
 * 跳过去只会 404，所以干脆不显示。
 *
 * 站点列表由 window.SITE_NAV_ENTRIES 覆盖，默认写死两个游戏。
 */
(() => {
  'use strict';

  const DEFAULT_ENTRIES = [
    { path: '/xiuxian', name: '问道仙坊', icon: '⛩️' },
    { path: '/dnf', name: 'DNF', icon: '⚔️' },
  ];

  function currentBase() {
    // 引导脚本已算过一次，直接复用，保证与 fetch 前缀完全一致。
    if (typeof window.__basePath === 'string') return window.__basePath;
    return location.pathname.replace(/[^/]*$/, '').replace(/\/$/, '');
  }

  function render() {
    const base = currentBase();
    if (!base) return; // 直连模式，不显示

    const entries = Array.isArray(window.SITE_NAV_ENTRIES) && window.SITE_NAV_ENTRIES.length
      ? window.SITE_NAV_ENTRIES
      : DEFAULT_ENTRIES;

    if (document.querySelector('.site-nav')) return;

    const nav = document.createElement('nav');
    nav.className = 'site-nav';
    nav.setAttribute('aria-label', '游戏导航');

    const title = document.createElement('div');
    title.className = 'site-nav-title';
    title.textContent = '切换游戏';
    nav.appendChild(title);

    for (const entry of entries) {
      const link = document.createElement('a');
      link.href = entry.path + '/';
      if (entry.path === base) link.setAttribute('aria-current', 'page');

      const icon = document.createElement('span');
      icon.className = 'site-nav-icon';
      icon.setAttribute('aria-hidden', 'true');
      icon.textContent = entry.icon || '🎮';
      link.appendChild(icon);
      link.appendChild(document.createTextNode(entry.name));

      nav.appendChild(link);
    }

    document.body.appendChild(nav);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', render, { once: true });
  } else {
    render();
  }
})();
