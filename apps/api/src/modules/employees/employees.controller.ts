import { Body, Controller, Delete, Get, Param, Patch, Post } from '@nestjs/common';
import {
  createEmployeeSchema,
  updateEmployeeSchema,
  setPinSchema,
  assignRoleSchema,
} from '@snappos/contracts';
import { EmployeesService } from './employees.service.js';
import { zodBody } from '../../platform/validation/zod.pipe.js';
import { CurrentUser } from '../../platform/auth/current-user.decorator.js';
import { RequirePermissions } from '../../platform/auth/auth.guard.js';
import type { AuthenticatedUser } from '../../platform/auth/auth.service.js';

@Controller({ path: 'employees', version: '1' })
export class EmployeesController {
  constructor(private readonly employees: EmployeesService) {}

  @Get()
  @RequirePermissions('employee.view')
  list(@CurrentUser() user: AuthenticatedUser) {
    return this.employees.list(user.orgId);
  }

  /** Declared before ':id' -- otherwise Nest would match "roles" as an employee id. */
  @Get('roles')
  @RequirePermissions('employee.view')
  roles(@CurrentUser() user: AuthenticatedUser) {
    return this.employees.listRoles(user.orgId);
  }

  @Get(':id')
  @RequirePermissions('employee.view')
  get(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.employees.get(user.orgId, id);
  }

  @Post()
  @RequirePermissions('employee.manage')
  create(
    @CurrentUser() user: AuthenticatedUser,
    @Body(zodBody(createEmployeeSchema)) body: ReturnType<typeof createEmployeeSchema.parse>,
  ) {
    return this.employees.create(user.orgId, user.userId, body);
  }

  @Patch(':id')
  @RequirePermissions('employee.manage')
  update(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body(zodBody(updateEmployeeSchema)) body: ReturnType<typeof updateEmployeeSchema.parse>,
  ) {
    return this.employees.update(user.orgId, user.userId, id, body);
  }

  @Post(':id/pin')
  @RequirePermissions('employee.manage')
  setPin(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body(zodBody(setPinSchema)) body: ReturnType<typeof setPinSchema.parse>,
  ) {
    return this.employees.setPin(user.orgId, user.userId, id, body.pin);
  }

  @Post(':id/roles')
  @RequirePermissions('employee.manage')
  assignRole(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body(zodBody(assignRoleSchema)) body: ReturnType<typeof assignRoleSchema.parse>,
  ) {
    return this.employees.assignRole(user.orgId, user.userId, id, body);
  }

  @Delete(':id/roles/:userRoleId')
  @RequirePermissions('employee.manage')
  removeRole(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Param('userRoleId') userRoleId: string,
  ) {
    return this.employees.removeRole(user.orgId, user.userId, id, userRoleId);
  }
}
