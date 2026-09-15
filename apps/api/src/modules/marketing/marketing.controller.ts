import { Body, Controller, Delete, Get, Param, Patch, Post, Query } from '@nestjs/common';
import {
  createSegmentSchema,
  updateSegmentSchema,
  segmentDefinitionSchema,
  createCampaignSchema,
  updateCampaignSchema,
  messageChannel,
} from '@snappos/contracts';
import { MarketingService } from './marketing.service.js';
import { zodBody } from '../../platform/validation/zod.pipe.js';
import { CurrentUser } from '../../platform/auth/current-user.decorator.js';
import { Public, RequirePermissions } from '../../platform/auth/auth.guard.js';
import type { AuthenticatedUser } from '../../platform/auth/auth.service.js';

@Controller({ path: 'marketing', version: '1' })
export class MarketingController {
  constructor(private readonly marketing: MarketingService) {}

  // --- Segments -------------------------------------------------------------

  @Get('segments')
  @RequirePermissions('marketing.manage')
  listSegments(@CurrentUser() user: AuthenticatedUser) {
    return this.marketing.listSegments(user.orgId);
  }

  @Get('segments/:id')
  @RequirePermissions('marketing.manage')
  getSegment(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.marketing.getSegment(user.orgId, id);
  }

  @Post('segments')
  @RequirePermissions('marketing.manage')
  createSegment(
    @CurrentUser() user: AuthenticatedUser,
    @Body(zodBody(createSegmentSchema)) body: ReturnType<typeof createSegmentSchema.parse>,
  ) {
    return this.marketing.createSegment(user.orgId, user.userId, body);
  }

  @Patch('segments/:id')
  @RequirePermissions('marketing.manage')
  updateSegment(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body(zodBody(updateSegmentSchema)) body: ReturnType<typeof updateSegmentSchema.parse>,
  ) {
    return this.marketing.updateSegment(user.orgId, user.userId, id, body);
  }

  @Delete('segments/:id')
  @RequirePermissions('marketing.manage')
  deleteSegment(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.marketing.deleteSegment(user.orgId, user.userId, id);
  }

  /**
   * How many a definition matches and how many of those are reachable.
   *
   * A POST despite reading nothing: the definition is a structured object
   * being composed in a form, which does not belong in a query string, and
   * this is how the editor previews a segment that has not been saved yet.
   */
  @Post('segments/preview')
  @RequirePermissions('marketing.manage')
  previewSegment(
    @CurrentUser() user: AuthenticatedUser,
    @Body(zodBody(segmentDefinitionSchema)) body: ReturnType<typeof segmentDefinitionSchema.parse>,
    @Query('channel') channel?: string,
  ) {
    return this.marketing.previewSegment(user.orgId, body, messageChannel.catch('email').parse(channel));
  }

  // --- Campaigns ------------------------------------------------------------

  @Get('campaigns')
  @RequirePermissions('marketing.manage')
  listCampaigns(@CurrentUser() user: AuthenticatedUser) {
    return this.marketing.listCampaigns(user.orgId);
  }

  @Get('campaigns/:id')
  @RequirePermissions('marketing.manage')
  getCampaign(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.marketing.getCampaign(user.orgId, id);
  }

  @Post('campaigns')
  @RequirePermissions('marketing.manage')
  createCampaign(
    @CurrentUser() user: AuthenticatedUser,
    @Body(zodBody(createCampaignSchema)) body: ReturnType<typeof createCampaignSchema.parse>,
  ) {
    return this.marketing.createCampaign(user.orgId, user.userId, body);
  }

  @Patch('campaigns/:id')
  @RequirePermissions('marketing.manage')
  updateCampaign(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id') id: string,
    @Body(zodBody(updateCampaignSchema)) body: ReturnType<typeof updateCampaignSchema.parse>,
  ) {
    return this.marketing.updateCampaign(user.orgId, user.userId, id, body);
  }

  /**
   * Actually send. A separate permission from composing one: writing a
   * campaign and mailing it to the whole customer list are different levels
   * of trust.
   */
  @Post('campaigns/:id/send')
  @RequirePermissions('marketing.send')
  sendCampaign(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string) {
    return this.marketing.sendCampaign(user.orgId, user.userId, id);
  }

  @Get('suppressions')
  @RequirePermissions('marketing.manage')
  listSuppressions(@CurrentUser() user: AuthenticatedUser) {
    return this.marketing.listSuppressions(user.orgId);
  }

  /**
   * The unsubscribe link from an email.
   *
   * Public, necessarily: the person clicking it is a customer reading their
   * mail, with no account here and no session. CAN-SPAM requires the opt-out
   * to work without making them sign in or explain themselves, so the token
   * in the URL is the whole authorization -- which is why it is 24 random
   * bytes and scoped to one recipient of one campaign.
   */
  @Post('unsubscribe/:token')
  @Public()
  unsubscribe(@Param('token') token: string) {
    return this.marketing.unsubscribe(token);
  }
}
