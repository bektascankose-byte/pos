import { Module } from '@nestjs/common';
import { OrdersModule } from '../orders/orders.module.js';
import { ComplianceModule } from '../compliance/compliance.module.js';
import { DeliveryService } from './delivery.service.js';
import { DeliverySettingsService } from './delivery-settings.service.js';
import { DeliveryOrdersController, DeliverySettingsController } from './delivery.controller.js';
import { DoorDashWebhookController } from './doordash-webhook.controller.js';

/**
 * Delivery sits downstream of orders: it books a courier for an order and
 * moves the order along on the courier's word, always through the orders
 * service's own transitions. Orders know nothing about couriers.
 */
@Module({
  imports: [OrdersModule, ComplianceModule],
  controllers: [DeliverySettingsController, DeliveryOrdersController, DoorDashWebhookController],
  providers: [DeliveryService, DeliverySettingsService],
  exports: [DeliveryService, DeliverySettingsService],
})
export class DeliveryModule {}
