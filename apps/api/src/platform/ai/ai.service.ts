import { Injectable, Logger } from '@nestjs/common';
import OpenAI from 'openai';
import { zodTextFormat } from 'openai/helpers/zod';
import {
  aiExtractedInvoiceSchema,
  aiMatchPredictionsSchema,
  aiComplianceSuggestionSchema,
  aiVendorSuggestionSchema,
  aiColumnMappingSchema,
  type AiExtractedInvoice,
  type AiLineMatchPrediction,
  type AiMatchLineInput,
  type AiComplianceSuggestion,
  type AiVendorSuggestion,
  type AiColumnGuess,
} from '@snappos/contracts';
import { z } from 'zod';
import { ApiException } from '../errors/api-exception.js';

/** Exported so callers with the raw text in hand (see `InvoicingService.parseWithAi`) can tell ahead of time whether this same limit is about to silently drop the tail of a document. */
export const MAX_DOCUMENT_CHARS = 20_000;

/** How much of a document `extractVendor` reads. Letterhead, not line items -- see that method. */
const VENDOR_HEADER_CHARS = 6_000;

const EXTRACTION_INSTRUCTIONS = `You are extracting line items from a vendor invoice for a retail point-of-sale system. The text below was pulled from a PDF or an EDI/plain-text document and may have irregular spacing, broken lines, or raw EDI segment codes and delimiters (such as *, ~, or |) instead of natural prose -- in either case, find the actual billed line items it describes.

Return every distinct billed line item as its own entry, with:
- raw_text: the original line text for this item, as close to verbatim as you can reconstruct it
- barcode: the product's own barcode for this line -- a UPC, EAN or GTIN, 8 to 14 digits with no letters. It may be under a column headed Barcode, UPC, UPC-A, EAN, GTIN or Scan Code, but PDF text extraction often loses the column headers or glues this value onto the end of the previous column, so also treat a bare 12-or-13-digit number sitting at the end of a line as the barcode. Do not put a price, quantity, invoice number or date here, and do not pad or reformat the digits -- copy them exactly. Null if the line genuinely has none.
- vendor_sku: the vendor's own item code/SKU for this line, if shown, else null. This is the vendor's internal code, usually short and often containing letters or dashes -- it is NOT the barcode. If the only code on the line is a long run of digits, that is the barcode, not the vendor SKU.
- description: the item's name/description as the invoice states it, else null
- quantity: the number of units/cases invoiced for this line, as a plain number, else null
- unit_cost: the per-unit cost for this line (not the extended/line-total price), as a plain number with no currency symbol or thousands separator, else null

Do not return invoice-level rows like subtotals, tax, shipping, or the grand total as line items.

Then, for the invoice as a whole, return whatever of these the document actually prints, as plain numbers with no currency symbol or thousands separator:
- vendor_invoice_no: the vendor's own invoice number
- invoice_total: the grand total for the whole invoice (often labelled "Invoice Total", "Total Due", "Total")
- amount_paid: how much has already been paid against this invoice ("Total Paid", "Amount Paid", "Payments", "Less Payments"). If the document lists individual payments but no total, add them up. Null if it shows nothing about payment.
- shipping_cost: freight/delivery/shipping charged on this invoice
- discount: any invoice-level discount
- payment_method: how it was or is to be paid, copied roughly as printed ("Credit Note on Account", "ACH", "Visa ending 4412"), else null
- payment_terms: the stated terms ("Net 30", "Due on receipt"), else null
- invoice_date: the date the vendor put on the invoice, as YYYY-MM-DD
- due_date: the payment due date, as YYYY-MM-DD

Dates must be YYYY-MM-DD with a four-digit year -- "10 Sep 2026" is "2026-09-10". If a date is ambiguous or you cannot tell the year, return null rather than guessing one. Use null for anything not actually present, and never compute a figure the document does not print: if it shows a total and a paid amount but no outstanding balance, return the two it shows and nothing else.`;

