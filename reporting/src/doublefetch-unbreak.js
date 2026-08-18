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

import logger from './logger';
import { findPlaceholders } from './http';

/**
 * Double-fetch loads a page as anonymously as possible: no credentials, no
 * cookies. As sites block more aggressively, that stops working everywhere -
 * behind AWS WAF, a request without the "aws-waf-token" it hands out is
 * answered with a challenge rather than with the page.
 *
 * Hence this allowlist: cookies that are not privacy-sensitive and can
 * therefore be included in an otherwise anonymous double-fetch.
 */
const UNBREAKING_COOKIES = [
  '__cf_bm',
  '__cfduid',
  '__Secure-ENID',
  '_cfuvid',
  'AEC',
  'aws-waf-token',
  'cf_clearance',
  'GOOGLE_ABUSE_EXEMPTION',
  'NID',
];

/**
 * Finds the cookies that the given double-fetch configuration is allowed to
 * borrow from the user: on the unbreaking list, asked for by the configuration,
 * and scoped to the URL that is about to be fetched.
 *
 * The lookup passes no "storeId", so it sees only the cookie store of the
 * extension's own background context, which is the user's normal profile.
 * Private windows and Firefox containers are separate stores, so their cookies
 * are never even visible here - they are excluded by not asking for them,
 * rather than by filtering them out afterwards.
 *
 * Returns the "safecookie" argument for "anonymousHttpGet", keyed by cookie
 * name.
 */
export async function findSafeCookies(url, params) {
  const requested = requestedCookies(params);
  if (requested.size === 0 || !chrome?.cookies?.getAll) {
    return new Map();
  }

  const found = new Map();
  await Promise.all(
    [...requested].map(async (name) => {
      try {
        // The first match is the most specific one, i.e. the one that the
        // browser itself would send first.
        const cookies = await chrome.cookies.getAll({ url, name });
        const value = cookies?.[0]?.value;
        if (value) {
          found.set(name, value);
        }
      } catch (e) {
        logger.warn('Unable to look up cookie:', name, e);
      }
    }),
  );
  return found;
}

function requestedCookies(params, requested = new Set()) {
  const headers = [
    params?.headers,
    ...(params?.steps || []).map((x) => x.headers),
  ];
  for (const template of headers.flatMap((x) => Object.values(x || {}))) {
    for (const expression of findPlaceholders(template)) {
      for (const placeholder of expression.split('||')) {
        if (placeholder.startsWith('safecookie:')) {
          const name = placeholder.slice('safecookie:'.length);
          if (UNBREAKING_COOKIES.includes(name)) {
            requested.add(name);
          } else {
            logger.warn('Ignoring', placeholder, '(not an unbreaking cookie)');
          }
        }
      }
    }
  }
  if (params?.onError) {
    requestedCookies(params.onError, requested);
  }
  return requested;
}
