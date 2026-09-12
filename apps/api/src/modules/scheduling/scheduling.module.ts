import { Module } from '@nestjs/common';
import { SchedulingController } from './scheduling.controller.js';
import { SchedulingService } from './scheduling.service.js';

@Module({
  controllers: [SchedulingController],
  providers: [SchedulingService],
})
export class SchedulingModule {}
