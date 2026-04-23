/**
 * WhoTracks.Me
 * https://ghostery.com/whotracksme
 *
 * Copyright 2017-present Ghostery GmbH. All rights reserved.
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0
 */

import chrome from 'sinon-chrome';
import { mock, match } from 'sinon';
import { expect } from 'chai';

import PageStore from '../../src/request/page-store.js';

describe('PageStore', function () {
  before(function () {
    chrome.storage.session = chrome.storage.local;
    globalThis.chrome = chrome;
  });

  beforeEach(function () {
    chrome.flush();
    chrome.storage.session.get.yields({});
    chrome.tabs.query.returns([]);
  });

  after(function () {
    chrome.flush();
    delete globalThis.chrome;
  });

  it('starts with empty tabs', async function () {
    const store = new PageStore({});
    await store.init();
    expect(store.checkIfEmpty()).to.be.true;
  });

  context('main-frame navigation', function () {
    it('creates a pending page on onBeforeNavigate', async function () {
      const store = new PageStore({});
      await store.init();
      const details = {
        tabId: 1,
        frameId: 0,
        url: 'about:blank',
        timeStamp: 100,
      };
      chrome.webNavigation.onBeforeNavigate.dispatch(details);
      expect(store.getPageForRequest({ tabId: 1 })).to.deep.include({
        tabId: 1,
        url: 'about:blank',
      });
    });

    it('associates documentId with the tab page on onCommitted', async function () {
      const store = new PageStore({});
      await store.init();
      const tabId = 1;
      const timeStamp = 100;
      chrome.webNavigation.onBeforeNavigate.dispatch({
        tabId,
        frameId: 0,
        url: 'about:blank',
        timeStamp,
      });
      chrome.webNavigation.onCommitted.dispatch({
        tabId,
        frameId: 0,
        documentId: 'doc-1',
        url: 'https://example.com',
        timeStamp: timeStamp + 10,
      });
      // lookup by documentId
      expect(
        store.getPageForRequest({ documentId: 'doc-1', tabId }),
      ).to.deep.include({
        tabId,
        url: 'https://example.com',
      });
      // and by tabId (for main-frame requests with no documentId)
      expect(store.getPageForRequest({ tabId })).to.deep.include({
        tabId,
        url: 'https://example.com',
      });
    });

    it('resolves subframe requests to the top-level page', async function () {
      const store = new PageStore({});
      await store.init();
      const tabId = 1;
      chrome.webNavigation.onBeforeNavigate.dispatch({
        tabId,
        frameId: 0,
        url: 'https://example.com',
        timeStamp: 100,
      });
      chrome.webNavigation.onCommitted.dispatch({
        tabId,
        frameId: 0,
        documentId: 'doc-top',
        url: 'https://example.com',
        timeStamp: 110,
      });
      chrome.webNavigation.onCommitted.dispatch({
        tabId,
        frameId: 2,
        documentId: 'doc-sub',
        parentDocumentId: 'doc-top',
        url: 'https://iframe.example.com',
        timeStamp: 120,
      });

      const page = store.getPageForRequest({
        documentId: 'doc-sub',
        tabId,
      });
      expect(page).to.deep.include({ url: 'https://example.com' });
    });

    it('stages the previous page on a new top-level navigation', async function () {
      const listener = mock();
      const store = new PageStore({ notifyPageStageListeners: listener });
      await store.init();
      const tabId = 1;
      chrome.webNavigation.onBeforeNavigate.dispatch({
        tabId,
        frameId: 0,
        url: 'https://example.com',
        timeStamp: 100,
      });
      chrome.webNavigation.onCommitted.dispatch({
        tabId,
        frameId: 0,
        documentId: 'doc-1',
        url: 'https://example.com',
        timeStamp: 110,
      });
      chrome.webNavigation.onCompleted.dispatch({
        tabId,
        frameId: 0,
        documentId: 'doc-1',
        timeStamp: 120,
      });

      expect(listener).to.not.have.been.called;

      chrome.webNavigation.onBeforeNavigate.dispatch({
        tabId,
        frameId: 0,
        url: 'https://next.example.com',
        timeStamp: 200,
      });
      expect(listener).to.have.been.calledWith(
        match({
          tabId,
          url: 'https://example.com',
          created: 100,
        }),
      );
    });

    it('does not stage an incomplete previous page', async function () {
      const listener = mock();
      const store = new PageStore({ notifyPageStageListeners: listener });
      await store.init();
      const tabId = 1;
      chrome.webNavigation.onBeforeNavigate.dispatch({
        tabId,
        frameId: 0,
        url: 'https://example.com',
        timeStamp: 100,
      });
      // no onCompleted -> state remains NAVIGATING

      chrome.webNavigation.onBeforeNavigate.dispatch({
        tabId,
        frameId: 0,
        url: 'https://next.example.com',
        timeStamp: 200,
      });
      expect(listener).to.not.have.been.called;
    });
  });

  context('on chrome.tabs.onRemoved', function () {
    it('stages the completed page for the closed tab', async function () {
      const listener = mock();
      const store = new PageStore({ notifyPageStageListeners: listener });
      await store.init();
      const tabId = 1;
      chrome.webNavigation.onBeforeNavigate.dispatch({
        tabId,
        frameId: 0,
        url: 'https://example.com',
        timeStamp: 100,
      });
      chrome.webNavigation.onCommitted.dispatch({
        tabId,
        frameId: 0,
        documentId: 'doc-1',
        url: 'https://example.com',
        timeStamp: 110,
      });
      chrome.webNavigation.onCompleted.dispatch({
        tabId,
        frameId: 0,
        documentId: 'doc-1',
        timeStamp: 120,
      });
      chrome.tabs.onRemoved.dispatch(tabId, {});
      expect(listener).to.have.been.calledWith(match({ tabId }));
    });
  });

  context('getPageForRequest', function () {
    it('returns null when neither documentId nor tabId resolves', async function () {
      const store = new PageStore({});
      await store.init();
      expect(store.getPageForRequest({ tabId: -1 })).to.be.null;
      expect(store.getPageForRequest({ tabId: 999 })).to.be.null;
    });

    it('falls back to tabId when documentId is unknown', async function () {
      const store = new PageStore({});
      await store.init();
      const tabId = 1;
      chrome.webNavigation.onBeforeNavigate.dispatch({
        tabId,
        frameId: 0,
        url: 'https://example.com',
        timeStamp: 100,
      });
      // No onCommitted yet: only tab-based lookup works.
      expect(
        store.getPageForRequest({ documentId: 'unknown', tabId }),
      ).to.deep.include({ url: 'https://example.com' });
    });
  });
});
