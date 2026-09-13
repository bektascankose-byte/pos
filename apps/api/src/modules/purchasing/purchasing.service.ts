import { Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import type { CreateVendor, CreatePurchaseOrder, ReceivePurchaseOrder } from '@snappos/contracts';
import { DatabaseService } from '../../platform/database/database.service.js';
import { AuditService } from '../../platform/audit/audit.service.js';
import { InventoryRepository, type Movement } from '../inventory/inventory.repository.js';
import { ApiException } from '../../platform/errors/api-exception.js';

const VENDOR_COLUMNS = `id, code, name, contact_name, phone, email, payment_terms, lead_time_days::int, status`;

const PO_LINE_COLUMNS = `pol.id, pol.variant_id, p.name AS product_name, pv.variant_name, pv.sku,
       pol.vendor_sku, pol.quantity_ordered::text, pol.quantity_received::text,
       pol.unit_cost::text, pol.line_total_minor::text`;

const PO_COLUMNS = `po.id, po.store_id, po.vendor_id, v.name AS vendor_name, po.reference, po.status,
       po.expected_at::text, po.subtotal_minor::text, po.shipping_minor::text,
       po.tax_minor::text, po.total_minor::text, po.note, po.created_at`;

@Injectable()
export class PurchasingService {
  constructor(
    private readonly db: DatabaseService,
    private readonly audit: AuditService,
    private readonly inventoryRepository: InventoryRepository,
  ) {}

  async listVendors(orgId: string) {
    return this.db.withOrg(orgId, async (tx) => {
      const { rows } = await tx.query(
        `SELECT ${VENDOR_COLUMNS} FROM vendors WHERE status = 'active' ORDER BY name`,
      );
      return rows;
    });
  }

  async createVendor(orgId: string, actorUserId: string, input: CreateVendor) {
    return this.db.withOrg(orgId, async (tx) => {
      const { rows } = await tx.query(
        `INSERT INTO vendors (org_id, code, name, contact_name, phone, email, payment_terms, lead_time_days)
         VALUES (current_setting('app.org_id')::uuid, $1,$2,$3,$4,$5,$6,$7)
         RETURNING ${VENDOR_COLUMNS}`,
        [
          input.code,
          input.name,
          input.contact_name ?? null,
          input.phone ?? null,
          input.email ?? null,
          input.payment_terms ?? null,
          input.lead_time_days ?? 7,
        ],
      );
      const vendor = rows[0]!;

      await this.audit.record(tx, {
        action: 'vendor.create',
        entityType: 'vendor',
        entityId: vendor.id,
        actorUserId,
        newValue: { code: input.code, name: input.name },
      });

      return vendor;
    });
  }

  async listPurchaseOrders(orgId: string, filter: { storeId?: string | undefined; status?: string | undefined }) {
    return this.db.withOrg(orgId, async (tx) => {
      const { rows } = await tx.query(
        `SELECT ${PO_COLUMNS}
         FROM purchase_orders po
         JOIN vendors v ON v.id = po.vendor_id
         WHERE ($1::uuid IS NULL OR po.store_id = $1)
           AND ($2::text IS NULL OR po.status::text = $2)
         ORDER BY po.created_at DESC`,
        [filter.storeId ?? null, filter.status ?? null],
      );
      return rows;
    });
  }

  async getPurchaseOrder(orgId: string, id: string) {
    return this.db.withOrg(orgId, async (tx) => {
      const { rows } = await tx.query(
        `SELECT ${PO_COLUMNS} FROM purchase_orders po JOIN vendors v ON v.id = po.vendor_id WHERE po.id = $1`,
        [id],
      );
      const po = rows[0];
      if (!po) throw ApiException.notFound('purchase order');

      const { rows: lines } = await tx.query(
        `SELECT ${PO_LINE_COLUMNS}
         FROM purchase_order_lines pol
         JOIN product_variants pv ON pv.id = pol.variant_id
         JOIN products p ON p.id = pv.product_id
         WHERE pol.purchase_order_id = $1
         ORDER BY p.name, pv.variant_name`,
        [id],
      );

      return { ...po, lines };
    });
  }

  /**
   * Create a PO and its lines in one transaction, with the total computed
   * from the lines rather than trusted from the caller -- `line_total_minor`
   * is `round(quantity_ordered * unit_cost * 100)`, done in Postgres numeric
   * arithmetic so nothing passes through a float on the way to a dollar
   * figure. Starts at `submitted`: this is a PO placed with a vendor, not a
   * draft edited over several sittings, so the `draft` state (and the
   * `confirmed`/`closed`/`cancelled` transitions) aren't wired to any action
   * in this pass.
   */
  async createPurchaseOrder(orgId: string, actorUserId: string, input: CreatePurchaseOrder) {
    return this.db.withOrg(orgId, (tx) => this.createPurchaseOrderTx(tx, actorUserId, input));
  }

  /**
   * Receive stock against a PO. Each line posts its own `receiving` movement
   * through the same `InventoryRepository` every other stock change goes
   * through -- this never touches `inventory_levels` directly. The PO's own
   * `subtotal_minor`/`total_minor` are left exactly as ordered; a unit cost
   * that differs from what's on the PO is recorded as `cost_changed` on the
   * receipt line, not silently folded into the PO's original total.
   */
  async receivePurchaseOrder(orgId: string, actorUserId: string, poId: string, input: ReceivePurchaseOrder) {
    return this.db.withOrg(orgId, (tx) => this.receivePurchaseOrderTx(tx, actorUserId, poId, input));
  }

  /**
   * The transactional bodies of `createPurchaseOrder`/`receivePurchaseOrder`,
   * pulled out so invoice-import commit can compose both inside one shared
   * transaction: synthesize a PO from an invoice that never had one, then
   * receive against it immediately, atomically. Each public method above is
   * just this run inside its own `withOrg` -- identical behavior, callable in
   * isolation exactly as before this split.
   */
  async createPurchaseOrderTx(tx: PoolClient, actorUserId: string, input: CreatePurchaseOrder) {
    const { rows: poRows } = await tx.query<{ id: string }>(
      `INSERT INTO purchase_orders
         (org_id, store_id, vendor_id, reference, status, expected_at, created_by, note)
       VALUES (current_setting('app.org_id')::uuid, $1, $2, $3, 'submitted', $4::date, $5, $6)
       RETURNING id`,
      [input.store_id, input.vendor_id, input.reference, input.expected_at ?? null, actorUserId, input.note ?? null],
    );
    const poId = poRows[0]!.id;

    for (const line of input.lines) {
      await tx.query(
        `INSERT INTO purchase_order_lines
           (org_id, purchase_order_id, variant_id, vendor_sku, quantity_ordered, unit_cost, line_total_minor)
         VALUES (current_setting('app.org_id')::uuid, $1, $2, $3, $4, $5,
                 round($4::numeric * $5::numeric * 100))`,
        [poId, line.variant_id, line.vendor_sku ?? null, line.quantity_ordered, line.unit_cost],
      );
    }

    await tx.query(
      `UPDATE purchase_orders po SET
         subtotal_minor = (SELECT COALESCE(sum(line_total_minor), 0) FROM purchase_order_lines WHERE purchase_order_id = po.id),
         total_minor    = (SELECT COALESCE(sum(line_total_minor), 0) FROM purchase_order_lines WHERE purchase_order_id = po.id)
       WHERE po.id = $1`,
      [poId],
    );

    await this.audit.record(tx, {
      action: 'purchasing.create',
      entityType: 'purchase_order',
      entityId: poId,
      actorUserId,
      newValue: { reference: input.reference, vendor_id: input.vendor_id, line_count: input.lines.length },
    });

    return this.loadPurchaseOrder(tx, poId);
  }

  /**
   * `extra` is populated only by invoice-import commit -- the file's own
   * object-storage reference and its stated total, neither of which the
   * ordinary receive endpoint has ever had a way to supply. Omitted, this
   * behaves exactly as it always has.
   */
  async receivePurchaseOrderTx(
    tx: PoolClient,
    actorUserId: string,
    poId: string,
    input: ReceivePurchaseOrder,
    extra?: { documentUrl?: string | undefined; invoiceTotalMinor?: string | undefined },
  ) {
    const { rows: poRows } = await tx.query<{ id: string; store_id: string; status: string }>(
      `SELECT id, store_id, status FROM purchase_orders WHERE id = $1 FOR UPDATE`,
      [poId],
    );
    const po = poRows[0];
    if (!po) throw ApiException.notFound('purchase order');
    if (po.status === 'closed' || po.status === 'cancelled') {
      throw new ApiException('conflict', `a ${po.status} purchase order cannot receive stock`, {
        retryable: false,
      });
    }

    const hasNote = !!input.note?.trim();
    const { rows: receiptRows } = await tx.query<{ id: string }>(
      `INSERT INTO po_receipts
         (org_id, purchase_order_id, received_by, vendor_invoice_no, variance_flagged, variance_note,
          document_url, invoice_total_minor)
       VALUES (current_setting('app.org_id')::uuid, $1, $2, $3, $4, $5, $6, $7)
       RETURNING id`,
      [
        poId,
        actorUserId,
        input.vendor_invoice_no ?? null,
        hasNote,
        input.note ?? null,
        extra?.documentUrl ?? null,
        extra?.invoiceTotalMinor ?? null,
      ],
    );
    const receiptId = receiptRows[0]!.id;

    const movements: Movement[] = [];

    for (const line of input.lines) {
      const { rows: lineRows } = await tx.query<{
        variant_id: string;
        unit_cost: string;
      }>(
        `SELECT variant_id, unit_cost::text FROM purchase_order_lines
         WHERE id = $1 AND purchase_order_id = $2 FOR UPDATE`,
        [line.po_line_id, poId],
      );
      const poLine = lineRows[0];
      if (!poLine) throw ApiException.notFound('purchase order line');

      const effectiveUnitCost = line.unit_cost ?? poLine.unit_cost;
      const costChanged =
        line.unit_cost !== undefined && Number(line.unit_cost) !== Number(poLine.unit_cost);

      await tx.query(
        `INSERT INTO po_receipt_lines
           (org_id, receipt_id, po_line_id, variant_id, quantity_received, unit_cost, cost_changed)
         VALUES (current_setting('app.org_id')::uuid, $1, $2, $3, $4, $5, $6)`,
        [receiptId, line.po_line_id, poLine.variant_id, line.quantity_received, effectiveUnitCost, costChanged],
      );

      await tx.query(
        `UPDATE purchase_order_lines SET quantity_received = quantity_received + $2 WHERE id = $1`,
        [line.po_line_id, line.quantity_received],
      );

      movements.push({
        storeId: po.store_id,
        variantId: poLine.variant_id,
        delta: line.quantity_received,
        reason: 'receiving',
        unitCost: effectiveUnitCost,
        referenceType: 'purchase_order',
        referenceId: poId,
        actorUserId,
      });
    }

    await this.inventoryRepository.post(tx, movements);

    const { rows: statusRows } = await tx.query<{ fully_received: boolean; any_received: boolean }>(
      `SELECT bool_and(quantity_received >= quantity_ordered) AS fully_received,
              bool_or(quantity_received > 0) AS any_received
       FROM purchase_order_lines WHERE purchase_order_id = $1`,
      [poId],
    );
    const { fully_received, any_received } = statusRows[0]!;
    const newStatus = fully_received ? 'received' : any_received ? 'partial' : po.status;
    await tx.query(`UPDATE purchase_orders SET status = $2 WHERE id = $1`, [poId, newStatus]);

    await this.audit.record(tx, {
      action: 'purchasing.receive',
      entityType: 'purchase_order',
      entityId: poId,
      actorUserId,
      newValue: { receipt_id: receiptId, line_count: input.lines.length },
    });

    return this.loadPurchaseOrder(tx, poId);
  }

  private async loadPurchaseOrder(tx: PoolClient, id: string) {
    const { rows } = await tx.query(
      `SELECT ${PO_COLUMNS} FROM purchase_orders po JOIN vendors v ON v.id = po.vendor_id WHERE po.id = $1`,
      [id],
    );
    const po = rows[0]!;
    const { rows: lines } = await tx.query(
      `SELECT ${PO_LINE_COLUMNS}
       FROM purchase_order_lines pol
       JOIN product_variants pv ON pv.id = pol.variant_id
       JOIN products p ON p.id = pv.product_id
       WHERE pol.purchase_order_id = $1
       ORDER BY p.name, pv.variant_name`,
      [id],
    );
    return { ...po, lines };
  }
}
