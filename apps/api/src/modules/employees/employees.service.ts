import { Injectable } from '@nestjs/common';
import type { CreateEmployee, UpdateEmployee, AssignRole } from '@snappos/contracts';
import { DatabaseService } from '../../platform/database/database.service.js';
import { AuthService } from '../../platform/auth/auth.service.js';
import { AuditService } from '../../platform/audit/audit.service.js';
import { OnboardingService } from '../onboarding/onboarding.service.js';
import { ApiException } from '../../platform/errors/api-exception.js';

const EMPLOYEE_COLUMNS = `id, email, phone, full_name, display_name, employee_code,
       hired_at::text, status, last_login_at, created_at`;

@Injectable()
export class EmployeesService {
  constructor(
    private readonly db: DatabaseService,
    private readonly auth: AuthService,
    private readonly audit: AuditService,
    private readonly onboarding: OnboardingService,
  ) {}

  async list(orgId: string) {
    return this.db.withOrg(orgId, async (tx) => {
      const { rows } = await tx.query(
        `SELECT u.id, u.email, u.phone, u.full_name, u.display_name, u.employee_code,
                u.status,
                COALESCE(
                  (SELECT array_agg(r.name ORDER BY r.name)
                   FROM user_roles ur JOIN roles r ON r.id = ur.role_id
                   WHERE ur.user_id = u.id),
                  '{}'
                ) AS role_names
         FROM users u
         ORDER BY u.full_name`,
      );
      return rows;
    });
  }

  /** One employee, plus every role assignment -- each carries its own id, so it can be revoked individually. */
  async get(orgId: string, id: string) {
    return this.db.withOrg(orgId, async (tx) => {
      const { rows } = await tx.query(`SELECT ${EMPLOYEE_COLUMNS} FROM users WHERE id = $1`, [id]);
      const employee = rows[0];
      if (!employee) throw ApiException.notFound('employee');

      const { rows: roles } = await tx.query(
        `SELECT ur.id, ur.role_id, r.key AS role_key, r.name AS role_name, ur.store_id
         FROM user_roles ur JOIN roles r ON r.id = ur.role_id
         WHERE ur.user_id = $1
         ORDER BY r.name`,
        [id],
      );

      return { ...employee, roles };
    });
  }

  /** Every role available to assign -- system defaults plus this org's own, none of which exist yet. */
  async listRoles(orgId: string) {
    return this.db.withOrg(orgId, async (tx) => {
      const { rows } = await tx.query(
        `SELECT r.id, r.key, r.name, r.description, r.is_system,
                COALESCE(
                  array_agg(rp.permission_key ORDER BY rp.permission_key)
                    FILTER (WHERE rp.permission_key IS NOT NULL),
                  '{}'
                ) AS permissions
         FROM roles r
         LEFT JOIN role_permissions rp ON rp.role_id = r.id
         WHERE r.org_id IS NULL OR r.org_id = current_setting('app.org_id')::uuid
         GROUP BY r.id
         ORDER BY r.name`,
      );
      return rows;
    });
  }

  /**
   * A new employee, with one starting role and, optionally, the two ways
   * they get in: a PIN for the register, a password for the back office.
   * Neither is required -- `users.password_hash` is nullable specifically
   * for PIN-only staff, per the schema's own comment -- but every employee
   * needs at least the role to do anything at all, so that one is not
   * optional here even though `user_roles` itself has no such constraint.
   */
  async create(orgId: string, actorUserId: string, input: CreateEmployee) {
    return this.db.withOrg(orgId, async (tx) => {
      const { rows: roleRows } = await tx.query<{ id: string }>(
        `SELECT id FROM roles
         WHERE key = $1 AND (org_id IS NULL OR org_id = current_setting('app.org_id')::uuid)`,
        [input.role_key],
      );
      const role = roleRows[0];
      if (!role) throw ApiException.notFound('role');

      const passwordHash = input.password ? await this.auth.hashPassword(input.password) : null;

      const { rows } = await tx.query(
        `INSERT INTO users
           (org_id, email, phone, full_name, display_name, password_hash, employee_code, hired_at, status)
         VALUES (current_setting('app.org_id')::uuid, $1,$2,$3,$4,$5,$6,$7,'active')
         RETURNING ${EMPLOYEE_COLUMNS}`,
        [
          input.email ?? null,
          input.phone ?? null,
          input.full_name,
          input.display_name ?? input.full_name.split(' ')[0],
          passwordHash,
          input.employee_code ?? null,
          input.hired_at ?? null,
        ],
      );
      const employee = rows[0]!;

      await tx.query(
        `INSERT INTO user_roles (org_id, user_id, role_id, store_id, granted_by)
         VALUES (current_setting('app.org_id')::uuid, $1, $2, $3, $4)`,
        [employee.id, role.id, input.store_id ?? null, actorUserId],
      );

      if (input.pin) {
        const pinHash = await this.auth.hashPin(input.pin);
        await tx.query(
          `INSERT INTO employee_pins (user_id, org_id, pin_hash)
           VALUES ($1, current_setting('app.org_id')::uuid, $2)`,
          [employee.id, pinHash],
        );
      }

      // Same transaction as the employee row itself: a new hire and their
      // onboarding checklist either both exist or neither does.
      await this.onboarding.startChecklistTx(tx, actorUserId, employee.id);

      await this.audit.record(tx, {
        action: 'employee.create',
        entityType: 'user',
        entityId: employee.id,
        actorUserId,
        newValue: { full_name: input.full_name, role_key: input.role_key },
      });

      return employee;
    });
  }