const MATCHING_INSTRUCTIONS = `You are matching vendor invoice line items against an existing product catalog for a retail point-of-sale system, and suggesting catalog metadata when the invoice implies it.

For each line you are given its raw text, parsed description/SKU/quantity/unit cost, and a short list of catalog candidates (each with an index, product name, variant name, brand, category, and that candidate's own unit cost/case quantity/pack quantity) drawn from a fuzzy text search -- not the full catalog. When two candidates read almost identically in name but differ in case/pack quantity (a single can vs. a 12-pack of the same product), use the line's own quantity and unit cost as a tiebreaker: the vendor's unit cost should land close to whichever candidate's own unit cost times its pack size actually matches, not just whichever name reads closer. For every line, return:
- line_index: copy the line's own index back unchanged
- matched_candidate_index: the index of the ONE candidate that is clearly this exact sellable item (same product AND same variant/flavor/size), or null if none of the candidates is clearly correct
- confidence: your confidence in that match from 0 to 1 (0 if matched_candidate_index is null)
- suggested_brand / suggested_category: your best guess at this item's brand and category -- prefer an exact name from the brands/categories lists you were given when one clearly applies, otherwise your own best short guess, otherwise null if you genuinely can't tell. A vendor invoice very often has no separate brand column at all: the brand is usually simply the first word or two of the line's own description (e.g. "SHERPA THC SELTZER 100MG SODA" is the brand "Sherpa", "LIQUID LAVA INFUSED BEVERAGE" is the brand "Liquid Lava"). Look for that pattern before deciding you can't tell.
- suggested_product_description: a short, clean, human-readable product name/description for this item, else null
- is_ambiguous_multi_item: true when the line's OWN TEXT implies it actually bundles more than one distinct sellable variant under a single line -- for example "Assorted Flavors", "Mixed Case", or a list of several flavors/colors/sizes for what is billed as one line. This means a human needs to split this line into separate variants (a different situation than simply being unsure which single candidate is right), and it can be true even when matched_candidate_index is null for that same reason.

Never invent an index outside the candidates given for that specific line. When nothing in the candidate list is right, set matched_candidate_index to null rather than picking the closest wrong one.`;

const CLASSIFICATION_INSTRUCTIONS = `You are deciding whether a retail product is age-restricted for a point-of-sale system in the United States, from its name, brand, category and description.

Return:
- is_age_restricted: true if the law requires checking a buyer's age before this can be sold
- minimum_age: the statutory age for this item (usually 21 for vape/ENDS, tobacco, and THC/cannabinoid products in most US states; null if not age-restricted)
- id_scan_required: true when an ID should be scanned rather than judged by eye -- true for vape/ENDS, THC/cannabinoid and tobacco by default
- regulated_class: a short label such as "ends" (vapes/disposables/e-liquid), "tobacco" (cigarettes/cigars/pouches/chew), "consumable_hemp" (THC, delta-8/9/10, THCP, CBD with intoxicating cannabinoids), "kratom", or null if not regulated
- contains_nicotine: true for vapes, cigarettes, cigars, pouches, chew
- contains_cannabinoid: true for anything THC/delta-8/delta-9/delta-10/THCP/CBD-with-cannabinoids
- is_smokable: true for anything meant to be smoked or vaped (flower, pre-rolls, disposables, cigars, cigarettes) rather than eaten/applied
- confidence: your confidence from 0 to 1

Concrete cues: "THC", "delta-8", "delta-9", "delta-10", "THCP", "seltzer/soda/gummies... THC/MG" implies an infused drink or edible; "vape", "ENDS", "disposable", "e-liquid", "pod" implies a vape; "cigar", "cigarette", "pouch", "chew", "nicotine" implies tobacco; "kratom" is its own class. An ordinary grocery, snack, drink, or household item with none of these cues is not age-restricted -- set is_age_restricted to false and every other flag to false/null rather than guessing a restriction that isn't there.`;

