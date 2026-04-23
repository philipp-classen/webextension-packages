/**
 * WhoTracks.Me
 * https://whotracks.me/
 *
 * Copyright 2017-present Ghostery GmbH. All rights reserved.
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0
 */

import ChromeStorageMap from './utils/chrome-storage-map.js';

const PAGE_TTL = 1000 * 60 * 60; // 1 hour

const PAGE_LOADING_STATE = {
  CREATED: 'created',
  NAVIGATING: 'navigating',
  COMMITTED: 'committed',
  COMPLETE: 'complete',
};

function makePageActive(page, active) {
  if (active && page.activeFrom === 0) {
    page.activeFrom = Date.now();
  } else if (!active && page.activeFrom > 0) {
    page.activeTime += Date.now() - page.activeFrom;
    page.activeFrom = 0;
  }
}

function createPage({ pageId, tabId, url, isPrivate, created }) {
  return {
    id: pageId,
    tabId,
    url,
    isPrivate: isPrivate || false,
    isPrivateServer: false,
    created: created || Date.now(),
    destroyed: null,
    state: PAGE_LOADING_STATE.CREATED,
    activeTime: 0,
    activeFrom: 0,
    requestStats: {},
    annotations: {},
    counter: 0,
  };
}

export default class PageStore {
  #notifyPageStageListeners;
  #pages; // pageId -> Page
  #tabToPage; // tabId -> pageId (the tab's current top-level page)
  #docToPage; // documentId -> pageId (resolves any document, incl. subframes, to its top-level page)
  #tabIncognito; // tabId -> boolean (in-memory only)

