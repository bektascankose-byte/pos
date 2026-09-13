import { Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import type {
  CreateOnboardingTaskTemplate,
  UpdateOnboardingTaskTemplate,
  AddOnboardingChecklistItem,
} from '@snappos/contracts';
import { DatabaseService } from '../../platform/database/database.service.js';
import { AuditService } from '../../platform/audit/audit.service.js';
import { ApiException } from '../../platform/errors/api-exception.js';

const TEMPLATE_COLUMNS = `id, title, description, sort_order, is_active, created_at`;

const CHECKLIST_ITEM_COLUMNS = `i.id, i.checklist_id, i.template_item_id, i.title, i.sort_order,
       i.is_completed, i.completed_by, u.full_name AS completed_by_name, i.completed_at, i.note`;

const CHECKLIST_ITEM_FROM = `onboarding_checklist_items i
       LEFT JOIN users u ON u.id = i.completed_by`;

@Injectable()
export class OnboardingService {
  constructor(
    private readonly db: DatabaseService,
    private readonly audit: AuditService,
  ) {}

  async listTemplates(orgId: string) {
    return this.db.withOrg(orgId, async (tx) => {
      const { rows } = await tx.query(
        `SELECT ${TEMPLATE_COLUMNS} FROM onboarding_task_templates ORDER BY sort_order, created_at`,
      );
      return rows;
    });
  }

  async createTemplateItem(orgId: string, actorUserId: string, input: CreateOnboardingTaskTemplate) {
    return this.db.withOrg(orgId, async (tx) => {
      const { rows: sortRows } = await tx.query<{ next: number }>(
        `SELECT COALESCE(MAX(sort_order), -1) + 1 AS next FROM onboarding_task_templates`,
      );

      const { rows } = await tx.query(
        `INSERT INTO onboarding_task_templates (org_id, title, description, sort_order)
         VALUES (current_setting('app.org_id')::uuid, $1, $2, $3)
         RETURNING ${TEMPLATE_COLUMNS}`,
        [input.title, input.description ?? null, input.sort_order ?? sortRows[0]!.next],
      );
      const item = rows[0]!;

      await this.audit.record(tx, {
        action: 'onboarding.template_create',
        entityType: 'onboarding_task_template',
        entityId: item.id,
        actorUserId,
        newValue: { title: input.title },
      });

      return item;
    });
  }

  /** Retiring an item (`is_active: false`) is the only way to remove it -- it may already be snapshotted onto real employees' checklists, so it's never hard-deleted. */
  async updateTemplateItem(orgId: string, actorUserId: string, id: string, input: UpdateOnboardingTaskTemplate) {
    return this.db.withOrg(orgId, async (tx) => {
      const { rows } = await tx.query(
        `UPDATE onboarding_task_templates SET
           title       = COALESCE($2, title),
           description = COALESCE($3, description),
           sort_order  = COALESCE($4, sort_order),
           is_active   = COALESCE($5, is_active)
         WHERE id = $1
         RETURNING ${TEMPLATE_COLUMNS}`,
        [id, input.title ?? null, input.description ?? null, input.sort_order ?? null, input.is_active ?? null],
      );
      const item = rows[0];
      if (!item) throw ApiException.notFound('onboarding task template item');

      await this.audit.record(tx, {
        action: 'onboarding.template_update',
        entityType: 'onboarding_task_template',
        entityId: id,
        actorUserId,
        newValue: input,
      });

      return item;
    });
  }

  async getChecklist(orgId: string, userId: string) {
    return this.db.withOrg(orgId, (tx) => this.loadChecklist(tx, userId));
  }

  /**
   * Snapshots every currently-active template item into a brand new
   * checklist for this employee. Called once, from inside
   * `EmployeesService.create`'s own transaction, so a new hire and their
   * checklist either both exist or neither does -- there is deliberately no
   * "start onboarding" endpoint a client can call on its own; see this
   * migration's own comment on why onboarding only ever starts at hire time.
   */
  async startChecklistTx(tx: PoolClient, actorUserId: string, userId: string): Promise<void> {
    const { rows: checklistRows } = await tx.query<{ id: string }>(
      `INSERT INTO onboarding_checklists (org_id, user_id, created_by)
       VALUES (current_setting('app.org_id')::uuid, $1, $2)
       RETURNING id`,
      [userId, actorUserId],
    );
    const checklistId = checklistRows[0]!.id;

    await tx.query(
      `INSERT INTO onboarding_checklist_items (org_id, checklist_id, template_item_id, title, sort_order)
       SELECT current_setting('app.org_id')::uuid, $1, id, title, sort_order
       FROM onboarding_task_templates
       WHERE is_active = true
       ORDER BY sort_order`,
      [checklistId],
    );
  }

  async completeItem(orgId: string, actorUserId: string, userId: string, itemId: string) {
    return this.db.withOrg(orgId, async (tx) => {
      const checklist = await this.loadChecklistRow(tx, userId);
      const { rows } = await tx.query(
        `UPDATE onboarding_checklist_items
           SET is_completed = true, completed_by = $2, completed_at = now()
         WHERE id = $1 AND checklist_id = $3
         RETURNING id`,
        [itemId, actorUserId, checklist.id],
      );
      if (!rows[0]) throw ApiException.notFound('checklist item');

      await this.audit.record(tx, {
        action: 'onboarding.item_complete',
        entityType: 'onboarding_checklist_item',
        entityId: itemId,
        actorUserId,
        newValue: {},
      });

      await this.maybeMarkChecklistComplete(tx, checklist.id);
      return this.loadChecklist(tx, userId);
    });
  }

  /** Reopens an item -- a manager unchecking something ticked by mistake. Also un-completes the checklist as a whole, since it's no longer true that everything is done. */
  async uncompleteItem(orgId: string, actorUserId: string, userId: string, itemId: string) {
    return this.db.withOrg(orgId, async (tx) => {
      const checklist = await this.loadChecklistRow(tx, userId);
      const { rows } = await tx.query(
        `UPDATE onboarding_checklist_items
           SET is_completed = false, completed_by = NULL, completed_at = NULL
         WHERE id = $1 AND checklist_id = $2
         RETURNING id`,
        [itemId, checklist.id],
      );
      if (!rows[0]) throw ApiException.notFound('checklist item');

      await tx.query(`UPDATE onboarding_checklists SET completed_at = NULL WHERE id = $1`, [checklist.id]);

      await this.audit.record(tx, {
        action: 'onboarding.item_reopen',
        entityType: 'onboarding_checklist_item',
        entityId: itemId,
        actorUserId,
        newValue: {},
      });

      return this.loadChecklist(tx, userId);
    });
  }

  /** A one-off item for this employee only -- not part of the shared template, so it never appears on anyone else's checklist. */
  async addItem(orgId: string, actorUserId: string, userId: string, input: AddOnboardingChecklistItem) {
    return this.db.withOrg(orgId, async (tx) => {
      const checklist = await this.loadChecklistRow(tx, userId);
      const { rows: sortRows } = await tx.query<{ next: number }>(
        `SELECT COALESCE(MAX(sort_order), -1) + 1 AS next FROM onboarding_checklist_items WHERE checklist_id = $1`,
        [checklist.id],
      );

      const { rows } = await tx.query<{ id: string }>(
        `INSERT INTO onboarding_checklist_items (org_id, checklist_id, title, sort_order, note)
         VALUES (current_setting('app.org_id')::uuid, $1, $2, $3, $4)
         RETURNING id`,
        [checklist.id, input.title, sortRows[0]!.next, input.note ?? null],
      );

      // A brand new pending item means the checklist can't be "done" anymore.
      await tx.query(`UPDATE onboarding_checklists SET completed_at = NULL WHERE id = $1`, [checklist.id]);

      await this.audit.record(tx, {
        action: 'onboarding.item_add',
        entityType: 'onboarding_checklist_item',
        entityId: rows[0]!.id,
        actorUserId,
        newValue: { title: input.title },
      });

      return this.loadChecklist(tx, userId);
    });
  }

  private async maybeMarkChecklistComplete(tx: PoolClient, checklistId: string): Promise<void> {
    await tx.query(
      `UPDATE onboarding_checklists SET completed_at = now()
       WHERE id = $1 AND completed_at IS NULL
         AND NOT EXISTS (
           SELECT 1 FROM onboarding_checklist_items WHERE checklist_id = $1 AND is_completed = false
         )`,
      [checklistId],
    );
  }

  private async loadChecklistRow(tx: PoolClient, userId: string): Promise<{ id: string }> {
    const { rows } = await tx.query<{ id: string }>(
      `SELECT id FROM onboarding_checklists WHERE user_id = $1`,
      [userId],
    );
    if (!rows[0]) throw ApiException.notFound('onboarding checklist');
    return rows[0];
  }

  private async loadChecklist(tx: PoolClient, userId: string) {
    const { rows } = await tx.query<{
      id: string;
      user_id: string;
      started_at: string;
      completed_at: string | null;
    }>(`SELECT id, user_id, started_at, completed_at FROM onboarding_checklists WHERE user_id = $1`, [userId]);
    const checklist = rows[0];
    if (!checklist) throw ApiException.notFound('onboarding checklist');

    const { rows: items } = await tx.query(
      `SELECT ${CHECKLIST_ITEM_COLUMNS} FROM ${CHECKLIST_ITEM_FROM} WHERE i.checklist_id = $1 ORDER BY i.sort_order`,
      [checklist.id],
    );

    return { ...checklist, items };
  }
}