  async update(orgId: string, actorUserId: string, id: string, input: UpdateEmployee) {
    return this.db.withOrg(orgId, async (tx) => {
      const { rows } = await tx.query(
        `UPDATE users SET
           full_name     = COALESCE($2, full_name),
           display_name  = COALESCE($3, display_name),
           email         = COALESCE($4, email),
           phone         = COALESCE($5, phone),
           employee_code = COALESCE($6, employee_code),
           hired_at      = COALESCE($7::date, hired_at),
           status        = COALESCE($8, status)
         WHERE id = $1
         RETURNING ${EMPLOYEE_COLUMNS}`,
        [
          id,
          input.full_name ?? null,
          input.display_name ?? null,
          input.email ?? null,
          input.phone ?? null,
          input.employee_code ?? null,
          input.hired_at ?? null,
          input.status ?? null,
        ],
      );
      const employee = rows[0];
      if (!employee) throw ApiException.notFound('employee');

      await this.audit.record(tx, {
        action: 'employee.update',
        entityType: 'user',
        entityId: id,
        actorUserId,
        newValue: input,
      });

      return employee;
    });
  }

  /**
   * Reset a PIN. Also clears failed attempts and any lockout -- a manager
   * handing someone a fresh PIN means they should be able to use it
   * immediately, not still be locked out from whatever they mistyped before.
   */
  async setPin(orgId: string, actorUserId: string, id: string, pin: string) {
    return this.db.withOrg(orgId, async (tx) => {
      const { rows: userRows } = await tx.query(`SELECT id FROM users WHERE id = $1`, [id]);
      if (!userRows[0]) throw ApiException.notFound('employee');

      const pinHash = await this.auth.hashPin(pin);
      await tx.query(
        `INSERT INTO employee_pins (user_id, org_id, pin_hash, failed_count, locked_until)
         VALUES ($1, current_setting('app.org_id')::uuid, $2, 0, NULL)
         ON CONFLICT (user_id) DO UPDATE
           SET pin_hash = EXCLUDED.pin_hash, failed_count = 0, locked_until = NULL`,
        [id, pinHash],
      );

      await this.audit.record(tx, {
        action: 'employee.pin_reset',
        entityType: 'user',
        entityId: id,
        actorUserId,
        newValue: {},
      });

      return { ok: true };
    });
  }

  async assignRole(orgId: string, actorUserId: string, id: string, input: AssignRole) {
    return this.db.withOrg(orgId, async (tx) => {
      const { rows: roleRows } = await tx.query<{ id: string }>(
        `SELECT id FROM roles
         WHERE key = $1 AND (org_id IS NULL OR org_id = current_setting('app.org_id')::uuid)`,
        [input.role_key],
      );
      const role = roleRows[0];
      if (!role) throw ApiException.notFound('role');

      await tx.query(
        `INSERT INTO user_roles (org_id, user_id, role_id, store_id, granted_by)
         VALUES (current_setting('app.org_id')::uuid, $1, $2, $3, $4)
         ON CONFLICT DO NOTHING`,
        [id, role.id, input.store_id ?? null, actorUserId],
      );

      await this.audit.record(tx, {
        action: 'employee.role_grant',
        entityType: 'user',
        entityId: id,
        actorUserId,
        newValue: { role_key: input.role_key, store_id: input.store_id ?? null },
      });

      return { ok: true };
    });
  }

  /** `userRoleId` is one specific assignment row, not the role itself -- see `get`'s `roles[].id`. */
  async removeRole(orgId: string, actorUserId: string, id: string, userRoleId: string) {
    return this.db.withOrg(orgId, async (tx) => {
      const { rows } = await tx.query(
        `DELETE FROM user_roles WHERE id = $1 AND user_id = $2 RETURNING role_id`,
        [userRoleId, id],
      );
      if (!rows[0]) throw ApiException.notFound('role assignment');

      await this.audit.record(tx, {
        action: 'employee.role_revoke',
        entityType: 'user',
        entityId: id,
        actorUserId,
        newValue: { user_role_id: userRoleId },
      });

      return { ok: true };
    });
  }
}
