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

import { expect } from 'chai';
import SearchExtractor from '../src/search-extractor.js';
import {
  allSupportedParsers,
  mockDocumentWith,
} from './helpers/dom-parsers.js';
import { lookupBuiltinTransform } from '../src/patterns.js';

const EMPTY_HTML_PAGE = `
<!DOCTYPE HTML PUBLIC "-//W3C//DTD HTML 4.01 Transitional//EN" "http://www.w3.org/TR/html4/loose.dtd">
<html lang="en">
  <head>
    <meta http-equiv="content-type" content="text/html; charset=utf-8">
    <title>Test page</title>
  </head>
  <body>
  </body>
</html>`;

async function fetchJson(url) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Unable to reach endpoint: ${url}: ${response.statusText}`);
  }
  return response.json();
}

async function fetchText(url) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Unable to reach endpoint: ${url}: ${response.statusText}`);
  }
  return response.text();
}

async function loadTestFixtures(url) {
  const { links } = await fetchJson(url);
  expect(links).to.be.an('object');

  const expectedOrigin = new URL(url).origin;
  return Promise.all(
    Object.entries(links).map(async ([name, fixtureUrl]) => {
      expect(new URL(fixtureUrl).origin).to.eql(expectedOrigin);
      const { scenario, html: htmlUrl } = await fetchJson(fixtureUrl);
      expect(new URL(htmlUrl).origin).to.eql(expectedOrigin);
      return {
        name,
        scenario,
        htmlUrl,
      };
    }),
  );
}

