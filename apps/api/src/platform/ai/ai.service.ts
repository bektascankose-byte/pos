import { Injectable, Logger } from '@nestjs/common';
import OpenAI from 'openai';
import { zodTextFormat } from 'openai/helpers/zod';
import {
  aiExtractedInvoiceSchema,
  aiMatchPredictionsSchema,
  aiComplianceSuggestionSchema,
  type AiExtractedInvoice,
  type AiLineMatchPrediction,
  type AiMatchLineInput,
  type AiComplianceSuggestion,
} from '@snappos/contracts';
import { ApiException } from '../errors/api-exception.js';

const MAX_DOCUMENT_CHARS = 20_000;

const EXTRACTION_INSTRUCTIONS = `You are extracting line items from a vendor invoice for a retail point-of-sale system. The text below was pulled from a PDF or an EDI/plain-text document and may have irregular spacing, broken lines, or raw EDI segment codes and delimiters (such as *, ~, or |) instead of natural prose -- in either case, find the actual billed line items it describes.

Return every distinct billed line item as its own entry, with:
- raw_text: the original line text for this item, as close to verbatim as you can reconstruct it
- vendor_sku: the vendor's own item code/SKU for this line, if shown, else null
- description: the item's name/description as the invoice states it, else null
- quantity: the number of units/cases invoiced for this line, as a plain number, else null
- unit_cost: the per-unit cost for this line (not the extended/line-total price), as a plain number with no currency symbol or thousands separator, else null

Do not return invoice-level rows like subtotals, tax, shipping, or the grand total as line items. If you can find the vendor's own invoice number, return it in vendor_invoice_no; if you can find a printed grand total for the whole invoice, return it in invoice_total as a plain number. Use null for anything not actually present rather than guessing.`;

const MATCHING_INSTRUCTIONS = `You are matching vendor invoice line items against an existing product catalog for a retail point-of-sale system, and suggesting catalog metadata when the invoice implies it.

For each line you are given its raw text, parsed description/SKU, and a short list of catalog candidates (each with an index, product name, variant name, brand, and category) drawn from a fuzzy text search -- not the full catalog. For every line, return:
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
}
