import { Module } from '@nestjs/common';
import { OrgController } from './org.controller.js';

@Module({ controllers: [OrgController] })
export class OrgModule {}