const VENDOR_INSTRUCTIONS = `You are identifying WHO SENT a vendor invoice to a retail store -- the supplier/distributor the store buys from and owes money to. The text below was pulled from a PDF, a CSV, or an EDI document.

An invoice names at least two businesses: the seller (the vendor, usually on the letterhead at the very top, near "Remit To", "Sold By", or the logo) and the buyer (the store itself, usually under "Bill To", "Ship To", or "Sold To"). Return the SELLER. If you cannot tell which is which, return null for name rather than guessing -- naming the store as its own vendor is worse than saying you don't know.

Return:
- name: the seller's business name as printed, else null
- phone / email / website: the seller's own contact details, else null
- address_line1 / city / region / postal_code: the seller's street address, city, state or province, and ZIP/postal code, else null
- account_number: the store's account number WITH this vendor, if the invoice prints one, else null
- payment_terms: terms as printed, normalized to a short code where obvious ("Net 30" -> "NET30", "Due on receipt" -> "COD"), else null
- confidence: how confident you are in the name specifically, from 0 to 1

Use null for anything not actually present in the text rather than inferring it.`;

const COLUMN_MAPPING_INSTRUCTIONS = `You are matching the columns of a spreadsheet a retail store uploaded against the fields of their point-of-sale system. A first pass already matched every column whose name was recognizable; you are being asked only about the fields it could not place, and offered only the columns nothing has claimed.

You are given: the fields still needing a column (each with a key, a label and a description of what belongs in it), the unclaimed column names, and a few example rows so you can judge a column by what is actually in it rather than only by its name. Example values matter most when a header is unhelpful -- a column named "F4" holding 24.99, 12.50, 8.75 is a price, and one holding 812345678901 is a barcode, whatever it is called.

For each field you were asked about, return:
- field: the field's key, copied back exactly as given
- column: the name of the ONE unclaimed column that holds that field, copied exactly as given, or null if none of them does
- confidence: 0 to 1

Rules. Never name a column that was not in the list you were given. Never use the same column for two different fields -- if two fields could plausibly take one column, give it to the better fit and answer null for the other. A field with no good column is null, not the closest leftover: a wrong mapping writes wrong data into a live catalog, while a null simply leaves that field empty for a human to fill in.`;

const VARIANT_SUGGESTION_INSTRUCTIONS = `You are helping a retail store stock every real flavor/size/color variant of a specific product. Search the web to find the actual, real variants this specific product is sold in -- not generic guesses.

Answer with ONLY a JSON array of short variant name strings (e.g. ["Blueberry", "Watermelon Ice", "Mango"]) and nothing else -- no prose, no markdown code fences, no explanation. Use the product's own naming (flavor, size, color -- whatever axis it actually varies on). If you can't find reliable information on real variants for this product, answer with an empty array [] rather than guessing generic flavors.`;

/** Loosely -- and defensively -- validates the model's free-text answer to `suggestProductVariants` against the shape the caller actually needs. */
const variantSuggestionListSchema = z.array(z.string());

/**
 * Ways a model says "this field isn't in the document" as a *string* instead
 * of as JSON null. Told to use null for anything absent, models will
 * sometimes write the word rather than the value -- observed in practice as
 * "/null" across every field of a document that had no vendor on it at all.
 * Left unchecked, that placeholder reaches the UI as a vendor named "/null",
 * and a mis-filed vendor is exactly what this whole flow exists to prevent.
 */
const NOTHING_HERE = new Set(['null', '/null', 'n/a', 'na', 'none', 'unknown', 'not found', '-', '--', '?']);

function nullIfPlaceholder(value: string | null): string | null {
  if (value === null) return null;
  const trimmed = value.trim();
  if (!trimmed || NOTHING_HERE.has(trimmed.toLowerCase())) return null;
  return trimmed;
}

/**
 * The only place this API talks to OpenAI. Every method here only ever
 * produces a suggestion -- the caller writes the result to an
 * `ai_suggested_*`/`ai_confidence` column, never straight into the catalog,
 * a price, or a purchase order. A missing key throws `provider_unavailable`
 * rather than silently producing an empty or fabricated result.
 */
@Injectable()
export class AiService {
  private readonly logger = new Logger(AiService.name);
  private client: OpenAI | undefined;

