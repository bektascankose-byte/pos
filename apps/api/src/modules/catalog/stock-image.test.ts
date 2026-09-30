import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { isPrivateAddress, matchMetaContent } from './stock-image.service.js';

/**
 * The addresses a product-photo fetch must refuse.
 *
 * This is the guard between "a model read an address off a web page" and "this
 * API makes a request from inside the network", so it is worth pinning by
 * example rather than by reading the ranges back.
 */
describe('stock image address guard', () => {
  it('refuses loopback', () => {
    for (const address of ['127.0.0.1', '127.1.2.3', '::1']) {
      assert.equal(isPrivateAddress(address), true, address);
    }
  });

  it('refuses the cloud metadata address', () => {
    assert.equal(isPrivateAddress('169.254.169.254'), true);
  });

  it('refuses the private IPv4 ranges', () => {
    for (const address of ['10.0.0.1', '172.16.0.1', '172.31.255.255', '192.168.1.177', '100.64.0.1']) {
      assert.equal(isPrivateAddress(address), true, address);
    }
  });

  it('allows a public address either side of a private range', () => {
    for (const address of ['172.15.0.1', '172.32.0.1', '192.167.1.1', '8.8.8.8', '104.18.32.7']) {
      assert.equal(isPrivateAddress(address), false, address);
    }
  });

  it('refuses IPv6 unique-local and link-local', () => {
    for (const address of ['fc00::1', 'fd12:3456::1', 'fe80::1', '[fe80::1]']) {
      assert.equal(isPrivateAddress(address), true, address);
    }
  });

  it('allows public IPv6', () => {
    assert.equal(isPrivateAddress('2606:4700:4700::1111'), false);
  });

  /** An IPv4 address wearing an IPv6 shape is the classic way past a v4-only check. */
  it('sees through an IPv4-mapped IPv6 address', () => {
    assert.equal(isPrivateAddress('::ffff:127.0.0.1'), true);
    assert.equal(isPrivateAddress('::ffff:169.254.169.254'), true);
    assert.equal(isPrivateAddress('::ffff:8.8.8.8'), false);
  });

  /** Anything unparseable is refused rather than allowed: this guard fails closed. */
  it('refuses what it cannot parse', () => {
    for (const address of ['', 'localhost', 'not-an-address', '10.0.0', '999.1.1.1', '0.0.0.0']) {
      assert.equal(isPrivateAddress(address), true, address);
    }
  });

  it('refuses multicast and broadcast', () => {
    for (const address of ['224.0.0.1', '239.255.255.250', '255.255.255.255']) {
      assert.equal(isPrivateAddress(address), true, address);
    }
  });
});

describe('the picture a page declares as its own', () => {
  it('reads og:image in either attribute order', () => {
    assert.equal(
      matchMetaContent('<meta property="og:image" content="https://x.test/a.jpg">', 'og:image'),
      'https://x.test/a.jpg',
    );
    assert.equal(
      matchMetaContent('<meta content="https://x.test/b.jpg" property="og:image">', 'og:image'),
      'https://x.test/b.jpg',
    );
  });

  it('accepts single quotes and the name= spelling twitter uses', () => {
    assert.equal(
      matchMetaContent("<meta name='twitter:image' content='https://x.test/c.png'>", 'twitter:image'),
      'https://x.test/c.png',
    );
  });

  /** A query string in an image URL arrives HTML-escaped and must come back usable. */
  it('unescapes the ampersands in a CDN address', () => {
    assert.equal(
      matchMetaContent('<meta property="og:image" content="https://cdn.test/i?w=800&amp;h=600">', 'og:image'),
      'https://cdn.test/i?w=800&h=600',
    );
  });

  /**
   * The failure that matters: og:image and og:image:secure_url sit next to each
   * other, and a loose pattern for the shorter name matches the longer tag. A
   * page's picture is not something to get from the wrong tag.
   */
  it('does not let og:image match og:image:secure_url', () => {
    const html =
      '<meta property="og:image:secure_url" content="https://x.test/secure.jpg">' +
      '<meta property="og:image" content="https://x.test/plain.jpg">';
    assert.equal(matchMetaContent(html, 'og:image'), 'https://x.test/plain.jpg');
    assert.equal(matchMetaContent(html, 'og:image:secure_url'), 'https://x.test/secure.jpg');
  });

  it('is null when the page declares nothing', () => {
    assert.equal(matchMetaContent('<meta name="description" content="a shop">', 'og:image'), null);
    assert.equal(matchMetaContent('', 'og:image'), null);
  });
});
