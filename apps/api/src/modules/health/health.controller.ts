import { Controller, Get, VERSION_NEUTRAL } from '@nestjs/common';
import { DatabaseService } from '../../platform/database/database.service.js';
import { Public } from '../../platform/auth/auth.guard.js';

// Version neutral and outside the /api prefix. A load balancer health check
// must not have to know which API version is current.
@Controller({ version: VERSION_NEUTRAL })
export class HealthController {
  constructor(private readonly db: DatabaseService) {}

  /**
   * Liveness. Deliberately does not touch the database: a liveness probe that
   * fails during a brief database blip gets the container killed and restarted
   * into the same blip, turning a ten second outage into a crash loop.
   */
  @Public()
  @Get('health')
  health() {
    return { status: 'ok', uptime_seconds: Math.floor(process.uptime()) };
  }

  /** Readiness. This one does check the database, because without it we serve nothing. */
  @Public()
  @Get('health/ready')
  async ready() {
    const database = await this.db.healthy();
    return { status: database ? 'ready' : 'degraded', database };
  }
}
