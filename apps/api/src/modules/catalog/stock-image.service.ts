import { Injectable, Logger } from '@nestjs/common';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import type { AiImageCandidate } from '@snappos/contracts';
import { ApiException } from '../../platform/errors/api-exception.js';

/** What counts as a product photo worth keeping. Matches `ProductImagesService`. */
const IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);

/**
 * Well under `ProductImagesService`'s 6MB ceiling, because these are fetched
 * from someone else's server on a person's behalf: a page pointing at a 40MB
 * TIFF should cost this API a few hundred milliseconds, not its memory.
 */
const MAX_BYTES = 8 * 1024 * 1024;

const TIMEOUT_MS = 10_000;

/** A redirect chain longer than this is a loop or a tracker, not a photo. */
const MAX_REDIRECTS = 4;

/** Pretending to be nobody gets a 403 from most retailers' CDNs. */
const USER_AGENT = 'SnapPOS/1.0 (+catalog product image fetch)';

/**
 * Fetches a product photograph from an address the AI found.
 *
 * Everything here exists because the address comes from a model reading the
 * open web, which makes it attacker-influenced input pointed at this server's
 * own network position. `http://169.254.169.254/latest/meta-data/` is a
 * perfectly well-formed image URL as far as a model is concerned, and this API
 * can reach the database, the object store and the metadata service that a
 * browser never could. So: every hop is resolved to its addresses and refused
 * if any of them is private, the chain is followed by hand rather than by
 * `fetch`, and nothing is read that does not arrive as an image.
 *
 * Bytes are returned, never stored. What to keep is the caller's decision --
 * and the resizing stays in the dashboard, where every other product photo is
 * already resized, rather than pulling an image library in here.
 */
@Injectable()
export class StockImageService {
  private readonly logger = new Logger(StockImageService.name);

  /**
   * Turn each candidate into a direct image address where one can be had.
   *
   * A model asked for a direct image address will often give the product page
   * instead, or an address that 404s. Rather than discard those, the page is
   * read for the picture it declares as its own (`og:image`), which is the one
   * a retailer means to represent the product and is usually better than
   * whatever a model would have picked out of the markup.
   *
   * Runs the candidates together: eight flavours resolved one after another
   * would keep a person waiting through eight sequential page loads.
   */
  async resolveAll(candidates: AiImageCandidate[]): Promise<AiImageCandidate[]> {
    return Promise.all(candidates.map((candidate) => this.resolveOne(candidate)));
  }

  private async resolveOne(candidate: AiImageCandidate): Promise<AiImageCandidate> {
    if (candidate.image_url && (await this.looksFetchable(candidate.image_url))) return candidate;
    if (!candidate.page_url) return { ...candidate, image_url: null };

    try {
      const declared = await this.readDeclaredImage(candidate.page_url);
      return { ...candidate, image_url: declared };
    } catch (error) {
      this.logger.debug(`could not read ${candidate.page_url}: ${(error as Error).message}`);
      return { ...candidate, image_url: null };
    }
  }

  /** The bytes, for the endpoint the dashboard downscales from. */
  async fetch(rawUrl: string): Promise<{ buffer: Buffer; contentType: string }> {
    const response = await this.get(rawUrl);
    const contentType = (response.headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase();
    if (!IMAGE_TYPES.has(contentType)) {
      throw new ApiException(
        'validation_failed',
        'That address did not return a JPEG, PNG or WebP image.',
        { retryable: false },
      );
    }

    // Read with a running count rather than trusting content-length, which a
    // server may understate or omit entirely.
    const reader = response.body?.getReader();
    if (!reader) throw ApiException.notFound('image');
    const chunks: Uint8Array[] = [];
    let total = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_BYTES) {
        await reader.cancel();
        throw new ApiException(
          'validation_failed',
          `That image is larger than ${MAX_BYTES / 1024 / 1024}MB.`,
          { retryable: false },
        );
      }
      chunks.push(value);
    }