describe('#SearchExtractor', function () {
  allSupportedParsers.forEach((htmlParser) => {
    describe(`using ${htmlParser} as HTML parser`, function () {
      function runScenario({
        url,
        query,
        category,
        ctry = '--',
        html,
        patterns,
        mustContain = [],
        mustNotContain = [],
      }) {
        try {
          expect(url, '<url>').to.be.a('string');
          expect(query, '<query>').to.be.a('string');
          expect(category, '<category>').to.be.a('string');
          expect(ctry, '<ctry>').to.be.a('string');
          expect(html, '<html>').to.be.a('string');
          expect(patterns, '<patterns>').to.be.an('object');
          expect(mustContain, '<mustContain>').to.be.an('array');
          expect(mustNotContain, '<mustNotContain>').to.be.an('array');
        } catch (e) {
          e.message = `Broken scenario detected (${e.message})`;
          throw e;
        }

        const extractor = new SearchExtractor({
          patterns: {
            getRulesSnapshot() {
              return patterns;
            },
          },
          sanitizer: {
            getSafeCountryCode() {
              return ctry;
            },
          },
          persistedHashes: {},
          jobScheduler: {
            registerHandler() {},
          },
        });
        const { window: mockWindow, document: doc } =
          mockDocumentWith[htmlParser](html);
        let results;
        try {
          results = extractor.extractMessages({
            doc,
            query,
            category,
            doublefetchRequest: {
              url,
            },
          });
        } finally {
          try {
            mockWindow?.close();
          } catch (e) {
            // ignore
          }
        }

        const messages = {};
        results.forEach((msg) => {
          messages[msg.body.action] = [];
        });
        results.forEach((msg) => {
          messages[msg.body.action].push(msg.body);
        });

        try {
          for (const check of mustContain) {
            if (!messages[check.action]) {
              throw new Error(`Missing message with action=${check.action}`);
            }
            expect(messages[check.action].length === 1);
            const realPayload = messages[check.action][0].payload;
            expect(
              realPayload,
              `found mismatch in ${check.action}`,
            ).to.deep.equal(check.payload);
          }

          for (const check of mustNotContain) {
            const unexpectedMatch = new RegExp(
              `^${check.action.replaceAll('.', '[.]').replaceAll('*', '.*')}$`,
            );
            const matches = Object.keys(messages).filter((x) =>
              unexpectedMatch.test(x),
            );
            if (matches.length > 0) {
              throw new Error(
                `Expected no messages with action '${check.action}' ` +
                  `but got messages for the following actions: [${matches}]`,
              );
            }
          }
        } catch (e) {
          e.results = results;
          throw e;
        }
      }

      it('should not throw on an empty page with empty patterns', function () {
        runScenario({
          url: 'http://example.test/x?q=foo',
          query: 'foo',
          category: 'test-action',
          html: EMPTY_HTML_PAGE,
          patterns: {},
          mustNotContain: [{ action: '*' }],
        });
      });

      it('should extract some dummy test', function () {
        runScenario({
          url: 'http://example.test/x?q=some-query',
          query: 'some-query',
          category: 'example-test',
          ctry: 'de',
          html: `
<!DOCTYPE html>
<html>
  <head>
    <meta http-equiv="content-type" content="text/html; charset=utf-8">
    <title>Test page</title>
  </head>
  <body>
    <div id="foo" bar="Some text to extract"></div>
  </body>
</html>`,
          patterns: {
            'example-test': {
              input: {
                'html body': {
                  first: {
                    textFromDiv: {
                      select: 'div#foo',
                      attr: 'bar',
                    },
                  },
                },
              },
              output: {
                'test-action': {
                  fields: [
                    {
                      key: 'textFromDiv',
                      source: 'html body',
                    },
                    { key: 'q' },
                    { key: 'qurl' },
                    { key: 'ctry' },
                  ],
                },
              },
            },
          },
          mustContain: [
            {
              action: 'test-action',
              payload: {
                textFromDiv: 'Some text to extract',
                q: 'some-query',
                qurl: 'http://example.test/x?q=some-query',
                ctry: 'de',
              },
            },
          ],
        });
      });

      it('should not double-encode links', function () {
        // Note: this URL has an encoded Umlaut. Depending on the DOMParser and
        // the mechanism to extract the URL (elem.href vs elem.getAttribute('href'),
        // it could lead to unintended double-encoding.
        const abslink =
          'https://www.mediamarkt.at/de/product/_krups-espresso-siebtr%C3%A4germaschine-xp442c-silber-schwarz-1824085.html';

        runScenario({
          url: 'http://example.test/x?q=some-query',
          query: 'some-query',
          category: 'example-test',
          ctry: 'de',
          html: `
<!DOCTYPE html>
<html>
  <head>
    <meta http-equiv="content-type" content="text/html; charset=utf-8">
    <title>Test page</title>
  </head>
  <body>
    <a id="abslink" href="${abslink}"></a>
  </body>
</html>`,
          patterns: {
            'example-test': {
              input: {
                'html body': {
                  first: {
                    abslink: {
                      select: '#abslink',
                      attr: 'href',
                    },
                  },
                },
              },
              output: {
                'test-action': {
                  fields: [
                    {
                      key: 'abslink',
                      source: 'html body',
                    },
                  ],
                },
              },
            },
          },
          mustContain: [
            {
              action: 'test-action',
              payload: {
                abslink,
              },
            },
          ],
        });
      });

      it('should resolve relative links based to the real URL, not extension ID', function () {
        runScenario({
          url: 'http://example.test/x?q=some-query',
          query: 'some-query',
          category: 'example-test',
          ctry: 'de',
          html: `
<!DOCTYPE html>
<html>
  <head>
    <meta http-equiv="content-type" content="text/html; charset=utf-8">
    <title>Test page</title>
  </head>
  <body>
    <a id="rellink" href="/foo?bar=42"></a>
  </body>
</html>`,
          patterns: {
            'example-test': {
              input: {
                'html body': {
                  first: {
                    rellink: {
                      select: '#rellink',
                      attr: 'href',
                    },
                  },
                },
              },
              output: {
                'test-action': {
                  fields: [
                    {
                      key: 'rellink',
                      source: 'html body',
                    },
                  ],
                },
              },
            },
          },
          mustContain: [
            {
              action: 'test-action',
              payload: {
                rellink: 'http://example.test/foo?bar=42',
              },
            },
          ],
        });
      });

      it('should fail with a permanent error if a primitive is not supported', function () {
        const nonExistingPrimitive = 'thisBuiltinDoesNotExist';
        expect(() => lookupBuiltinTransform(nonExistingPrimitive)).to.throw();

        expect(() => {
          runScenario({
            url: 'http://example.test/x?q=some-query',
            query: 'some-query',
            category: 'example-test',
            ctry: 'de',
            html: `
  <!DOCTYPE HTML PUBLIC "-//W3C//DTD HTML 4.01 Transitional//EN" "http://www.w3.org/TR/html4/loose.dtd">
  <html lang="en">
  <head>
    <meta http-equiv="content-type" content="text/html; charset=utf-8">
    <title>Test page</title>
  </head>
  <body>
    <div>Some text</div>
  </body>
  </html>`,
            patterns: {
              'example-test': {
                input: {
                  'html > body > div': {
                    first: {
                      title: {
                        attr: 'textContent',
                        transform: [[nonExistingPrimitive]],
                      },
                    },
                  },
                },
                output: {
                  'test-action': {
                    fields: [
                      {
                        key: 'extractedText',
                        source: 'html > body > div',
                      },
                    ],
                  },
                },
              },
            },
            mustNotContain: [{ action: '*' }],
          });
        })
          .to.throw()
          .with.property('isPermanentError');
      });

      it('should omit messages that are marked as being redundant', function () {
        runScenario({
          url: 'http://example.test/x?q=some-query',
          query: 'some-query',
          category: 'example-test',
          ctry: 'de',
          html: `
<!DOCTYPE html>
<html>
  <head>
    <meta http-equiv="content-type" content="text/html; charset=utf-8">
    <title>Test page</title>
    <
  </head>
  <body>
    <a id="rellink" href="/foo?bar=42"></a>
  </body>
</html>`,
          patterns: {
            'example-test': {
              input: {
                'html body': {
                  first: {
                    rellink: {
                      select: '#rellink',
                      attr: 'href',
                    },
                  },
                },
              },
              output: {
                'test-action': {
                  fields: [
                    {
                      key: 'rellink',
                      source: 'html body',
                    },
                  ],
                },
                'redundant-test-action': {
                  fields: [
                    {
                      key: 'rellink',
                      source: 'html body',
                    },
                  ],
                  omitIfExistsAny: ['test-action'], // exists, so it should be omitted
                },
                'non-redundant-test-action': {
                  fields: [
                    {
                      key: 'rellink',
                      source: 'html body',
                    },
                  ],
                  omitIfExistsAny: ['some-message-that-does-not-exist'],
                },
              },
            },
          },
          mustContain: [
            {
              action: 'test-action',
              payload: {
                rellink: 'http://example.test/foo?bar=42',
              },
            },
            {
              action: 'non-redundant-test-action',
              payload: {
                rellink: 'http://example.test/foo?bar=42',
              },
            },
          ],
          mustNotContain: [{ action: 'redundant-test-action' }],
        });
      });

      describe('during preprocessing', function () {
        it('should support removing an inner div', function () {
          runScenario({
            url: 'http://example.test/x?q=some-query',
            query: 'some-query',
            category: 'example-test',
            ctry: 'de',
            html: `
  <!DOCTYPE HTML PUBLIC "-//W3C//DTD HTML 4.01 Transitional//EN" "http://www.w3.org/TR/html4/loose.dtd">
  <html lang="en">
  <head>
    <meta http-equiv="content-type" content="text/html; charset=utf-8">
    <title>Test page</title>
  </head>
  <body>
    <div>It does <div>NOT</div>work</div>
  </body>
  </html>`,
            patterns: {
              'example-test': {
                preprocess: {
                  prune: [{ first: 'div > div' }],
                },
                input: {
                  'html > body > div': {
                    first: {
                      extractedText: {
                        attr: 'textContent',
                      },
                    },
                  },
                },
                output: {
                  'test-action': {
                    fields: [
                      {
                        key: 'extractedText',
                        source: 'html > body > div',
                      },
                    ],
                  },
                },
              },
            },
            mustContain: [
              {
                action: 'test-action',
                payload: {
                  extractedText: 'It does work',
                },
              },
            ],
          });
        });

        it('should support support removing one or many elements (complex scenario)', function () {
          runScenario({
            url: 'http://example.test/x?q=some-query',
            query: 'some-query',
            category: 'example-test',
            ctry: 'de',
            html: `
  <!DOCTYPE HTML PUBLIC "-//W3C//DTD HTML 4.01 Transitional//EN" "http://www.w3.org/TR/html4/loose.dtd">
  <html lang="en">
  <head>
    <meta http-equiv="content-type" content="text/html; charset=utf-8">
    <title>Test page</title>
  </head>
  <body>
    <p>Remove the X's: only the first p, but all divs</p>
    <div>1<p id="remove-me">X</p>2<p id="but-keep-me">3</p>4<div>X</div><div>X</div>5<div>X</div>6</div>
  </body>
  </html>`,
            patterns: {
              'example-test': {
                preprocess: {
                  prune: [{ first: 'div > p' }, { all: 'div > div' }],
                },
                input: {
                  'html > body > div': {
                    first: {
                      extractedText: {
                        attr: 'textContent',
                      },
                    },
                  },
                },
                output: {
                  'test-action': {
                    fields: [
                      {
                        key: 'extractedText',
                        source: 'html > body > div',
                      },
                    ],
                  },
                },
              },
            },
            mustContain: [
              {
                action: 'test-action',
                payload: {
                  extractedText: '123456',
                },
              },
            ],
          });
        });
      });

      // This are optional tests that can be enabled if the TEST_FIXTURES_URL
      // environment variable is defined. Karma lacks access to the filesystem,
      // but we can fetch fixtures over the network.
      //
      // eslint-disable-next-line no-undef
      const testFixturesUrl = __karma__.config.TEST_FIXTURES_URL;
      if (testFixturesUrl) {
        it('passes remote tests', async function () {
          this.timeout(10000000);
          const maxRequests = 3;
          const fixtures = await loadTestFixtures(testFixturesUrl);
          const fixtures2 = [...fixtures];
          const prefetchHtml = () => {
            const next = fixtures2.shift();
            if (next) {
              next.pendingHtml = fetchText(next.htmlUrl);
            }
          };
          for (let i = 0; i < maxRequests - 1; i += 1) {
            prefetchHtml();
          }
          let testsPassed = [];
          let testsFailed = [];
          try {
            console.log(
              `Running test fixtures: ${fixtures.length} tests found`,
            );
            while (fixtures.length > 0) {
              prefetchHtml();
              const { name, scenario, pendingHtml } = fixtures.shift();
              scenario.html = await pendingHtml;
              try {
                scenario.category = scenario.category || scenario.type; // TODO: remove after migrating tests
                runScenario(scenario);
                testsPassed.push(name);
                console.log(`test ${name}: PASSED`);
              } catch (e) {
                testsFailed.push({ name, error: e });
                e.message = `Test fixture <${name}> failed: ${e}`;
                console.error(e);
                if (e.results) {
                  console.log(`These were the extracted messages:\n
----------------------------------------------------------------------
${JSON.stringify(e.results, null, 2)}
----------------------------------------------------------------------
`);
                }
              }
            }
            if (testsFailed.length > 0) {
              throw testsFailed[0].error;
            }
          } finally {
            const passed = testsPassed.length;
            const failed = testsFailed.length;
            const total = testsPassed.length + testsFailed.length;
            if (total > 0) {
              const ratio = ((100 * passed) / total).toFixed(2);
              console.log(
                `
****************** remote test results *************
${total} tests run: ${passed} passed, ${failed} failed (${ratio}% passed)
****************************************************
`,
              );
              if (failed > 0) {
                console.warn(
                  `The following tests failed:\n${testsFailed
                    .map((x) => `* ${x.error}`)
                    .join('\n')}\n\n`,
                );
              }
            }
          }
        });
      }
    });
  });
});
