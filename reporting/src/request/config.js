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

import logger from '../logger.js';

const RETRY_TIMEOUT = 30 * 1000;

export const VERSION = '0.103';

export const COOKIE_MODE = {
  THIRD_PARTY: 'thirdparty',
  TRACKERS: 'trackers',
};

const DEFAULTS = {
  safekeyValuesThreshold: 4,
  shortTokenLength: 6,
  placeHolder: 'ghostery',
  cliqzHeader: 'Ghostery-AntiTracking',
  cookieEnabled: true,
  qsEnabled: true,
  sendAntiTrackingHeader: true,
  // tpDomainDepth: 2,
  cookieMode: COOKIE_MODE.THIRD_PARTY,
};

/**
 * These are attributes which are loaded from the remote CONFIG_URL
 * @type {Array}
 */
const REMOTELY_CONFIGURED = ['cookieWhitelist', 'compatibilityList'];

export default class Config {
  constructor(
    { defaults = DEFAULTS, configUrl, remoteWhitelistUrl, localWhitelistUrl },
    { db, trustedClock },
  ) {
    this.db = db;
    this.trustedClock = trustedClock;
    this.debugMode = false;

    if (!configUrl) {
      throw new Error('Config requires configUrl');
    }
    this.configUrl = configUrl;

    if (!remoteWhitelistUrl) {
      throw new Error('Config requires remoteWhitelistUrl');
    }
    this.remoteWhitelistUrl = remoteWhitelistUrl;

    if (!localWhitelistUrl) {
      throw new Error('Config requires localWhitelistUrl');
    }
    this.localWhitelistUrl = localWhitelistUrl;

    this.tokenDomainCountThreshold = 2;
    this.safeKeyExpire = 7;

    Object.assign(this, defaults);
  }

  async init() {
    await this._loadConfig();
  }

  unload() {
    clearTimeout(this._retryTimeout);
    this._retryTimeout = null;
  }

  async _loadConfig() {
    await this.db.ready;
    const lastUpdate = (await this.db.get('config')) || {};
    const day = this.trustedClock.getTimeAsYYYYMMDD();
    // use stored config if it was already updated today
    if (lastUpdate['config'] && lastUpdate['lastUpdate'] === day) {
      this._updateConfig(lastUpdate['config']);
      return;
    }
    try {
      const response = await fetch(this.configUrl);
      if (!response.ok) {
        throw new Error(response.text());
      }
      const conf = await response.json();
      this._updateConfig(conf);
      await this.db.set('config', {
        lastUpdate: day,
        config: conf,
      });
    } catch (e) {
      logger.error('could not load request config', e);
      this._retryTimeout = setTimeout(
        this._loadConfig.bind(this),
        RETRY_TIMEOUT,
      );
    }
  }

  _updateConfig(conf) {
    REMOTELY_CONFIGURED.forEach((key) => {
      this[key] = conf[key];
    });
  }
}