    return { buffer: Buffer.concat(chunks), contentType };
  }

  /** Whether an address answers as an image, without reading the whole thing. */
  private async looksFetchable(rawUrl: string): Promise<boolean> {
    try {
      const response = await this.get(rawUrl, 'HEAD');
      const contentType = (response.headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase();
      // A server that refuses HEAD but would serve GET is common enough that an
      // empty type is given the benefit of the doubt; a type that is present and
      // is not an image is not.
      return contentType === '' || IMAGE_TYPES.has(contentType);
    } catch {
      return false;
    }
  }

  /**
   * The picture a page declares as its own, from `og:image` or `twitter:image`.
   *
   * Only those two, deliberately. Scraping `<img>` tags out of a retail page
   * returns the site's logo, a payment badge or a "customers also bought"
   * thumbnail far more often than the product, and a wrong photo on a till is
   * worse than an empty tile.
   */
  private async readDeclaredImage(pageUrl: string): Promise<string | null> {
    const response = await this.get(pageUrl);
    const contentType = (response.headers.get('content-type') ?? '').toLowerCase();
    if (!contentType.includes('text/html')) return null;

    // Only the head, where these tags live. A product page carrying a hundred
    // reviews is not worth reading to the end.
    const html = (await this.readCapped(response, 256 * 1024)).split(/<\/head>/i)[0] ?? '';

    for (const property of ['og:image:secure_url', 'og:image', 'twitter:image']) {
      const found = matchMetaContent(html, property);
      if (!found) continue;
      try {
        const absolute = new URL(found, pageUrl);
        if (absolute.protocol !== 'http:' && absolute.protocol !== 'https:') continue;
        if (await this.looksFetchable(absolute.toString())) return absolute.toString();
      } catch {
        continue;
      }
    }
    return null;
  }

  private async readCapped(response: Response, max: number): Promise<string> {
    const reader = response.body?.getReader();
    if (!reader) return '';
    const decoder = new TextDecoder();
    let text = '';
    while (text.length < max) {
      const { done, value } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
    }
    await reader.cancel().catch(() => undefined);
    return text;
  }

  /**
   * A request that will not be turned against this server's own network.
   *
   * Redirects are followed by hand, with every hop checked the same way as the
   * first, because `redirect: 'follow'` would let a public address bounce
   * straight to `127.0.0.1` with nothing to inspect. There is a gap between
   * checking a name's addresses and connecting to one -- DNS can change in
   * between -- which closing properly needs a custom socket-level agent; what
   * this does close is the whole class of attacks that just names an internal
   * host, which is the realistic one for addresses a model read off a web page.
   */
  private async get(rawUrl: string, method: 'GET' | 'HEAD' = 'GET'): Promise<Response> {
    let url = new URL(rawUrl);
    for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
      if (url.protocol !== 'http:' && url.protocol !== 'https:') {
        throw new ApiException('validation_failed', 'Only http and https addresses can be fetched.', {
          retryable: false,
        });
      }
      await this.assertPublic(url.hostname);

      const response = await globalThis.fetch(url, {
        method,
        redirect: 'manual',
        signal: AbortSignal.timeout(TIMEOUT_MS),
        headers: { 'user-agent': USER_AGENT, accept: 'image/*,text/html;q=0.8,*/*;q=0.5' },
      });

      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get('location');
        await response.body?.cancel().catch(() => undefined);
        if (!location) throw ApiException.notFound('image');
        url = new URL(location, url);
        continue;
      }

      if (!response.ok) {
        await response.body?.cancel().catch(() => undefined);
        throw new ApiException(
          'validation_failed',
          `That address answered ${response.status}.`,
          { retryable: response.status >= 500 },
        );
      }
      return response;
    }
    throw new ApiException('validation_failed', 'That address redirects too many times.', {
      retryable: false,
    });
  }

  /** Refuses a host that resolves anywhere inside this network. */
  private async assertPublic(hostname: string): Promise<void> {
    const addresses = isIP(hostname)
      ? [hostname]
      : (await lookup(hostname, { all: true }).catch(() => [])).map((entry) => entry.address);

    if (addresses.length === 0) {
      throw new ApiException('validation_failed', 'That address could not be resolved.', {
        retryable: false,
      });
    }
    // Every address, not the first: a name answering with one public and one
    // private address would otherwise be reachable on whichever the stack picks.
    for (const address of addresses) {
      if (isPrivateAddress(address)) {
        this.logger.warn(`refused a stock image fetch: ${hostname} resolves to ${address}`);
        throw new ApiException(
          'validation_failed',
          'That address points inside a private network and was not fetched.',
          { retryable: false },
        );
      }
    }
  }
}

/** `<meta property="og:image" content="...">`, either attribute order, either quote. */
export function matchMetaContent(html: string, property: string): string | null {
  const name = property.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const patterns = [
    new RegExp(`<meta[^>]+(?:property|name)=["']${name}["'][^>]+content=["']([^"']+)["']`, 'i'),
    new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["']${name}["']`, 'i'),
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(html);
    if (match?.[1]) return decodeHtmlEntities(match[1].trim());
  }
  return null;
}

/** Only the five that matter in an attribute value; this is a URL, not prose. */
function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

/**
 * Whether an address is one this server should refuse to fetch from.
 *
 * Loopback, link-local (which is where cloud metadata services live), the
 * private IPv4 ranges, carrier-grade NAT, IPv6 unique-local and mapped IPv4.
 */
export function isPrivateAddress(address: string): boolean {
  const version = isIP(address);
  if (version === 4) return isPrivateV4(address);
  if (version !== 6) return true;

  const lower = address.toLowerCase().replace(/^\[|\]$/g, '');
  if (lower === '::' || lower === '::1') return true;
  // ::ffff:10.0.0.1 and friends -- an IPv4 address wearing an IPv6 shape.
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(lower);
  if (mapped) return isPrivateV4(mapped[1]!);
  const head = parseInt(lower.split(':')[0] || '0', 16);
  if ((head & 0xfe00) === 0xfc00) return true; // fc00::/7, unique-local
  if ((head & 0xffc0) === 0xfe80) return true; // fe80::/10, link-local
  return false;
}

function isPrivateV4(address: string): boolean {
  const parts = address.split('.').map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true;
  const [a, b] = parts as [number, number, number, number];
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 169 && b === 254) return true; // link-local, incl. cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true; // carrier-grade NAT
  if (a >= 224) return true; // multicast and reserved
  return false;
}