  isConfigured(): boolean {
    return Boolean(process.env.OPENAI_API_KEY && process.env.OPENAI_MODEL);
  }

  private getClient(): { client: OpenAI; model: string } {
    const apiKey = process.env.OPENAI_API_KEY;
    const model = process.env.OPENAI_MODEL;
    if (!apiKey || !model) {
      throw new ApiException(
        'provider_unavailable',
        'AI extraction is not configured on this server -- set OPENAI_API_KEY and OPENAI_MODEL',
        { retryable: false },
      );
    }
    this.client ??= new OpenAI({ apiKey });
    return { client: this.client, model };
  }

  /** Reads free-form document text (a PDF's or EDI file's own text) into the same raw line shape a parsed CSV already produces. */
  async extractInvoiceLines(documentText: string): Promise<AiExtractedInvoice> {
    const { client, model } = this.getClient();
    const response = await client.responses.parse({
      model,
      instructions: EXTRACTION_INSTRUCTIONS,
      input: documentText.slice(0, MAX_DOCUMENT_CHARS),
      text: { format: zodTextFormat(aiExtractedInvoiceSchema, 'extracted_invoice') },
    });
    if (!response.output_parsed) {
      throw new Error('the model returned no parsed output');
    }
    return response.output_parsed;
  }

  /**
   * Who sent this invoice, read off its letterhead. A suggestion only, same
   * rule as everything else here -- `InvoicingService` fuzzy-matches this
   * against the vendors that already exist and shows the result for a person
   * to accept; nothing assigns a vendor or creates one on its own.
   *
   * Reads a much smaller window than `extractInvoiceLines` does, because the
   * two are looking for different things: line items are spread over every
   * page, but who sent the document is at the top of the first one. Feeding
   * twenty pages of line items to this question costs more and reads worse.
   */
  async extractVendor(documentText: string): Promise<AiVendorSuggestion> {
    const { client, model } = this.getClient();
    const response = await client.responses.parse({
      model,
      instructions: VENDOR_INSTRUCTIONS,
      input: documentText.slice(0, VENDOR_HEADER_CHARS),
      text: { format: zodTextFormat(aiVendorSuggestionSchema, 'vendor_suggestion') },
    });
    if (!response.output_parsed) {
      throw new Error('the model returned no parsed output');
    }

    // Every text field goes through the placeholder check, so "nothing here"
    // arrives at the caller as a real null whichever way the model chose to
    // express it. `confidence` is left exactly as given.
    const parsed = response.output_parsed;
    return {
      ...parsed,
      name: nullIfPlaceholder(parsed.name),
      phone: nullIfPlaceholder(parsed.phone),
      email: nullIfPlaceholder(parsed.email),
      website: nullIfPlaceholder(parsed.website),
      address_line1: nullIfPlaceholder(parsed.address_line1),
      city: nullIfPlaceholder(parsed.city),
      region: nullIfPlaceholder(parsed.region),
      postal_code: nullIfPlaceholder(parsed.postal_code),
      account_number: nullIfPlaceholder(parsed.account_number),
      payment_terms: nullIfPlaceholder(parsed.payment_terms),
    };
  }

  /** The matching cascade's last tier -- only ever called for lines the deterministic tiers already failed to place. */
  async predictMatches(input: {
    lines: AiMatchLineInput[];
    brands: string[];
    categories: string[];
  }): Promise<AiLineMatchPrediction[]> {
    if (input.lines.length === 0) return [];
    const { client, model } = this.getClient();
    const response = await client.responses.parse({
      model,
      instructions: MATCHING_INSTRUCTIONS,
      input: JSON.stringify({ brands: input.brands, categories: input.categories, lines: input.lines }),
      text: { format: zodTextFormat(aiMatchPredictionsSchema, 'match_predictions') },
    });
    if (!response.output_parsed) {
      throw new Error('the model returned no parsed output');
    }
    return response.output_parsed.predictions;
  }