  constructor({ notifyPageStageListeners }) {
    this.#pages = new ChromeStorageMap({
      storageKey: 'wtm-url-reporting:page-store:documents',
      ttlInMs: PAGE_TTL,
    });
    this.#tabToPage = new ChromeStorageMap({
      storageKey: 'wtm-url-reporting:page-store:tab-to-page',
      ttlInMs: PAGE_TTL,
    });
    this.#docToPage = new ChromeStorageMap({
      storageKey: 'wtm-url-reporting:page-store:doc-to-page',
      ttlInMs: PAGE_TTL,
    });
    this.#tabIncognito = new Map();
    this.#notifyPageStageListeners = notifyPageStageListeners;
  }

  async init() {
    await this.#pages.isReady;
    await this.#tabToPage.isReady;
    await this.#docToPage.isReady;

    chrome.tabs.onCreated.addListener(this.#onTabCreated);
    chrome.tabs.onRemoved.addListener(this.#onTabRemoved);
    chrome.tabs.onActivated.addListener(this.#onTabActivated);
    chrome.webNavigation.onBeforeNavigate.addListener(this.#onBeforeNavigate);
    chrome.webNavigation.onCommitted.addListener(this.#onNavigationCommitted);
    chrome.webNavigation.onCompleted.addListener(this.#onNavigationCompleted);

    // Note: not available on Firefox Android
    chrome.windows?.onFocusChanged?.addListener(this.#onWindowFocusChanged);

    // Seed incognito state for already-open tabs.
    try {
      for (const tab of await chrome.tabs.query({})) {
        this.#tabIncognito.set(tab.id, tab.incognito || false);
      }
    } catch {
      // ignore
    }
  }

  unload() {
    this.#pages.forEach((page) => {
      if (!page.destroyed) {
        this.#stagePage(page);
      }
    });
    this.#pages.clear();
    this.#tabToPage.clear();
    this.#docToPage.clear();
    this.#tabIncognito.clear();

    chrome.tabs.onCreated.removeListener(this.#onTabCreated);
    chrome.tabs.onRemoved.removeListener(this.#onTabRemoved);
    chrome.tabs.onActivated.removeListener(this.#onTabActivated);
    chrome.webNavigation.onBeforeNavigate.removeListener(
      this.#onBeforeNavigate,
    );
    chrome.webNavigation.onCommitted.removeListener(
      this.#onNavigationCommitted,
    );
    chrome.webNavigation.onCompleted.removeListener(
      this.#onNavigationCompleted,
    );
    chrome.windows?.onFocusChanged?.removeListener(this.#onWindowFocusChanged);
  }

  checkIfEmpty() {
    return this.#pages.countNonExpiredKeys() === 0;
  }

  #stagePage(page) {
    makePageActive(page, false);
    page.destroyed = Date.now();
    this.#notifyPageStageListeners(page);
  }

  #stageTabCurrent(tabId) {
    const pageId = this.#tabToPage.get(tabId);
    if (pageId === undefined) {
      return;
    }
    const page = this.#pages.get(pageId);
    if (page && !page.destroyed && page.state === PAGE_LOADING_STATE.COMPLETE) {
      this.#stagePage(page);
      this.#pages.set(pageId, page);
    }
  }

  #onTabCreated = (tab) => {
    this.#tabIncognito.set(tab.id, tab.incognito || false);
  };

  #onTabRemoved = (tabId) => {
    this.#stageTabCurrent(tabId);
    this.#tabToPage.delete(tabId);
    this.#tabIncognito.delete(tabId);
  };

  #onTabActivated = (details) => {
    const { previousTabId, tabId } = details;
    if (!previousTabId) {
      for (const page of this.#pages.values()) {
        if (page.destroyed) {
          continue;
        }
        makePageActive(page, false);
        this.#pages.set(page.id, page);
      }
    } else {
      const prevPageId = this.#tabToPage.get(previousTabId);
      if (prevPageId !== undefined) {
        const prevPage = this.#pages.get(prevPageId);
        if (prevPage && !prevPage.destroyed) {
          makePageActive(prevPage, false);
          this.#pages.set(prevPageId, prevPage);
        }
      }
    }
    const currentPageId = this.#tabToPage.get(tabId);
    if (currentPageId !== undefined) {
      const page = this.#pages.get(currentPageId);
      if (page && !page.destroyed) {
        makePageActive(page, true);
        this.#pages.set(currentPageId, page);
      }
    }
  };

  #onWindowFocusChanged = async (focusedWindowId) => {
    const activeTabs = await chrome.tabs.query({ active: true });
    for (const { id, windowId } of activeTabs) {
      const pageId = this.#tabToPage.get(id);
      if (pageId === undefined) {
        continue;
      }
      const page = this.#pages.get(pageId);
      if (!page || page.destroyed) {
        continue;
      }
      makePageActive(page, windowId === focusedWindowId);
      this.#pages.set(pageId, page);
    }
  };

  #onBeforeNavigate = (details) => {
    const { frameId, tabId, url, timeStamp } = details;
    if (frameId !== 0) {
      return;
    }

    // Stage the previous top-level page for this tab (if complete).
    this.#stageTabCurrent(tabId);

    // Create a new "pending" page keyed by tabId+timeStamp. The documentId
    // isn't provided by onBeforeNavigate; it arrives on onCommitted, at which
    // point we register an alias.
    const pageId = `tab:${tabId}:${timeStamp ?? Date.now()}`;
    const page = createPage({
      pageId,
      tabId,
      url,
      isPrivate: this.#tabIncognito.get(tabId) || false,
      created: timeStamp,
    });
    page.state = PAGE_LOADING_STATE.NAVIGATING;
    this.#pages.set(pageId, page);
    this.#tabToPage.set(tabId, pageId);
  };

  #onNavigationCommitted = (details) => {
    const { frameId, tabId, documentId, url, parentDocumentId } = details;
    if (frameId === 0) {
      const pageId = this.#tabToPage.get(tabId);
      if (pageId === undefined) {
        return;
      }
      const page = this.#pages.get(pageId);
      if (!page) {
        return;
      }
      page.state = PAGE_LOADING_STATE.COMMITTED;
      if (url) {
        page.url = url;
      }
      this.#pages.set(pageId, page);
      if (documentId) {
        this.#docToPage.set(documentId, pageId);
      }
    } else if (documentId) {
      // Sub-frame: associate with its top-level ancestor.
      let topPageId;
      if (parentDocumentId) {
        topPageId = this.#docToPage.get(parentDocumentId);
      }
      if (topPageId === undefined) {
        topPageId = this.#tabToPage.get(tabId);
      }
      if (topPageId !== undefined) {
        this.#docToPage.set(documentId, topPageId);
      }
    }
  };

  #onNavigationCompleted = (details) => {
    const { frameId, tabId } = details;
    if (frameId !== 0) {
      return;
    }
    const pageId = this.#tabToPage.get(tabId);
    if (pageId === undefined) {
      return;
    }
    const page = this.#pages.get(pageId);
    if (!page) {
      return;
    }
    page.state = PAGE_LOADING_STATE.COMPLETE;
    this.#pages.set(pageId, page);
  };

  getPageForRequest(context) {
    const { documentId, tabId } = context;

    // Precise path: resolve by documentId (works for subresource requests from
    // any document, including sub-frames and documents that are no longer the
    // tab's active top-level document).
    if (documentId) {
      const pageId = this.#docToPage.get(documentId);
      if (pageId !== undefined) {
        return this.#pages.get(pageId) ?? null;
      }
    }

    // Fallback: the main-frame webRequest events fire before onCommitted and
    // therefore don't yet carry a documentId. Use the tab's current page.
    if (tabId !== undefined && tabId !== -1) {
      const pageId = this.#tabToPage.get(tabId);
      if (pageId !== undefined) {
        return this.#pages.get(pageId) ?? null;
      }
    }

    return null;
  }
}