  /**
   * Which spreadsheet column holds which field, for the fields a
   * deterministic alias pass could not place.
   *
   * Only the leftovers are asked about, and only the unclaimed columns are
   * offered, so a recognizable header never costs a model call and the model
   * can never take a column something else already owns. Sample rows go with
   * the question because a header is often useless ("F4", "Column7") while
   * the values in it are obvious.
   *
   * A suggestion only. The caller shows the whole mapping for confirmation
   * before a single row is written, and validates every column name here
   * against the real header row -- a model naming a column that doesn't exist
   * would otherwise read as `undefined` on every row of the file.
   */
  async mapColumns(input: {
    entity: string;
    fields: { key: string; label: string; hint: string }[];
    columns: string[];
    sample_rows: Record<string, string>[];
  }): Promise<AiColumnGuess[]> {
    if (input.fields.length === 0 || input.columns.length === 0) return [];
    const { client, model } = this.getClient();
    const response = await client.responses.parse({
      model,
      instructions: COLUMN_MAPPING_INSTRUCTIONS,
      input: JSON.stringify(input),
      text: { format: zodTextFormat(aiColumnMappingSchema, 'column_mapping') },
    });
    if (!response.output_parsed) {
      throw new Error('the model returned no parsed output');
    }
    return response.output_parsed.guesses;
  }

  /**
   * A suggestion only, same rule as every other method here -- the caller
   * shows this on the create-product form for a human to review and edit; it
   * never gets written to `product_compliance` on its own.
   */
  async classifyCompliance(input: {
    name: string;
    brand?: string | null | undefined;
    category?: string | null | undefined;
    description?: string | null | undefined;
  }): Promise<AiComplianceSuggestion> {
    const { client, model } = this.getClient();
    const response = await client.responses.parse({
      model,
      instructions: CLASSIFICATION_INSTRUCTIONS,
      input: JSON.stringify(input),
      text: { format: zodTextFormat(aiComplianceSuggestionSchema, 'compliance_suggestion') },
    });
    if (!response.output_parsed) {
      throw new Error('the model returned no parsed output');
    }
    return response.output_parsed;
  }

  /**
   * A suggestion only, same rule as every other method here -- the caller
   * shows these as a checklist on the create-product form; nothing here
   * creates a variant on its own. Uses the Responses API's hosted web search
   * tool rather than the model's own training data, since a product's real
   * flavor/size lineup changes over time and isn't something to guess from
   * memory. Deliberately does NOT use `.parse()`/`zodTextFormat` like every
   * other method here -- combining a hosted tool with strict Structured
   * Outputs isn't something to assume works, so this reads the model's plain
   * text answer and parses it defensively instead.
   */
  async suggestProductVariants(input: {
    product_name: string;
    brand_name?: string | null | undefined;
  }): Promise<{ variants: string[] }> {
    const { client, model } = this.getClient();
    const response = await client.responses.create({
      model,
      instructions: VARIANT_SUGGESTION_INSTRUCTIONS,
      tools: [{ type: 'web_search' }],
      input: JSON.stringify({ product_name: input.product_name, brand_name: input.brand_name ?? null }),
    });

    const text = response.output_text?.trim();
    if (!text) {
      throw new Error('the model returned no output');
    }

    const jsonText = text
      .replace(/^```(?:json)?\s*/i, '')
      .replace(/\s*```$/, '')
      .trim();

    let parsed: unknown;
    try {
      parsed = JSON.parse(jsonText);
    } catch {
      this.logger.warn(`suggestProductVariants: could not parse model output as JSON: ${text.slice(0, 200)}`);
      throw new Error('the model did not return a parseable list of variants');
    }

    const result = variantSuggestionListSchema.safeParse(parsed);
    if (!result.success) {
      this.logger.warn(`suggestProductVariants: model output was not a string array: ${text.slice(0, 200)}`);
      throw new Error('the model did not return a valid list of variants');
    }

    const seen = new Set<string>();
    const variants: string[] = [];
    for (const raw of result.data) {
      const name = raw.trim();
      const key = name.toLowerCase();
      if (!name || seen.has(key)) continue;
      seen.add(key);
      variants.push(name);
      if (variants.length >= 12) break;
    }
    return { variants };
  }
}
